import { query, getSettings } from '@/lib/db';
import { s3Client, s3Bucket } from '@/lib/s3';
import { GetObjectCommand } from '@aws-sdk/client-s3';

export const dynamic = 'force-dynamic';

// In-memory cache for high-concurrency telephony playback
const audioMemoryCache = new Map<string, { buffer: Buffer; mimeType: string; expiresAt: number }>();

async function getAudioBuffer(asset: any): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const cacheKey = asset.id || asset.s3_key || asset.filename;
  const cached = audioMemoryCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { buffer: cached.buffer, mimeType: cached.mimeType };
  }

  let buffer: Buffer | null = null;

  // 1. Try fetching via S3 GetObjectCommand
  const s3Key = asset.s3_key || (asset.filename && !asset.filename.includes('/') ? asset.filename : null);
  if (s3Key) {
    try {
      const s3Res = await s3Client.send(
        new GetObjectCommand({
          Bucket: s3Bucket,
          Key: s3Key,
        })
      );
      if (s3Res.Body) {
        const chunks: Uint8Array[] = [];
        for await (const chunk of s3Res.Body as any) {
          chunks.push(chunk);
        }
        buffer = Buffer.concat(chunks);
      }
    } catch (s3Err) {
      console.warn(`S3 fetch failed for key '${s3Key}':`, s3Err);
    }
  }

  // 2. Fallback: Fetch directly via external public URL
  if (!buffer && (asset.external_url || asset.storage_url || asset.filepath)) {
    const url = asset.external_url || asset.storage_url || asset.filepath;
    if (typeof url === 'string' && url.startsWith('http')) {
      try {
        const fetchRes = await fetch(url);
        if (fetchRes.ok) {
          const ab = await fetchRes.arrayBuffer();
          buffer = Buffer.from(ab);
        }
      } catch (fetchErr) {
        console.warn(`Direct fetch failed for URL '${url}':`, fetchErr);
      }
    }
  }

  // 3. Fallback: Check audio_bytes BLOB if present in DB
  if (!buffer && asset.audio_bytes) {
    if (Buffer.isBuffer(asset.audio_bytes)) {
      buffer = asset.audio_bytes;
    } else if (asset.audio_bytes.data) {
      buffer = Buffer.from(asset.audio_bytes.data);
    }
  }

  if (!buffer || buffer.length === 0) {
    return null;
  }

  // Auto-detect canonical audio format from magic bytes
  let mimeType = 'audio/wav';
  const isWav =
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WAVE';

  const isMp3 =
    buffer.length >= 3 &&
    (buffer.toString('ascii', 0, 3) === 'ID3' ||
      (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0));

  const isOgg = buffer.length >= 4 && buffer.toString('ascii', 0, 4) === 'OggS';

  if (isWav) {
    mimeType = 'audio/wav';
  } else if (isMp3) {
    mimeType = 'audio/mpeg';
  } else if (isOgg) {
    mimeType = 'audio/ogg';
  } else if (asset.mime_type) {
    mimeType = asset.mime_type;
  }

  // Cache for 10 minutes in memory
  audioMemoryCache.set(cacheKey, {
    buffer,
    mimeType,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });

  return { buffer, mimeType };
}

export async function GET(req: Request, { params }: { params: { slug: string } }) {
  return handleAudioServe(req, params.slug, false);
}

export async function HEAD(req: Request, { params }: { params: { slug: string } }) {
  return handleAudioServe(req, params.slug, true);
}

async function handleAudioServe(req: Request, rawSlug: string, isHead: boolean) {
  try {
    const slug = decodeURIComponent(rawSlug || '').trim();

    // Clean extension to get canonical ID
    let cleanId = slug;
    for (const sfx of ['.wav', '.mp3', '.ogg', '.webm', '.aac']) {
      if (cleanId.toLowerCase().endsWith(sfx)) {
        cleanId = cleanId.slice(0, -sfx.length);
        break;
      }
    }

    // Resolve asset from database
    let asset: any = null;
    const dbRes = await query(
      `SELECT * FROM audio_assets
       WHERE id = $1
          OR id = $2
          OR filename = $1
          OR filename = $2
          OR s3_key = $1
          OR s3_key = $2
       LIMIT 1`,
      [cleanId, slug]
    );

    if (dbRes.rows.length > 0) {
      asset = dbRes.rows[0];
    } else {
      // Fallback: Resolve active default audio asset
      const settings = await getSettings();
      if (settings.default_audio_id) {
        const defRes = await query(`SELECT * FROM audio_assets WHERE id = $1 LIMIT 1`, [settings.default_audio_id]);
        if (defRes.rows.length > 0) asset = defRes.rows[0];
      }
      if (!asset) {
        const anyRes = await query(`SELECT * FROM audio_assets ORDER BY created_at DESC LIMIT 1`);
        if (anyRes.rows.length > 0) asset = anyRes.rows[0];
      }
    }

    if (!asset) {
      return new Response('Audio asset not found', { status: 404 });
    }

    const audioData = await getAudioBuffer(asset);
    if (!audioData) {
      return new Response('Audio data stream unavailable', { status: 502 });
    }

    const { buffer, mimeType } = audioData;
    const totalLength = buffer.length;
    const rangeHeader = req.headers.get('range');
    const ext = mimeType === 'audio/mpeg' ? 'mp3' : 'wav';
    const filename = `prompt_${cleanId.slice(0, 8)}.${ext}`;

    // Handle Range Requests (HTTP 206 Partial Content) required by FreeSWITCH/Asterisk
    if (rangeHeader && rangeHeader.startsWith('bytes=')) {
      const parts = rangeHeader.replace('bytes=', '').split('-');
      const start = parseInt(parts[0], 10) || 0;
      const end = parts[1] ? Math.min(parseInt(parts[1], 10), totalLength - 1) : totalLength - 1;

      if (start < totalLength && end >= start) {
        const chunk = isHead ? Buffer.alloc(0) : buffer.subarray(start, end + 1);
        return new Response(new Uint8Array(chunk), {
          status: 206,
          headers: {
            'Content-Type': mimeType,
            'Content-Length': String(end - start + 1),
            'Content-Range': `bytes ${start}-${end}/${totalLength}`,
            'Accept-Ranges': 'bytes',
            'Content-Disposition': `inline; filename="${filename}"`,
            'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
            'X-Audio-Decoder-Hint': ext.toUpperCase(),
          },
        });
      }
    }

    // Standard 200 OK Response
    return new Response(isHead ? null : new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': mimeType,
        'Content-Length': String(totalLength),
        'Accept-Ranges': 'bytes',
        'Content-Disposition': `inline; filename="${filename}"`,
        'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
        'X-Audio-Decoder-Hint': ext.toUpperCase(),
      },
    });
  } catch (err: any) {
    console.error('Audio serve error:', err);
    return new Response(`Error serving audio: ${err.message}`, { status: 500 });
  }
}
