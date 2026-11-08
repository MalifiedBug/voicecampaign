import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';

const SUPABASE_IPV4_POOLER =
  'postgresql://postgres.oyqcsfdzlbldrmykoosq:X#?S&8!HGFP!vH9@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres';

function getPoolConfig() {
  let connStr =
    process.env.DATABASE_URL ||
    process.env.SUPABASE_DB_URL ||
    process.env.POSTGRES_URL ||
    SUPABASE_IPV4_POOLER;

  // Vercel serverless functions in AWS are IPv4 only.
  // Direct hostname db.<ref>.supabase.co is IPv6 only, causing getaddrinfo ENOTFOUND on Vercel.
  // We automatically translate it to Supabase's IPv4 connection pooler on transaction port 6543.
  if (connStr.includes('db.oyqcsfdzlbldrmykoosq.supabase.co') || connStr.includes('pooler.supabase.com')) {
    connStr = SUPABASE_IPV4_POOLER;
  }

  try {
    const match = connStr.match(/^postgres(?:ql)?:\/\/([^:]+):(.+)@([^:]+):(\d+)\/(.+)$/);
    if (match) {
      return {
        user: decodeURIComponent(match[1]),
        password: match[2],
        host: match[3],
        port: 6543, // Transaction pooler for serverless
        database: match[5],
        ssl: { rejectUnauthorized: false },
        max: 2,
        idleTimeoutMillis: 5000,
        connectionTimeoutMillis: 8000,
      };
    }
  } catch (e) {}

  return {
    connectionString: connStr,
    ssl: { rejectUnauthorized: false },
    max: 2,
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 8000,
  };
}

declare global {
  var _pgPool: Pool | undefined;
}

const pool: Pool = global._pgPool || new Pool(getPoolConfig());
if (process.env.NODE_ENV !== 'production') {
  global._pgPool = pool;
}

export async function query(text: string, params?: any[]) {
  const client = await pool.connect();
  try {
    const res = await client.query(text, params);
    return res;
  } finally {
    client.release();
  }
}

export async function getSettings(): Promise<Record<string, string>> {
  try {
    const res = await query('SELECT key, value FROM settings');
    const settings: Record<string, string> = {};
    for (const row of res.rows) {
      settings[row.key] = row.value;
    }

    // Overlay environment variables if present
    if (process.env.VOBIZ_AUTH_ID) settings.auth_id = process.env.VOBIZ_AUTH_ID;
    if (process.env.VOBIZ_AUTH_TOKEN) settings.auth_token = process.env.VOBIZ_AUTH_TOKEN;
    if (process.env.VOBIZ_CALLER_ID) settings.caller_id = process.env.VOBIZ_CALLER_ID;
    if (process.env.WEBHOOK_BASE_URL) settings.webhook_base_url = process.env.WEBHOOK_BASE_URL;

    return settings;
  } catch (err) {
    console.error('Error fetching settings:', err);
    return {
      auth_id: process.env.VOBIZ_AUTH_ID || '',
      auth_token: process.env.VOBIZ_AUTH_TOKEN || '',
      caller_id: process.env.VOBIZ_CALLER_ID || '',
      webhook_base_url: process.env.WEBHOOK_BASE_URL || 'https://voicecampaign.vercel.app',
    };
  }
}

