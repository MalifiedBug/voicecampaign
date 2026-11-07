"""
Contacts Page: Upload Bulk Contacts via .vcf (vCard), Manage Directory, and Launch Campaigns.
Supports vCard 2.1, 3.0, 4.0, Google Contacts, iPhone/iCloud, and Outlook address books.
"""

import streamlit as st
import pandas as pd
import io
from datetime import datetime
from typing import List, Dict, Any

from database import (
    create_contact,
    bulk_create_contacts,
    get_contacts,
    get_contact,
    delete_contact,
    delete_contacts,
    clear_all_contacts,
    get_contacts_count,
    get_contact_groups,
    get_settings,
    find_duplicate_contacts,
    deduplicate_contacts,
    bulk_update_contact_group
)
from vcf_parser import (
    parse_vcf_bytes,
    parse_vcf_text,
    normalize_phone_number,
    export_contacts_to_vcf
)
from scheduler import trigger_call_now

st.title("👥 Contacts & Audience Directory")
st.caption("Upload bulk contacts from `.vcf` (vCard) files, organize your target audience, and launch targeted voice campaigns.")

# Caching helpers
@st.cache_data(ttl=30)
def fetch_contacts_cached(search: str = "", group: str = "All"):
    return get_contacts(search_query=search or None, group_filter=group or None, limit=2000)

@st.cache_data(ttl=30)
def fetch_groups_cached():
    return get_contact_groups()

# Initialize session state for selections
if "selected_contact_phones" not in st.session_state:
    st.session_state["selected_contact_phones"] = []

# Top-level KPI Telemetry
with st.spinner("Loading contacts & audience directory from Supabase..."):
    total_contacts = get_contacts_count()
    groups = fetch_groups_cached()
    all_contacts = fetch_contacts_cached()
    unique_phones = len(set(c["phone"] for c in all_contacts if c.get("phone")))
    vcf_imports = len([c for c in all_contacts if c.get("source") == "vcf"])

col1, col2, col3, col4 = st.columns(4)
with col1:
    st.metric(label="Total Contacts", value=total_contacts)
with col2:
    st.metric(label="Dialable Phone Numbers", value=unique_phones)
with col3:
    st.metric(label="Audience Groups", value=len(groups))
with col4:
    st.metric(label="Imported via .vcf", value=vcf_imports)

st.markdown("---")

# Main Navigation Tabs: Upload .vcf, Directory, Add Single Contact
tab_upload, tab_directory, tab_manual = st.tabs([
    "📁 Upload Bulk Contacts (.vcf)",
    "📇 Contacts Directory",
    "➕ Add Contact Manually"
])

