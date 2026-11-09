import { NextResponse } from 'next/server';
import { addAudioAsset, updateSettings } from '@/lib/db';
import { s3Client, s3Bucket } from '@/lib/s3';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { v4 as uuidv4 } from 'uuid';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const assetId = uuidv4();
    let name = body.custom_name || body.filename || `Audio ${new Date().toLocaleTimeString()}`;
    let filename = body.filename || `${assetId}.wav`;
    const publicUrl = body.public_url;
    const s3Key = body.key;
    let mimeType = body.mime_type || 'audio/wav';
    const sourceType = body.source_type || 'upload';

    // Verify magic bytes directly from S3 storage to avoid mislabeled formats
    if (s3Key) {
      try {
        const headerRes = await s3Client.send(
          new GetObjectCommand({
            Bucket: s3Bucket,
            Key: s3Key,
            Range: 'bytes=0-15',
          })
        );
        if (headerRes.Body) {
          const chunks: Uint8Array[] = [];
          for await (const chunk of headerRes.Body as any) {
            chunks.push(chunk);
          }
          const buf = Buffer.concat(chunks);
          if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'RIFF') {
            mimeType = 'audio/wav';
            if (filename.toLowerCase().endsWith('.mp3')) {
              filename = filename.slice(0, -4) + '.wav';
            }
          } else if (
            buf.length >= 3 &&
            (buf.toString('ascii', 0, 3) === 'ID3' ||
              (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0))
          ) {
            mimeType = 'audio/mpeg';
            if (filename.toLowerCase().endsWith('.wav')) {
              filename = filename.slice(0, -4) + '.mp3';
            }
          }
        }
      } catch (err) {
        console.warn('Could not inspect S3 header for audio verification:', err);
      }
    }

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

