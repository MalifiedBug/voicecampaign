"""
Database module for Voice Campaign Vobiz Application.
Supports Supabase PostgreSQL (persistent storage for data and audio media)
with automatic fallback to SQLite for offline local development and testing.
"""

import os
import json
import logging
from datetime import datetime
from typing import Dict, Any, List, Optional
import uuid
import sqlite3

try:
    import psycopg2
    from psycopg2.extras import RealDictCursor
except ImportError:
    psycopg2 = None
    RealDictCursor = None

logger = logging.getLogger(__name__)

def load_dotenv(dotenv_path: Optional[str] = None):
    """
    Parses a local .env file and sets values in os.environ if not already present.
    Supports comments (#), export statements, and quoted strings.
    """
    if dotenv_path is None:
        dotenv_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")

    if not os.path.exists(dotenv_path):
        return

    try:
        with open(dotenv_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if line.startswith("export "):
                    line = line[7:].strip()
                if "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k = k.strip()
                v = v.strip()
                if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
                    val = v[1:-1]
                else:
                    val = v
                if k and k not in os.environ:
                    os.environ[k] = val
    except Exception as e:
        logger.warning(f"Failed to read .env file: {e}")

# Load .env immediately
load_dotenv()

ENV_SETTING_MAPPINGS = {
    "auth_id": ["VOBIZ_AUTH_ID"],
    "auth_token": ["VOBIZ_AUTH_TOKEN"],
    "caller_id": ["VOBIZ_CALLER_ID", "VOBIZ_FROM_NUMBER"],
    "webhook_base_url": ["WEBHOOK_BASE_URL", "VERCEL_PROJECT_PRODUCTION_URL", "VERCEL_URL"],
    "app_id": ["VOBIZ_APP_ID"],
    "app_name": ["VOBIZ_APP_NAME"],
    "ring_timeout": ["VOBIZ_RING_TIMEOUT", "RING_TIMEOUT"],
    "time_limit": ["VOBIZ_TIME_LIMIT", "TIME_LIMIT"],
    "machine_detection": ["VOBIZ_MACHINE_DETECTION", "MACHINE_DETECTION"],
    "timezone": ["VOBIZ_TIMEZONE", "TIMEZONE"],
    "default_audio_id": ["VOBIZ_DEFAULT_AUDIO_ID"],
    "tts_default_voice": ["VOBIZ_TTS_VOICE", "TTS_DEFAULT_VOICE"],
    "tts_default_language": ["VOBIZ_TTS_LANGUAGE", "TTS_DEFAULT_LANGUAGE"]
}

# Production Supabase PostgreSQL Connection Strings
SUPABASE_DIRECT_URL = "postgresql://postgres:X#?S&8!HGFP!vH9@db.oyqcsfdzlbldrmykoosq.supabase.co:5432/postgres"
SUPABASE_POOLER_URL = SUPABASE_DIRECT_URL

DEFAULT_SUPABASE_URL = (
    os.environ.get("DATABASE_URL")
    or os.environ.get("SUPABASE_DB_URL")
    or os.environ.get("POSTGRES_URL")
    or SUPABASE_DIRECT_URL
)

def get_env_override(key: str) -> Optional[str]:
    """
    Checks os.environ (and optionally Streamlit secrets) for an override.
    Normalizes URLs for webhook_base_url.
    """
    var_names = ENV_SETTING_MAPPINGS.get(key, [])
    for var in var_names:
        val = os.environ.get(var)
        if val is not None and str(val).strip():
            clean_val = str(val).strip()
            if key == "webhook_base_url":
                if not clean_val.startswith("http://") and not clean_val.startswith("https://"):
                    clean_val = f"https://{clean_val}"
                clean_val = clean_val.rstrip("/")
            return clean_val

    try:
        import streamlit as st
        if hasattr(st, "secrets"):
            for var in var_names:
                if var in st.secrets and str(st.secrets[var]).strip():
                    clean_val = str(st.secrets[var]).strip()
                    if key == "webhook_base_url":
                        if not clean_val.startswith("http://") and not clean_val.startswith("https://"):
                            clean_val = f"https://{clean_val}"
                        clean_val = clean_val.rstrip("/")
                    return clean_val
    except Exception:
        pass

    return None

def is_setting_env_managed(key: str) -> bool:
    """Returns True if the setting is provided by an active environment variable."""
    return get_env_override(key) is not None

def is_vobiz_env_configured() -> bool:
    """Returns True if essential Vobiz credentials (auth_id and auth_token) come from environment."""
    return bool(get_env_override("auth_id") and get_env_override("auth_token"))

def get_env_managed_keys() -> List[str]:
    """Returns list of setting keys currently populated from environment variables."""
    return [k for k in ENV_SETTING_MAPPINGS if is_setting_env_managed(k)]

# --- Connection Management (Supabase PostgreSQL / SQLite) ---

def get_database_url() -> Optional[str]:
    """Resolves PostgreSQL connection string from environment, secrets, or default Supabase project."""
    if os.environ.get("USE_SQLITE") == "true":
        return None

    for k in ["DATABASE_URL", "SUPABASE_DB_URL", "POSTGRES_URL"]:
        val = os.environ.get(k)
        if val and str(val).strip():
            c = str(val).strip()
            if c.lower() in ["sqlite", "false", "none", "0"]:
                return None
            return c

    try:
        import streamlit as st
        if hasattr(st, "secrets"):
            for k in ["DATABASE_URL", "SUPABASE_DB_URL", "POSTGRES_URL"]:
                if k in st.secrets and str(st.secrets[k]).strip():
                    return str(st.secrets[k]).strip()
    except Exception:
        pass

    return DEFAULT_SUPABASE_URL

_db_mode: Optional[str] = None
_pg_conn = None
_active_pg_url: Optional[str] = None

def get_db_mode() -> str:
    """Determines active database backend ('postgres' or 'sqlite')."""
    global _db_mode, _pg_conn, _active_pg_url
    if _db_mode is not None:
        return _db_mode

    configured_url = get_database_url()
    if configured_url and psycopg2 is not None and (configured_url.startswith("postgres://") or configured_url.startswith("postgresql://")):
        enc_url = None
        try:
            import urllib.parse
            prefix = "postgresql://" if configured_url.startswith("postgresql://") else "postgres://"
            rest = configured_url[len(prefix):]
            if "@" in rest and ":" in rest.split("@")[0]:
                user_pass, host_part = rest.split("@", 1)
                user, pwd = user_pass.split(":", 1)
                encoded_pwd = urllib.parse.quote(urllib.parse.unquote(pwd), safe="")
                enc_url = f"{prefix}{user}:{encoded_pwd}@{host_part}"
        except Exception:
            pass

        candidates = [enc_url, configured_url] if enc_url else [configured_url]

        for candidate in candidates:
            try:
                test_conn = psycopg2.connect(candidate, connect_timeout=6)
                test_conn.autocommit = True
                _pg_conn = test_conn
                _active_pg_url = candidate
                _db_mode = "postgres"
                logger.info(f"Database initialized: connected to Supabase PostgreSQL via {candidate.split('@')[-1]}.")
                return _db_mode
            except Exception as e:
                logger.warning(f"Connection attempt to {candidate.split('@')[-1]} failed: {e}")

    _db_mode = "sqlite"
    return _db_mode

def is_postgres() -> bool:
    return get_db_mode() == "postgres"

def get_pg_conn():
    """Returns persistent, autocommit connection to Supabase PostgreSQL with auto-reconnection."""
    global _pg_conn, _active_pg_url
    if _pg_conn is not None:
        try:
            if _pg_conn.closed == 0:
                with _pg_conn.cursor() as cur:
                    cur.execute("SELECT 1;")
                return _pg_conn
        except Exception:
            try:
                _pg_conn.close()
            except Exception:
                pass
            _pg_conn = None

    url = _active_pg_url or get_database_url() or SUPABASE_DIRECT_URL
    enc_url = None
    try:
        import urllib.parse
        prefix = "postgresql://" if url.startswith("postgresql://") else "postgres://"
        rest = url[len(prefix):]
        if "@" in rest and ":" in rest.split("@")[0]:
            user_pass, host_part = rest.split("@", 1)
            user, pwd = user_pass.split(":", 1)
            encoded_pwd = urllib.parse.quote(urllib.parse.unquote(pwd), safe="")
            enc_url = f"{prefix}{user}:{encoded_pwd}@{host_part}"
    except Exception:
        pass

    candidates = [enc_url, url] if enc_url else [url]

    for cand in candidates:
        if not cand:
            continue
        try:
            conn = psycopg2.connect(cand, connect_timeout=6)
            conn.autocommit = True
            _pg_conn = conn
            _active_pg_url = cand
            return _pg_conn
        except Exception as e:
            logger.warning(f"Connection attempt to {cand.split('@')[-1]} failed: {e}")

    raise ValueError("Could not establish a connection to Supabase PostgreSQL.")

def get_db_path() -> str:
    if os.environ.get("VERCEL") or os.environ.get("AWS_LAMBDA_FUNCTION_NAME"):
        return "/tmp/voicecampaign.db"
    vc_path = os.path.join(os.path.dirname(__file__), "data", "voicecampaign.db")
    legacy_path = os.path.join(os.path.dirname(__file__), "data", "farmcalling.db")
    if not os.path.exists(vc_path) and os.path.exists(legacy_path):
        return legacy_path
    return vc_path

def get_sqlite_conn() -> sqlite3.Connection:
    """Returns local SQLite connection with Row factory."""
    db_path = get_db_path()
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    conn = sqlite3.connect(db_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn

def get_connection():
    """Backwards-compatible connection accessor."""
    if is_postgres():
        return get_pg_conn()
    return get_sqlite_conn()

def db_execute(sql: str, params: tuple = (), fetch: str = "none") -> Any:
    """
    Unified query runner.
    Handles '?' to '%s' translation, binary wrapping, and result mapping.
    """
    if is_postgres():
        pg_sql = sql.replace("?", "%s")
        conv_params = tuple(
            psycopg2.Binary(p) if isinstance(p, (bytes, bytearray)) else p
            for p in params
        )
        for attempt in range(2):
            try:
                conn = get_pg_conn()
                with conn.cursor(cursor_factory=RealDictCursor) as cur:
                    cur.execute(pg_sql, conv_params)
                    if fetch == "one":
                        row = cur.fetchone()
                        if row:
                            d = dict(row)
                            for k, v in d.items():
                                if isinstance(v, memoryview):
                                    d[k] = bytes(v)
                            return d
                        return None
                    elif fetch == "all":
                        rows = cur.fetchall()
                        res = []
                        for r in rows:
                            d = dict(r)
                            for k, v in d.items():
                                if isinstance(v, memoryview):
                                    d[k] = bytes(v)
                            res.append(d)
                        return res
                    return None
            except (psycopg2.OperationalError, psycopg2.InterfaceError) as e:
                logger.warning(f"PostgreSQL connection hiccup: {e}. Retrying ({attempt+1}/2)...")
                global _pg_conn
                _pg_conn = None
                if attempt == 1:
                    raise
    else:
        conn = get_sqlite_conn()
        with conn:
            cur = conn.cursor()
            cur.execute(sql, params)
            if fetch == "one":
                row = cur.fetchone()
                return dict(row) if row else None
            elif fetch == "all":
                rows = cur.fetchall()
                return [dict(r) for r in rows]
            return None

def init_db():
    """Initializes schema and default assets on either Supabase PostgreSQL or SQLite."""
    if is_postgres():
        conn = get_pg_conn()
        with conn.cursor() as cur:
            cur.execute("""
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT
            );
            """)

            cur.execute("""
            CREATE TABLE IF NOT EXISTS audio_assets (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                filename TEXT NOT NULL,
                filepath TEXT NOT NULL,
                mime_type TEXT NOT NULL,
                source_type TEXT NOT NULL,
                duration_seconds REAL DEFAULT 0,
                file_size_bytes BIGINT DEFAULT 0,
                tts_text TEXT,
                tts_voice TEXT,
                audio_bytes BYTEA,
                external_url TEXT,
                storage_url TEXT,
                s3_key TEXT,
                created_at TEXT NOT NULL
            );
            """)
            cur.execute("ALTER TABLE audio_assets ADD COLUMN IF NOT EXISTS s3_key TEXT;")
            cur.execute("ALTER TABLE audio_assets ADD COLUMN IF NOT EXISTS storage_url TEXT;")

            cur.execute("""
            CREATE TABLE IF NOT EXISTS schedules (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                to_number TEXT NOT NULL,
                schedule_type TEXT NOT NULL,
                scheduled_datetime TEXT,
                interval_value INTEGER,
                interval_unit TEXT,
                cron_expression TEXT,
                audio_id TEXT,
                play_mode TEXT DEFAULT 'audio',
                tts_message TEXT,
                loop_count INTEGER DEFAULT 1,
                status TEXT DEFAULT 'active',
                last_run_at TEXT,
                next_run_at TEXT,
                total_runs INTEGER DEFAULT 0,
                created_at TEXT NOT NULL
            );
            """)

            cur.execute("""
            CREATE TABLE IF NOT EXISTS call_logs (
                id TEXT PRIMARY KEY,
                schedule_id TEXT,
                schedule_name TEXT,
                to_number TEXT NOT NULL,
                from_number TEXT NOT NULL,
                audio_id TEXT,
                call_uuid TEXT,
                vobiz_api_id TEXT,
                status TEXT DEFAULT 'queued',
                initiated_at TEXT NOT NULL,
                answered_at TEXT,
                ended_at TEXT,
                duration INTEGER DEFAULT 0,
                hangup_cause TEXT,
                notes TEXT,
                xml_rendered TEXT
            );
            """)
            cur.execute("CREATE INDEX IF NOT EXISTS idx_call_logs_uuid ON call_logs(call_uuid);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_call_logs_time ON call_logs(initiated_at);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_call_logs_to ON call_logs(to_number);")

            cur.execute("""
            CREATE TABLE IF NOT EXISTS contacts (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                phone TEXT NOT NULL,
                email TEXT,
                organization TEXT,
                notes TEXT,
                group_tag TEXT,
                source TEXT DEFAULT 'manual',
                created_at TEXT NOT NULL
            );
            """)
            cur.execute("CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name);")

            # Ensure Supabase storage bucket exists
            try:
                cur.execute("""
                INSERT INTO storage.buckets (id, name, public)
                VALUES ('farmcalling-audio', 'farmcalling-audio', true)
                ON CONFLICT (id) DO NOTHING;
                """)
            except Exception:
                pass

            # Ensure 24/7 cloud cron engine via Supabase pg_cron + pg_net
            try:
                cur.execute("CREATE EXTENSION IF NOT EXISTS pg_net;")
                cur.execute("CREATE EXTENSION IF NOT EXISTS pg_cron;")
                cur.execute("SELECT jobid FROM cron.job WHERE jobname = 'farmcalling-minute-heartbeat' LIMIT 1;")
                if not cur.fetchone():
                    target_url = "https://farmcalling2.vercel.app/api/cron"
                    cur.execute("""
                        SELECT cron.schedule(
                            'farmcalling-minute-heartbeat',
                            '* * * * *',
                            %s
                        );
                    """, (f"SELECT net.http_get(url := '{target_url}', timeout_milliseconds := 15000);",))
                    logger.info("Successfully provisioned 24/7 cloud heartbeat job in Supabase pg_cron.")
            except Exception as e:
                logger.warning(f"Note: pg_cron setup skipped or not supported: {e}")
    else:
        conn = get_sqlite_conn()
        with conn:
            conn.execute("""
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT
            );
            """)
            conn.execute("""
            CREATE TABLE IF NOT EXISTS audio_assets (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                filename TEXT NOT NULL,
                filepath TEXT NOT NULL,
                mime_type TEXT NOT NULL,
                source_type TEXT NOT NULL,
                duration_seconds REAL DEFAULT 0,
                file_size_bytes INTEGER DEFAULT 0,
                tts_text TEXT,
                tts_voice TEXT,
                audio_bytes BLOB,
                external_url TEXT,
                created_at TEXT NOT NULL
            );
            """)
            try:
                conn.execute("ALTER TABLE audio_assets ADD COLUMN audio_bytes BLOB;")
            except Exception:
                pass
            try:
                conn.execute("ALTER TABLE audio_assets ADD COLUMN external_url TEXT;")
            except Exception:
                pass
            try:
                conn.execute("ALTER TABLE audio_assets ADD COLUMN storage_url TEXT;")
            except Exception:
                pass
            try:
                conn.execute("ALTER TABLE audio_assets ADD COLUMN s3_key TEXT;")
            except Exception:
                pass

            conn.execute("""
            CREATE TABLE IF NOT EXISTS schedules (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                to_number TEXT NOT NULL,
                schedule_type TEXT NOT NULL,
                scheduled_datetime TEXT,
                interval_value INTEGER,
                interval_unit TEXT,
                cron_expression TEXT,
                audio_id TEXT,
                play_mode TEXT DEFAULT 'audio',
                tts_message TEXT,
                loop_count INTEGER DEFAULT 1,
                status TEXT DEFAULT 'active',
                last_run_at TEXT,
                next_run_at TEXT,
                total_runs INTEGER DEFAULT 0,
                created_at TEXT NOT NULL
            );
            """)

            conn.execute("""
            CREATE TABLE IF NOT EXISTS call_logs (
                id TEXT PRIMARY KEY,
                schedule_id TEXT,
                schedule_name TEXT,
                to_number TEXT NOT NULL,
                from_number TEXT NOT NULL,
                audio_id TEXT,
                call_uuid TEXT,
                vobiz_api_id TEXT,
                status TEXT DEFAULT 'queued',
                initiated_at TEXT NOT NULL,
                answered_at TEXT,
                ended_at TEXT,
                duration INTEGER DEFAULT 0,
                hangup_cause TEXT,
                notes TEXT,
                xml_rendered TEXT
            );
            """)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_call_logs_uuid ON call_logs(call_uuid);")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_call_logs_time ON call_logs(initiated_at);")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_call_logs_to ON call_logs(to_number);")

            conn.execute("""
            CREATE TABLE IF NOT EXISTS contacts (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                phone TEXT NOT NULL,
                email TEXT,
                organization TEXT,
                notes TEXT,
                group_tag TEXT,
                source TEXT DEFAULT 'manual',
                created_at TEXT NOT NULL
            );
            """)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone);")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name);")
        conn.close()

    # Seed default settings
    default_settings = {
        "auth_id": get_env_override("auth_id") or "",
        "auth_token": get_env_override("auth_token") or "",
        "caller_id": get_env_override("caller_id") or "",
        "app_id": get_env_override("app_id") or "",
        "app_name": get_env_override("app_name") or "Voice-Campaign-App",
        "webhook_base_url": get_env_override("webhook_base_url") or "",
        "ring_timeout": get_env_override("ring_timeout") or "30",
        "time_limit": get_env_override("time_limit") or "3600",
        "machine_detection": get_env_override("machine_detection") or "false",
        "timezone": get_env_override("timezone") or "Asia/Kolkata",
        "default_audio_id": get_env_override("default_audio_id") or "",
        "tts_default_voice": get_env_override("tts_default_voice") or "WOMAN",
        "tts_default_language": get_env_override("tts_default_language") or "en-US"
    }

    for key, val in default_settings.items():
        db_execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING",
            (key, str(val))
        )

    # Purge legacy stock audio assets and heal default_audio_id setting
    try:
        db_execute("DELETE FROM audio_assets WHERE id IN ('test1-sample-id', 'farm-alert-sample-id') OR filename IN ('test1.wav', 'farm_alert.wav');")
    except Exception as e:
        logger.warning(f"Could not purge legacy stock audios: {e}")

    try:
        def_row = db_execute("SELECT value FROM settings WHERE key = 'default_audio_id';", fetch="one")
        cur_def = (def_row.get("value") or "").strip() if def_row else ""
        if cur_def in ("test1-sample-id", "farm-alert-sample-id") or (cur_def and not get_audio_asset(cur_def)):
            latest_id = get_latest_custom_audio_id() or ""
            db_execute("UPDATE settings SET value = ? WHERE key = 'default_audio_id';", (latest_id,))
    except Exception as e:
        logger.warning(f"Could not heal default_audio_id: {e}")

