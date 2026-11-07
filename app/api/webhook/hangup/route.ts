import { NextResponse } from 'next/server';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const contentType = req.headers.get('content-type') || '';
    let payload: Record<string, any> = {};

    if (contentType.includes('application/json')) {
      payload = await req.json().catch(() => ({}));
    } else {
      const text = await req.text();
      const params = new URLSearchParams(text);
      params.forEach((val, key) => {
        payload[key] = val;
      });
    }

    const callUuid = payload.CallUUID || payload.call_uuid || payload.RequestUUID || payload.request_uuid;
    const duration = parseInt(payload.Duration || payload.duration || payload.BillDuration || '0', 10);
    const hangupCause = payload.HangupCause || payload.hangup_cause || payload.Reason || 'Normal Clearing';
    const status = (payload.CallStatus || payload.status || 'completed').toLowerCase();

    if (callUuid) {
      await query(
        `UPDATE call_logs
         SET status = $1, duration = $2, hangup_cause = $3, ended_at = $4
         WHERE call_uuid = $5 OR vobiz_api_id = $5`,
        [status, duration, hangupCause, new Date().toISOString(), callUuid]
      );
    }

    return NextResponse.json({ success: true, processed_uuid: callUuid });
  } catch (err: any) {
    console.error('Hangup webhook error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

