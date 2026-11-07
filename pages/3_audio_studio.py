"""
Audio Studio Page: Record via Microphone, Upload MP3/WAV, or Generate TTS Prompts.
"""

import streamlit as st
import os
from datetime import datetime

from audio_manager import (
    save_uploaded_audio,
    save_recorded_audio,
    create_tts_asset,
    get_audio_assets,
    delete_audio_asset,
    get_asset_url
)
from database import get_settings, update_settings, get_audio_bytes, get_effective_audio_id
import s3_storage

st.title("🎙️ Audio Studio & Voice Library")
st.caption("Record custom voice announcements from your microphone, upload audio tracks, or configure Text-to-Speech.")

# Supabase Storage S3 Status Check
with st.expander("☁️ Supabase Cloud Storage (S3) Connectivity", expanded=False):
    s3_ok, s3_msg, s3_info = s3_storage.test_s3_connection()
    if s3_ok:
        st.success(f"✅ {s3_msg}")
        st.caption(f"• **Endpoint:** `{s3_info.get('endpoint')}`  \n• **Region:** `{s3_info.get('region')}`  \n• **Target Bucket:** `{s3_info.get('bucket')}`  \n• **Public CDN:** `{s3_storage.get_s3_config().get('public_base')}`")
    else:
        st.warning(f"⚠️ {s3_msg}")

settings = get_settings()
base_url = settings.get("webhook_base_url", "https://api.example.com")
default_audio_id = get_effective_audio_id()

tab_rec, tab_up, tab_tts = st.tabs(["🎤 Record Microphone", "📁 Upload Audio File", "🗣️ Text-to-Speech (TTS)"])

# TAB 1: Record Microphone
with tab_rec:
    st.subheader("Record Voice Prompt using Microphone")
    st.markdown("Click the microphone button below to record your voice message directly in the browser.")

    rec_name = st.text_input("Recording Name", placeholder="e.g. Cold Wave Alert for Vegetables", key="rec_name_input")
    audio_record = st.audio_input("Record your voice prompt", key="mic_recorder_input")

    # Preserve recorded bytes into session state so widget reruns don't flush the recording
    if audio_record is not None:
        raw_rec_bytes = audio_record.getvalue() if hasattr(audio_record, "getvalue") else audio_record.read()
        if raw_rec_bytes and len(raw_rec_bytes) > 0:
            st.session_state["mic_recorded_bytes"] = raw_rec_bytes
            st.session_state["mic_recorded_type"] = getattr(audio_record, "type", "audio/wav")

    cached_rec_bytes = st.session_state.get("mic_recorded_bytes")

    if cached_rec_bytes:
        st.write("🎧 Preview your recording:")
        rec_type = st.session_state.get("mic_recorded_type", "audio/wav")
        st.audio(cached_rec_bytes, format=rec_type)
        st.caption(f"Captured: `{round(len(cached_rec_bytes) / 1024, 1)} KB` audio ready to store.")

        col_save_btn, col_discard_btn = st.columns([2, 1])
        with col_save_btn:
            if st.button("💾 Save Recording to Audio Library", type="primary", key="save_rec_btn", use_container_width=True):
                r_name = rec_name.strip() if rec_name.strip() else f"Voice Recording {datetime.now().strftime('%b %d %H:%M')}"
                hint = "wav"
                if "webm" in rec_type:
                    hint = "webm"
                elif "ogg" in rec_type:
                    hint = "ogg"
                elif "mp3" in rec_type or "mpeg" in rec_type:
                    hint = "mp3"

                with st.spinner("Uploading audio to Supabase Storage S3 bucket..."):
                    asset_id = save_recorded_audio(audio_bytes=cached_rec_bytes, custom_name=r_name, format_hint=hint)
                    update_settings({"default_audio_id": asset_id})

                st.session_state.pop("mic_recorded_bytes", None)
                st.session_state.pop("mic_recorded_type", None)
                st.success(f"🎉 Recording **'{r_name}'** securely saved to Supabase S3 bucket and set as active prompt! (ID: `{asset_id[:8]}...`)")
                st.rerun()

        with col_discard_btn:
            if st.button("🗑️ Discard Recording", key="discard_rec_btn", use_container_width=True):
                st.session_state.pop("mic_recorded_bytes", None)
                st.session_state.pop("mic_recorded_type", None)
                st.rerun()

# TAB 2: Upload Audio File
with tab_up:
    st.subheader("Upload Pre-Recorded Audio File")
    st.markdown("Upload standard **MP3** or **WAV** telephony audio files. Mono 8kHz / 16kHz audio recommended.")

    custom_name = st.text_input("Audio Clip Label", placeholder="e.g. Fertilizer Subsidy Broadcast", key="upload_name_input")
    uploaded_file = st.file_uploader("Choose an audio file", type=["mp3", "wav"], key="uploader_widget")

    if uploaded_file is not None:
        file_bytes = uploaded_file.getvalue() if hasattr(uploaded_file, "getvalue") else uploaded_file.read()
        st.write("🎧 Audio Preview:")
        st.audio(file_bytes, format=getattr(uploaded_file, "type", "audio/wav"))

        if st.button("💾 Save Audio to Library", type="primary", key="save_up_btn", use_container_width=True):
            c_name = custom_name.strip() if custom_name.strip() else uploaded_file.name
            with st.spinner("Processing & uploading to Supabase Storage S3 bucket..."):
                asset_id = save_uploaded_audio(
                    file_name=uploaded_file.name,
                    file_bytes=file_bytes,
                    custom_name=c_name
                )
                update_settings({"default_audio_id": asset_id})
            st.success(f"🎉 Audio **'{c_name}'** uploaded to Supabase S3 bucket and set as active prompt! (ID: `{asset_id[:8]}...`)")
            st.rerun()

