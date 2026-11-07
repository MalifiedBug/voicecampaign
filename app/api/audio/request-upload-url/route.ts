import { NextResponse } from 'next/server';
import { createPresignedUploadUrl } from '@/lib/s3';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const filename = body.filename || `audio_${Date.now()}.wav`;
    const contentType = body.content_type || 'audio/wav';

    const presigned = await createPresignedUploadUrl(filename, contentType);
    return NextResponse.json(presigned);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
