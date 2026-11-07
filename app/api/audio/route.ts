import { NextResponse } from 'next/server';
import { getAudioAssets, getSettings } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const assets = await getAudioAssets();
    const settings = await getSettings();
    return NextResponse.json(
      assets.map((a) => ({
        ...a,
        is_default: a.id === settings.default_audio_id,
      }))
    );
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

