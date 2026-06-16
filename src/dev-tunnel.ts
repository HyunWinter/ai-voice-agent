import ngrok from '@ngrok/ngrok';
import { env } from './config.js';
import { log } from './log.js';

// Public tunnel for development. Only runs when NGROK_AUTHTOKEN is present (skipped in production).
// No separate installation or PATH required — ngrok binary is included in npm dependencies.
export async function startDevTunnel(): Promise<void> {
  if (!env.NGROK_AUTHTOKEN) {
    log.info('No NGROK_AUTHTOKEN found -> Skipping tunnel (manual/production mode)');
    return;
  }
  try {
    const listener = await ngrok.forward({
      addr: env.PORT,
      authtoken: env.NGROK_AUTHTOKEN,
      ...(env.NGROK_DOMAIN ? { domain: env.NGROK_DOMAIN } : {}),
    });
    const url = listener.url() ?? '(unknown)';
    log.info(`🌐 Public Tunnel: ${url}`);
    log.info(`   -> OpenAI Webhook URL = ${url}/openai/webhook`);
    log.info(`   -> Twilio Voice URL = ${url}/voice`);
  } catch (e) {
    log.error('Failed to start ngrok tunnel (Check NGROK_AUTHTOKEN)', e);
  }
}