# ==============================================================================
# TAB 1: UPLOAD BULK CONTACTS VIA .VCF FILE
# ==============================================================================
with tab_upload:
    st.subheader("Bulk Import via .vcf (vCard) File")
    st.markdown(
        "Upload a `.vcf` / `.vcard` file exported from **Android, iPhone, Google Contacts, Outlook, WhatsApp, or iCloud**. "
        "The system will parse all contacts, extract phone numbers, decode character sets, and populate your directory."
    )

    with st.container(border=True):
        col_up1, col_up2 = st.columns([2, 1])
        with col_up1:
            uploaded_file = st.file_uploader(
                "Select .vcf or .vcard File",
                type=["vcf", "vcard"],
                help="Accepts single or multi-contact vCard address books"
            )
        with col_up2:
            default_cc = st.selectbox(
                "Default Country Code",
                ["+91 (India)", "+1 (US / Canada)", "+44 (UK)", "+61 (Australia)", "+971 (UAE)", "None / Keep Raw"],
                index=0,
                help="Applied to local 10-digit numbers missing a country prefix"
            )
            cc_code = default_cc.split(" ")[0] if default_cc.startswith("+") else "+91"

            custom_group = st.text_input(
                "Assign to Group / Tag",
                value="Bulk-Import",
                help="Tag these contacts for targeted campaign segmentation (e.g., 'Farmers-Zone-1', 'Clients')"
            )

        update_dups = st.checkbox(
            "Update existing contacts if phone number matches (Enrich details)",
            value=True,
            help="If unchecked, duplicate phone numbers will be skipped"
        )

        if uploaded_file is not None:
            file_bytes = uploaded_file.read()
            # Parse contacts
            with st.spinner("Parsing vCard records..."):
                parsed_contacts = parse_vcf_bytes(
                    file_bytes=file_bytes,
                    default_country_code=cc_code,
                    default_group=custom_group.strip() or "Imported"
                )

            if not parsed_contacts:
                st.error("No valid contacts with dialable phone numbers could be extracted from this file. Please ensure the .vcf contains valid 'TEL' records.")
            else:
                st.success(f"✅ Found **{len(parsed_contacts)} dialable contact record(s)** in `{uploaded_file.name}`!")

                # Preview parsed contacts
                preview_df = pd.DataFrame(parsed_contacts)[["name", "phone", "organization", "email", "group_tag"]]
                preview_df.columns = ["Full Name", "Phone (E.164)", "Organization", "Email", "Group Tag"]

                st.markdown("##### 🔍 Preview Extracted Contacts")
                st.dataframe(preview_df.head(20), use_container_width=True)
                if len(parsed_contacts) > 20:
                    st.caption(f"Showing first 20 of {len(parsed_contacts)} contacts.")

                # Action buttons
                col_btn1, col_btn2 = st.columns([1, 1])
                with col_btn1:
                    if st.button(f"📥 Import {len(parsed_contacts)} Contacts into Directory", type="primary", use_container_width=True):
                        with st.status(f"Importing {len(parsed_contacts)} contacts...", expanded=True) as status_box:
                            st.write("Inserting and deduplicating records...")
                            result = bulk_create_contacts(parsed_contacts, update_duplicates=update_dups)
                            st.write(f"Added: `{result['added']}` | Updated: `{result['updated']}` | Skipped: `{result['skipped']}`")
                            status_box.update(label="✅ Import Completed Successfully!", state="complete", expanded=False)

                        st.success(f"🎉 **Import Summary:** Added **{result['added']}** new contacts, updated **{result['updated']}**, and skipped **{result['skipped']}**.")
                        st.cache_data.clear()
                        st.rerun()

                with col_btn2:
                    # Instant bulk campaign launch with uploaded numbers
                    bulk_vobiz_str = "<".join([c["phone"] for c in parsed_contacts])
                    if st.button("🚀 Populate New Campaign with these Contacts", use_container_width=True):
                        st.session_state["campaign_target_numbers"] = bulk_vobiz_str
                        st.session_state["campaign_default_name"] = f"Campaign ({uploaded_file.name})"
                        st.info("Contacts loaded! Redirecting to Schedules page...")
                        st.switch_page("pages/2_schedules.py")


