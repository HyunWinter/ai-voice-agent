import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import { env } from './config.js';
import { log } from './log.js';

// ---- MRE Interfaces ----
export interface VoiceConfig {
  tenantId: string;
  model: string;
  voice: 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer';
  instructions: string;
}

const CALLS_API = 'https://api.openai.com/v1/realtime/calls';
const HANGUP_DELAY_MS = 2000; // Time allowed for the goodbye audio to play before disconnecting
const SILENCE_MS = 15_000; // After AI finishes speaking, if user is silent for N seconds -> reprompt / hangup
const MAX_CALL_MS = 600_000; // Absolute backstop: 10 min max call duration (prevents infinite billing)

// Store leads in a local file for this Minimal Reproduction (MRE).
const LEADS_FILE = path.resolve('data', 'leads.jsonl');

// Metadata for a single call — Caller/Called numbers extracted from SIP headers in index.ts.
export interface CallMeta {
  callerNumber: string | null; // Caller ID (E.164). Null if private/blocked.
  toNumber: string | null; // Called (tenant) number.
}

// Accepts incoming SIP call and injects tenant settings (instructions/voice/model).
// Audio/Codec bridging is handled by the OpenAI SIP endpoint — we only manage control.
export async function acceptCall(callId: string, config: VoiceConfig, meta: CallMeta): Promise<void> {
  // Inject the caller's phone number into instructions so the AI doesn't ask for it or invent one.
  const callerLine = meta.callerNumber
    ? `The caller is phoning from ${meta.callerNumber}. Use this as their callback number — do NOT ask them to read out their phone number, and NEVER invent one. If they insist on a different callback number, mention it in the problem notes.`
    : `Caller ID is unavailable. Ask the caller for the best callback number and read it back to confirm. NEVER invent a number.`;

  const body = {
    type: 'realtime',
    model: config.model,
    instructions: `${config.instructions}\n${callerLine}`,
    audio: {
      input: {
        turn_detection: {
          type: 'server_vad',
          // Raise VAD threshold above default (0.5 -> 0.6) so the AI doesn't react to
          // background noise, breathing, or line hiss on PSTN calls.
          threshold: 0.6,
          prefix_padding_ms: 300,
          // Extend silence duration (200 -> 600ms) so short pauses don't cut the user's turn.
          silence_duration_ms: 600,
        },
      },
      output: { voice: config.voice },
    },
    // Allows the AI to end the call itself by calling this function after saying goodbye.
    tools: [
      {
        type: 'function',
        name: 'capture_lead',
        description: "Save the caller's details once you have collected them.",
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: "Caller's name" },
            phone: { type: 'string', description: "Callback phone number" },
          },
          required: ['name'],
        },
      },
      {
        type: 'function',
        name: 'end_call',
        description: "End the phone call. Call this ONLY after the caller's request is handled and you have said a short goodbye.",
        parameters: { type: 'object', properties: {}, required: [] },
      },
    ],
    tool_choice: 'auto',
  };

  const res = await fetch(`${CALLS_API}/${callId}/accept`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`accept failed ${res.status}: ${await res.text()}`);
  }
  log.info(`Call accepted callId=${callId} tenant=${config.tenantId}`);
}

// Terminates the call (SIP hangup). Used when the AI calls end_call or as a fallback.
export async function hangupCall(callId: string): Promise<void> {
  const res = await fetch(`${CALLS_API}/${encodeURIComponent(callId)}/hangup`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
  });
  if (!res.ok) log.error(`hangup failed ${res.status}: ${await res.text()}`);
  else log.info(`Call ended (hangup) callId=${callId}`);
}

// Reject call (SIP reject) — For unmatched/inactive tenants to prevent billing waste.
export async function rejectCall(callId: string): Promise<void> {
  const res = await fetch(`${CALLS_API}/${encodeURIComponent(callId)}/reject`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status_code: 480 }), // 480 Temporarily Unavailable
  });
  if (!res.ok) log.error(`reject failed ${res.status}: ${await res.text()}`);
  else log.info(`Call rejected callId=${callId}`);
}

// ── Silence Detection (Event-Driven State Machine) ────────────────────────────
//
// Problem: The OpenAI Realtime API has no built-in "user went silent" event.
// True silence = no events at all, but "user is speaking" also produces no events until
// speech_started fires. We disambiguate via a state machine:
//
//   response.done      (AI finished speaking)     -> ARM silence timer
//   response.created   (AI started speaking)      -> DISARM (AI is talking)
//   speech_started     (User started speaking)    -> DISARM (User is talking)
//
// Timer fires (N sec with no activity after AI turn) -> reprompt "Are you still there?"
// Timer fires a second time                         -> hangup (caller left)
// MAX_CALL_MS absolute backstop                     -> hangup (prevents infinite billing)

