import { NextResponse } from 'next/server';
import { getSchedules, addSchedule, getSettings } from '@/lib/db';
import { v4 as uuidv4 } from 'uuid';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const schedules = await getSchedules();
    return NextResponse.json(schedules);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const settings = await getSettings();

    const id = uuidv4();
    const name = body.name || `Campaign ${new Date().toLocaleDateString()}`;
    const toNumber = body.to_number || body.to;
    if (!toNumber) {
      return NextResponse.json({ error: 'Destination number(s) required' }, { status: 400 });
    }

    const scheduleType = body.schedule_type || 'once';
    const audioId = body.audio_id || settings.default_audio_id;
    const playMode = body.play_mode || 'audio';
    const ttsMessage = body.tts_message || '';
    const loopCount = parseInt(body.loop_count || '1', 10);
    const scheduledDatetime = body.scheduled_datetime || null;
    const intervalValue = body.interval_value ? parseInt(body.interval_value, 10) : null;
    const intervalUnit = body.interval_unit || 'minutes';

    let nextRunAt = scheduledDatetime;
    if (scheduleType === 'interval' && intervalValue) {
      const now = new Date();
      if (intervalUnit === 'minutes') {
        now.setMinutes(now.getMinutes() + intervalValue);
      } else if (intervalUnit === 'hours') {
        now.setHours(now.getHours() + intervalValue);
      }
      nextRunAt = now.toISOString();
    }

    await addSchedule({
      id,
      name,
      to_number: toNumber,
      schedule_type: scheduleType,
      scheduled_datetime: scheduledDatetime,
      interval_value: intervalValue,
      interval_unit: intervalUnit,
      audio_id: audioId,
      play_mode: playMode,
      tts_message: ttsMessage,
      loop_count: loopCount,
      status: 'active',
      next_run_at: nextRunAt,
    });

    return NextResponse.json({
      success: true,
      id,
      message: `Schedule '${name}' created successfully!`,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