# ==============================================================================
# TAB 2: CONTACTS DIRECTORY, SEARCH, DEDUPLICATION & BULK ACTIONS
# ==============================================================================
with tab_directory:
    st.subheader("Audience Directory")

    # --- 1. Deduplication Detection & Resolution Section ---
    dup_groups = find_duplicate_contacts()
    dup_count = len(dup_groups)
    total_redundant = sum(g["count"] - 1 for g in dup_groups)

    if dup_count > 0:
        with st.container(border=True):
            col_dup_text, col_dup_btn = st.columns([2.5, 1.2])
            with col_dup_text:
                st.warning(f"⚠️ **Duplicate Contacts Found:** **{dup_count}** phone number(s) have **{total_redundant}** duplicate record(s).")
                st.caption("Merge missing contact details (names, organizations, emails, tags) into primary records and purge redundant entries.")
            with col_dup_btn:
                with st.popover("🧹 Deduplicate Contacts", use_container_width=True):
                    st.markdown("##### 🧹 Duplicate Resolution Tool")
                    st.markdown(f"Detected **{dup_count}** phone numbers with multiple entries ({total_redundant} redundant records).")
                    
                    dup_strategy = st.radio(
                        "Deduplication Preference:",
                        ["Merge into Newest Record (Recommended)", "Merge into Oldest Record"],
                        index=0,
                        help="Fills empty contact fields from other duplicates, then purges redundant rows."
                    )
                    strategy_key = "merge_into_newest" if "Newest" in dup_strategy else "keep_oldest"

                    if st.button("🚀 Merge & Purge Duplicates Now", type="primary", use_container_width=True):
                        with st.spinner("Processing deduplication in PostgreSQL..."):
                            d_res = deduplicate_contacts(strategy=strategy_key)
                        st.cache_data.clear()
                        st.success(f"🎉 Deduplicated **{d_res['duplicate_groups']}** group(s)! Merged and purged **{d_res['removed_count']}** duplicate record(s).")
                        st.rerun()

                    with st.expander("👁️ Preview Duplicate Contacts", expanded=False):
                        dup_table = []
                        for dg in dup_groups:
                            for dc in dg["contacts"]:
                                dup_table.append({
                                    "Phone": dg["phone"],
                                    "Name": dc["name"],
                                    "Organization": dc.get("organization") or "—",
                                    "Email": dc.get("email") or "—",
                                    "Group": dc.get("group_tag") or "—",
                                    "Added": (dc.get("created_at") or "")[:10]
                                })
                        st.dataframe(pd.DataFrame(dup_table), use_container_width=True)

    # --- 2. Search & Filter Controls ---
    col_s1, col_s2, col_s3, col_s4 = st.columns([2.5, 1.2, 0.7, 0.9])
    with col_s1:
        search_query = st.text_input(
            "🔍 Search Contacts",
            placeholder="Search by name, phone (+91...), company, group, notes, or email...",
            key="contacts_search_input"
        )
    with col_s2:
        all_groups = ["All"] + groups
        selected_group = st.selectbox("Filter by Group", all_groups, index=0)
    with col_s3:
        st.write("")
        st.write("")
        if search_query:
            if st.button("✖ Clear", use_container_width=True):
                st.session_state["contacts_search_input"] = ""
                st.rerun()
    with col_s4:
        st.write("")
        st.write("")
        if st.button("🔄 Refresh", use_container_width=True):
            st.cache_data.clear()
            st.rerun()

    with st.spinner("Fetching contacts from database..."):
        contacts = get_contacts(
            search_query=search_query.strip() or None,
            group_filter=selected_group if selected_group != "All" else None,
            limit=2000
        )

    if not contacts:
        if search_query or selected_group != "All":
            st.warning(f"No contacts found matching search '{search_query}' in group '{selected_group}'.")
        else:
            st.info("No contacts found in directory. Upload a `.vcf` file above or add contacts manually.")
    else:
        # Search match feedback
        if search_query.strip():
            st.caption(f"🔍 Found **{len(contacts)}** contact(s) matching `\"{search_query.strip()}\"`")
        else:
            st.caption(f"Showing **{len(contacts)}** contact(s)")

        # Initialize selection set in session state
        if "selected_contact_ids" not in st.session_state:
            st.session_state["selected_contact_ids"] = set()

        # Selection Control Bar (Select All / Clear Selection)
        col_sel_a, col_sel_c, col_sel_space = st.columns([1, 1, 3])
        with col_sel_a:
            if st.button("☑️ Select All Visible", use_container_width=True):
                st.session_state["selected_contact_ids"] = {c["id"] for c in contacts}
                st.rerun()
        with col_sel_c:
            if st.button("⬜ Clear Selection", use_container_width=True):
                st.session_state["selected_contact_ids"] = set()
                st.rerun()
        with col_sel_space:
            active_sel_count = len(st.session_state["selected_contact_ids"].intersection({c["id"] for c in contacts}))
            if active_sel_count > 0:
                st.markdown(f"**📌 {active_sel_count} of {len(contacts)} contact(s) selected**")
            else:
                st.caption("Tip: Use the checkboxes in the table below for bulk operations.")

        # Prepare DataFrame with interactive 'Select' column
        table_data = []
        for c in contacts:
            table_data.append({
                "Select": c["id"] in st.session_state["selected_contact_ids"],
                "ID": c["id"],
                "Name": c["name"],
                "Phone": c["phone"],
                "Group": c.get("group_tag") or "Default",
                "Organization": c.get("organization") or "—",
                "Email": c.get("email") or "—",
                "Source": c.get("source", "manual").upper(),
                "Added": (c.get("created_at") or "")[:10]
            })

        df_contacts = pd.DataFrame(table_data)

        # Interactive Data Editor for Checkbox Bulk Selection
        edited_df = st.data_editor(
            df_contacts,
            hide_index=True,
            disabled=["ID", "Name", "Phone", "Group", "Organization", "Email", "Source", "Added"],
            column_config={
                "Select": st.column_config.CheckboxColumn("Select", help="Check to select contact for bulk action", default=False),
                "ID": None,
                "Name": st.column_config.TextColumn("Contact Name", width="medium"),
                "Phone": st.column_config.TextColumn("Phone Number", width="medium"),
                "Group": st.column_config.TextColumn("Group / Tag", width="small"),
                "Organization": st.column_config.TextColumn("Organization", width="small"),
                "Email": st.column_config.TextColumn("Email", width="medium"),
                "Source": st.column_config.TextColumn("Source", width="small"),
                "Added": st.column_config.TextColumn("Added On", width="small")
            },
            use_container_width=True,
            key="contacts_editor_table"
        )

        # Extract currently selected rows from editor
        selected_rows = edited_df[edited_df["Select"] == True]
        selected_ids = selected_rows["ID"].tolist()
        selected_phones = selected_rows["Phone"].tolist()

        # Update session state if editor state changed
        if set(selected_ids) != st.session_state["selected_contact_ids"]:
            st.session_state["selected_contact_ids"] = set(selected_ids)

        # --- 3. Dynamic Bulk Action Toolbar ---
        with st.container(border=True):
            if len(selected_ids) > 0:
                st.markdown(f"##### ⚡ Bulk Actions for Selected Contacts ({len(selected_ids)})")
                col_b1, col_b2, col_b3, col_b4 = st.columns([1.3, 1.1, 1, 1])

                with col_b1:
                    sel_phones_str = "<".join(selected_phones)
                    if st.button(f"📢 Launch Campaign ({len(selected_ids)})", type="primary", use_container_width=True):
                        st.session_state["campaign_target_numbers"] = sel_phones_str
                        st.session_state["campaign_default_name"] = f"Targeted Campaign ({len(selected_ids)} contacts)"
                        st.switch_page("pages/2_schedules.py")

                with col_b2:
                    with st.popover(f"🏷️ Assign Group ({len(selected_ids)})", use_container_width=True):
                        new_grp_val = st.text_input("New Group / Tag Name", placeholder="e.g. VIP-Audience", key="bulk_grp_val_inp")
                        if st.button("Apply New Group", key="apply_grp_btn", type="primary", use_container_width=True):
                            if new_grp_val.strip():
                                bulk_update_contact_group(selected_ids, new_grp_val.strip())
                                st.cache_data.clear()
                                st.success(f"Updated group tag for {len(selected_ids)} contacts to '{new_grp_val.strip()}'.")
                                st.rerun()

                with col_b3:
                    sel_contacts_raw = [c for c in contacts if c["id"] in set(selected_ids)]
                    vcf_sel_text = export_contacts_to_vcf(sel_contacts_raw)
                    st.download_button(
                        label=f"📇 Export .vcf ({len(selected_ids)})",
                        data=vcf_sel_text,
                        file_name=f"contacts_selected_{len(selected_ids)}.vcf",
                        mime="text/vcard",
                        use_container_width=True
                    )

                with col_b4:
                    with st.popover(f"🗑️ Delete ({len(selected_ids)})", use_container_width=True):
                        st.warning(f"⚠️ Permanently delete {len(selected_ids)} selected contact(s)?")
                        if st.button("Confirm Bulk Delete", type="primary", use_container_width=True):
                            delete_contacts(selected_ids)
                            st.session_state["selected_contact_ids"] = set()
                            st.cache_data.clear()
                            st.success(f"Deleted {len(selected_ids)} contact(s).")
                            st.rerun()
            else:
                # Default toolbar for entire filtered view
                st.markdown("##### ⚡ Audience Actions (Filtered Contacts)")
                col_act1, col_act2, col_act3, col_act4 = st.columns([1.3, 1, 1, 1])

                with col_act1:
                    all_phones_str = "<".join([c["phone"] for c in contacts])
                    if st.button(f"📢 Campaign to ALL Filtered ({len(contacts)})", type="primary", use_container_width=True):
                        st.session_state["campaign_target_numbers"] = all_phones_str
                        st.session_state["campaign_default_name"] = f"Broadcast ({selected_group} - {len(contacts)} contacts)"
                        st.switch_page("pages/2_schedules.py")

                with col_act2:
                    csv_buffer = io.StringIO()
                    df_contacts.drop(columns=["Select", "ID"]).to_csv(csv_buffer, index=False)
                    st.download_button(
                        label="📥 Export CSV",
                        data=csv_buffer.getvalue(),
                        file_name="voice_campaign_contacts.csv",
                        mime="text/csv",
                        use_container_width=True
                    )

                with col_act3:
                    vcf_text = export_contacts_to_vcf(contacts)
                    st.download_button(
                        label="📇 Export .vcf",
                        data=vcf_text,
                        file_name="voice_campaign_contacts.vcf",
                        mime="text/vcard",
                        use_container_width=True
                    )

                with col_act4:
                    with st.popover("🗑️ Clear Directory", use_container_width=True):
                        st.warning("⚠️ This will permanently remove all contacts from the database.")
                        if st.button("Confirm Clear All Contacts", type="primary"):
                            clear_all_contacts()
                            st.session_state["selected_contact_ids"] = set()
                            st.cache_data.clear()
                            st.success("All contacts deleted.")
                            st.rerun()

        # Individual Contact Inspection / Quick Delete
        with st.expander("🛠️ Manage Individual Contact", expanded=False):
            contact_options = {f"{c['name']} ({c['phone']})": c["id"] for c in contacts}
            selected_label = st.selectbox("Select Contact to Manage", list(contact_options.keys()))
            sel_id = contact_options[selected_label]
            target_contact = get_contact(sel_id)

            if target_contact:
                col_view1, col_view2 = st.columns(2)
                with col_view1:
                    st.write(f"**Name:** {target_contact['name']}")
                    st.write(f"**Phone:** `{target_contact['phone']}`")
                    st.write(f"**Group:** `{target_contact.get('group_tag') or 'Default'}`")
                with col_view2:
                    st.write(f"**Company:** {target_contact.get('organization') or 'None'}")
                    st.write(f"**Email:** {target_contact.get('email') or 'None'}")
                    st.write(f"**Source:** `{target_contact.get('source', 'manual')}`")

                col_sub1, col_sub2 = st.columns([1, 1])
                with col_sub1:
                    if st.button(f"⚡ Dial {target_contact['phone']} Now", type="primary"):
                        st.session_state["instant_dial_number"] = target_contact["phone"]
                        st.switch_page("pages/1_dashboard.py")
                with col_sub2:
                    if st.button(f"🗑️ Delete Contact", type="secondary"):
                        delete_contact(sel_id)
                        st.cache_data.clear()
                        st.success(f"Contact deleted.")
                        st.rerun()


