/**
 * High-performance VCF (vCard) parser for Browser & Server.
 * Supports vCard 2.1, 3.0, 4.0, multiline unfolding, quoted-printable UTF-8,
 * Apple iOS (item1.TEL), Google Contacts, and E.164 phone normalization.
 */

export interface ParsedContact {
  name: string;
  phone: string;
  email?: string;
  organization?: string;
  notes?: string;
  group_tag: string;
}

export function normalizePhoneNumber(rawPhone: string, defaultCountryCode: string = '+91'): string {
  if (!rawPhone) return '';

  // Clean whitespace, parentheses, dashes, dots, brackets
  let clean = String(rawPhone).trim().replace(/[^\d+]/g, '');
  if (!clean) return '';

  // Handle international prefix 00
  if (clean.startsWith('00')) {
    clean = '+' + clean.slice(2);
  }

  // Handle domestic trunk prefix '0' (e.g. 09876543210 -> +919876543210)
  if (clean.startsWith('0') && clean.length === 11 && !clean.startsWith('00')) {
    clean = defaultCountryCode + clean.slice(1);
  } else if (!clean.startsWith('+')) {
    // 10-digit standard Indian/local number
    if (clean.length === 10) {
      clean = defaultCountryCode + clean;
    } else if (clean.length === 12 && clean.startsWith('91')) {
      clean = '+' + clean;
    } else {
      clean = '+' + clean;
    }
  }

  // Basic sanity check: 7 to 16 digits
  const digitsOnly = clean.replace(/\D/g, '');
  if (digitsOnly.length < 7 || digitsOnly.length > 16) {
    return '';
  }

  return clean;
}

function decodeQuotedPrintable(str: string): string {
  try {
    const raw = str.replace(/=([0-9A-Fa-f]{2})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    );
    return decodeURIComponent(
      raw
        .split('')
        .map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
        .join('')
    );
  } catch {
    return str.replace(/=([0-9A-Fa-f]{2})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    );
  }
}

export function decodeVcfValue(rawVal: string, params: string = ''): string {
  let val = (rawVal || '').trim();
  const pUpper = (params || '').toUpperCase();

  if (
    pUpper.includes('ENCODING=QUOTED-PRINTABLE') ||
    pUpper.includes('ENCODING=QP') ||
    pUpper.includes(';QP')
  ) {
    val = decodeQuotedPrintable(val);
  }

  // Unescape standard vCard sequences
  val = val
    .replace(/\\n/gi, ' ')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');

  return val.trim();
}

export function unfoldVcfLines(text: string): string[] {
  const rawLines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const unfolded: string[] = [];

  for (const rawLine of rawLines) {
    const line = rawLine.trimEnd();
    if (!line) continue;

    // Soft line break from quoted-printable
    if (unfolded.length > 0 && unfolded[unfolded.length - 1].endsWith('=')) {
      unfolded[unfolded.length - 1] = unfolded[unfolded.length - 1].slice(0, -1) + line.trimStart();
    }
    // RFC unfolding: space or tab at start
    else if (unfolded.length > 0 && (rawLine.startsWith(' ') || rawLine.startsWith('\t'))) {
      unfolded[unfolded.length - 1] += line.trimStart();
    } else {
      unfolded.push(line);
    }
  }

  return unfolded;
}

export function parseVcfText(
  vcfText: string,
  defaultCountryCode: string = '+91',
  defaultGroup: string = 'VCF-Import'
): ParsedContact[] {
  const lines = unfoldVcfLines(vcfText);
  const contacts: ParsedContact[] = [];

  let inCard = false;
  let currentCard: Record<string, string> = {};
  let currentPhones: Array<{ phone: string; params: string }> = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const uLine = line.toUpperCase();

    if (uLine === 'BEGIN:VCARD') {
      inCard = true;
      currentCard = {};
      currentPhones = [];
      continue;
    }

    if (uLine === 'END:VCARD') {
      if (inCard) {
        let displayName = currentCard.fn || '';
        if (!displayName) {
          const nParts = [currentCard.n_given, currentCard.n_family].filter(Boolean);
          displayName = nParts.join(' ').trim();
        }

        const seenPhones = new Set<string>();
        for (const p of currentPhones) {
          const norm = normalizePhoneNumber(p.phone, defaultCountryCode);
          if (!norm || seenPhones.has(norm)) continue;
          seenPhones.add(norm);

          contacts.push({
            name: displayName || norm,
            phone: norm,
            email: currentCard.email || undefined,
            organization: currentCard.org || undefined,
            notes: currentCard.notes || undefined,
            group_tag: defaultGroup,
          });
        }
      }
      inCard = false;
      continue;
    }

    if (!inCard) continue;

    // Discard large binary fields immediately (PHOTO, LOGO, SOUND)
    if (
      uLine.startsWith('PHOTO') ||
      uLine.startsWith('LOGO') ||
      uLine.startsWith('SOUND') ||
      uLine.startsWith('KEY')
    ) {
      continue;
    }

    // Strip Apple iOS item prefixes (item1.TEL -> TEL)
    const propLine = line.replace(/^item\d+\./i, '');
    const colonIdx = propLine.indexOf(':');
    if (colonIdx === -1) continue;

    const propHeader = propLine.slice(0, colonIdx);
    const propVal = propLine.slice(colonIdx + 1);
    const headerParts = propHeader.split(';');
    const propKey = headerParts[0].toUpperCase().trim();
    const propParams = headerParts.slice(1).join(';');

    if (propKey === 'FN') {
      currentCard.fn = decodeVcfValue(propVal, propParams);
    } else if (propKey === 'N') {
      const decodedN = decodeVcfValue(propVal, propParams);
      const nChunks = decodedN.split(';');
      currentCard.n_family = nChunks[0] || '';
      currentCard.n_given = nChunks[1] || '';
    } else if (propKey === 'TEL') {
      const decodedPhone = decodeVcfValue(propVal, propParams);
      if (decodedPhone) {
        currentPhones.push({ phone: decodedPhone, params: propParams });
      }
    } else if (propKey === 'EMAIL' && !currentCard.email) {
      const decodedEmail = decodeVcfValue(propVal, propParams);
      if (decodedEmail.includes('@')) {
        currentCard.email = decodedEmail;
      }
    } else if (propKey === 'ORG') {
      const decodedOrg = decodeVcfValue(propVal, propParams);
      currentCard.org = decodedOrg.split(';')[0].trim();
    } else if (propKey === 'NOTE') {
      currentCard.notes = decodeVcfValue(propVal, propParams);
    }
  }

  return contacts;
}
