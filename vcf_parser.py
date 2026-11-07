"""
VCF (vCard) Parser Module for Voice Campaign.
Handles importing, decoding, normalizing, and exporting contacts in vCard format (vCard 2.1, 3.0, 4.0).
Supports:
- Multiline folded lines (RFC 2425/6350)
- Quoted-Printable encoded fields (UTF-8, Latin-1, multilingual characters)
- Apple iOS / Google Contacts extended fields (item1.TEL, X-ABLabel)
- Phone number normalization to E.164 (+91 / international format)
- Deduplication and multi-number extraction per contact
"""

import re
import quopri
import logging
from typing import List, Dict, Any, Optional, Tuple

logger = logging.getLogger(__name__)

def normalize_phone_number(raw_phone: str, default_country_code: str = "+91") -> str:
    """
    Cleans and standardizes raw phone strings into dialable E.164 format.
    Examples:
        "+91 (987) 654-3210" -> "+919876543210"
        "9876543210"         -> "+919876543210"
        "09876543210"        -> "+919876543210"
        "00919876543210"     -> "+919876543210"
        "+1 415 555 2671"    -> "+14155552671"
    """
    if not raw_phone:
        return ""

    # Clean whitespace, parentheses, dashes, dots, brackets
    clean = re.sub(r"[^\d+]", "", str(raw_phone).strip())
    if not clean:
        return ""

    # Handle international prefixes
    if clean.startswith("00"):
        clean = "+" + clean[2:]

    # Handle single leading 0 (domestic trunk prefix in India/UK etc)
    if clean.startswith("0") and len(clean) == 11 and not clean.startswith("00"):
        clean = default_country_code + clean[1:]
    elif not clean.startswith("+"):
        # If standard 10-digit number without country code
        if len(clean) == 10:
            clean = default_country_code + clean
        else:
            # Fallback prepend default country code if missing plus
            clean = "+" + clean

    # Sanity check: must contain at least 7 digits to be a legitimate phone number
    digits_only = re.sub(r"\D", "", clean)
    if len(digits_only) < 7 or len(digits_only) > 16:
        return ""

    return clean

def decode_vcf_value(raw_val: str, params: str = "") -> str:
    """
    Decodes vCard parameter encoded text (e.g. Quoted-Printable UTF-8, escaped chars).
    """
    val = raw_val.strip()
    p_upper = params.upper()

    # 1. Quoted-Printable decoding
    if "ENCODING=QUOTED-PRINTABLE" in p_upper or "ENCODING=QP" in p_upper or ";QP" in p_upper:
        try:
            # Quoted-printable bytes decode
            decoded_bytes = quopri.decodestring(val.encode("latin-1", errors="replace"))
            # Detect charset
            charset = "utf-8"
            if "CHARSET=" in p_upper:
                cs_match = re.search(r"CHARSET=([A-Za-z0-9_-]+)", p_upper)
                if cs_match:
                    charset = cs_match.group(1).lower()
            val = decoded_bytes.decode(charset, errors="replace")
        except Exception as e:
            logger.debug(f"QP decode fallback: {e}")

    # 2. Unescape standard vCard characters
    val = val.replace(r"\n", " ").replace(r"\N", " ")
    val = val.replace(r"\,", ",").replace(r"\;", ";").replace(r"\\", "\\")

    return val.strip()

def unfold_vcf_lines(text: str) -> List[str]:
    """
    Unfolds multi-line vCard content.
    Lines starting with space, tab, or preceded by '=' in Quoted-Printable are joined.
    """
    raw_lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    unfolded = []

    for line in raw_lines:
        line_clean = line.rstrip("\r\n")
        if not line_clean:
            continue

        # Check soft line break from quoted-printable (line ends with =)
        if unfolded and unfolded[-1].endswith("="):
            unfolded[-1] = unfolded[-1][:-1] + line_clean
        # Check standard RFC unfolding (starts with space or tab)
        elif unfolded and (line_clean.startswith(" ") or line_clean.startswith("\t")):
            unfolded[-1] += line_clean[1:]
        else:
            unfolded.append(line_clean)

    return unfolded

