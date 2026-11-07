"""
Dashboard Page: Live Telephony Operations, KPIs, and Instant Call Launcher.
"""

import streamlit as st
import pandas as pd
from datetime import datetime
import requests

from database import (
    get_call_stats,
    get_call_logs,
    get_schedules,
    get_audio_assets,
    get_audio_asset,
    get_effective_audio_id,
    get_settings,
    get_contacts,
    get_contact_groups,
    format_vobiz_recipients
)
from scheduler import trigger_call_now

st.title("📞 Telephony Operations Dashboard")
st.caption("Monitor automated outbound campaigns, inspect real-time metrics, and trigger instant calls.")

# 1. KPI Metrics
with st.spinner("Loading telemetry metrics and live call stats..."):
    stats = get_call_stats()
col1, col2, col3, col4, col5 = st.columns(5)

total_calls = stats["total_calls"]
completed = stats["completed_calls"]
failed = stats["failed_calls"]
success_rate = round((completed / total_calls * 100), 1) if total_calls > 0 else 0.0

with col1:
    st.metric(label="Total Outbound Calls", value=total_calls)
with col2:
    st.metric(label="Completed Calls", value=completed, delta=f"{success_rate}% success")
with col3:
    st.metric(label="Failed / Busy", value=failed, delta_color="inverse")
with col4:
    st.metric(label="Total Call Time", value=f"{stats['total_duration_sec']}s")
with col5:
    st.metric(label="Active Schedules", value=stats["active_schedules"])

st.markdown("---")

# 2. Main content: Two Columns (Instant Dialer + Active Schedules)
left_col, right_col = st.columns([1.1, 0.9])

with left_col:
    st.subheader("⚡ Instant Call Launcher")
    st.markdown("Place a live test call immediately with your recorded audio or text-to-speech prompt.")

    settings = get_settings()
    configured = bool(settings.get("auth_id") and settings.get("auth_token") and settings.get("caller_id"))

    if not configured:
        st.warning("⚠️ Vobiz credentials or Outbound Caller ID not configured. Please visit **Settings** to set up your Auth ID and phone number.")

    # Check for incoming numbers from Contacts Directory
    passed_dial_num = st.session_state.pop("instant_dial_number", "")

    with st.spinner("Loading contacts directory..."):
        all_contacts_quick = get_contacts(limit=500)
    has_contacts = len(all_contacts_quick) > 0

    recipient_mode = st.radio(
        "Recipient Selection Method",
        ["👥 Select from Contacts Directory", "✏️ Enter Phone Number(s) Manually"] if has_contacts else ["✏️ Enter Phone Number(s) Manually"],
        horizontal=True,
        key="dash_recipient_mode"
    )

    compiled_numbers = ""

    if has_contacts and recipient_mode == "👥 Select from Contacts Directory":
        groups = get_contact_groups()
        col_grp_f, col_quick_btns = st.columns([1.5, 1.5])
        with col_grp_f:
            selected_grp = st.selectbox("Filter by Group", ["All Groups"] + groups, key="dash_contact_grp") if groups else "All Groups"

        filtered_c = all_contacts_quick if selected_grp == "All Groups" else [c for c in all_contacts_quick if c.get("group_tag") == selected_grp]
        contact_map = {f"{c['name']} ({c['phone']})" + (f" • {c.get('group_tag')}" if c.get("group_tag") else ""): c['phone'] for c in filtered_c}

        # Initialize session state for selected contact labels
        if "dash_selected_contact_labels" not in st.session_state:
            st.session_state["dash_selected_contact_labels"] = []

        with col_quick_btns:
            st.write("")
            col_b1, col_b2 = st.columns(2)
            with col_b1:
                if st.button("Select All", key="dash_sel_all_btn", use_container_width=True):
                    st.session_state["dash_selected_contact_labels"] = list(contact_map.keys())
                    st.rerun()
            with col_b2:
                if st.button("Clear", key="dash_clear_sel_btn", use_container_width=True):
                    st.session_state["dash_selected_contact_labels"] = []
                    st.rerun()

        chosen_labels = st.multiselect(
            "Select Recipient Contact(s)",
            options=list(contact_map.keys()),
            default=[l for l in st.session_state["dash_selected_contact_labels"] if l in contact_map],
            key="dash_contact_multiselect",
            placeholder="Search by contact name or phone number..."
        )
        st.session_state["dash_selected_contact_labels"] = chosen_labels

        chosen_phones = [contact_map[lbl] for lbl in chosen_labels if lbl in contact_map]
        compiled_numbers = format_vobiz_recipients(chosen_phones)

        if chosen_phones:
            if len(chosen_phones) == 1:
                st.success(f"🎯 **1 Recipient Selected:** `{chosen_phones[0]}`")
            else:
                st.success(f"🎯 **{len(chosen_phones)} Recipients Selected for Bulk Dispatch:** `{compiled_numbers[:65]}{'...' if len(compiled_numbers) > 65 else ''}`")
        else:
            st.caption("ℹ️ Select one or multiple contacts above to dial.")

    with st.form("instant_call_form", clear_on_submit=False):
        if recipient_mode == "👥 Select from Contacts Directory" and has_contacts:
            to_phone = st.text_input(
                "Destination Phone Number(s) (Formatted for Vobiz)",
                value=compiled_numbers,
                placeholder="+919876543210 (or separate multiple with <)",
                help="Vobiz accepts single numbers or bulk recipients separated by '<' (e.g. +919876543210<+919876543211)"
            )
        else:
            to_phone = st.text_input(
                "Destination Phone Number(s) (E.164 format)",
                value=passed_dial_num,
                placeholder="+919876543210 or separate multiple with < or comma",
                help="Enter one or more numbers. Multiple numbers can be separated by '<' or comma."
            )

        audio_assets = get_audio_assets()
        effective_aid = get_effective_audio_id()
        audio_options = {}

        # Pre-select currently active default prompt at the very top
        eff_asset = get_audio_asset(effective_aid) if effective_aid else None
        if eff_asset:
            eff_label = f"⭐ Active Prompt: {eff_asset['name']} ({eff_asset['source_type'].upper()})"
            audio_options[eff_label] = eff_asset["id"]

        # Add all other tracks
        for a in audio_assets:
            if a["id"] != effective_aid:
                label = f"{a['name']} ({a['source_type'].upper()} - {a['duration_seconds']}s)"
                audio_options[label] = a["id"]

        if not audio_options:
            audio_options = {"No custom audio recorded (Use TTS or record in Audio Studio)": ""}

        selected_audio_label = st.selectbox("Select Audio Prompt to Play", list(audio_options.keys()))
        selected_audio_id = audio_options[selected_audio_label]

        play_mode = st.radio("Playback Type", ["Audio File", "Custom Text-to-Speech (TTS)"], horizontal=True)

        tts_message = ""
        if play_mode == "Custom Text-to-Speech (TTS)":
            tts_message = st.text_area(
                "Text-to-Speech Script",
                value="Hello! This is a test alert from Voice Campaign. Have a productive day! Goodbye.",
                height=80
            )

        loops = st.number_input("Audio Repeat Count (Loop)", min_value=1, max_value=10, value=1, help="Number of times to play audio before cutting call (1 - 10)")

        submitted = st.form_submit_button("🚀 Dial Recipient(s) Now", width="stretch", type="primary")

    if submitted:
        clean_to = format_vobiz_recipients(to_phone)
        if not clean_to:
            st.error("Please enter or select at least one valid destination phone number.")
        else:
            dest_count = len(clean_to.split("<"))
            with st.status(f"Initiating Outbound Call ({dest_count} recipient{'s' if dest_count > 1 else ''}) via Vobiz API...", expanded=True) as status_box:
                st.write(f"Connecting to Vobiz API using Caller ID: `{settings.get('caller_id')}`")
                st.write(f"Dialing destination(s): `{clean_to[:70]}{'...' if len(clean_to) > 70 else ''}`")

                p_mode = "tts" if play_mode == "Custom Text-to-Speech (TTS)" else "audio"
                success, msg, data = trigger_call_now(
                    to_number=clean_to,
                    audio_id=selected_audio_id,
                    play_mode=p_mode,
                    tts_message=tts_message,
                    loop_count=loops,
                    schedule_name="Instant Test Call"
                )

                if success:
                    call_uuid = data.get("request_uuid") or data.get("api_id")
                    st.write(f"Call UUID: `{call_uuid}`")
                    st.write("Vobiz accepted the request. Destination will ring shortly.")
                    status_box.update(label=f"✅ Call Dispatched to {dest_count} Recipient(s)!", state="complete", expanded=False)
                    st.success(f"Success! {msg}")
                else:
                    st.write(f"Error details: {msg}")
                    status_box.update(label="❌ Call Dispatch Failed", state="error", expanded=True)
                    st.error(f"Call dispatch failed: {msg}")