export async function updateSettings(data: Record<string, string>) {
  for (const [key, value] of Object.entries(data)) {
    await query(
      `INSERT INTO settings (key, value)
       VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, String(value ?? '')]
    );
  }
}

export async function getContacts(options: { search?: string; group?: string; limit?: number; offset?: number } = {}) {
  const { search = '', group = '', limit = 500, offset = 0 } = options;
  const conditions: string[] = [];
  const params: any[] = [];

  if (search.trim()) {
    params.push(`%${search.trim().toLowerCase()}%`);
    conditions.push(
      `(LOWER(name) LIKE $${params.length} OR LOWER(phone) LIKE $${params.length} OR LOWER(COALESCE(organization, '')) LIKE $${params.length} OR LOWER(COALESCE(group_tag, '')) LIKE $${params.length})`
    );
  }

  if (group && group !== 'All Groups') {
    params.push(group);
    conditions.push(`group_tag = $${params.length}`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit);
  const limitParam = `$${params.length}`;
  params.push(offset);
  const offsetParam = `$${params.length}`;

  const res = await query(
    `SELECT * FROM contacts ${whereClause} ORDER BY created_at DESC LIMIT ${limitParam} OFFSET ${offsetParam}`,
    params
  );
  return res.rows;
}

export async function getContactsCount(options: { search?: string; group?: string } = {}): Promise<number> {
  const { search = '', group = '' } = options;
  const conditions: string[] = [];
  const params: any[] = [];

  if (search.trim()) {
    params.push(`%${search.trim().toLowerCase()}%`);
    conditions.push(
      `(LOWER(name) LIKE $${params.length} OR LOWER(phone) LIKE $${params.length} OR LOWER(COALESCE(organization, '')) LIKE $${params.length} OR LOWER(COALESCE(group_tag, '')) LIKE $${params.length})`
    );
  }

  if (group && group !== 'All Groups') {
    params.push(group);
    conditions.push(`group_tag = $${params.length}`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const res = await query(`SELECT COUNT(*) as cnt FROM contacts ${whereClause}`, params);
  return parseInt(res.rows[0]?.cnt || '0', 10);
}

export async function getAllContactPhones(options: { search?: string; group?: string } = {}): Promise<string[]> {
  const { search = '', group = '' } = options;
  const conditions: string[] = [];
  const params: any[] = [];

  if (search.trim()) {
    params.push(`%${search.trim().toLowerCase()}%`);
    conditions.push(
      `(LOWER(name) LIKE $${params.length} OR LOWER(phone) LIKE $${params.length} OR LOWER(COALESCE(organization, '')) LIKE $${params.length} OR LOWER(COALESCE(group_tag, '')) LIKE $${params.length})`
    );
  }

  if (group && group !== 'All Groups') {
    params.push(group);
    conditions.push(`group_tag = $${params.length}`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const res = await query(`SELECT phone FROM contacts ${whereClause} ORDER BY created_at DESC`, params);
  return res.rows.map((r) => r.phone);
}

export async function getContactGroups(): Promise<string[]> {
  try {
    const res = await query(
      `SELECT DISTINCT group_tag FROM contacts WHERE group_tag IS NOT NULL AND group_tag != '' ORDER BY group_tag`
    );
    return res.rows.map((r) => r.group_tag);
  } catch {
    return [];
  }
}

export async function addContact(contact: {
  id: string;
  name: string;
  phone: string;
  email?: string;
  organization?: string;
  notes?: string;
  group_tag?: string;
  source?: string;
}) {
  await query(
    `INSERT INTO contacts (id, name, phone, email, organization, notes, group_tag, source, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      contact.id,
      contact.name,
      contact.phone,
      contact.email || null,
      contact.organization || null,
      contact.notes || null,
      contact.group_tag || null,
      contact.source || 'manual',
      new Date().toISOString(),
    ]
  );
}

export async function bulkAddContacts(
  contacts: Array<{
    name: string;
    phone: string;
    email?: string;
    organization?: string;
    notes?: string;
    group_tag?: string;
    source?: string;
  }>
): Promise<number> {
  if (!contacts || contacts.length === 0) return 0;

  const CHUNK_SIZE = 500;
  let totalInserted = 0;

  for (let i = 0; i < contacts.length; i += CHUNK_SIZE) {
    const chunk = contacts.slice(i, i + CHUNK_SIZE);
    const valueClauses: string[] = [];
    const params: any[] = [];
    const now = new Date().toISOString();

    chunk.forEach((c) => {
      const id = uuidv4();
      const pIdx = params.length;
      params.push(
        id,
        c.name || 'Unnamed Contact',
        c.phone,
        c.email || null,
        c.organization || null,
        c.notes || null,
        c.group_tag || 'VCF-Import',
        c.source || 'vcf_import',
        now
      );
      valueClauses.push(
        `($${pIdx + 1}, $${pIdx + 2}, $${pIdx + 3}, $${pIdx + 4}, $${pIdx + 5}, $${pIdx + 6}, $${pIdx + 7}, $${pIdx + 8}, $${pIdx + 9})`
      );
    });

    const sql = `
      INSERT INTO contacts (id, name, phone, email, organization, notes, group_tag, source, created_at)
      VALUES ${valueClauses.join(', ')}
      ON CONFLICT (id) DO NOTHING
    `;

    const res = await query(sql, params);
    totalInserted += res.rowCount || chunk.length;
  }

  return totalInserted;
}

export async function deduplicateContacts(): Promise<{ original_count: number; final_count: number; duplicates_removed: number }> {
  const all = await query('SELECT * FROM contacts ORDER BY created_at ASC');
  const seen: Record<string, any> = {};
  const duplicateIds: string[] = [];

  for (const contact of all.rows) {
    // Normalize phone number (strip whitespace, dashes, parens)
    const normalized = (contact.phone || '').replace(/[\s\-\(\)]/g, '');
    if (seen[normalized]) {
      duplicateIds.push(contact.id);
    } else {
      seen[normalized] = contact;
    }
  }

  if (duplicateIds.length > 0) {
    await query(`DELETE FROM contacts WHERE id = ANY($1::text[])`, [duplicateIds]);
  }

  return {
    original_count: all.rows.length,
    final_count: all.rows.length - duplicateIds.length,
    duplicates_removed: duplicateIds.length,
  };
}

export async function getAudioAssets() {
  const res = await query('SELECT * FROM audio_assets ORDER BY created_at DESC');
  return res.rows;
}

export async function getAudioAsset(id: string) {
  const res = await query('SELECT * FROM audio_assets WHERE id = $1 LIMIT 1', [id]);
  return res.rows[0] || null;
}

export async function addAudioAsset(asset: {
  id: string;
  name: string;
  filename: string;
  filepath: string;
  mime_type: string;
  source_type: string;
  duration_seconds?: number;
  file_size_bytes?: number;
  external_url?: string;
  storage_url?: string;
  s3_key?: string;
  tts_text?: string;
  tts_voice?: string;
}) {
  await query(
    `INSERT INTO audio_assets (
      id, name, filename, filepath, mime_type, source_type,
      duration_seconds, file_size_bytes, external_url, storage_url, s3_key,
      tts_text, tts_voice, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      asset.id,
      asset.name,
      asset.filename,
      asset.filepath,
      asset.mime_type,
      asset.source_type,
      asset.duration_seconds || 0,
      asset.file_size_bytes || 0,
      asset.external_url || null,
      asset.storage_url || null,
      asset.s3_key || null,
      asset.tts_text || null,
      asset.tts_voice || null,
      new Date().toISOString(),
    ]
  );
}

export async function deleteAudioAsset(id: string) {
  await query('DELETE FROM audio_assets WHERE id = $1', [id]);
}

export async function getSchedules() {
  const res = await query('SELECT * FROM schedules ORDER BY created_at DESC');
  return res.rows;
}

export async function addSchedule(schedule: {
  id: string;
  name: string;
  to_number: string;
  schedule_type: string;
  scheduled_datetime?: string | null;
  interval_value?: number | null;
  interval_unit?: string | null;
  audio_id?: string | null;
  play_mode?: string | null;
  tts_message?: string | null;
  loop_count?: number | null;
  status?: string | null;
  next_run_at?: string | null;
}) {
  await query(
    `INSERT INTO schedules (
      id, name, to_number, schedule_type, scheduled_datetime,
      interval_value, interval_unit, audio_id, play_mode,
      tts_message, loop_count, status, next_run_at, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      schedule.id,
      schedule.name,
      schedule.to_number,
      schedule.schedule_type,
      schedule.scheduled_datetime || null,
      schedule.interval_value || null,
      schedule.interval_unit || null,
      schedule.audio_id || null,
      schedule.play_mode || 'audio',
      schedule.tts_message || null,
      schedule.loop_count || 1,
      schedule.status || 'active',
      schedule.next_run_at || null,
      new Date().toISOString(),
    ]
  );
}

export async function deleteSchedule(id: string) {
  await query('DELETE FROM schedules WHERE id = $1', [id]);
}

export async function getCallLogs(limit: number = 100) {
  const res = await query('SELECT * FROM call_logs ORDER BY initiated_at DESC LIMIT $1', [limit]);
  return res.rows;
}

export async function addCallLog(log: {
  id: string;
  schedule_id?: string;
  schedule_name?: string;
  to_number: string;
  from_number: string;
  audio_id?: string;
  call_uuid?: string;
  vobiz_api_id?: string;
  status?: string;
  notes?: string;
  xml_rendered?: string;
}) {
  await query(
    `INSERT INTO call_logs (
      id, schedule_id, schedule_name, to_number, from_number,
      audio_id, call_uuid, vobiz_api_id, status, initiated_at, notes, xml_rendered
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      log.id,
      log.schedule_id || null,
      log.schedule_name || null,
      log.to_number,
      log.from_number,
      log.audio_id || null,
      log.call_uuid ? String(log.call_uuid).slice(0, 255) : null,
      log.vobiz_api_id ? String(log.vobiz_api_id).slice(0, 255) : null,
      log.status || 'queued',
      new Date().toISOString(),
      log.notes || null,
      log.xml_rendered || null,
    ]
  );
}

export async function bulkAddCallLogs(
  logs: Array<{
    id?: string;
    schedule_id?: string;
    schedule_name?: string;
    to_number: string;
    from_number: string;
    audio_id?: string;
    call_uuid?: string;
    vobiz_api_id?: string;
    status?: string;
    notes?: string;
    xml_rendered?: string;
  }>
): Promise<number> {
  if (!logs || logs.length === 0) return 0;

  const CHUNK_SIZE = 500;
  let totalInserted = 0;
  const now = new Date().toISOString();

  for (let i = 0; i < logs.length; i += CHUNK_SIZE) {
    const chunk = logs.slice(i, i + CHUNK_SIZE);
    const valueClauses: string[] = [];
    const params: any[] = [];

    chunk.forEach((l) => {
      const pIdx = params.length;
      params.push(
        l.id || uuidv4(),
        l.schedule_id || null,
        l.schedule_name || null,
        l.to_number,
        l.from_number,
        l.audio_id || null,
        l.call_uuid ? String(l.call_uuid).slice(0, 255) : null,
        l.vobiz_api_id ? String(l.vobiz_api_id).slice(0, 255) : null,
        l.status || 'queued',
        now,
        l.notes || null,
        l.xml_rendered || null
      );
      valueClauses.push(
        `($${pIdx + 1}, $${pIdx + 2}, $${pIdx + 3}, $${pIdx + 4}, $${pIdx + 5}, $${pIdx + 6}, $${pIdx + 7}, $${pIdx + 8}, $${pIdx + 9}, $${pIdx + 10}, $${pIdx + 11}, $${pIdx + 12})`
      );
    });

    const sql = `
      INSERT INTO call_logs (
        id, schedule_id, schedule_name, to_number, from_number,
        audio_id, call_uuid, vobiz_api_id, status, initiated_at, notes, xml_rendered
      ) VALUES ${valueClauses.join(', ')}
      ON CONFLICT (id) DO NOTHING
    `;

    const res = await query(sql, params);
    totalInserted += res.rowCount || chunk.length;
  }

  return totalInserted;
}

export async function getCallStats() {
  const totalRes = await query('SELECT count(*) as count FROM call_logs');
  const completedRes = await query("SELECT count(*) as count FROM call_logs WHERE status = 'completed'");
  const failedRes = await query(
    "SELECT count(*) as count FROM call_logs WHERE status IN ('failed', 'busy', 'no-answer', 'rejected')"
  );
  const durRes = await query('SELECT COALESCE(SUM(duration), 0) as total FROM call_logs');
  const schedRes = await query("SELECT count(*) as count FROM schedules WHERE status = 'active'");

  return {
    total_calls: parseInt(totalRes.rows[0]?.count || '0', 10),
    completed_calls: parseInt(completedRes.rows[0]?.count || '0', 10),
    failed_calls: parseInt(failedRes.rows[0]?.count || '0', 10),
    total_duration_sec: parseInt(durRes.rows[0]?.total || '0', 10),
    active_schedules: parseInt(schedRes.rows[0]?.count || '0', 10),
  };
}
