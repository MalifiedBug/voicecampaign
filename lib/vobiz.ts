import { getSettings, getAudioAsset, addCallLog } from './db';
import { v4 as uuidv4 } from 'uuid';

export function formatVobizRecipients(input: string | string[]): string {
  let rawList: string[] = [];

  if (Array.isArray(input)) {
    rawList = input;
  } else if (typeof input === 'string') {
    rawList = input
      .split(/[<,;\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  const cleaned = rawList
    .map((num) => {
      let n = num.replace(/[\s\-\(\)]/g, '');
      if (!n.startsWith('+')) {
        if (/^\d{10}$/.test(n)) {
          n = `+91${n}`;
        } else if (/^91\d{10}$/.test(n)) {
          n = `+${n}`;
        }
      }
      return n;
    })
    .filter((n) => /^\+\d{7,15}$/.test(n));

  // Deduplicate recipients while preserving order
  const unique = Array.from(new Set(cleaned));
  return unique.join('<');
}

export async function makeOutboundCall(params: {
  to: string;
  audioId?: string;
  playMode?: string;
  ttsMessage?: string;
  loopCount?: number;
  scheduleId?: string;
  scheduleName?: string;
}) {
  const settings = await getSettings();
  const authId = settings.auth_id || process.env.VOBIZ_AUTH_ID;
  const authToken = settings.auth_token || process.env.VOBIZ_AUTH_TOKEN;
  const callerId = settings.caller_id || process.env.VOBIZ_CALLER_ID;
  const baseUrl = (settings.webhook_base_url || process.env.WEBHOOK_BASE_URL || 'https://voicecampaign.vercel.app').replace(/\/$/, '');

  if (!authId || !authToken) {
    throw new Error('Vobiz credentials not configured. Please set VOBIZ_AUTH_ID and VOBIZ_AUTH_TOKEN.');
  }

  if (!callerId) {
    throw new Error('Outbound Caller ID not configured.');
  }

  const formattedTo = formatVobizRecipients(params.to);
  if (!formattedTo) {
    throw new Error('No valid destination phone numbers provided.');
  }

  const answerUrl = `${baseUrl}/api/webhook/answer?schedule_id=${encodeURIComponent(params.scheduleId || '')}&audio_id=${encodeURIComponent(params.audioId || '')}&loop=${params.loopCount || 1}`;
  const hangupUrl = `${baseUrl}/api/webhook/hangup`;

  const vobizEndpoint = `https://api.vobiz.ai/api/v1/Account/${authId}/Call/`;
  const basicAuth = Buffer.from(`${authId}:${authToken}`).toString('base64');

  const payload: Record<string, any> = {
    from: callerId,
    to: formattedTo,
    answer_url: answerUrl,
    answer_method: 'POST',
    hangup_url: hangupUrl,
    hangup_method: 'POST',
    ring_timeout: parseInt(settings.ring_timeout || '45', 10),
    time_limit: parseInt(settings.time_limit || '300', 10),
  };

  const response = await fetch(vobizEndpoint, {
    method: 'POST',
    headers: {
      'X-Auth-ID': authId,
      'X-Auth-Token': authToken,
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const errorMsg = data.message || data.error || `HTTP ${response.status} from Vobiz API`;
    throw new Error(errorMsg);
  }

  const recipients = formattedTo.split('<').map((s) => s.trim()).filter(Boolean);

  // Parse UUIDs returned by Vobiz (can be an array, delimited string, or single string)
  let uuids: string[] = [];
  if (Array.isArray(data.request_uuid)) {
    uuids = data.request_uuid.map(String);
  } else if (typeof data.request_uuid === 'string' && data.request_uuid.includes('<')) {
    uuids = data.request_uuid.split('<').map((s) => s.trim());
  } else if (typeof data.request_uuid === 'string' && data.request_uuid.includes(',')) {
    uuids = data.request_uuid.split(',').map((s) => s.trim());
  } else if (typeof data.request_uuid === 'string') {
    uuids = [data.request_uuid];
  }

  // Create clean individual CDR record for each recipient
  for (let i = 0; i < recipients.length; i++) {
    const singleTo = recipients[i];
    const singleUuid = uuids[i] || (uuids.length === 1 && recipients.length === 1 ? uuids[0] : `${uuids[0] || 'bulk'}_${i + 1}`);

    await addCallLog({
      id: uuidv4(),
      schedule_id: params.scheduleId,
      schedule_name: params.scheduleName || (recipients.length > 1 ? `Bulk Call (${i + 1}/${recipients.length})` : 'Instant Call'),
      to_number: singleTo,
      from_number: callerId,
      audio_id: params.audioId,
      call_uuid: String(singleUuid).slice(0, 100),
      vobiz_api_id: data.api_id ? String(data.api_id).slice(0, 100) : undefined,
      status: 'in-progress',
      notes: `Broadcast recipient ${i + 1} of ${recipients.length}. ApiId: ${data.api_id || ''}`,
    });
  }

  const primaryCallUuid = uuids[0] || (typeof data.request_uuid === 'string' ? data.request_uuid : uuidv4());

  return {
    success: true,
    data,
    callUuid: primaryCallUuid,
    recipients,
  };
}

export function buildAnswerXml(options: {
  audioUrl?: string;
  ttsMessage?: string;
  ttsVoice?: string;
  ttsLang?: string;
  loop?: number;
}): string {
  const { audioUrl, ttsMessage, ttsVoice = 'WOMAN', ttsLang = 'en-IN', loop = 1 } = options;

  if (ttsMessage && ttsMessage.trim()) {
    const cleanMsg = ttsMessage.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Speak voice="${ttsVoice}" language="${ttsLang}">${cleanMsg}</Speak>
    <Hangup/>
</Response>`;
  }

  if (audioUrl) {
    const cleanUrl = audioUrl.replace(/&/g, '&amp;');
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Play loop="${loop}">${cleanUrl}</Play>
    <Hangup/>
</Response>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Speak voice="WOMAN" language="en-IN">Hello, this is Voice Campaign. No audio was selected. Goodbye.</Speak>
    <Hangup/>
</Response>`;
}

