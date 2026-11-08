import { NextResponse } from 'next/server';
import { executeExtensiveDeduplication } from '@/lib/dedup';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    let body: any = {};
    const contentType = req.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      body = await req.json().catch(() => ({}));
    }

    const mergeByName = Boolean(body.merge_by_name);
    const result = await executeExtensiveDeduplication({ mergeByName });

    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch (err: any) {
    console.error('Deduplication error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