# ==============================================================================
# TAB 3: ADD SINGLE CONTACT MANUALLY
# ==============================================================================
with tab_manual:
    st.subheader("Add Single Contact")

    with st.form("manual_contact_form", clear_on_submit=True):
        col_m1, col_m2 = st.columns(2)
        with col_m1:
            m_name = st.text_input("Full Name *", placeholder="e.g. Ramesh Patel")
            m_phone = st.text_input("Phone Number *", placeholder="e.g. +919876543210 or 9876543210")
            m_group = st.text_input("Group / Tag", value="General", placeholder="e.g. Farmers, VIP, Staff")
        with col_m2:
            m_org = st.text_input("Organization / Farm", placeholder="e.g. Patel Agro Farms")
            m_email = st.text_input("Email Address", placeholder="e.g. ramesh@example.com")
            m_notes = st.text_area("Notes / Description", placeholder="e.g. Key distributor for Nashik region", height=68)

        m_submit = st.form_submit_button("💾 Save Contact", type="primary", use_container_width=True)

    if m_submit:
        if not m_name.strip() or not m_phone.strip():
            st.error("Contact Name and Phone Number are required.")
        else:
            normalized_p = normalize_phone_number(m_phone.strip())
            if not normalized_p:
                st.error("Please enter a valid phone number (at least 7 to 15 digits).")
            else:
                with st.spinner(f"Saving {m_name.strip()} to database..."):
                    cid = create_contact(
                        name=m_name.strip(),
                        phone=normalized_p,
                        email=m_email.strip() or None,
                        organization=m_org.strip() or None,
                        notes=m_notes.strip() or None,
                        group_tag=m_group.strip() or "General",
                        source="manual"
                    )
                st.success(f"🎉 Contact **{m_name.strip()}** (`{normalized_p}`) saved successfully!")
                st.cache_data.clear()
                st.rerun()