# --- Settings Helpers ---

def get_settings() -> Dict[str, str]:
    """
    Returns settings dictionary.
    Environment variables ALWAYS take precedence over stored database values.
    """
    rows = db_execute("SELECT key, value FROM settings", fetch="all") or []
    res = {row["key"]: row["value"] for row in rows}

    for key in ENV_SETTING_MAPPINGS:
        env_val = get_env_override(key)
        if env_val is not None:
            res[key] = env_val

    return res

def get_setting(key: str, default: str = "") -> str:
    """Gets a single setting value, checking environment variables first."""
    env_val = get_env_override(key)
    if env_val is not None:
        return env_val

    row = db_execute("SELECT value FROM settings WHERE key = ?", (key,), fetch="one")
    return row["value"] if row else default

def update_settings(updates: Dict[str, Any]):
    """Updates settings in database. Keys managed by environment variables are skipped."""
    for key, val in updates.items():
        if is_setting_env_managed(key):
            logger.info(f"Skipping database update for '{key}' because it is managed by environment variable.")
            continue
        db_execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, str(val))
        )

def ensure_supabase_cron_heartbeat(webhook_base_url: Optional[str] = None) -> bool:
    """
    Ensures pg_cron and pg_net are enabled in Supabase PostgreSQL,
    and schedules a 1-minute recurring HTTP heartbeat to /api/cron.
    Runs 24/7 in the cloud with zero dependencies on browser or local machine.
    """
    if not is_postgres():
        return False
    try:
        url = (webhook_base_url or os.environ.get("WEBHOOK_BASE_URL") or "https://farmcalling2.vercel.app").rstrip("/")
        cron_endpoint = f"{url}/api/cron"

        db_execute("CREATE EXTENSION IF NOT EXISTS pg_net;")
        db_execute("CREATE EXTENSION IF NOT EXISTS pg_cron;")

        job = db_execute("SELECT jobid, command FROM cron.job WHERE jobname = 'farmcalling-minute-heartbeat' LIMIT 1", fetch="one")
        expected_cmd = f"SELECT net.http_get(url := '{cron_endpoint}', timeout_milliseconds := 15000);"

        if not job or job.get("command") != expected_cmd:
            try:
                db_execute("SELECT cron.unschedule('farmcalling-minute-heartbeat')", fetch="none")
            except Exception:
                pass
            db_execute("""
                SELECT cron.schedule(
                    'farmcalling-minute-heartbeat',
                    '* * * * *',
                    ?
                )
            """, (expected_cmd,), fetch="none")
            logger.info(f"Registered 24/7 Supabase pg_cron heartbeat for {cron_endpoint}")
        return True
    except Exception as e:
        logger.warning(f"Note: Supabase pg_cron setup skipped or not supported: {e}")
        return False

