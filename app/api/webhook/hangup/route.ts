import { NextResponse } from 'next/server';
import { query } from '@/lib/db';

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
          `Call terminated with ${hangupCause} (${duration}s)`,
          String(callUuid).slice(0, 100),
        ]
      );
    }

    return NextResponse.json({
      success: true,
      processed_uuid: callUuid,
      status: finalStatus,
      duration,
    });
  } catch (err: any) {
    console.error('Hangup webhook error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