def parse_vcf_text(
    vcf_text: str,
    default_country_code: str = "+91",
    default_group: Optional[str] = None
) -> List[Dict[str, Any]]:
    """
    Parses full vCard (.vcf) text and returns a structured list of contact records.
    Each record contains:
        name, phone, email, organization, notes, group_tag, source
    """
    lines = unfold_vcf_lines(vcf_text)
    contacts: List[Dict[str, Any]] = []

    in_card = False
    current_card: Dict[str, Any] = {}
    current_phones: List[Tuple[str, str]] = [] # list of (phone_number, label)

    for line in lines:
        s_line = line.strip()
        if not s_line:
            continue

        u_line = s_line.upper()

        if u_line == "BEGIN:VCARD":
            in_card = True
            current_card = {
                "fn": "",
                "n_given": "",
                "n_family": "",
                "org": "",
                "email": "",
                "notes": "",
                "title": ""
            }
            current_phones = []
            continue

        if u_line == "END:VCARD":
            if in_card:
                # Resolve best available display name
                display_name = current_card.get("fn", "").strip()
                if not display_name:
                    n_parts = [current_card.get("n_given", "").strip(), current_card.get("n_family", "").strip()]
                    display_name = " ".join([p for p in n_parts if p]).strip()

                # Process all valid phones for this contact
                seen_numbers = set()
                for raw_phone, p_label in current_phones:
                    norm_phone = normalize_phone_number(raw_phone, default_country_code=default_country_code)
                    if not norm_phone or norm_phone in seen_numbers:
                        continue
                    seen_numbers.add(norm_phone)

                    final_name = display_name or norm_phone
                    contacts.append({
                        "name": final_name,
                        "phone": norm_phone,
                        "email": current_card.get("email", ""),
                        "organization": current_card.get("org", ""),
                        "notes": current_card.get("notes", ""),
                        "group_tag": default_group or "Imported",
                        "source": "vcf"
                    })

                in_card = False
            continue

        if not in_card:
            continue

        # Property parsing
        # Strip Apple/iOS item prefix e.g. 'item1.TEL;...' -> 'TEL;...'
        prop_line = re.sub(r"^item\d+\.", "", s_line, flags=re.IGNORECASE)

        if ":" not in prop_line:
            continue

        prop_header, prop_val = prop_line.split(":", 1)
        prop_parts = prop_header.split(";")
        prop_key = prop_parts[0].upper().strip()
        prop_params = ";".join(prop_parts[1:]) if len(prop_parts) > 1 else ""

        # Formatted Name (FN)
        if prop_key == "FN":
            decoded_fn = decode_vcf_value(prop_val, prop_params)
            current_card["fn"] = decoded_fn

        # Structured Name (N:Family;Given;Additional;Prefix;Suffix)
        elif prop_key == "N":
            decoded_n = decode_vcf_value(prop_val, prop_params)
            n_chunks = decoded_n.split(";")
            current_card["n_family"] = n_chunks[0] if len(n_chunks) > 0 else ""
            current_card["n_given"] = n_chunks[1] if len(n_chunks) > 1 else ""

        # Phone Number (TEL)
        elif prop_key == "TEL":
            decoded_phone = decode_vcf_value(prop_val, prop_params)
            current_phones.append((decoded_phone, prop_params))

        # Email (EMAIL)
        elif prop_key == "EMAIL" and not current_card.get("email"):
            decoded_email = decode_vcf_value(prop_val, prop_params)
            if "@" in decoded_email:
                current_card["email"] = decoded_email

        # Organization (ORG)
        elif prop_key == "ORG":
            decoded_org = decode_vcf_value(prop_val, prop_params)
            org_name = decoded_org.split(";")[0].strip()
            current_card["org"] = org_name

        # Title (TITLE)
        elif prop_key == "TITLE":
            current_card["title"] = decode_vcf_value(prop_val, prop_params)

        # Notes (NOTE)
        elif prop_key == "NOTE":
            current_card["notes"] = decode_vcf_value(prop_val, prop_params)

    return contacts

def parse_vcf_bytes(
    file_bytes: bytes,
    default_country_code: str = "+91",
    default_group: Optional[str] = None
) -> List[Dict[str, Any]]:
    """
    Decodes raw file bytes into string and parses vCard contacts.
    Tolerates UTF-8 with BOM, UTF-8, Latin-1, and CP1252.
    """
    if not file_bytes:
        return []

    text = None
    for encoding in ["utf-8-sig", "utf-8", "latin-1", "cp1252"]:
        try:
            text = file_bytes.decode(encoding)
            break
        except UnicodeDecodeError:
            continue

    if text is None:
        text = file_bytes.decode("utf-8", errors="replace")

    return parse_vcf_text(text, default_country_code=default_country_code, default_group=default_group)

def export_contacts_to_vcf(contacts: List[Dict[str, Any]]) -> str:
    """
    Generates standard vCard 3.0 file content for a list of contacts.
    """
    cards = []
    for c in contacts:
        name = (c.get("name") or "Contact").replace("\n", " ")
        phone = c.get("phone", "").strip()
        if not phone:
            continue

        card_lines = [
            "BEGIN:VCARD",
            "VERSION:3.0",
            f"FN:{name}",
            f"N:;{name};;;",
            f"TEL;TYPE=CELL,VOICE:{phone}"
        ]

        if c.get("email"):
            card_lines.append(f"EMAIL;TYPE=INTERNET:{c['email'].strip()}")
        if c.get("organization"):
            card_lines.append(f"ORG:{c['organization'].strip()}")
        if c.get("notes"):
            note = c["notes"].replace("\n", r"\n")
            card_lines.append(f"NOTE:{note}")

        card_lines.append("END:VCARD")
        cards.append("\r\n".join(card_lines))

    return "\r\n".join(cards) + "\r\n"

