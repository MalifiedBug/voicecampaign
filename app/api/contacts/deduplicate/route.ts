import { NextResponse } from 'next/server';
import { deduplicateContacts } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    const result = await deduplicateContacts();
    return NextResponse.json({
      success: true,
      ...result,
      message: `Removed ${result.duplicates_removed} duplicate contact(s). ${result.final_count} unique records preserved.`,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