# TAB 3: Text-to-Speech Studio
with tab_tts:
    st.subheader("Text-to-Speech (TTS) Synthesizer")
    st.markdown("Vobiz natively converts text to voice inside the phone call using `<Speak>` XML verbs.")

    tts_label = st.text_input("TTS Preset Label", placeholder="e.g. Daily Market Price Alert", key="tts_label_input")
    col_v, col_l = st.columns(2)
    with col_v:
        tts_voice = st.selectbox("Voice Tone", ["WOMAN", "MAN"], index=0)
    with col_l:
        tts_lang = st.selectbox("Language / Accent", ["en-US", "en-IN", "hi-IN", "en-GB"], index=1)

    tts_content = st.text_area(
        "Voice Script Text",
        value="Attention all farmers: Today's wholesale market price for tomatoes is 25 rupees per kilogram. Thank you and have a great harvest.",
        height=100
    )

    with st.expander("🔍 View Generated VobizXML"):
        st.code(f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Speak voice="{tts_voice}" language="{tts_lang}">{tts_content}</Speak>
    <Hangup/>
</Response>""", language="xml")

    if st.button("💾 Save TTS Template to Library", type="primary", key="save_tts_btn"):
        if not tts_content.strip():
            st.error("Please enter a voice script.")
        else:
            t_name = tts_label.strip() if tts_label.strip() else f"TTS {tts_voice} ({tts_lang})"
            asset_id = create_tts_asset(name=t_name, text=tts_content.strip(), voice=tts_voice)
            st.success(f"TTS Template '{t_name}' saved to library!")
            st.rerun()

# Section 4: Audio Library & Player
st.markdown("---")
col_lib_header, col_lib_ref = st.columns([3, 1])
with col_lib_header:
    st.subheader("📚 Saved Voice Library")
with col_lib_ref:
    st.write("")
    if st.button("🔄 Refresh Library", use_container_width=True):
        st.rerun()

with st.spinner("Loading audio tracks from Supabase S3..."):
    assets = get_audio_assets()

if not assets:
    st.info("No audio tracks in your library yet. Record or upload one above.")
else:
    for asset in assets:
        with st.container(border=True):
            col_info, col_player, col_actions = st.columns([1.5, 2, 1.2])

            with col_info:
                st.markdown(f"**{asset['name']}**")
                is_default = (asset["id"] == default_audio_id)
                if is_default:
                    st.success("⭐ **ACTIVE CALL PROMPT**", icon="🎯")
                else:
                    st.caption("Available Audio Track")
                
                size_kb = round(asset.get("file_size_bytes", 0) / 1024, 1)
                storage_tag = "☁️ Supabase S3" if asset.get("external_url") else f"Source: `{asset['source_type'].upper()}`"
                st.caption(f"{storage_tag} | Size: `{size_kb} KB` | Format: `{asset['mime_type']}`")
                if asset.get("duration_seconds", 0) > 0:
                    st.caption(f"Duration: `{asset['duration_seconds']}s`")

            with col_player:
                pub_url = get_asset_url(asset["id"], base_url)
                if asset["source_type"] == "tts":
                    st.markdown(f"🗣️ *\"{asset.get('tts_text', '')}\"*")
                else:
                    # Stream audio directly from Supabase Storage S3 or bytes
                    s3_cdn_url = asset.get("external_url") or asset.get("storage_url")
                    a_bytes = get_audio_bytes(asset["id"])
                    if s3_cdn_url and s3_cdn_url.startswith("http"):
                        st.audio(s3_cdn_url, format=asset.get("mime_type", "audio/wav"))
                        st.caption(f"☁️ S3 CDN: `{s3_cdn_url[:65]}...`")
                    elif a_bytes and len(a_bytes) > 0:
                        st.audio(a_bytes, format=asset.get("mime_type", "audio/wav"))
                        st.caption(f"Vobiz Stream URL: `{pub_url}`")
                    elif os.path.exists(asset.get("filepath", "")):
                        st.audio(asset["filepath"])
                        st.caption(f"Vobiz Stream URL: `{pub_url}`")
                    else:
                        st.caption("⚠️ Audio file not found.")

            with col_actions:
                if not is_default:
                    if st.button("⭐ Set Default", key=f"def_{asset['id']}"):
                        update_settings({"default_audio_id": asset["id"]})
                        st.success("Set as default audio!")
                        st.rerun()
                
                if st.button("🗑️ Delete", key=f"del_aud_{asset['id']}"):
                    delete_audio_asset(asset["id"])
                    if is_default:
                        update_settings({"default_audio_id": ""})
                    st.success("Audio deleted.")
                    st.rerun()

