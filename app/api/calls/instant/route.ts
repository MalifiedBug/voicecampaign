import { NextResponse } from 'next/server';
import { makeOutboundCall } from '@/lib/vobiz';
import { getSettings } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const to = body.to || body.to_number;
    if (!to) {
      return NextResponse.json({ error: 'Destination number(s) required' }, { status: 400 });
    }

    const settings = await getSettings();
    const audioId = body.audio_id || settings.default_audio_id;
    const playMode = body.play_mode || 'audio';
    const ttsMessage = body.tts_message || '';
    const loopCount = parseInt(body.loop_count || '1', 10);
    const scheduleName = body.schedule_name || 'Instant Call';
    const retryDelayMinutes = parseInt(body.retry_delay_minutes ?? '10', 10);
    const maxRetries = parseInt(body.max_retries ?? '1', 10);

    const result = await makeOutboundCall({
      to,
      audioId,
      playMode,
      ttsMessage,
      loopCount,
      scheduleName,
      retryDelayMinutes,
      maxRetries,
      currentAttempt: 0,
    });

    return NextResponse.json({
      ...result,
      message: `Call dispatched to ${result.recipients.length} recipient(s)!`,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
