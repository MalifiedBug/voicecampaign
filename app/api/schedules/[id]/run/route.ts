import { NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { makeOutboundCall } from '@/lib/vobiz';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const res = await query('SELECT * FROM schedules WHERE id = $1', [params.id]);
    const schedule = res.rows[0];
    if (!schedule) {
      return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });
    }

    const callRes = await makeOutboundCall({
      to: schedule.to_number,
      audioId: schedule.audio_id,
      playMode: schedule.play_mode,
      ttsMessage: schedule.tts_message,
      loopCount: schedule.loop_count,
      scheduleId: schedule.id,
      scheduleName: schedule.name,
    });

    await query(
      `UPDATE schedules
       SET total_runs = total_runs + 1, last_run_at = $1
       WHERE id = $2`,
      [new Date().toISOString(), schedule.id]
    );

    return NextResponse.json({
      ...callRes,
      message: `Triggered campaign '${schedule.name}' for ${callRes.recipients.length} recipient(s)!`,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
