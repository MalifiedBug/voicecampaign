import { NextResponse } from 'next/server';
import { addContact } from '@/lib/db';
import { v4 as uuidv4 } from 'uuid';

export const dynamic = 'force-dynamic';

function parseVcfContent(content: string, defaultGroup: string = 'VCF-Import') {
  const cards: Array<{
    name: string;
    phone: string;
    email?: string;
    organization?: string;
    group_tag?: string;
  }> = [];

  const rawCards = content.split(/BEGIN:VCARD/i);

  for (const block of rawCards) {
    if (!block.trim()) continue;

    let fn = '';
    const phones: string[] = [];
    let email = '';
    let org = '';

    const lines = block.split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      if (line.toUpperCase().startsWith('FN:') || line.toUpperCase().startsWith('FN;')) {
        const parts = line.split(':');
        fn = parts.slice(1).join(':').trim();
      } else if (line.toUpperCase().startsWith('TEL:') || line.toUpperCase().startsWith('TEL;')) {
        const parts = line.split(':');
        const phone = parts.slice(1).join(':').trim();
        if (phone) phones.push(phone);
      } else if (line.toUpperCase().startsWith('EMAIL:') || line.toUpperCase().startsWith('EMAIL;')) {
        const parts = line.split(':');
        email = parts.slice(1).join(':').trim();
      } else if (line.toUpperCase().startsWith('ORG:') || line.toUpperCase().startsWith('ORG;')) {
        const parts = line.split(':');
        org = parts.slice(1).join(':').replace(/;/g, ' ').trim();
      }
    }

    if (phones.length > 0) {
      for (const p of phones) {
        cards.push({
          name: fn || 'Unnamed Contact',
          phone: p,
          email: email || undefined,
          organization: org || undefined,
          group_tag: defaultGroup,
        });
      }
    }
  }

  return cards;
}

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    const groupTag = (formData.get('group_tag') as string) || 'VCF-Import';

    if (!file) {
      return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
    }

    const text = await file.text();
    const contacts = parseVcfContent(text, groupTag);

    if (contacts.length === 0) {
      return NextResponse.json({ error: 'No valid phone numbers found in VCF file.' }, { status: 400 });
    }

    let imported = 0;
    for (const c of contacts) {
      await addContact({
        id: uuidv4(),
        name: c.name,
        phone: c.phone,
        email: c.email,
        organization: c.organization,
        group_tag: c.group_tag,
        source: 'vcf_import',
      });
      imported++;
    }

    return NextResponse.json({
      success: true,
      imported,
      total_found: contacts.length,
      message: `Successfully imported ${imported} contact(s) from VCF!`,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
