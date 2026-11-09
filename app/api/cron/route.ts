import { NextResponse } from 'next/server';
import { query, updateSettings } from '@/lib/db';
import { makeOutboundCall } from '@/lib/vobiz';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return handleCron(req);
}

export async function POST(req: Request) {
  return handleCron(req);
}

async function handleCron(req: Request) {
  try {
    const now = new Date();
    await updateSettings({ last_cron_ping_at: now.toISOString() });

    // Fetch active schedules that are due
    const res = await query(
      `SELECT * FROM schedules
       WHERE status = 'active'
       AND (next_run_at IS NULL OR next_run_at <= $1)`,
      [now.toISOString()]
    );

    const dueSchedules = res.rows;
    const triggered: any[] = [];

    for (const schedule of dueSchedules) {
      try {
        const isRetry = schedule.name?.startsWith('Auto-Retry:');
        let retryDelayMinutes = 0;
        let maxRetries = 1;
        let currentAttempt = 1;

        if (isRetry) {
          const match = schedule.name.match(/\((\d+)\/(\d+)\s+in\s+(\d+)m\)/);
          if (match) {
            currentAttempt = parseInt(match[1], 10);
            maxRetries = parseInt(match[2], 10);
            retryDelayMinutes = parseInt(match[3], 10);
          }
        }

        const callRes = await makeOutboundCall({
          to: schedule.to_number,
          audioId: schedule.audio_id,
          playMode: schedule.play_mode,
          ttsMessage: schedule.tts_message,
          loopCount: schedule.loop_count,
          scheduleId: schedule.id,
          scheduleName: schedule.name,
          retryDelayMinutes,
          maxRetries,
          currentAttempt,
        });

        // Compute next run time for recurring schedules
        let nextRunAt: string | null = null;
        let nextStatus = schedule.status;

        if (schedule.schedule_type === 'interval' && schedule.interval_value) {
          const nextTime = new Date();
          if (schedule.interval_unit === 'minutes') {
            nextTime.setMinutes(nextTime.getMinutes() + schedule.interval_value);
          } else if (schedule.interval_unit === 'hours') {
            nextTime.setHours(nextTime.getHours() + schedule.interval_value);
          }
          nextRunAt = nextTime.toISOString();
        } else if (schedule.schedule_type === 'once') {
          nextStatus = 'completed';
        }

        await query(
          `UPDATE schedules
           SET total_runs = total_runs + 1, last_run_at = $1, next_run_at = $2, status = $3
           WHERE id = $4`,
          [now.toISOString(), nextRunAt, nextStatus, schedule.id]
        );

        triggered.push({ id: schedule.id, name: schedule.name, recipients: callRes.recipients });
      } catch (err: any) {
        console.error(`Failed to trigger due schedule ${schedule.id}:`, err);
      }
    }

    return NextResponse.json({
      success: true,
      timestamp: now.toISOString(),
      due_count: dueSchedules.length,
      triggered,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