// Monitoring WebSocket — Triggers the AI to say the initial greeting + processes events.
export function monitorCall(callId: string, config: VoiceConfig, meta: CallMeta): void {
  const ws = new WebSocket(`wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}`, {
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
  });

  // ── Silence detection state ──
  let silenceTimer: ReturnType<typeof setTimeout> | undefined;
  let reprompted = false;

  const disarmSilence = () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = undefined;
  };

  function onSilence() {
    if (!reprompted) {
      reprompted = true;
      log.info(`Silence ${SILENCE_MS / 1000}s after AI turn -> reprompting callId=${callId}`);
      ws.send(
        JSON.stringify({
          type: 'response.create',
          response: {
            instructions:
              'The caller has been silent. Warmly and briefly ask if they are still there, e.g. "Hello? Are you still there?"',
          },
        }),
      );
      // The reprompt response's response.done will re-arm the timer.
    } else {
      log.warn(`Still silent after reprompt -> hangup callId=${callId}`);
      void hangupCall(callId);
    }
  }

  const armSilence = () => {
    disarmSilence();
    silenceTimer = setTimeout(onSilence, SILENCE_MS);
  };

  // Absolute backstop — prevents infinite billing if something goes wrong.
  const maxTimer = setTimeout(() => {
    log.warn(`Max call duration ${MAX_CALL_MS / 60_000}min exceeded -> hangup callId=${callId}`);
    void hangupCall(callId);
  }, MAX_CALL_MS);

  ws.on('open', () => {
    log.info(`Monitor WS connected callId=${callId}`);
    // server_vad waits for user speech, so we trigger an empty response to make the AI speak first.
    ws.send(JSON.stringify({ type: 'response.create' }));
  });

  ws.on('message', (raw) => {
    let evt: any;
    try {
      evt = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // ── Silence timer state transitions (event-driven) ──
    if (evt.type === 'response.created') disarmSilence(); // AI is speaking
    if (evt.type === 'input_audio_buffer.speech_started') {
      reprompted = false; // User spoke -> reset silence state
      disarmSilence();
    }

    if (evt.type === 'error') {
      log.error('Realtime event error', evt);
      return;
    }

    // Handle function calls initiated by the model: capture_lead / end_call
    if (evt.type === 'response.done') {
      for (const item of evt.response?.output ?? []) {
        if (item.type !== 'function_call') continue;
        if (item.name === 'capture_lead') {
          void handleCaptureLead(ws, callId, config, meta, item.call_id, item.arguments).catch((e) =>
            log.error('Failed to process capture_lead', e),
          );
        } else if (item.name === 'end_call') {
          log.info(`AI requested call end -> hangup in ${HANGUP_DELAY_MS}ms callId=${callId}`);
          setTimeout(() => void hangupCall(callId), HANGUP_DELAY_MS);
        }
      }
      armSilence(); // AI turn ended -> start counting user silence
      return;
    }
    log.debug(`event: ${evt.type}`);
  });

  ws.on('close', () => {
    disarmSilence();
    clearTimeout(maxTimer);
    log.info(`Monitor WS closed callId=${callId}`);
  });
  ws.on('error', (e) => log.error('Monitor WS error', e));
}

// Process capture_lead: Store lead in a local file (MRE) + return result to model to continue conversation.
async function handleCaptureLead(
  ws: WebSocket,
  callId: string,
  config: VoiceConfig,
  meta: CallMeta,
  toolCallId: string | undefined,
  rawArgs: string | undefined,
): Promise<void> {
  let args: any = {};
  try {
    args = JSON.parse(rawArgs ?? '{}');
  } catch {
    /* Empty object if parsing fails */
  }

  // Use Caller ID as the phone number — prevents the AI from dictating/inventing numbers.
  const phone = meta.callerNumber ?? args.phone ?? 'Unknown';
  const lead = { ts: new Date().toISOString(), callId, tenantId: config.tenantId, ...args, phone };

  try {
    fs.mkdirSync(path.dirname(LEADS_FILE), { recursive: true });
    fs.appendFileSync(LEADS_FILE, JSON.stringify(lead) + '\n');
    log.info(`📋 Lead saved to local file (MRE Mock) -> ${LEADS_FILE}`, lead);
  } catch (e) {
    log.error('Failed to save lead to local file', e);
  }

  // Return the function result to the model and prompt it to continue (e.g. say goodbye -> end_call).
  if (toolCallId) {
    ws.send(
      JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: toolCallId, output: '{"status":"saved"}' },
      }),
    );
    ws.send(JSON.stringify({ type: 'response.create' }));
  }
}
