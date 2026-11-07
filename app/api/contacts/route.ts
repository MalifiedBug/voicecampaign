import { NextResponse } from 'next/server';
import { getContacts, addContact, query } from '@/lib/db';
import { v4 as uuidv4 } from 'uuid';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const search = searchParams.get('search') || '';
    const group = searchParams.get('group') || '';
    const limit = parseInt(searchParams.get('limit') || '500', 10);
    const offset = parseInt(searchParams.get('offset') || '0', 10);

    const contacts = await getContacts({ search, group, limit, offset });
    return NextResponse.json(contacts);
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

    if (clearAll) {
      await query('DELETE FROM contacts');
      return NextResponse.json({ success: true, message: 'All contacts cleared' });
    }

    if (!id) {
      return NextResponse.json({ error: 'Contact ID required' }, { status: 400 });
    }

    await query('DELETE FROM contacts WHERE id = $1', [id]);
    return NextResponse.json({ success: true, id });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

