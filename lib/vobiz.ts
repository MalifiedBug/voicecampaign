import { getSettings, getAudioAsset, addCallLog, bulkAddCallLogs } from './db';
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

  const answerUrl = `${baseUrl}/api/webhook/answer?schedule_id=${encodeURIComponent(params.scheduleId || '')}&audio_id=${encodeURIComponent(params.audioId || '')}&play_mode=${encodeURIComponent(params.playMode || 'audio')}&loop=${params.loopCount || 1}${params.ttsMessage ? `&tts_message=${encodeURIComponent(params.ttsMessage)}` : ''}`;
  const hangupUrl = `${baseUrl}/api/webhook/hangup`;

  const vobizEndpoint = `https://api.vobiz.ai/api/v1/Account/${authId}/Call/`;
  const basicAuth = Buffer.from(`${authId}:${authToken}`).toString('base64');

  const allRecipients = formattedTo.split('<').map((s) => s.trim()).filter(Boolean);
  if (allRecipients.length === 0) {
    throw new Error('No valid destination phone numbers provided.');
  }

  // Vobiz allows max 1000 destinations per POST request.
  // We chunk in blocks of 500 for optimal telecom gateway reliability.
  const BATCH_SIZE = 500;
  const batches: string[][] = [];
  for (let i = 0; i < allRecipients.length; i += BATCH_SIZE) {
    batches.push(allRecipients.slice(i, i + BATCH_SIZE));
  }

  let primaryCallUuid = '';
  let lastData: any = {};
  let globalRecipientIndex = 0;

  for (let bIdx = 0; bIdx < batches.length; bIdx++) {
    const batchRecipients = batches[bIdx];
    const batchTo = batchRecipients.join('<');

    const payload: Record<string, any> = {
      from: callerId,
      to: batchTo,
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
      throw new Error(`Batch ${bIdx + 1} (${batchRecipients.length} recipients) failed: ${errorMsg}`);
    }

    lastData = data;

    // Parse UUIDs returned by Vobiz
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

    if (!primaryCallUuid) {
      primaryCallUuid = uuids[0] || (typeof data.request_uuid === 'string' ? data.request_uuid : uuidv4());
    }

    // Create clean individual CDR records for each recipient in fast bulk batches
    const batchLogs: any[] = [];
    for (let i = 0; i < batchRecipients.length; i++) {
      globalRecipientIndex++;
      const singleTo = batchRecipients[i];
      const singleUuid =
        uuids[i] ||
        (uuids.length === 1 && batchRecipients.length === 1
          ? uuids[0]
          : `${uuids[0] || 'bulk'}_${globalRecipientIndex}`);

      batchLogs.push({
        id: uuidv4(),
        schedule_id: params.scheduleId,
        schedule_name:
          params.scheduleName ||
          (allRecipients.length > 1
            ? `Bulk Call (${globalRecipientIndex}/${allRecipients.length})`
            : 'Instant Call'),
        to_number: singleTo,
        from_number: callerId,
        audio_id: params.audioId,
        call_uuid: String(singleUuid).slice(0, 100),
        vobiz_api_id: data.api_id ? String(data.api_id).slice(0, 100) : undefined,
        status: 'ringing',
        notes: `Dispatched and queued on carrier trunk (recipient ${globalRecipientIndex} of ${allRecipients.length}, batch ${bIdx + 1}/${batches.length}). ApiId: ${data.api_id || ''}`,
      });
    }

    await bulkAddCallLogs(batchLogs);
  }

  return {
    success: true,
    data: lastData,
    callUuid: primaryCallUuid || uuidv4(),
    recipients: allRecipients,
    totalBatches: batches.length,
    message: `Dispatched to ${allRecipients.length} recipient(s) across ${batches.length} batch(es)!`,
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
    <Wait length="1"/>
    <Hangup/>
</Response>`;
  }

  if (audioUrl) {
    const cleanUrl = audioUrl.replace(/&/g, '&amp;');
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Play loop="${loop}">${cleanUrl}</Play>
    <Wait length="1"/>
    <Hangup/>
</Response>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Speak voice="WOMAN" language="en-IN">Hello, this is Voice Campaign. No audio prompt was configured. Goodbye.</Speak>
    <Wait length="1"/>
    <Hangup/>
</Response>`;
}

