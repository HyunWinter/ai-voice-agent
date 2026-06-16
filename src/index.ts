import express from 'express';
import rateLimit from 'express-rate-limit';
import { env } from './config.js';
import { log } from './log.js';
import { acceptCall, monitorCall, rejectCall, type VoiceConfig } from './openai-call.js';
import { startDevTunnel } from './dev-tunnel.js';
import { buildDialSip } from './twilio/twiml.js';

const app = express();
// Behind proxies like ngrok/ALB -> Trust the first hop (for per-IP rate-limiting and URL reconstruction).
app.set('trust proxy', 1);

// [M3] Rate Limit — Basic DoS protection for publicly exposed endpoints (300/min per IP).
const limiter = rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false });

app.get('/health', (_req, res) => {
  res.send('ok');
});

// ── MRE Mock Implementations ──────────────────────────────────────────────────
// In a real production system, you would verify the Twilio signature here using the Twilio SDK.
function validateTwilioSignature(req: express.Request): boolean {
  if (!env.TWILIO_AUTH_TOKEN) return true; // Skip if token is not set
  log.debug('MRE: Bypassing real Twilio signature validation for standalone run');
  return true;
}

// In a real system, you verify the OpenAI Webhook signature using crypto.createHmac.
function verifyWebhook(rawBody: string, headers: any, secret: string): boolean {
  log.debug('MRE: Bypassing real OpenAI Webhook signature validation for standalone run');
  return true;
}

// In a real system, you query the database to find the tenant's AI configuration based on the dialed number.
async function resolveTenantByNumber(toNumber: string): Promise<VoiceConfig | null> {
  return {
    tenantId: 'mre-tenant',
    model: env.OPENAI_REALTIME_MODEL,
    voice: 'alloy',
    instructions: 'You are a helpful AI receptionist. Ask the user how you can help them today. Be concise and polite.'
  };
}

// Basic phone sanitization (Replacing domain/phone.ts)
function parseE164(phone: string | null): string {
  if (!phone) return 'Unknown';
  return phone.replace(/[^+\d]/g, '');
}

// ── Twilio Voice Webhook (Tenant Number) ──────────────────────────────────────
// Routes inbound PSTN calls to the OpenAI SIP endpoint. Audio flows directly from Twilio to OpenAI.
function voiceTwiml(req: express.Request, res: express.Response) {
  if (req.method === 'POST') {
    if (!validateTwilioSignature(req)) {
      log.warn('Twilio signature validation failed -> rejected /voice');
      res.status(403).send('forbidden');
      return;
    }
  }

  // Twilio `To` = Our (tenant's) phone number.
  // After <Dial><Sip>, the SIP To changes to the OpenAI URI, meaning the tenant number is lost.
  // Therefore, we pass it via a custom SIP header X-Tenant-Number (the bridge uses this to resolve the tenant).
  const called = String((req.body?.To as string) ?? (req.query?.To as string) ?? '');
  const caller = String((req.body?.From as string) ?? (req.query?.From as string) ?? '');
  
  res.type('text/xml').send(
    buildDialSip({
      projectId: env.OPENAI_PROJECT_ID,
      toNumber: called || undefined,
      callerNumber: caller || undefined,
    }),
  );
}
app.post('/voice', limiter, express.urlencoded({ extended: false }), voiceTwiml);
app.get('/voice', voiceTwiml);

// ── OpenAI Webhook ─────────────────────────────────────────────────────────────
// Receives realtime.call.incoming -> verifies signature -> resolves tenant -> accepts + monitors.
app.post('/openai/webhook', limiter, express.raw({ type: '*/*' }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  if (!verifyWebhook(raw, req.headers, env.OPENAI_WEBHOOK_SECRET)) {
    log.warn('Webhook signature validation failed');
    res.status(400).send('bad signature');
    return;
  }

  let evt: { type?: string; data?: { call_id?: string; sip_headers?: SipHeader[] } };
  try {
    evt = JSON.parse(raw);
  } catch {
    res.status(400).send('bad json');
    return;
  }

  log.info(`Received webhook: ${evt.type}`);
  if (evt.type !== 'realtime.call.incoming' || !evt.data?.call_id) {
    res.status(200).send('ignored (test/non-call event)');
    return;
  }

  const callId = evt.data.call_id;
  // The called tenant number is in the custom header X-Tenant-Number, injected in /voice (since To is OpenAI URI).
  const calledRaw = headerValue(evt.data.sip_headers, 'X-Tenant-Number');
  const toNumber = parseE164(calledRaw);
  // Caller ID — used as the lead's phone number (so the AI doesn't dictate/invent it).
  const callerNumber = parseE164(headerValue(evt.data.sip_headers, 'X-Caller-Number'));
  
  log.info(`Called(tenant)='${toNumber}' Caller='${callerNumber}'`);

  res.status(200).send('ok'); // Webhooks require an immediate 200 response; processing is async.
  
  try {
    const config = await resolveTenantByNumber(toNumber);
    if (!config) {
      // Unmatched/Inactive tenant -> Reject. Do not answer with generic AI.
      await rejectCall(callId);
      return;
    }
    const meta = { callerNumber, toNumber };
    await acceptCall(callId, config, meta);
    monitorCall(callId, config, meta);
  } catch (e) {
    log.error('Failed to process call', e);
  }
});

app.listen(env.PORT, () => {
  log.info(`voice-bridge :${env.PORT} (SIP connector mode, project=${env.OPENAI_PROJECT_ID})`);
  void startDevTunnel();
});

// ── Helpers ─────────────────────────────────────────────────────────────────
interface SipHeader {
  name: string;
  value: string;
}
function headerValue(headers: SipHeader[] | undefined, name: string): string | null {
  return headers?.find((h) => h.name === name)?.value ?? null;
}
