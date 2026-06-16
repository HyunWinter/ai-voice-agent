# AI Voice Agent — Twilio × OpenAI Realtime SIP Bridge

Bridges inbound phone calls to the OpenAI Realtime API via Twilio SIP. You call a number, an AI picks up and talks to you. This server never touches audio. It only manages the control plane (accepting calls, configuring the AI session, handling tool calls, silence detection).

Extracted from one of my larger side project. Multi-tenant routing, CMS integration, and signature verification have been stripped out to keep this focused on the core integration.

## How it works

1. Caller dials a Twilio number
2. Twilio hits `/voice` → we return TwiML that dials OpenAI's SIP endpoint directly (audio bypasses us entirely)
3. OpenAI fires a webhook to `/openai/webhook` → we accept the call, inject AI config + tools
4. We open a monitoring WebSocket (control only) to trigger the greeting and handle tool calls (`capture_lead`, `end_call`)

## Interesting bits

- **VAD tuning** — Default threshold picks up line noise as speech, causing the AI to talk over itself. Raised threshold `0.5→0.6`, extended silence duration `200→600ms`.
- **Silence detection** — The API has no "user went silent" event, so I built a state machine on top of `response.done` / `response.created` / `speech_started` to detect it. 15s silence → reprompt, another 15s → hangup.
- **Caller ID injection** — Phone numbers are injected from SIP headers into the AI's instructions so it never asks the user to read out digits (it hallucinates them).
- **SIP header forwarding** — `<Dial><Sip>` overwrites the To field, so tenant/caller numbers are passed as custom headers (`X-Tenant-Number`, `X-Caller-Number`).

## Setup

Requires Node 18+, a Twilio number, OpenAI API key (Realtime access), and ngrok (free).

```bash
npm install
cp .env.example .env   # see comments inside for each key
npm run dev             # auto-provisions ngrok tunnel
```

Point Twilio voice webhook → `https://<ngrok>/voice`, OpenAI webhook → `https://<ngrok>/openai/webhook` (subscribe to `realtime.call.incoming`).

## Files

- `src/index.ts` — Express server, webhook handlers
- `src/openai-call.ts` — Call lifecycle, silence detection, tool handling
- `src/twilio/twiml.ts` — TwiML builder with SIP header injection
- `src/config.ts` — Env vars
- `src/dev-tunnel.ts` — ngrok auto-setup
- `src/log.ts` — Logger

## License

MIT
