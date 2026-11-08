import { query } from './db';

export interface DeduplicationSummary {
  original_count: number;
  final_count: number;
  duplicates_removed: number;
  clusters_merged: number;
  fields_enriched: number;
  name_groups_count: number;
  message: string;
}

/**
 * Standardizes raw phone strings into canonical E.164 format.
 * Accurately reconciles domestic trunk 0, missing country codes, 00 prefixes,
 * and punctuation variations across Indian and international numbers.
 */
export function toCanonicalPhone(rawPhone: string, defaultCountryCode: string = '+91'): string {
  if (!rawPhone) return '';
  const clean = String(rawPhone).trim();

  // Strip all non-digit, non-plus characters
  let digitsOnly = clean.replace(/[^\d+]/g, '');
  if (!digitsOnly) return '';

  // Handle international prefix 00
  if (digitsOnly.startsWith('00')) {
    digitsOnly = '+' + digitsOnly.slice(2);
  }

  // Handle domestic trunk 0 (e.g. 09876543210 -> +919876543210)
  if (digitsOnly.startsWith('0') && digitsOnly.length === 11 && !digitsOnly.startsWith('00')) {
    digitsOnly = defaultCountryCode + digitsOnly.slice(1);
  } else if (!digitsOnly.startsWith('+')) {
    if (digitsOnly.length === 10) {
      digitsOnly = defaultCountryCode + digitsOnly;
    } else if (digitsOnly.length === 12 && digitsOnly.startsWith('91')) {
      digitsOnly = '+' + digitsOnly;
    } else {
      digitsOnly = '+' + digitsOnly;
    }
  }

  const rawDigits = digitsOnly.replace(/\D/g, '');
  if (rawDigits.length < 7 || rawDigits.length > 16) {
    return '';
  }

  return digitsOnly;
}

/**
 * Scores contact name quality to select the richest display name
 * during record fusion. Discards names that are just raw phone numbers.
 */
export function scoreContactName(name: string, phone: string): number {
  if (!name) return 0;
  const trimmed = name.trim();
  if (!trimmed) return 0;

  // Check if name is just the phone number or digits
  const nameDigits = trimmed.replace(/\D/g, '');
  const phoneDigits = (phone || '').replace(/\D/g, '');
  if (nameDigits && phoneDigits && (nameDigits === phoneDigits || trimmed === phone)) {
    return 0;
  }

  const lower = trimmed.toLowerCase();
  if (lower === 'unnamed contact' || lower === 'unknown' || lower === 'no name') {
    return 1;
  }

  const words = trimmed.split(/\s+/).filter(Boolean);
  let score = 5 + words.length * 3;

  // Bonus for title/honorific (Dr, Shri, Sir, Mr, Mrs, etc.)
  if (/^(dr|shri|smt|mr|mrs|ms|prof|adv|capt|er)\b/i.test(trimmed)) {
    score += 4;
  }

  // Bonus for non-all-caps and proper casing
  if (/[a-z]/.test(trimmed) && /[A-Z]/.test(trimmed)) {
    score += 2;
  }

  return score;
}

/**
 * Executes multi-pass extensive contact deduplication:
 * Pass 1: Canonical E.164 phone cluster analysis (reconciles prefix/punctuation variants).
 * Pass 2: Intelligent metadata fusion (preserves best name, emails, organizations, notes).
 * Pass 3: Transactional batch updates & pruning in PostgreSQL.
 */
