import { NextResponse } from 'next/server';
import { query, addSchedule } from '@/lib/db';
import { v4 as uuidv4 } from 'uuid';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return handleHangup(req);
}

export async function POST(req: Request) {
  return handleHangup(req);
}

async function handleHangup(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const contentType = req.headers.get('content-type') || '';
    let payload: Record<string, any> = {};

    if (contentType.includes('application/json')) {
      payload = await req.json().catch(() => ({}));
    } else {
      const text = await req.text().catch(() => '');
      if (text) {
        const params = new URLSearchParams(text);
        params.forEach((val, key) => {
          payload[key] = val;
        });
      }
    }

    const callUuid =
      payload.CallUUID ||
      payload.call_uuid ||
      payload.RequestUUID ||
      payload.request_uuid ||
      searchParams.get('CallUUID') ||
      searchParams.get('call_uuid') ||
      searchParams.get('RequestUUID') ||
      searchParams.get('request_uuid');

    const duration = parseInt(
      payload.Duration || payload.duration || payload.BillDuration || searchParams.get('Duration') || '0',
      10
    );

    const hangupCause =
      payload.HangupCause ||
      payload.hangup_cause ||
      payload.Reason ||
      searchParams.get('HangupCause') ||
      'NORMAL_CLEARING';

    const rawStatus = (
      payload.CallStatus ||
      payload.status ||
      searchParams.get('CallStatus') ||
      'completed'
    ).toLowerCase();

    // Map telecom carrier hangup causes to clean application statuses
    let finalStatus = 'completed';
    const causeUpper = hangupCause.toUpperCase();
    if (causeUpper.includes('BUSY') || causeUpper.includes('REJECTED')) {
      finalStatus = 'busy';
    } else if (
      causeUpper.includes('NO_ANSWER') ||
      causeUpper.includes('NO ANSWER') ||
      causeUpper.includes('CANCEL')
    ) {
      finalStatus = 'no-answer';
    } else if (
      causeUpper.includes('FAIL') ||
      causeUpper.includes('ERROR') ||
      causeUpper.includes('UNALLOCATED') ||
      rawStatus === 'failed'
    ) {
      finalStatus = 'failed';
    }

    // Retrieve corresponding call log record
    let callLog: any = null;
    if (callUuid) {
      const logRes = await query(
        `SELECT * FROM call_logs WHERE call_uuid = $1 OR vobiz_api_id = $1 LIMIT 1`,
        [String(callUuid).slice(0, 100)]
      );
      if (logRes.rows.length > 0) callLog = logRes.rows[0];
    }

    const toNumber = callLog?.to_number || payload.To || payload.to || searchParams.get('To') || '';
    let retryNote = '';

    // Handle Completed Call: Cancel any pending retry campaigns for this recipient
    if (finalStatus === 'completed' && duration > 0 && toNumber) {
      await query(
        `UPDATE schedules
         SET status = 'cancelled'
         WHERE to_number = $1
           AND name LIKE 'Auto-Retry%'
           AND status = 'active'`,
        [toNumber]
      ).catch((err) => console.warn('Could not cancel pending retries:', err));
    }

    // Handle Unanswered/Cancelled/Busy Call: Auto-Redial after configured delay
    const retryDelayMinutes = parseInt(searchParams.get('retry_delay') || '0', 10);
    const maxRetries = parseInt(searchParams.get('max_retries') || '1', 10);
    const currentAttempt = parseInt(searchParams.get('attempt') || '0', 10);

    const isUnanswered =
      finalStatus === 'no-answer' ||
      finalStatus === 'busy' ||
      finalStatus === 'failed' ||
      duration === 0;

    if (isUnanswered && retryDelayMinutes > 0 && toNumber) {
      if (currentAttempt < maxRetries) {
        // Anti-spam check: Verify no active duplicate retry is already queued
        const existingRetry = await query(
          `SELECT id FROM schedules
           WHERE to_number = $1
             AND name LIKE 'Auto-Retry%'
             AND status = 'active'
           LIMIT 1`,
          [toNumber]
        );

        if (existingRetry.rows.length === 0) {
          const nextAttempt = currentAttempt + 1;
          const retryScheduleId = uuidv4();
          const nextRunDate = new Date(Date.now() + retryDelayMinutes * 60 * 1000);
          const nextRunAt = nextRunDate.toISOString();

          const audioId = searchParams.get('audio_id') || callLog?.audio_id || null;
          const playMode = searchParams.get('play_mode') || 'audio';
          const loopCount = parseInt(searchParams.get('loop') || '1', 10);
          const ttsMessage = searchParams.get('tts_message') || '';
          const scheduleName = `Auto-Retry: ${toNumber} (${nextAttempt}/${maxRetries} in ${retryDelayMinutes}m)`;

          await addSchedule({
            id: retryScheduleId,
            name: scheduleName,
            to_number: toNumber,
            schedule_type: 'once',
            scheduled_datetime: nextRunAt,
            next_run_at: nextRunAt,
            status: 'active',
            audio_id: audioId,
            play_mode: playMode,
            tts_message: ttsMessage || null,
            loop_count: loopCount,
          });

          const istTime = nextRunDate.toLocaleTimeString('en-IN', {
            timeZone: 'Asia/Kolkata',
            hour: '2-digit',
            minute: '2-digit',
          });

          retryNote = ` | 🔄 Auto-redial scheduled in ${retryDelayMinutes}m (at ${istTime} IST, attempt ${nextAttempt}/${maxRetries})`;
        }
      } else {
        retryNote = ` | 🛑 Max auto-redial attempts reached (${maxRetries}/${maxRetries})`;
      }
    }

    if (callUuid) {
      await query(
        `UPDATE call_logs
         SET status = $1,
             duration = $2,
             hangup_cause = $3,
             ended_at = $4,
             notes = COALESCE(notes || ' | ', '') || $5
         WHERE call_uuid = $6 OR vobiz_api_id = $6`,
        [
          finalStatus,
          duration,
          hangupCause,
          new Date().toISOString(),
          `Call terminated with ${hangupCause} (${duration}s)${retryNote}`,
          String(callUuid).slice(0, 100),
        ]
      );
    }

    return NextResponse.json({
      success: true,
      processed_uuid: callUuid,
      status: finalStatus,
      duration,
      auto_retry_scheduled: Boolean(retryNote && !retryNote.includes('Max')),
    });
  } catch (err: any) {
    console.error('Hangup webhook error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
