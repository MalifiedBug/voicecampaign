import { NextResponse } from 'next/server';
import { getSettings, query } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const settings = await getSettings();
    const schedCountRes = await query("SELECT count(*) as c FROM schedules WHERE status = 'active'");
    const activeSchedules = parseInt(schedCountRes.rows[0]?.c || '0', 10);

    return NextResponse.json({
      status: 'active',
      last_ping: settings.last_cron_ping_at || null,
      active_schedules: activeSchedules,
      webhook_url: `${(settings.webhook_base_url || 'https://voicecampaign.vercel.app').replace(/\/$/, '')}/api/cron`,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