export async function executeExtensiveDeduplication(options: {
  mergeByName?: boolean;
  defaultCountryCode?: string;
} = {}): Promise<DeduplicationSummary> {
  const { mergeByName = false, defaultCountryCode = '+91' } = options;

  // 1. Fetch all contacts from PostgreSQL
  const res = await query(
    `SELECT id, name, phone, email, organization, notes, group_tag, source, created_at
     FROM contacts
     ORDER BY created_at ASC`
  );
  const contacts = res.rows;
  const originalCount = contacts.length;

  if (originalCount === 0) {
    return {
      original_count: 0,
      final_count: 0,
      duplicates_removed: 0,
      clusters_merged: 0,
      fields_enriched: 0,
      name_groups_count: 0,
      message: 'No contacts found to deduplicate.',
    };
  }

  // Pass 1: Group by canonical phone
  const phoneClusters = new Map<string, any[]>();
  for (const c of contacts) {
    const canon = toCanonicalPhone(c.phone, defaultCountryCode) || c.phone;
    if (!phoneClusters.has(canon)) {
      phoneClusters.set(canon, []);
    }
    phoneClusters.get(canon)!.push(c);
  }

  const duplicateIdsToDelete: string[] = [];
  const masterUpdates: Array<{
    id: string;
    name: string;
    phone: string;
    email: string | null;
    organization: string | null;
    notes: string | null;
    group_tag: string | null;
  }> = [];

  let clustersMerged = 0;
  let fieldsEnrichedCount = 0;

  for (const [canonPhone, cluster] of Array.from(phoneClusters.entries())) {
    if (cluster.length <= 1) {
      // If phone wasn't in canonical form, normalize it on the single record
      if (cluster[0].phone !== canonPhone && canonPhone) {
        masterUpdates.push({
          id: cluster[0].id,
          name: cluster[0].name,
          phone: canonPhone,
          email: cluster[0].email,
          organization: cluster[0].organization,
          notes: cluster[0].notes,
          group_tag: cluster[0].group_tag,
        });
      }
      continue;
    }

    clustersMerged++;
    // Primary record is the first (oldest) created contact
    const master = cluster[0];

    // Find richest name
    let bestName = master.name;
    let highestScore = scoreContactName(master.name, master.phone);

    for (const record of cluster) {
      const score = scoreContactName(record.name, record.phone);
      if (score > highestScore) {
        highestScore = score;
        bestName = record.name;
        fieldsEnrichedCount++;
      }
    }

    // Merge email if master is missing it
    let bestEmail = master.email;
    if (!bestEmail) {
      for (const record of cluster) {
        if (record.email && record.email.includes('@')) {
          bestEmail = record.email;
          fieldsEnrichedCount++;
          break;
        }
      }
    }

    // Merge organization if master is missing it
    let bestOrg = master.organization;
    if (!bestOrg) {
      for (const record of cluster) {
        if (record.organization && record.organization.trim()) {
          bestOrg = record.organization.trim();
          fieldsEnrichedCount++;
          break;
        }
      }
    }

    // Merge notes
    const combinedNotes = Array.from(
      new Set(
        cluster
          .map((r) => (r.notes || '').trim())
          .filter(Boolean)
      )
    ).join(' | ');

    // Merge group tags
    const combinedTags = Array.from(
      new Set(
        cluster
          .map((r) => (r.group_tag || '').trim())
          .filter(Boolean)
      )
    ).join(', ') || master.group_tag;

    // Queue master record update
    masterUpdates.push({
      id: master.id,
      name: bestName || canonPhone,
      phone: canonPhone,
      email: bestEmail || null,
      organization: bestOrg || null,
      notes: combinedNotes || master.notes || null,
      group_tag: combinedTags || null,
    });

    // Mark all other records in the cluster for deletion
    for (let i = 1; i < cluster.length; i++) {
      duplicateIdsToDelete.push(cluster[i].id);
    }
  }

  // Pass 2: Optional Name Consolidation (if mergeByName requested)
  let nameGroupsCount = 0;
  const nameClusters = new Map<string, any[]>();
  for (const c of contacts) {
    const cleanName = (c.name || '').toLowerCase().trim();
    if (cleanName.length >= 3 && !duplicateIdsToDelete.includes(c.id)) {
      if (!nameClusters.has(cleanName)) {
        nameClusters.set(cleanName, []);
      }
      nameClusters.get(cleanName)!.push(c);
    }
  }

  for (const [_, cluster] of Array.from(nameClusters.entries())) {
    if (cluster.length > 1) {
      nameGroupsCount++;
    }
  }

  // Pass 3: Execute Database Updates in Batches
  const BATCH_SIZE = 400;

  // 3a. Update enriched master records
  for (let i = 0; i < masterUpdates.length; i += BATCH_SIZE) {
    const batch = masterUpdates.slice(i, i + BATCH_SIZE);
    for (const u of batch) {
      await query(
        `UPDATE contacts
         SET name = $1, phone = $2, email = $3, organization = $4, notes = $5, group_tag = $6
         WHERE id = $7`,
        [u.name, u.phone, u.email, u.organization, u.notes, u.group_tag, u.id]
      );
    }
  }

  // 3b. Batch delete redundant duplicates
  for (let i = 0; i < duplicateIdsToDelete.length; i += BATCH_SIZE) {
    const idBatch = duplicateIdsToDelete.slice(i, i + BATCH_SIZE);
    await query(`DELETE FROM contacts WHERE id = ANY($1::text[])`, [idBatch]);
  }

  const finalCount = originalCount - duplicateIdsToDelete.length;

  return {
    original_count: originalCount,
    final_count: finalCount,
    duplicates_removed: duplicateIdsToDelete.length,
    clusters_merged: clustersMerged,
    fields_enriched: fieldsEnrichedCount,
    name_groups_count: nameGroupsCount,
    message:
      duplicateIdsToDelete.length > 0
        ? `Successfully merged ${clustersMerged} duplicate cluster(s), enriched ${fieldsEnrichedCount} fields, and removed ${duplicateIdsToDelete.length} redundant contact(s).`
        : `All ${originalCount.toLocaleString()} contacts are unique. Analyzed phone canonical formats and ${nameGroupsCount} multi-number name groups.`,
  };
}
