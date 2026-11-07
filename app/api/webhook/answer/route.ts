import { NextResponse } from 'next/server';
import { getSettings, getAudioAsset, getAudioAssets } from '@/lib/db';
import { buildAnswerXml } from '@/lib/vobiz';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return handleAnswer(req);
}

export async function POST(req: Request) {
  return handleAnswer(req);
}

async function handleAnswer(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const audioIdParam = searchParams.get('audio_id');
    const loopParam = parseInt(searchParams.get('loop') || '1', 10);

    const settings = await getSettings();
    let effectiveAudioId = audioIdParam || settings.default_audio_id;

    let asset: any = null;
    if (effectiveAudioId) {
      asset = await getAudioAsset(effectiveAudioId);
    }

    // Fallback: If no asset found by ID, get the most recent audio asset
    if (!asset) {
      const allAssets = await getAudioAssets();
      if (allAssets.length > 0) {
        asset = allAssets[0];
      }
    }

    let xml = '';
    if (asset && asset.source_type === 'tts') {
      xml = buildAnswerXml({
        ttsMessage: asset.tts_text,
        ttsVoice: asset.tts_voice || 'WOMAN',
        ttsLang: 'en-IN',
      });
    } else if (asset && (asset.external_url || asset.storage_url)) {
      const audioUrl = asset.external_url || asset.storage_url;
      xml = buildAnswerXml({
        audioUrl,
        loop: loopParam,
      });
    } else {
      xml = buildAnswerXml({
        ttsMessage: 'Hello, this is Voice Campaign alert. Your automated message has finished. Goodbye.',
      });
    }

    return new NextResponse(xml, {
      status: 200,
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      },
    });
  } catch (err: any) {
    console.error('Answer webhook error:', err);
    const fallbackXml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Speak voice="WOMAN" language="en-IN">An unexpected error occurred. Goodbye.</Speak>
    <Hangup/>
</Response>`;
    return new NextResponse(fallbackXml, {
      status: 200,
      headers: { 'Content-Type': 'application/xml; charset=utf-8' },
    });
  }
}
