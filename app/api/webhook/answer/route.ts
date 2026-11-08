import { NextResponse } from 'next/server';
import { query, getSettings, getAudioAsset, getAudioAssets } from '@/lib/db';
import { buildAnswerXml } from '@/lib/vobiz';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return handleAnswer(req);
}

export async function POST(req: Request) {
  return handleAnswer(req);
}

async function handleAnswer(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const contentType = req.headers.get('content-type') || '';
    let formPayload: Record<string, any> = {};

    if (contentType.includes('application/json')) {
      formPayload = await req.json().catch(() => ({}));
    } else if (
      contentType.includes('application/x-www-form-urlencoded') ||
      contentType.includes('multipart/form-data')
    ) {
      const text = await req.text().catch(() => '');
      if (text) {
        const p = new URLSearchParams(text);
        p.forEach((val, key) => {
          formPayload[key] = val;
        });
      }
    }

    const callUuid =
      formPayload.CallUUID ||
      formPayload.call_uuid ||
      formPayload.RequestUUID ||
      formPayload.request_uuid ||
      searchParams.get('CallUUID') ||
      searchParams.get('call_uuid') ||
      searchParams.get('RequestUUID') ||
      searchParams.get('request_uuid');

    // Lifecycle state update: Transition call from queued/ringing to in-progress when answered
    if (callUuid) {
      await query(
        `UPDATE call_logs
         SET status = 'in-progress',
             answered_at = NOW(),
             notes = COALESCE(notes || ' | ', '') || 'Call answered by recipient. Audio prompt streaming.'
         WHERE (call_uuid = $1 OR vobiz_api_id = $1)
           AND answered_at IS NULL`,
        [String(callUuid).slice(0, 100)]
      ).catch((err) => console.warn('Could not update call_logs on answer:', err));
    }

    const scheduleId = searchParams.get('schedule_id');
    const audioIdParam = searchParams.get('audio_id');
    const playModeParam = searchParams.get('play_mode');
    const ttsMsgParam = searchParams.get('tts_message');
    const loopParam = parseInt(searchParams.get('loop') || '1', 10);

    const settings = await getSettings();
    const baseUrl = (
      settings.webhook_base_url ||
      process.env.WEBHOOK_BASE_URL ||
      'https://voicecampaign.vercel.app'
    ).replace(/\/$/, '');

    // Resolve schedule parameters if scheduleId is given
    let schedule: any = null;
    if (scheduleId) {
      const schedRes = await query(`SELECT * FROM schedules WHERE id = $1 LIMIT 1`, [scheduleId]);
      if (schedRes.rows.length > 0) schedule = schedRes.rows[0];
    }

    const effectivePlayMode = playModeParam || (schedule ? schedule.play_mode : 'audio');
    const effectiveTtsMessage = ttsMsgParam || (schedule ? schedule.tts_message : '');
    const effectiveAudioId =
      audioIdParam || (schedule ? schedule.audio_id : '') || settings.default_audio_id;
    const effectiveLoop = Math.max(1, Math.min(loopParam || (schedule ? schedule.loop_count : 1) || 1, 10));

    let xml = '';

    // TTS Mode
    if (effectivePlayMode === 'tts' && effectiveTtsMessage && effectiveTtsMessage.trim()) {
      xml = buildAnswerXml({
        ttsMessage: effectiveTtsMessage,
        ttsVoice: settings.tts_default_voice || 'WOMAN',
        ttsLang: settings.tts_default_language || 'en-IN',
        loop: effectiveLoop,
      });
    } else {
      // Audio Prompt Mode
      let asset: any = null;
      if (effectiveAudioId) {
        asset = await getAudioAsset(effectiveAudioId);
      }
      if (!asset) {
        const allAssets = await getAudioAssets();
        if (allAssets.length > 0) asset = allAssets[0];
      }

      if (asset) {
        if (asset.source_type === 'tts' && asset.tts_text) {
          xml = buildAnswerXml({
            ttsMessage: asset.tts_text,
            ttsVoice: asset.tts_voice || 'WOMAN',
            ttsLang: 'en-IN',
            loop: effectiveLoop,
          });
        } else {
          // Serve canonical streamed audio URL with proper extension and HTTP Range support
          // If the mime type is audio/wav or filename ends with .wav, route to .wav
          const isWav = asset.mime_type === 'audio/wav' || asset.filename?.toLowerCase().endsWith('.wav');
          const ext = isWav ? 'wav' : 'mp3';
          const audioUrl = `${baseUrl}/audio/${asset.id}.${ext}`;

          xml = buildAnswerXml({
            audioUrl,
            loop: effectiveLoop,
          });
        }
      } else {
        xml = buildAnswerXml({
          ttsMessage:
            effectiveTtsMessage ||
            'Hello, this is Voice Campaign. Your automated message has finished. Goodbye.',
          loop: 1,
        });
      }
    }

    return new NextResponse(xml, {
      status: 200,
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      },
    });
  } catch (err: any) {
    console.error('Answer webhook error:', err);
    const fallbackXml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Speak voice="WOMAN" language="en-IN">An unexpected error occurred during audio delivery. Goodbye.</Speak>
    <Hangup/>
</Response>`;
    return new NextResponse(fallbackXml, {
      status: 200,
      headers: { 'Content-Type': 'application/xml; charset=utf-8' },
    });
  }
}