with right_col:
    st.subheader("📅 Active Schedules")
    with st.spinner("Fetching active campaigns..."):
        active_scheds = get_schedules(status_filter="active")

    if not active_scheds:
        st.info("No active schedules found. Create your first automated campaign in the **Schedules** page.")
    else:
        for s in active_scheds[:4]:
            with st.container(border=True):
                col_a, col_b = st.columns([2, 1])
                with col_a:
                    st.markdown(f"**{s['name']}**")
                    st.caption(f"Target: `{s['to_number']}` | Type: `{s['schedule_type'].capitalize()}`")
                with col_b:
                    st.caption(f"Runs: **{s['total_runs']}**")
                    if s.get("next_run_at"):
                        st.caption(f"Next: {s['next_run_at'].replace('T', ' ')[:16]}")
                    elif s.get("scheduled_datetime"):
                        st.caption(f"At: {s['scheduled_datetime'].replace('T', ' ')[:16]}")

# 3. Recent Call Activity
st.markdown("---")
col_log_h1, col_log_h2 = st.columns([3, 1])
with col_log_h1:
    st.subheader("📋 Recent Call Logs")
    st.caption("Real-time telemetry loaded directly from the database.")
with col_log_h2:
    st.write("")
    if st.button("🔄 Refresh Logs from DB", key="dash_refresh_logs", use_container_width=True):
        st.cache_data.clear()
        st.rerun()

with st.spinner("Fetching latest call telemetry..."):
    logs = get_call_logs(limit=15)
if not logs:
    st.info("No call logs recorded in database yet. Dial a number above or schedule a campaign to see live records.")
else:
    table_data = []
    for log in logs:
        status_icon = "🟢" if log["status"] == "completed" else ("🟡" if log["status"] in ["ringing", "in-progress"] else "🔴")
        table_data.append({
            "Status": f"{status_icon} {log['status'].upper()}",
            "Destination": log["to_number"],
            "Campaign / Schedule": log.get("schedule_name") or "Instant Call",
            "Duration": f"{log.get('duration', 0)}s",
            "Hangup Cause": log.get("hangup_cause") or "-",
            "Time": log["initiated_at"].replace("T", " ")[:19]
        })

    df_logs = pd.DataFrame(table_data)
    st.dataframe(df_logs, width="stretch", hide_index=True)

