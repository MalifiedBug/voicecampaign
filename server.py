"""
FastAPI Server for Voice Campaign (Vercel Serverless Ready).
Provides:
- Web dashboard at /
- Audio streaming endpoints for Vobiz (<Play> URL)
- Answer Webhook endpoint (returns VobizXML)
- Hangup Webhook endpoint (logs duration, status, hangup cause)
- Vercel Cron endpoint at /api/cron for scheduled dialer
- REST API for dashboard controls
"""

import os
import time
import threading
import logging
from datetime import datetime
from typing import Optional, List, Dict, Any
from fastapi import FastAPI, Request, Response, HTTPException, Query, Form, UploadFile, File
from fastapi.responses import FileResponse, PlainTextResponse, JSONResponse, HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from database import (
    init_db,
    get_audio_asset,
    get_audio_assets,
    delete_audio_asset,
    get_latest_custom_audio_id,
    get_effective_audio_id,
    get_schedule,
    get_schedules,
    create_schedule,
    delete_schedule,
    get_setting,
    get_settings,
    update_settings,
    is_setting_env_managed,
    is_vobiz_env_configured,
    get_env_managed_keys,
    update_call_log_by_uuid,
    create_call_log,
    update_call_log,
    get_call_logs,
    get_call_stats,
    create_contact,
    bulk_create_contacts,
    get_contacts,
    get_contact,
    delete_contact,
    clear_all_contacts,
    get_contacts_count,
    add_audio_asset
)
from audio_manager import save_uploaded_audio, save_recorded_audio, create_tts_asset
from vcf_parser import parse_vcf_bytes, export_contacts_to_vcf
from vobiz_client import VobizClient

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("voicecampaign.server")

# Ensure DB is initialized
init_db()

