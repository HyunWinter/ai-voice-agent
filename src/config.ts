import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable: ${name} (Check .env)`);
  return v;
}

export const env = {
  PORT: Number(process.env.PORT ?? 5050),
  OPENAI_API_KEY: required('OPENAI_API_KEY'),
  // Target project ID for SIP URI (proj_...). Twilio trunk routes to sip:<id>@sip.api.openai.com.
  OPENAI_PROJECT_ID: required('OPENAI_PROJECT_ID'),
  // Secret for verifying OpenAI Webhook signatures (whsec_...). platform.openai.com > Project > Webhooks.
  OPENAI_WEBHOOK_SECRET: required('OPENAI_WEBHOOK_SECRET'),
  // Model ID
  OPENAI_REALTIME_MODEL: process.env.OPENAI_REALTIME_MODEL ?? 'gpt-realtime-mini',
  // (Development) If set, `npm run dev` automatically spins up an ngrok tunnel. Skipped in production.
  NGROK_AUTHTOKEN: process.env.NGROK_AUTHTOKEN,
  NGROK_DOMAIN: process.env.NGROK_DOMAIN, // (Optional) Static domain
  // (Optional) For verifying Twilio request signatures. If set, /voice validates X-Twilio-Signature.
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
};
