import { NextResponse } from 'next/server';
import { addAudioAsset, updateSettings } from '@/lib/db';
import { v4 as uuidv4 } from 'uuid';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const assetId = uuidv4();
    const name = body.custom_name || body.filename || `Audio ${new Date().toLocaleTimeString()}`;
    const filename = body.filename || `${assetId}.wav`;
    const publicUrl = body.public_url;
    const s3Key = body.key;
    const mimeType = body.mime_type || 'audio/wav';
    const sourceType = body.source_type || 'upload';

    await addAudioAsset({
      id: assetId,
      name,
      filename,
      filepath: publicUrl,
      mime_type: mimeType,
      source_type: sourceType,
      duration_seconds: body.duration_seconds || 0,
      file_size_bytes: body.file_size_bytes || 0,
      external_url: publicUrl,
      storage_url: publicUrl,
      s3_key: s3Key,
    });

    // Make newly added audio the active prompt
    await updateSettings({ default_audio_id: assetId });

    return NextResponse.json({
      success: true,
      asset_id: assetId,
      name,
      public_url: publicUrl,
      message: `Audio '${name}' successfully registered and set as active prompt!`,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
