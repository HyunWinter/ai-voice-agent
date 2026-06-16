// Twilio <Dial><Sip> TwiML generation — Pure function. Includes XML escaping.
// Without escaping, the '&' in the SIP URI breaks the TwiML XML and Twilio will disconnect with an "application error".

const xmlEscape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface DialSipParams {
  projectId: string; // OpenAI project ID (SIP user part)
  toNumber?: string; // Called (tenant) number -> Custom SIP header X-Tenant-Number
  callerNumber?: string; // Caller ID -> Custom SIP header X-Caller-Number
}

// TwiML to Dial an inbound PSTN call to the OpenAI SIP endpoint.
// After <Dial><Sip>, the SIP To changes to the OpenAI URI, meaning the tenant and caller numbers are lost.
// Therefore, we pass them via custom SIP headers (X-Tenant-Number / X-Caller-Number). (The bridge webhook parses these)
export function buildDialSip({ projectId, toNumber, callerNumber }: DialSipParams): string {
  const params: string[] = [];
  if (toNumber) params.push(`X-Tenant-Number=${encodeURIComponent(toNumber)}`);
  if (callerNumber) params.push(`X-Caller-Number=${encodeURIComponent(callerNumber)}`);
  const hdr = params.length ? `?${params.join('&')}` : '';
  const sip = `sip:${projectId}@sip.api.openai.com;transport=tls${hdr}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial>
    <Sip>${xmlEscape(sip)}</Sip>
  </Dial>
</Response>`;
}
