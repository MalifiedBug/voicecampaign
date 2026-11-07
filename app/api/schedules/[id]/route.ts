import { NextResponse } from 'next/server';
import { deleteSchedule, query } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  try {
    await deleteSchedule(params.id);
    return NextResponse.json({ success: true, id: params.id });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  try {
    const body = await req.json();
    if (body.status) {
      await query('UPDATE schedules SET status = $1 WHERE id = $2', [body.status, params.id]);
      return NextResponse.json({ success: true, status: body.status });
    }
    return NextResponse.json({ error: 'No valid update field' }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
