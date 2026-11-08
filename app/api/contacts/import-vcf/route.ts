import { NextResponse } from 'next/server';
import { bulkAddContacts } from '@/lib/db';
import { parseVcfText, ParsedContact } from '@/lib/vcf';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const contentType = req.headers.get('content-type') || '';

    // Mode 1: JSON payload with pre-parsed contacts array (chunked bulk upload)
    if (contentType.includes('application/json')) {
      const body = await req.json();
      const rawContacts: ParsedContact[] = body.contacts || [];
      const groupTag = body.group_tag || 'VCF-Import';

      if (!Array.isArray(rawContacts) || rawContacts.length === 0) {
        return NextResponse.json({ error: 'No contacts provided in batch' }, { status: 400 });
      }

      const contactsToInsert = rawContacts.map((c) => ({
        name: c.name || 'Unnamed Contact',
        phone: c.phone,
        email: c.email,
        organization: c.organization,
        notes: c.notes,
        group_tag: c.group_tag || groupTag,
        source: 'vcf_import',
      }));

      const inserted = await bulkAddContacts(contactsToInsert);

      return NextResponse.json({
        success: true,
        imported: inserted,
        total_found: contactsToInsert.length,
        message: `Successfully imported ${inserted} contact(s)!`,
      });
    }

    // Mode 2: Multipart form file upload (for smaller files)
    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    const groupTag = (formData.get('group_tag') as string) || 'VCF-Import';

    if (!file) {
      return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
    }

    const text = await file.text();
    const contacts = parseVcfText(text, '+91', groupTag);

    if (contacts.length === 0) {
      return NextResponse.json(
        { error: 'No valid phone numbers found in VCF file.' },
        { status: 400 }
      );
    }

    const inserted = await bulkAddContacts(
      contacts.map((c) => ({
        ...c,
        source: 'vcf_import',
      }))
    );

    return NextResponse.json({
      success: true,
      imported: inserted,
      total_found: contacts.length,
      message: `Successfully imported ${inserted} contact(s) from VCF!`,
    });
  } catch (err: any) {
    console.error('VCF import error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
