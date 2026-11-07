import { NextResponse } from 'next/server';
import { getAudioAsset, deleteAudioAsset, updateSettings, getSettings } from '@/lib/db';
import { deleteS3Object } from '@/lib/s3';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: { id: string } }) {
  try {
    const asset = await getAudioAsset(params.id);
    if (!asset) {
      return NextResponse.json({ error: 'Audio asset not found' }, { status: 404 });
    }

    if (asset.external_url) {
      return NextResponse.redirect(asset.external_url);
    }

    return NextResponse.json(asset);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  try {
    const asset = await getAudioAsset(params.id);
    if (asset) {
      if (asset.s3_key) {
        await deleteS3Object(asset.s3_key);
      }
      await deleteAudioAsset(params.id);

      const settings = await getSettings();
      if (settings.default_audio_id === params.id) {
        await updateSettings({ default_audio_id: '' });
      }
    }

    return NextResponse.json({ success: true, id: params.id });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  try {
    const body = await req.json();
    if (body.set_default) {
      await updateSettings({ default_audio_id: params.id });
      return NextResponse.json({ success: true, message: 'Set as active prompt' });
    }
    return NextResponse.json({ error: 'Invalid operation' }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