# --- Audio Assets Helpers ---

def add_audio_asset(
    name: str,
    filename: str,
    filepath: str,
    mime_type: str,
    source_type: str,
    duration_seconds: float = 0.0,
    file_size_bytes: int = 0,
    tts_text: Optional[str] = None,
    tts_voice: Optional[str] = None,
    audio_bytes: Optional[bytes] = None,
    external_url: Optional[str] = None,
    s3_key: Optional[str] = None
) -> str:
    """Stores audio asset metadata and S3 reference in persistent Supabase PostgreSQL."""
    asset_id = str(uuid.uuid4())
    now = datetime.now().isoformat()
    clean_s3_key = s3_key or (filename if source_type != "tts" else None)
    if not external_url and clean_s3_key:
        external_url = f"https://oyqcsfdzlbldrmykoosq.supabase.co/storage/v1/object/public/farmcalling-audio/{clean_s3_key}"

    db_execute("""
        INSERT INTO audio_assets (
            id, name, filename, filepath, mime_type, source_type,
            duration_seconds, file_size_bytes, tts_text, tts_voice,
            audio_bytes, external_url, storage_url, s3_key, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        asset_id, name, filename, filepath, mime_type, source_type,
        duration_seconds, file_size_bytes, tts_text, tts_voice,
        audio_bytes, external_url, external_url, clean_s3_key, now
    ))
    # Automatically set newly uploaded/recorded audio as the system default audio in Supabase
    if source_type in ("upload", "recorded") and not name.startswith("Test "):
        try:
            update_settings({"default_audio_id": asset_id})
            logger.info(f"Set newly created audio {asset_id} ('{name}') as active default_audio_id in settings.")
        except Exception as e:
            logger.warning(f"Could not auto-set default_audio_id for {asset_id}: {e}")
    return asset_id

def get_audio_assets(include_test_stubs: bool = False) -> List[Dict[str, Any]]:
    """Returns list of audible audio assets from Supabase PostgreSQL."""
    base_filter = "WHERE id NOT IN ('test1-sample-id', 'farm-alert-sample-id') AND filename NOT IN ('test1.wav', 'farm_alert.wav')"
    if not include_test_stubs:
        base_filter += " AND (source_type = 'tts' OR file_size_bytes > 0 OR audio_bytes IS NOT NULL OR external_url IS NOT NULL OR s3_key IS NOT NULL)"
    return db_execute(f"""
        SELECT id, name, filename, filepath, mime_type, source_type,
               duration_seconds, file_size_bytes, tts_text, tts_voice,
               external_url, storage_url, s3_key,
               (audio_bytes IS NOT NULL OR s3_key IS NOT NULL OR external_url IS NOT NULL) AS has_audio_bytes,
               created_at
        FROM audio_assets
        {base_filter}
        ORDER BY created_at DESC
    """, fetch="all") or []

def get_audio_asset(asset_id: str) -> Optional[Dict[str, Any]]:
    """Returns complete audio asset record including binary audio_bytes from Supabase PostgreSQL."""
    if not asset_id:
        return None
    clean = str(asset_id).strip()
    base = clean
    for sfx in [".wav", ".mp3", ".ogg", ".webm"]:
        if base.lower().endswith(sfx):
            base = base[:-len(sfx)]
            break
    return db_execute("""
        SELECT * FROM audio_assets
        WHERE id = ? OR id = ? OR filename = ? OR filename = ? OR name = ?
        ORDER BY (audio_bytes IS NOT NULL) DESC, created_at DESC
        LIMIT 1
    """, (clean, base, clean, f"{base}.wav", clean), fetch="one")

def get_audio_bytes(asset_id: str) -> Optional[bytes]:
    """
    Retrieves raw audio bytes for an asset.
    Checks:
    1. In-memory/DB audio_bytes
    2. Supabase Storage S3 (via s3_storage)
    3. Direct public CDN fetch
    4. Local disk filepath
    """
    asset = get_audio_asset(asset_id)
    if not asset:
        return None

    b = asset.get("audio_bytes")
    if b and len(b) > 0:
        return b

    s3_key = asset.get("s3_key") or asset.get("filename")
    if s3_key and asset.get("source_type") != "tts":
        try:
            import s3_storage
            s3_data = s3_storage.get_audio_from_s3(s3_key)
            if s3_data and len(s3_data) > 0:
                return s3_data
        except Exception as e:
            logger.warning(f"Failed to fetch {s3_key} from S3: {e}")

    ext_url = asset.get("external_url") or asset.get("storage_url")
    if ext_url and ext_url.startswith("http"):
        try:
            import requests
            r = requests.get(ext_url, timeout=6)
            if r.status_code == 200 and len(r.content) > 0:
                return r.content
        except Exception as e:
            logger.warning(f"Failed to fetch {ext_url} via HTTP: {e}")

    fp = asset.get("filepath")
    if fp and os.path.exists(fp):
        try:
            with open(fp, "rb") as f:
                return f.read()
        except Exception:
            pass

    return None

def get_latest_custom_audio_id() -> Optional[str]:
    """
    Returns the ID of the most recently uploaded or recorded custom audio asset
    persisted in Supabase PostgreSQL or S3.
    """
    row = db_execute("""
        SELECT id FROM audio_assets
        WHERE (audio_bytes IS NOT NULL OR file_size_bytes > 0 OR source_type = 'tts' OR s3_key IS NOT NULL OR external_url IS NOT NULL)
          AND id NOT IN ('test1-sample-id', 'farm-alert-sample-id')
        ORDER BY created_at DESC
        LIMIT 1
    """, fetch="one")
    return row["id"] if row else None

def get_effective_audio_id(requested_id: Optional[str] = None) -> Optional[str]:
    """
    Resolves the canonical audio asset ID to play for calls.
    Order of precedence:
    1. Explicit requested_id if provided, non-empty, and valid in DB
    2. Persistent default_audio_id in settings if valid in DB
    3. Most recent custom uploaded or recorded audio in Supabase
    4. None (no prerecorded stock audios)
    """
    if requested_id:
        clean = str(requested_id).strip()
        if clean and clean.lower() not in ("", "none", "[none / system default]", "test1-sample-id", "farm-alert-sample-id"):
            asset = get_audio_asset(clean)
            if asset:
                return asset["id"]

    settings = get_settings()
    def_id = settings.get("default_audio_id", "").strip()
    if def_id and def_id not in ("", "none", "test1-sample-id", "farm-alert-sample-id"):
        asset = get_audio_asset(def_id)
        if asset:
            return asset["id"]

    latest_custom = get_latest_custom_audio_id()
    if latest_custom:
        return latest_custom

    return None

def delete_audio_asset(asset_id: str) -> bool:
    asset = get_audio_asset(asset_id)
    if not asset:
        return False
    fp = asset.get("filepath", "")
    if fp and os.path.exists(fp):
        try:
            os.remove(fp)
        except Exception:
            pass

    # Delete from Supabase Storage S3
    s3_key = asset.get("s3_key") or asset.get("filename")
    if s3_key and asset.get("source_type") != "tts":
        try:
            import s3_storage
            s3_storage.delete_audio_from_s3(s3_key)
        except Exception as e:
            logger.warning(f"Could not delete {s3_key} from S3: {e}")

    db_execute("DELETE FROM audio_assets WHERE id = ?", (asset["id"],))
    # If the deleted asset was the default_audio_id, update to latest custom or empty
    settings = get_settings()
    if settings.get("default_audio_id") == asset["id"]:
        new_def = get_latest_custom_audio_id() or ""
        update_settings({"default_audio_id": new_def})
    return True

# --- Schedules Helpers ---

def create_schedule(
    name: str,
    to_number: str,
    schedule_type: str,
    scheduled_datetime: Optional[str] = None,
    interval_value: Optional[int] = None,
    interval_unit: Optional[str] = None,
    cron_expression: Optional[str] = None,
    audio_id: Optional[str] = None,
    play_mode: str = "audio",
    tts_message: Optional[str] = None,
    loop_count: int = 1,
    next_run_at: Optional[str] = None
) -> str:
    import pytz
    ist_tz = pytz.timezone("Asia/Kolkata")
    now_ist = datetime.now(ist_tz).isoformat()
    schedule_id = str(uuid.uuid4())

    if not next_run_at:
        try:
            from scheduler import compute_next_run_ist
            next_run_at = compute_next_run_ist(
                schedule_type=schedule_type,
                cron_expression=cron_expression,
                scheduled_datetime=scheduled_datetime,
                interval_value=interval_value,
                interval_unit=interval_unit
            )
        except Exception:
            next_run_at = scheduled_datetime

    db_execute("""
        INSERT INTO schedules (
            id, name, to_number, schedule_type, scheduled_datetime,
            interval_value, interval_unit, cron_expression, audio_id,
            play_mode, tts_message, loop_count, status, next_run_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    """, (
        schedule_id, name, to_number, schedule_type, scheduled_datetime,
        interval_value, interval_unit, cron_expression, audio_id,
        play_mode, tts_message, loop_count, next_run_at, now_ist
    ))
    return schedule_id

def get_schedules(status_filter: Optional[str] = None) -> List[Dict[str, Any]]:
    if status_filter:
        return db_execute("SELECT * FROM schedules WHERE status = ? ORDER BY created_at DESC", (status_filter,), fetch="all") or []
    return db_execute("SELECT * FROM schedules ORDER BY created_at DESC", fetch="all") or []

def get_schedule(schedule_id: str) -> Optional[Dict[str, Any]]:
    return db_execute("SELECT * FROM schedules WHERE id = ?", (schedule_id,), fetch="one")

def update_schedule_status(schedule_id: str, status: str):
    db_execute("UPDATE schedules SET status = ? WHERE id = ?", (status, schedule_id))

def update_schedule_run_info(schedule_id: str, last_run_at: str, next_run_at: Optional[str]):
    db_execute("""
        UPDATE schedules 
        SET last_run_at = ?, next_run_at = ?, total_runs = total_runs + 1
        WHERE id = ?
    """, (last_run_at, next_run_at, schedule_id))

def delete_schedule(schedule_id: str):
    db_execute("DELETE FROM schedules WHERE id = ?", (schedule_id,))

# --- Call Logs Helpers ---

def create_call_log(
    to_number: str,
    from_number: str,
    schedule_id: Optional[str] = None,
    schedule_name: Optional[str] = None,
    audio_id: Optional[str] = None,
    call_uuid: Optional[str] = None,
    vobiz_api_id: Optional[str] = None,
    status: str = "queued",
    notes: Optional[str] = None,
    xml_rendered: Optional[str] = None
) -> str:
    log_id = str(uuid.uuid4())
    now = datetime.now().isoformat()
    db_execute("""
        INSERT INTO call_logs (
            id, schedule_id, schedule_name, to_number, from_number,
            audio_id, call_uuid, vobiz_api_id, status, initiated_at,
            notes, xml_rendered
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        log_id, schedule_id, schedule_name, to_number, from_number,
        audio_id, call_uuid, vobiz_api_id, status, now, notes, xml_rendered
    ))
    return log_id

def update_call_log(
    log_id: str,
    status: Optional[str] = None,
    call_uuid: Optional[str] = None,
    answered_at: Optional[str] = None,
    ended_at: Optional[str] = None,
    duration: Optional[int] = None,
    hangup_cause: Optional[str] = None,
    notes: Optional[str] = None,
    xml_rendered: Optional[str] = None
):
    updates = []
    params = []
    if status is not None:
        updates.append("status = ?")
        params.append(status)
    if call_uuid is not None:
        updates.append("call_uuid = ?")
        params.append(call_uuid)
    if answered_at is not None:
        updates.append("answered_at = ?")
        params.append(answered_at)
    if ended_at is not None:
        updates.append("ended_at = ?")
        params.append(ended_at)
    if duration is not None:
        updates.append("duration = ?")
        params.append(duration)
    if hangup_cause is not None:
        updates.append("hangup_cause = ?")
        params.append(hangup_cause)
    if notes is not None:
        updates.append("notes = ?")
        params.append(notes)
    if xml_rendered is not None:
        updates.append("xml_rendered = ?")
        params.append(xml_rendered)

    if updates:
        params.append(log_id)
        sql = f"UPDATE call_logs SET {', '.join(updates)} WHERE id = ?"
        db_execute(sql, tuple(params))

def get_call_log_by_uuid(call_uuid: str) -> Optional[Dict[str, Any]]:
    if not call_uuid:
        return None
    return db_execute("""
        SELECT * FROM call_logs
        WHERE call_uuid = ? OR vobiz_api_id = ?
        ORDER BY initiated_at DESC LIMIT 1
    """, (call_uuid.strip(), call_uuid.strip()), fetch="one")

def update_call_log_by_uuid(
    call_uuid: str,
    status: Optional[str] = None,
    answered_at: Optional[str] = None,
    ended_at: Optional[str] = None,
    duration: Optional[int] = None,
    hangup_cause: Optional[str] = None,
    notes: Optional[str] = None,
    to_number: Optional[str] = None,
    from_number: Optional[str] = None,
    request_uuid: Optional[str] = None
):
    if not call_uuid and not request_uuid:
        return

    # Check if record exists in database
    target_uuid = call_uuid or request_uuid
    existing = get_call_log_by_uuid(target_uuid)
    if not existing and request_uuid and request_uuid != call_uuid:
        existing = get_call_log_by_uuid(request_uuid)

    if existing:
        log_id = existing["id"]
        update_call_log(
            log_id=log_id,
            status=status,
            call_uuid=call_uuid or existing.get("call_uuid"),
            answered_at=answered_at,
            ended_at=ended_at,
            duration=duration,
            hangup_cause=hangup_cause,
            notes=notes
        )
    else:
        # Guarantee every single call is stored into PostgreSQL call_logs
        now = datetime.now().isoformat()
        create_call_log(
            to_number=to_number or "Incoming/Direct",
            from_number=from_number or "Vobiz",
            call_uuid=call_uuid,
            vobiz_api_id=request_uuid,
            status=status or "completed",
            notes=notes or f"Auto-captured ({hangup_cause or 'Call Ended'})"
        )

def get_call_logs(limit: int = 100) -> List[Dict[str, Any]]:
    return db_execute("SELECT * FROM call_logs ORDER BY initiated_at DESC LIMIT ?", (limit,), fetch="all") or []

def get_call_stats() -> Dict[str, Any]:
    t_row = db_execute("SELECT COUNT(*) as c FROM call_logs", fetch="one")
    total = t_row["c"] if t_row else 0

    c_row = db_execute("SELECT COUNT(*) as c FROM call_logs WHERE status = 'completed'", fetch="one")
    completed = c_row["c"] if c_row else 0

    f_row = db_execute("SELECT COUNT(*) as c FROM call_logs WHERE status IN ('failed', 'busy', 'no-answer')", fetch="one")
    failed = f_row["c"] if f_row else 0

    d_row = db_execute("SELECT SUM(duration) as s FROM call_logs", fetch="one")
    total_duration = d_row["s"] if d_row and d_row["s"] is not None else 0

    a_row = db_execute("SELECT COUNT(*) as c FROM schedules WHERE status = 'active'", fetch="one")
    active_schedules = a_row["c"] if a_row else 0

    return {
        "total_calls": total,
        "completed_calls": completed,
        "failed_calls": failed,
        "total_duration_sec": total_duration,
        "active_schedules": active_schedules
    }

# --- Contacts Helpers ---

def create_contact(
    name: str,
    phone: str,
    email: Optional[str] = None,
    organization: Optional[str] = None,
    notes: Optional[str] = None,
    group_tag: Optional[str] = "Default",
    source: str = "manual"
) -> str:
    contact_id = str(uuid.uuid4())
    now = datetime.now().isoformat()
    db_execute("""
        INSERT INTO contacts (
            id, name, phone, email, organization, notes, group_tag, source, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        contact_id, name.strip(), phone.strip(),
        (email or "").strip() or None,
        (organization or "").strip() or None,
        (notes or "").strip() or None,
        (group_tag or "Default").strip(),
        source,
        now
    ))
    return contact_id

def bulk_create_contacts(
    contacts_list: List[Dict[str, Any]],
    update_duplicates: bool = True
) -> Dict[str, int]:
    """
    Bulk inserts a list of contacts with deduplication by phone number.
    Returns summary: {"total": int, "added": int, "updated": int, "skipped": int}
    """
    added = 0
    updated = 0
    skipped = 0
    now = datetime.now().isoformat()

    for c in contacts_list:
        phone = str(c.get("phone", "")).strip()
        if not phone:
            skipped += 1
            continue

        name = str(c.get("name", "")).strip() or phone
        email = str(c.get("email", "")).strip() or None
        org = str(c.get("organization", "")).strip() or None
        notes = str(c.get("notes", "")).strip() or None
        group_tag = str(c.get("group_tag", "Imported")).strip() or "Imported"
        source = str(c.get("source", "vcf")).strip()

        # Check existing contact by phone
        existing = get_contact_by_phone(phone)
        if existing:
            if update_duplicates:
                upd_fields = []
                params = []
                if name and name != phone and (not existing.get("name") or existing.get("name") == phone):
                    upd_fields.append("name = ?")
                    params.append(name)
                if email and not existing.get("email"):
                    upd_fields.append("email = ?")
                    params.append(email)
                if org and not existing.get("organization"):
                    upd_fields.append("organization = ?")
                    params.append(org)
                if group_tag and group_tag != existing.get("group_tag"):
                    upd_fields.append("group_tag = ?")
                    params.append(group_tag)

                if upd_fields:
                    params.append(existing["id"])
                    db_execute(f"UPDATE contacts SET {', '.join(upd_fields)} WHERE id = ?", tuple(params))
                    updated += 1
                else:
                    skipped += 1
            else:
                skipped += 1
        else:
            cid = str(uuid.uuid4())
            db_execute("""
                INSERT INTO contacts (
                    id, name, phone, email, organization, notes, group_tag, source, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (cid, name, phone, email, org, notes, group_tag, source, now))
            added += 1

    return {"total": len(contacts_list), "added": added, "updated": updated, "skipped": skipped}

def get_contacts(
    search_query: Optional[str] = None,
    group_filter: Optional[str] = None,
    limit: int = 2000
) -> List[Dict[str, Any]]:
    sql = "SELECT * FROM contacts"
    clauses = []
    params = []

    if group_filter and group_filter != "All":
        clauses.append("group_tag = ?")
        params.append(group_filter)

    if search_query and search_query.strip():
        q = f"%{search_query.strip().lower()}%"
        clauses.append("(LOWER(name) LIKE ? OR LOWER(phone) LIKE ? OR LOWER(COALESCE(organization, '')) LIKE ? OR LOWER(COALESCE(email, '')) LIKE ? OR LOWER(COALESCE(group_tag, '')) LIKE ? OR LOWER(COALESCE(notes, '')) LIKE ?)")
        params.extend([q, q, q, q, q, q])

    if clauses:
        sql += " WHERE " + " AND ".join(clauses)

    sql += " ORDER BY created_at DESC LIMIT ?"
    params.append(limit)

    return db_execute(sql, tuple(params), fetch="all") or []

def get_contact(contact_id: str) -> Optional[Dict[str, Any]]:
    return db_execute("SELECT * FROM contacts WHERE id = ? LIMIT 1", (contact_id,), fetch="one")

def get_contact_by_phone(phone: str) -> Optional[Dict[str, Any]]:
    return db_execute("SELECT * FROM contacts WHERE phone = ? LIMIT 1", (phone.strip(),), fetch="one")

def update_contact(contact_id: str, fields: Dict[str, Any]) -> bool:
    allowed = ["name", "phone", "email", "organization", "notes", "group_tag"]
    updates = []
    params = []
    for k, v in fields.items():
        if k in allowed:
            updates.append(f"{k} = ?")
            params.append(v)
    if not updates:
        return False
    params.append(contact_id)
    db_execute(f"UPDATE contacts SET {', '.join(updates)} WHERE id = ?", tuple(params))
    return True

def delete_contact(contact_id: str) -> bool:
    db_execute("DELETE FROM contacts WHERE id = ?", (contact_id,))
    return True

def delete_contacts(contact_ids: List[str]) -> int:
    if not contact_ids:
        return 0
    placeholders = ", ".join(["?"] * len(contact_ids))
    db_execute(f"DELETE FROM contacts WHERE id IN ({placeholders})", tuple(contact_ids))
    return len(contact_ids)

def bulk_update_contact_group(contact_ids: List[str], new_group: str) -> int:
    """Updates group_tag for a list of contacts."""
    if not contact_ids or not new_group or not new_group.strip():
        return 0
    placeholders = ", ".join(["?"] * len(contact_ids))
    params = [new_group.strip()] + list(contact_ids)
    db_execute(f"UPDATE contacts SET group_tag = ? WHERE id IN ({placeholders})", tuple(params))
    return len(contact_ids)

def find_duplicate_contacts() -> List[Dict[str, Any]]:
    """
    Scans the contacts table for duplicate phone numbers.
    Returns list of duplicate groups with their full contact records.
    """
    rows = db_execute("""
        SELECT phone, COUNT(*) as cnt
        FROM contacts
        WHERE phone IS NOT NULL AND phone != ''
        GROUP BY phone
        HAVING COUNT(*) > 1
        ORDER BY cnt DESC
    """, fetch="all") or []

    results = []
    for r in rows:
        phone = r["phone"]
        dups = db_execute("SELECT * FROM contacts WHERE phone = ? ORDER BY created_at DESC", (phone,), fetch="all") or []
        results.append({
            "phone": phone,
            "count": r["cnt"],
            "contacts": dups
        })
    return results

def deduplicate_contacts(strategy: str = "merge_into_newest") -> Dict[str, Any]:
    """
    Deduplicates contacts by normalized phone number.
    - 'merge_into_newest': keeps the newest record as primary, fills in missing fields
      (name, email, organization, notes, group_tag) from older duplicates, then deletes older duplicates.
    - 'keep_oldest': keeps the oldest record as primary, fills in missing fields from newer duplicates,
      then deletes newer duplicates.
    Returns summary: {"duplicate_groups": int, "removed_count": int, "retained_count": int}
    """
    dup_groups = find_duplicate_contacts()
    if not dup_groups:
        return {"duplicate_groups": 0, "removed_count": 0, "retained_count": 0}

    total_removed = 0
    total_retained = 0

    for group in dup_groups:
        contacts_in_group = group["contacts"]
        if len(contacts_in_group) < 2:
            continue

        if strategy == "keep_oldest":
            primary = contacts_in_group[-1]
            others = contacts_in_group[:-1]
        else:
            primary = contacts_in_group[0]
            others = contacts_in_group[1:]

        upd = {}
        for other in others:
            if not primary.get("name") or primary["name"] == primary["phone"]:
                if other.get("name") and other["name"] != other["phone"]:
                    primary["name"] = other["name"]
                    upd["name"] = other["name"]
            if not primary.get("email") and other.get("email"):
                primary["email"] = other["email"]
                upd["email"] = other["email"]
            if not primary.get("organization") and other.get("organization"):
                primary["organization"] = other["organization"]
                upd["organization"] = other["organization"]
            if not primary.get("notes") and other.get("notes"):
                primary["notes"] = other["notes"]
                upd["notes"] = other["notes"]
            if (not primary.get("group_tag") or primary["group_tag"] in ("Default", "General", "Bulk-Import")) and other.get("group_tag") and other["group_tag"] not in ("Default", "General", "Bulk-Import"):
                primary["group_tag"] = other["group_tag"]
                upd["group_tag"] = other["group_tag"]

        if upd:
            update_contact(primary["id"], upd)

        to_remove_ids = [o["id"] for o in others]
        if to_remove_ids:
            delete_contacts(to_remove_ids)
            total_removed += len(to_remove_ids)

        total_retained += 1

    return {
        "duplicate_groups": len(dup_groups),
        "removed_count": total_removed,
        "retained_count": total_retained
    }

def clear_all_contacts() -> bool:
    db_execute("DELETE FROM contacts")
    return True

def get_contacts_count() -> int:
    row = db_execute("SELECT COUNT(*) as c FROM contacts", fetch="one")
    return row["c"] if row else 0

def get_contact_groups() -> List[str]:
    rows = db_execute("SELECT DISTINCT group_tag FROM contacts WHERE group_tag IS NOT NULL AND group_tag != ''", fetch="all") or []
    groups = [r["group_tag"] for r in rows if r.get("group_tag")]
    return sorted(list(set(groups)))

def format_vobiz_recipients(numbers: Any) -> str:
    """
    Normalizes phone numbers into canonical Vobiz bulk-dial format separated by '<'.
    Accepts string, list, or tuple.
    Handles delimiters: '<', ',', ';', newlines, carriage returns.
    Strips whitespace and ensures unique numbers preserving order.
    """
    if not numbers:
        return ""
    if isinstance(numbers, str):
        items = [numbers]
    else:
        items = list(numbers)

    cleaned = []
    seen = set()
    for item in items:
        if not item:
            continue
        raw_parts = str(item).replace("\r", "\n").replace(";", "\n").replace(",", "\n").replace("<", "\n").split("\n")
        for part in raw_parts:
            num = part.strip()
            if num and num not in seen:
                seen.add(num)
                cleaned.append(num)

    return "<".join(cleaned)

# Initialize database schema on startup
init_db()
