import { NextResponse } from 'next/server';
import { getContacts, getContactsCount, getAllContactPhones, getContactGroups, addContact, query } from '@/lib/db';
import { v4 as uuidv4 } from 'uuid';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const search = searchParams.get('search') || '';
    const group = searchParams.get('group') || '';
    const allPhones = searchParams.get('all_phones') === 'true';

    if (allPhones) {
      const phones = await getAllContactPhones({ search, group });
      const total = await getContactsCount({ search, group });
      return NextResponse.json({ total, phones });
    }

    const limit = parseInt(searchParams.get('limit') || '500', 10);
    const offset = parseInt(searchParams.get('offset') || '0', 10);

    const [contacts, total, groups] = await Promise.all([
      getContacts({ search, group, limit, offset }),
      getContactsCount({ search, group }),
      getContactGroups(),
    ]);

    return NextResponse.json({
      total,
      contacts,
      groups,
      limit,
      offset,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    if (!body.phone) {
      return NextResponse.json({ error: 'Phone number is required' }, { status: 400 });
    }

    const id = body.id || uuidv4();
    await addContact({
      id,
      name: body.name || 'Unnamed Contact',
      phone: body.phone,
      email: body.email,
      organization: body.organization,
      notes: body.notes,
      group_tag: body.group_tag,
      source: body.source || 'manual',
    });

    return NextResponse.json({ success: true, id });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');
    const clearAll = searchParams.get('all') === 'true';

    // 1. Wipe all contacts
    if (clearAll) {
      await query('DELETE FROM contacts');
      return NextResponse.json({ success: true, message: 'All contacts cleared' });
    }

    // 2. Parse IDs from body or query params
    let idsToDelete: string[] = [];
    try {
      const body = await req.json();
      if (body.ids && Array.isArray(body.ids)) {
        idsToDelete = body.ids.filter(Boolean);
      }
    } catch (e) {}

    const idsParam = searchParams.get('ids');
    if (idsParam) {
      idsToDelete = idsToDelete.concat(idsParam.split(',').map((x) => x.trim()).filter(Boolean));
    }

    if (id) {
      idsToDelete.push(id.trim());
    }

    idsToDelete = Array.from(new Set(idsToDelete));

    if (idsToDelete.length === 0) {
      return NextResponse.json({ error: 'No contact ID(s) provided for deletion' }, { status: 400 });
    }

    await query(`DELETE FROM contacts WHERE id = ANY($1::text[])`, [idsToDelete]);
    return NextResponse.json({
      success: true,
      deleted_count: idsToDelete.length,
      message: `Successfully deleted ${idsToDelete.length} contact(s).`,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