app = FastAPI(title="Voice Campaign Telephony Platform", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
if not os.path.exists(STATIC_DIR):
    for _cand in [
        os.path.join(os.getcwd(), "static"),
        os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static")
    ]:
        if os.path.exists(_cand):
            STATIC_DIR = _cand
            break

# --- Opportunistic Background Dispatcher ---
# Evaluates due schedules in IST whenever incoming traffic hits the server
_last_opportunistic_check = 0.0

def run_due_schedules_check():
    """Worker that evaluates and triggers active schedules in Indian Standard Time (IST)."""
    try:
        from scheduler import execute_call_job, is_schedule_due_now
        active_schedules = get_schedules(status_filter="active")
        for s in active_schedules:
            if is_schedule_due_now(s):
                logger.info(f"Opportunistic Dispatcher triggering due campaign in IST: {s.get('name')} ({s.get('id')})")
                execute_call_job(s["id"])
    except Exception as e:
        logger.warning(f"Opportunistic check encountered error: {e}")

@app.middleware("http")
async def opportunistic_cron_middleware(request: Request, call_next):
    global _last_opportunistic_check
    now_ts = time.time()
    path = request.url.path
    # Trigger background evaluation if > 25 seconds elapsed and not a media/static fetch
    if (now_ts - _last_opportunistic_check > 25) and not path.startswith("/audio") and not path.startswith("/static"):
        _last_opportunistic_check = now_ts
        threading.Thread(target=run_due_schedules_check, daemon=True).start()

    response = await call_next(request)
    return response

# --- Web UI ---
@app.get("/", response_class=HTMLResponse)
@app.get("/api/index", response_class=HTMLResponse)
@app.get("/api/index/", response_class=HTMLResponse)
def index_page():
    index_path = os.path.join(STATIC_DIR, "index.html")
    if os.path.exists(index_path):
        with open(index_path, "r", encoding="utf-8") as f:
            return f.read()
    return "<h1>Voice Campaign API is running</h1>"

@app.get("/health")
def health_check():
    from database import get_db_mode, is_postgres
    return {
        "status": "healthy",
        "service": "Voice Campaign Telephony Engine",
        "database_backend": get_db_mode(),
        "is_supabase_postgres": is_postgres(),
        "vercel_serverless": bool(os.environ.get("VERCEL")),
        "timestamp": datetime.now().isoformat()
    }

@app.get("/api/db/status")
def api_db_status():
    """Returns database backend connection and table telemetry for verification."""
    from database import get_db_mode, is_postgres, db_execute, get_audio_assets, get_schedules
    stats = {}
    try:
        stats["backend"] = get_db_mode()
        stats["is_supabase_postgres"] = is_postgres()
        stats["schedules_count"] = len(get_schedules())
        stats["audio_assets_count"] = len(get_audio_assets())
        c_row = db_execute("SELECT count(*) as c FROM call_logs", fetch="one")
        stats["call_logs_count"] = c_row["c"] if c_row else 0
        s_row = db_execute("SELECT count(*) as c FROM settings", fetch="one")
        stats["settings_count"] = s_row["c"] if s_row else 0
        stats["status"] = "connected"
    except Exception as e:
        stats["status"] = "error"
        stats["error"] = str(e)
    return stats

# --- Audio Serving ---
@app.api_route("/audio/{asset_id}", methods=["GET", "HEAD"])
def serve_audio(asset_id: str, request: Request):
    """
    High-reliability audio streaming endpoint for Vobiz (<Play> URL).
    Supports HTTP Range requests (206 Partial Content) required by telephony media gateways.
    Tiers:
    1. Database BLOB bytes (in-memory, works across any serverless instance)
    2. Filepath on disk (temporary or bundled)
    3. Bundled static audio (/static/audio/test1.wav, farm_alert.wav)
    4. Fallback chime (never returns 404 to Vobiz so calls never drop in silence)
    """
    logger.info(f"Serving audio request for asset_id: {asset_id}")

    # Strip extensions to obtain canonical asset ID
    clean_id = asset_id.strip()
    base_id = clean_id
    for sfx in [".wav", ".mp3", ".ogg", ".webm"]:
        if base_id.lower().endswith(sfx):
            base_id = base_id[:-len(sfx)]
            break

    def make_byte_response(data: bytes, m_type: str, f_name: str) -> Response:
        """Helper to create standard or 206 Partial Content responses based on Range header."""
        total_len = len(data)
        range_header = request.headers.get("range")
        if range_header and range_header.startswith("bytes="):
            try:
                ranges = range_header[6:].split("-")
                start = int(ranges[0]) if ranges[0] else 0
                end = int(ranges[1]) if len(ranges) > 1 and ranges[1] else total_len - 1
                end = min(end, total_len - 1)
                if start <= end < total_len:
                    sliced = data[start:end+1]
                    return Response(
                        content=sliced,
                        status_code=206,
                        media_type=m_type,
                        headers={
                            "Accept-Ranges": "bytes",
                            "Content-Range": f"bytes {start}-{end}/{total_len}",
                            "Content-Length": str(len(sliced)),
                            "Content-Disposition": f'inline; filename="{f_name}"',
                            "Cache-Control": "public, max-age=120"
                        }
                    )
            except Exception as ex:
                logger.warning(f"Failed parsing Range '{range_header}': {ex}")

        return Response(
            content=data,
            media_type=m_type,
            headers={
                "Accept-Ranges": "bytes",
                "Content-Length": str(total_len),
                "Content-Disposition": f'inline; filename="{f_name}"',
                "Cache-Control": "public, max-age=120"
            }
        )

    # Tier 1: Look up in database by base_id or clean_id
    asset = get_audio_asset(base_id) or get_audio_asset(clean_id)
    if asset:
        # 1a. If raw audio_bytes BLOB exists in DB, serve directly from memory
        raw_bytes = asset.get("audio_bytes")

        # 1b. If not in DB, retrieve directly from Supabase Storage S3
        if not raw_bytes or len(raw_bytes) == 0:
            s3_key = asset.get("s3_key") or asset.get("filename")
            if s3_key and asset.get("source_type") != "tts":
                try:
                    import s3_storage
                    raw_bytes = s3_storage.get_audio_from_s3(s3_key)
                except Exception as e:
                    logger.warning(f"Could not load audio from S3 for {s3_key}: {e}")

        if raw_bytes and len(raw_bytes) > 0:
            if raw_bytes.startswith(b"RIFF"):
                mime_type = "audio/wav"
                filename = f"{base_id}.wav"
                try:
                    from audio_manager import normalize_wav_bytes
                    raw_bytes = normalize_wav_bytes(raw_bytes)
                except Exception as e:
                    logger.warning(f"Failed to normalize WAV bytes: {e}")
            elif raw_bytes.startswith(b"ID3") or (len(raw_bytes) > 2 and raw_bytes[0] == 0xFF and (raw_bytes[1] & 0xE0) == 0xE0):
                mime_type = "audio/mpeg"
                filename = f"{base_id}.mp3"
            else:
                mime_type = asset.get("mime_type", "audio/wav")
                filename = asset.get("filename", f"{base_id}.wav")

            return make_byte_response(raw_bytes, mime_type, filename)

        # 1c. If filepath on disk exists
        fp = asset.get("filepath", "")
        if fp and os.path.exists(fp):
            try:
                with open(fp, "rb") as f:
                    disk_bytes = f.read()
                if disk_bytes.startswith(b"RIFF"):
                    from audio_manager import normalize_wav_bytes
                    disk_bytes = normalize_wav_bytes(disk_bytes)
                    return make_byte_response(disk_bytes, "audio/wav", f"{base_id}.wav")
                elif disk_bytes.startswith(b"ID3") or (len(disk_bytes) > 2 and disk_bytes[0] == 0xFF and (disk_bytes[1] & 0xE0) == 0xE0):
                    return make_byte_response(disk_bytes, "audio/mpeg", f"{base_id}.mp3")
                else:
                    return make_byte_response(disk_bytes, asset.get("mime_type", "audio/wav"), asset.get("filename", f"{base_id}.wav"))
            except Exception as e:
                logger.warning(f"Error reading audio file from {fp}: {e}")

        # 1c. Try resolving filename in static/audio, data/audio, or /tmp/audio
        fname = asset.get("filename", "")
        if fname:
            for c_dir in [
                os.path.join(STATIC_DIR, "audio"),
                os.path.join(os.path.dirname(__file__), "data", "audio"),
                "/tmp/audio"
            ]:
                candidate = os.path.join(c_dir, fname)
                if os.path.exists(candidate):
                    with open(candidate, "rb") as f:
                        b = f.read()
                    m = "audio/wav" if candidate.endswith(".wav") else "audio/mpeg"
                    return make_byte_response(b, m, fname)

    # Tier 2: Check if asset_id is a direct filename (e.g. "test1.wav", "test1", "farm_alert.wav")
    candidates = [clean_id]
    if not clean_id.endswith(".wav") and not clean_id.endswith(".mp3"):
        candidates.extend([f"{clean_id}.wav", f"{clean_id}.mp3"])

    for c_name in candidates:
        for c_dir in [
            os.path.join(STATIC_DIR, "audio"),
            os.path.join(os.path.dirname(__file__), "data", "audio"),
            "/tmp/audio"
        ]:
            candidate = os.path.join(c_dir, c_name)
            if os.path.exists(candidate):
                with open(candidate, "rb") as f:
                    b = f.read()
                mtype = "audio/wav" if candidate.endswith(".wav") else "audio/mpeg"
                return make_byte_response(b, mtype, c_name)

    # Tier 3: If specific asset was not found, check if active custom audio exists in Supabase
    fallback_aid = get_effective_audio_id()
    if fallback_aid and fallback_aid != clean_id and fallback_aid != base_id:
        fb_asset = get_audio_asset(fallback_aid)
        if fb_asset:
            fb_bytes = fb_asset.get("audio_bytes")
            if fb_bytes and len(fb_bytes) > 0:
                logger.info(f"Serving active custom audio fallback '{fallback_aid}' for missing request '{asset_id}'")
                m_type = "audio/wav" if fb_bytes.startswith(b"RIFF") else "audio/mpeg"
                return make_byte_response(fb_bytes, m_type, f"{fallback_aid}.wav")

    # Tier 4: Fallback to most recent custom audio in Supabase, or clean silence WAV (never 404 to Vobiz)
    latest_aid = get_latest_custom_audio_id()
    if latest_aid and latest_aid != clean_id and latest_aid != base_id:
        latest_asset = get_audio_asset(latest_aid)
        if latest_asset:
            lb = latest_asset.get("audio_bytes")
            if lb and len(lb) > 0:
                logger.info(f"Serving latest custom audio '{latest_aid}' for missing asset '{asset_id}'")
                m_type = "audio/wav" if lb.startswith(b"RIFF") else "audio/mpeg"
                return make_byte_response(lb, m_type, f"{latest_aid}.wav")

    # If no custom audio exists, synthesize a standard 0.5s 16kHz PCM silence WAV
    import wave, io
    silence_io = io.BytesIO()
    with wave.open(silence_io, 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        wf.writeframes(b"\x00\x00" * 8000)
    return make_byte_response(silence_io.getvalue(), "audio/wav", "silence.wav")

# --- Vobiz Webhooks ---
@app.api_route("/webhook/answer", methods=["GET", "POST"])
async def answer_webhook(
    request: Request,
    schedule_id: Optional[str] = Query(None),
    audio_id: Optional[str] = Query(None),
    play_mode: Optional[str] = Query(None),
    loop: Optional[int] = Query(None)
):
    form_data = {}
    if request.method == "POST":
        try:
            raw_form = await request.form()
            form_data = dict(raw_form)
        except Exception:
            pass

    call_uuid = form_data.get("CallUUID") or request.query_params.get("CallUUID", "")
    from_num = form_data.get("From") or request.query_params.get("From", "")
    to_num = form_data.get("To") or request.query_params.get("To", "")

    # Auto-resolve base_url dynamically from incoming request if not configured
    settings = get_settings()
    base_url = settings.get("webhook_base_url", "").rstrip("/")
    if not base_url or "example.com" in base_url or "localhost" in base_url or "127.0.0.1" in base_url:
        host_header = request.headers.get("x-forwarded-host") or request.headers.get("host")
        if host_header:
            proto = request.headers.get("x-forwarded-proto", "https")
            base_url = f"{proto}://{host_header}"
        else:
            v_url = os.environ.get("VERCEL_PROJECT_PRODUCTION_URL") or os.environ.get("VERCEL_URL")
            if v_url:
                base_url = f"https://{v_url}" if not v_url.startswith("http") else v_url

    schedule = get_schedule(schedule_id) if schedule_id else None
    raw_aid = audio_id or (schedule.get("audio_id") if schedule else None)
    target_audio_id = get_effective_audio_id(raw_aid)
    target_play_mode = play_mode or (schedule.get("play_mode") if schedule else "audio")
    raw_loop = loop if loop is not None else (schedule.get("loop_count", 1) if schedule else 1)
    target_loop = max(1, min(int(raw_loop or 1), 10))

    xml_content = ""

    if target_play_mode == "tts" and schedule and schedule.get("tts_message"):
        tts_text = schedule.get("tts_message")
        voice = settings.get("tts_default_voice", "WOMAN")
        lang = settings.get("tts_default_language", "en-US")
        xml_content = VobizClient.generate_speak_xml(tts_text, voice=voice, language=lang, loop=target_loop)
    elif target_audio_id:
        clean_aid = str(target_audio_id).strip()
        if clean_aid.startswith("http://") or clean_aid.startswith("https://"):
            xml_content = VobizClient.generate_play_xml(clean_aid, loop=target_loop)
        else:
            base_aid = clean_aid
            for sfx in [".wav", ".mp3"]:
                if base_aid.lower().endswith(sfx):
                    base_aid = base_aid[:-len(sfx)]
                    break

            asset = get_audio_asset(base_aid) or get_audio_asset(clean_aid)
            if asset and asset.get("source_type") == "tts" and asset.get("tts_text"):
                voice = asset.get("tts_voice") or settings.get("tts_default_voice", "WOMAN")
                xml_content = VobizClient.generate_speak_xml(asset["tts_text"], voice=voice, loop=target_loop)
            else:
                ext = ".wav"
                if asset:
                    m = asset.get("mime_type", "")
                    if "mpeg" in m or "mp3" in m:
                        ext = ".mp3"
                    raw = asset.get("audio_bytes")
                    if raw:
                        if raw.startswith(b"RIFF"):
                            ext = ".wav"
                        elif raw.startswith(b"ID3") or (len(raw) > 2 and raw[0] == 0xFF and (raw[1] & 0xE0) == 0xE0):
                            ext = ".mp3"
                s3_url = asset.get("external_url") or asset.get("storage_url") if asset else None
                if s3_url and s3_url.startswith("http"):
                    audio_public_url = s3_url
                elif clean_aid.endswith(".wav") or clean_aid.endswith(".mp3"):
                    audio_public_url = f"{base_url}/audio/{clean_aid}"
                else:
                    audio_public_url = f"{base_url}/audio/{clean_aid}{ext}"
                xml_content = VobizClient.generate_play_xml(audio_public_url, loop=target_loop)
    else:
        # No audio_id requested: resolve canonical active custom audio or speak TTS prompt
        eff_id = get_effective_audio_id()
        eff_asset = get_audio_asset(eff_id) if eff_id else None
        if eff_asset and eff_asset.get("source_type") == "tts" and eff_asset.get("tts_text"):
            voice = eff_asset.get("tts_voice") or "WOMAN"
            xml_content = VobizClient.generate_speak_xml(eff_asset["tts_text"], voice=voice, loop=target_loop)
        elif eff_id:
            s3_url = eff_asset.get("external_url") or eff_asset.get("storage_url") if eff_asset else None
            if s3_url and s3_url.startswith("http"):
                audio_public_url = s3_url
            else:
                audio_public_url = f"{base_url}/audio/{eff_id}.wav"
            xml_content = VobizClient.generate_play_xml(audio_public_url, loop=target_loop)
        else:
            xml_content = VobizClient.generate_speak_xml("Hello, this is Voice Campaign. Your automated call is connected.", voice="WOMAN", loop=1)

    if call_uuid:
        update_call_log_by_uuid(
            call_uuid=call_uuid,
            status="in-progress",
            answered_at=datetime.now().isoformat(),
            notes="Call answered. VobizXML dispatched.",
            to_number=to_num,
            from_number=from_num
        )

    return Response(content=xml_content, media_type="application/xml; charset=utf-8")

@app.api_route("/webhook/hangup", methods=["GET", "POST"])
async def hangup_webhook(request: Request):
    form_data = {}
    if request.method == "POST":
        try:
            raw_form = await request.form()
            form_data = dict(raw_form)
        except Exception:
            pass

    call_uuid = form_data.get("CallUUID") or request.query_params.get("CallUUID", "")
    request_uuid = form_data.get("RequestUUID") or request.query_params.get("RequestUUID", "")
    from_num = form_data.get("From") or request.query_params.get("From", "")
    to_num = form_data.get("To") or request.query_params.get("To", "")
    call_status = form_data.get("CallStatus") or request.query_params.get("CallStatus", "completed")
    duration_str = form_data.get("Duration") or request.query_params.get("Duration", "0")
    hangup_cause = form_data.get("HangupCause") or request.query_params.get("HangupCause", "NORMAL_CLEARING")

    try:
        duration = int(duration_str)
    except ValueError:
        duration = 0

    if call_uuid or request_uuid:
        final_status = "completed"
        if hangup_cause in ["USER_BUSY", "CALL_REJECTED"]:
            final_status = "busy"
        elif hangup_cause in ["NO_ANSWER", "ORIGINATOR_CANCEL"]:
            final_status = "no-answer"
        elif "FAIL" in hangup_cause.upper() or "ERROR" in hangup_cause.upper():
            final_status = "failed"

        update_call_log_by_uuid(
            call_uuid=call_uuid,
            status=final_status,
            ended_at=datetime.now().isoformat(),
            duration=duration,
            hangup_cause=hangup_cause,
            notes=f"Call hung up with {hangup_cause} ({duration}s)",
            to_number=to_num,
            from_number=from_num,
            request_uuid=request_uuid
        )

    return JSONResponse(content={"status": "acknowledged", "call_uuid": call_uuid})

# --- Vercel Cron Endpoint ---
@app.get("/api/cron")
@app.get("/cron")
@app.post("/api/cron")
@app.post("/api/cron/trigger")
def vercel_cron_handler():
    """
    Invoked periodically by external runners (GitHub Actions, cron-job.org, browser heartbeat, Vercel Cron).
    Evaluates schedules with high precision using Indian Standard Time (Asia/Kolkata, UTC+5:30).
    """
    from scheduler import execute_call_job, is_schedule_due_now
    import pytz
    tz = pytz.timezone("Asia/Kolkata")
    now_ist = datetime.now(tz)
    now_iso = now_ist.isoformat()

    # Record heartbeat in settings
    try:
        update_settings({"last_cron_ping_at": now_iso})
    except Exception:
        pass

    schedules = get_schedules(status_filter="active")
    triggered = []

    for s in schedules:
        try:
            if is_schedule_due_now(s):
                logger.info(f"Cron executing due schedule in IST: {s['name']} ({s['id']})")
                execute_call_job(s["id"])
                triggered.append({
                    "id": s["id"],
                    "name": s.get("name"),
                    "to": s.get("to_number")
                })
        except Exception as e:
            logger.error(f"Error evaluating schedule {s.get('id')}: {e}")

    return {
        "status": "success",
        "current_time_ist": now_ist.strftime("%Y-%m-%d %H:%M:%S %Z"),
        "timezone": "Asia/Kolkata (IST)",
        "total_active_schedules": len(schedules),
        "triggered_count": len(triggered),
        "triggered_schedules": triggered,
        "last_ping_recorded": now_iso
    }

@app.get("/api/cron/status")
def api_cron_status():
    """Returns real-time status of automated campaign heartbeat and external pingers."""
    settings = get_settings()
    last_ping = settings.get("last_cron_ping_at")
    active_schedules = get_schedules(status_filter="active")
    import pytz
    tz = pytz.timezone("Asia/Kolkata")
    now_ist = datetime.now(tz)

    diff_seconds = None
    is_alive = False
    if last_ping:
        try:
            last_dt = datetime.fromisoformat(last_ping)
            if last_dt.tzinfo is None:
                last_dt = tz.localize(last_dt)
            diff_seconds = int((now_ist - last_dt).total_seconds())
            # Considered alive if triggered within the last 6 minutes (matching GitHub Actions 5m interval)
            is_alive = diff_seconds <= 360
        except Exception:
            pass

    base_url = settings.get("webhook_base_url", "https://farmcalling2.vercel.app").rstrip("/")
    return {
        "is_active": is_alive,
        "last_ping_at": last_ping,
        "seconds_since_last_ping": diff_seconds,
        "active_schedules_count": len(active_schedules),
        "cron_webhook_url": f"{base_url}/api/cron",
        "current_time_ist": now_ist.strftime("%Y-%m-%d %H:%M:%S %Z")
    }

# --- REST API for Dashboard ---

@app.get("/api/stats")
def api_get_stats():
    return get_call_stats()

@app.get("/api/calls")
def api_get_calls(limit: int = 50):
    return get_call_logs(limit=limit)

class InstantCallPayload(BaseModel):
    to_number: str
    audio_id: Optional[str] = None
    play_mode: Optional[str] = "audio"
    tts_message: Optional[str] = None
    loop_count: Optional[int] = 1
    base_url: Optional[str] = None

@app.post("/api/calls/instant")
def api_trigger_instant_call(request: Request, payload: InstantCallPayload):
    from scheduler import trigger_call_now

    # Auto-resolve the exact public HTTPS domain from request or payload
    host = request.headers.get("x-forwarded-host") or request.headers.get("host")
    proto = request.headers.get("x-forwarded-proto", "https")
    detected_base = payload.base_url or (f"{proto}://{host}" if host else None)

    p_mode = "tts" if payload.tts_message else (payload.play_mode or "audio")
    loops = max(1, min(int(payload.loop_count or 1), 10))
    success, msg, data = trigger_call_now(
        to_number=payload.to_number,
        audio_id=payload.audio_id,
        play_mode=p_mode,
        tts_message=payload.tts_message,
        loop_count=loops,
        schedule_name="Instant Dial",
        base_url_override=detected_base
    )
    return {"success": success, "message": msg, "data": data}

@app.get("/api/schedules")
def api_get_schedules():
    return get_schedules()

class CreateSchedulePayload(BaseModel):
    name: str
    to_number: str
    schedule_type: str
    scheduled_datetime: Optional[str] = None
    interval_value: Optional[int] = None
    interval_unit: Optional[str] = None
    cron_expression: Optional[str] = None
    audio_id: Optional[str] = None
    play_mode: Optional[str] = "audio"
    tts_message: Optional[str] = None
    loop_count: Optional[int] = 1

@app.post("/api/schedules")
def api_create_schedule(payload: CreateSchedulePayload):
    from scheduler import register_schedule_job, compute_next_run_ist
    loops = max(1, min(int(payload.loop_count or 1), 10))
    sched_id = create_schedule(
        name=payload.name.strip(),
        to_number=payload.to_number.strip(),
        schedule_type=payload.schedule_type,
        scheduled_datetime=payload.scheduled_datetime,
        interval_value=payload.interval_value,
        interval_unit=payload.interval_unit,
        cron_expression=payload.cron_expression,
        audio_id=payload.audio_id,
        play_mode=payload.play_mode or "audio",
        tts_message=payload.tts_message,
        loop_count=loops
    )

    next_run_ist = register_schedule_job(sched_id)
    if not next_run_ist:
        next_run_ist = compute_next_run_ist(
            schedule_type=payload.schedule_type,
            cron_expression=payload.cron_expression,
            scheduled_datetime=payload.scheduled_datetime,
            interval_value=payload.interval_value,
            interval_unit=payload.interval_unit
        )

    return {
        "success": True,
        "schedule_id": sched_id,
        "status": "active",
        "next_run_at": next_run_ist,
        "timezone": "Asia/Kolkata (IST)",
        "message": f"Schedule '{payload.name}' activated in IST! Next call: {next_run_ist or 'Scheduled'}"
    }

@app.delete("/api/schedules/{schedule_id}")
def api_delete_schedule(schedule_id: str):
    delete_schedule(schedule_id)
    return {"success": True}

@app.post("/api/schedules/{schedule_id}/run")
def api_run_schedule(schedule_id: str):
    from scheduler import execute_call_job
    execute_call_job(schedule_id)
    return {"success": True}

@app.get("/api/audio")
def api_get_audio():
    return get_audio_assets()

class PresignedUploadRequest(BaseModel):
    filename: str
    mime_type: Optional[str] = "audio/wav"
    file_size: Optional[int] = None

class ConfirmS3UploadRequest(BaseModel):
    name: str
    filename: str
    s3_key: str
    mime_type: Optional[str] = "audio/wav"
    file_size_bytes: Optional[int] = 0
    duration_seconds: Optional[float] = 0.0
    set_as_default: Optional[bool] = True

@app.post("/api/audio/request-upload-url")
def api_request_upload_url(req: PresignedUploadRequest):
    """
    Generates a presigned S3 upload URL allowing direct-to-cloud uploads.
    Bypasses Vercel Serverless Function 4.5MB request payload limit (HTTP 413).
    """
    try:
        import s3_storage
        success, upload_url, s3_key, public_url = s3_storage.create_presigned_upload_url(
            filename=req.filename,
            mime_type=req.mime_type or "audio/wav"
        )
        if success and upload_url:
            return {
                "success": True,
                "upload_url": upload_url,
                "s3_key": s3_key,
                "public_url": public_url,
                "bucket": s3_storage.get_s3_config()["bucket"]
            }
    except Exception as e:
        logger.error(f"Error creating presigned upload url: {e}")

    return {"success": False, "message": "Direct S3 presigned upload not available"}

@app.post("/api/audio/confirm-s3-upload")
def api_confirm_s3_upload(req: ConfirmS3UploadRequest):
    """
    Registers an audio asset that was uploaded directly from browser to Supabase S3.
    """
    import s3_storage
    public_url = s3_storage.get_s3_public_url(req.s3_key)

    aid = add_audio_asset(
        name=req.name or req.filename,
        filename=req.filename,
        filepath=f"s3://{req.s3_key}",
        mime_type=req.mime_type or "audio/wav",
        source_type="uploaded",
        duration_seconds=float(req.duration_seconds or 0.0),
        file_size_bytes=int(req.file_size_bytes or 0),
        audio_bytes=None,  # Preserved in S3 object store
        external_url=public_url,
        s3_key=req.s3_key
    )

    if req.set_as_default:
        try:
            update_settings({"default_audio_id": aid})
        except Exception as e:
            logger.warning(f"Could not update default_audio_id: {e}")

    return {
        "success": True,
        "audio_id": aid,
        "external_url": public_url,
        "name": req.name
    }

@app.post("/api/audio/upload")
async def api_upload_audio(audio_file: UploadFile = File(...), name: Optional[str] = Form(None)):
    content = await audio_file.read()
    aid = save_uploaded_audio(
        file_name=audio_file.filename,
        file_bytes=content,
        custom_name=name or audio_file.filename
    )
    # Immediately make the new upload the default audio prompt for calls
    try:
        update_settings({"default_audio_id": aid})
    except Exception as e:
        logger.warning(f"Could not update default_audio_id: {e}")
    return {"success": True, "audio_id": aid}

@app.post("/api/audio/{asset_id}/set-default")
def api_set_default_audio(asset_id: str):
    asset = get_audio_asset(asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="Audio asset not found")
    update_settings({"default_audio_id": asset["id"]})
    return {"success": True, "default_audio_id": asset["id"]}

@app.delete("/api/audio/{asset_id}")
def api_delete_audio(asset_id: str):
    delete_audio_asset(asset_id)
    return {"success": True}

@app.get("/api/settings")
def api_get_settings():
    s = get_settings()
    env_keys = get_env_managed_keys()
    is_prod_env = is_vobiz_env_configured()
    res = dict(s)
    if "auth_token" in env_keys:
        res["auth_token"] = "••••••••••••••••"
    res["_env_managed_keys"] = env_keys
    res["_is_production_env"] = is_prod_env
    return res

@app.post("/api/settings")
def api_save_settings(data: Dict[str, Any]):
    env_keys = get_env_managed_keys()
    clean_data = {}
    for k, v in data.items():
        if k in env_keys:
            continue
        if k == "auth_token" and ("••••" in str(v) or not str(v).strip()):
            continue
        clean_data[k] = v
    if clean_data:
        update_settings(clean_data)
    return {"success": True, "updated_keys": list(clean_data.keys())}

@app.post("/api/settings/verify")
def api_verify_settings():
    s = get_settings()
    client = VobizClient(s.get("auth_id", ""), s.get("auth_token", ""))
    success, msg, data = client.test_connection()
    return {"success": success, "message": msg, "data": data}

@app.post("/api/settings/create-app")
def api_create_app():
    s = get_settings()
    client = VobizClient(s.get("auth_id", ""), s.get("auth_token", ""))
    base_url = s.get("webhook_base_url", "").rstrip("/")
    if not base_url or "example.com" in base_url:
        return {"success": False, "message": "Please configure a valid Public Webhook Base URL."}

    app_name = s.get("app_name", "Voice-Campaign-App")
    success, msg, data = client.create_application(
        app_name=app_name,
        answer_url=f"{base_url}/webhook/answer",
        hangup_url=f"{base_url}/webhook/hangup"
    )
    if success:
        app_id = data.get("app_id", "")
        update_settings({"app_id": app_id})
    return {"success": success, "message": msg, "data": data}

# --- REST API for Contacts & .vcf Bulk Upload ---

class CreateContactPayload(BaseModel):
    name: str
    phone: str
    email: Optional[str] = None
    organization: Optional[str] = None
    notes: Optional[str] = None
    group_tag: Optional[str] = "Default"

@app.get("/api/contacts")
def api_get_contacts(search: Optional[str] = None, group: Optional[str] = None, limit: int = 1000):
    return {
        "total": get_contacts_count(),
        "contacts": get_contacts(search_query=search, group_filter=group, limit=limit)
    }

@app.post("/api/contacts")
def api_create_contact(payload: CreateContactPayload):
    cid = create_contact(
        name=payload.name,
        phone=payload.phone,
        email=payload.email,
        organization=payload.organization,
        notes=payload.notes,
        group_tag=payload.group_tag or "Default",
        source="manual"
    )
    return {"success": True, "contact_id": cid}

@app.post("/api/contacts/upload-vcf")
async def api_upload_vcf(
    vcf_file: UploadFile = File(...),
    group_tag: Optional[str] = Form("Bulk-Import"),
    default_country_code: Optional[str] = Form("+91"),
    update_duplicates: Optional[bool] = Form(True)
):
    content = await vcf_file.read()
    contacts = parse_vcf_bytes(
        file_bytes=content,
        default_country_code=default_country_code or "+91",
        default_group=group_tag or "Bulk-Import"
    )
    if not contacts:
        return {
            "success": False,
            "message": "No valid contacts with dialable phone numbers could be extracted from this .vcf file.",
            "total_parsed": 0,
            "summary": {"total": 0, "added": 0, "updated": 0, "skipped": 0}
        }

    summary = bulk_create_contacts(contacts, update_duplicates=bool(update_duplicates))
    return {
        "success": True,
        "message": f"Successfully parsed and populated {summary['added']} new contacts (updated {summary['updated']}).",
        "total_parsed": len(contacts),
        "summary": summary,
        "contacts": contacts[:50]
    }

@app.get("/api/contacts/export-vcf")
def api_export_vcf():
    contacts = get_contacts(limit=5000)
    vcf_text = export_contacts_to_vcf(contacts)
    return Response(
        content=vcf_text,
        media_type="text/vcard",
        headers={"Content-Disposition": 'attachment; filename="contacts.vcf"'}
    )

@app.delete("/api/contacts/{contact_id}")
def api_delete_contact(contact_id: str):
    delete_contact(contact_id)
    return {"success": True}

@app.delete("/api/contacts")
def api_clear_contacts():
    clear_all_contacts()
    return {"success": True}

@app.get("/api/contacts/duplicates")
def api_get_duplicates():
    from database import find_duplicate_contacts
    dups = find_duplicate_contacts()
    return {
        "success": True,
        "duplicate_groups_count": len(dups),
        "total_duplicates": sum(g["count"] - 1 for g in dups),
        "groups": dups
    }

@app.post("/api/contacts/deduplicate")
def api_deduplicate(strategy: Optional[str] = "merge_into_newest"):
    from database import deduplicate_contacts
    res = deduplicate_contacts(strategy=strategy or "merge_into_newest")
    return {"success": True, "summary": res}

class BulkContactActionPayload(BaseModel):
    contact_ids: List[str]
    group_tag: Optional[str] = None

@app.post("/api/contacts/bulk-delete")
def api_bulk_delete_contacts(payload: BulkContactActionPayload):
    from database import delete_contacts
    cnt = delete_contacts(payload.contact_ids)
    return {"success": True, "deleted_count": cnt}

@app.post("/api/contacts/bulk-group")
def api_bulk_group_contacts(payload: BulkContactActionPayload):
    from database import bulk_update_contact_group
    if not payload.group_tag:
        raise HTTPException(status_code=400, detail="group_tag is required")
    cnt = bulk_update_contact_group(payload.contact_ids, payload.group_tag)
    return {"success": True, "updated_count": cnt}

