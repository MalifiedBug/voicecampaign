'use client';

import React, { useState, useEffect, useRef } from 'react';
import {
  Phone,
  PhoneCall,
  PhoneForwarded,
  Users,
  Mic,
  Calendar,
  BarChart3,
  Settings,
  Plus,
  Trash2,
  Play,
  Square,
  Upload,
  RefreshCw,
  Search,
  CheckCircle2,
  AlertCircle,
  Clock,
  Volume2,
  Send,
  FileText,
  UserPlus,
  Sparkles,
} from 'lucide-react';
import { parseVcfText } from '@/lib/vcf';

export default function VoiceCampaignDashboard() {
  const [activeTab, setActiveTab] = useState<'dialer' | 'contacts' | 'audio' | 'schedules' | 'history' | 'settings'>('dialer');

  // Global Data State
  const [stats, setStats] = useState<any>({ total_calls: 0, completed_calls: 0, failed_calls: 0, total_duration_sec: 0, active_schedules: 0 });
  const [contacts, setContacts] = useState<any[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const [audioAssets, setAudioAssets] = useState<any[]>([]);
  const [schedules, setSchedules] = useState<any[]>([]);
  const [callLogs, setCallLogs] = useState<any[]>([]);
  const [settings, setSettings] = useState<any>({});

  // Loading States
  const [loadingStats, setLoadingStats] = useState(false);
  const [loadingContacts, setLoadingContacts] = useState(false);
  const [loadingAudio, setLoadingAudio] = useState(false);
  const [loadingSchedules, setLoadingSchedules] = useState(false);
  const [loadingLogs, setLoadingLogs] = useState(false);

  // Status Notification
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);

  const showToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  // ----------------- INITIAL LOAD -----------------
  useEffect(() => {
    fetchStats();
    fetchContacts();
    fetchAudio();
    fetchSchedules();
    fetchLogs();
    fetchSettings();

    // Auto-trigger due cron/retries and refresh call statistics every 30 seconds
    const interval = setInterval(async () => {
      try {
        await fetch('/api/cron');
        fetchSchedules();
        fetchLogs();
        fetchStats();
      } catch (e) {}
    }, 30000);

    return () => clearInterval(interval);
  }, []);

  const fetchStats = async () => {
    setLoadingStats(true);
    try {
      const res = await fetch('/api/calls/stats');
      if (res.ok) setStats(await res.json());
    } finally {
      setLoadingStats(false);
    }
  };

  const fetchContacts = async (search = '', group = '') => {
    setLoadingContacts(true);
    try {
      const queryParams = new URLSearchParams();
      if (search) queryParams.set('search', search);
      if (group && group !== 'All Groups') queryParams.set('group', group);
      const res = await fetch(`/api/contacts?${queryParams.toString()}`);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          setContacts(data);
          setTotalContacts(data.length);
          const grps = Array.from(new Set(data.map((c: any) => c.group_tag).filter(Boolean))) as string[];
          setGroups(grps);
        } else if (data.contacts) {
          setContacts(data.contacts);
          setTotalContacts(data.total || data.contacts.length);
          if (data.groups && Array.isArray(data.groups)) {
            setGroups(data.groups);
          }
        }
      }
    } finally {
      setLoadingContacts(false);
    }
  };

  const fetchAudio = async () => {
    setLoadingAudio(true);
    try {
      const res = await fetch('/api/audio');
      if (res.ok) setAudioAssets(await res.json());
    } finally {
      setLoadingAudio(false);
    }
  };

  const fetchSchedules = async () => {
    setLoadingSchedules(true);
    try {
      const res = await fetch('/api/schedules');
      if (res.ok) setSchedules(await res.json());
    } finally {
      setLoadingSchedules(false);
    }
  };

  const fetchLogs = async () => {
    setLoadingLogs(true);
    try {
      const res = await fetch('/api/calls?limit=50');
      if (res.ok) setCallLogs(await res.json());
    } finally {
      setLoadingLogs(false);
    }
  };

  const fetchSettings = async () => {
    try {
      const res = await fetch('/api/settings');
      if (res.ok) setSettings(await res.json());
    } catch (e) {}
  };

  // ----------------- DIALER STATE -----------------
  const [dialTo, setDialTo] = useState('');
  const [dialAudioId, setDialAudioId] = useState('');
  const [dialPlayMode, setDialPlayMode] = useState<'audio' | 'tts'>('audio');
  const [dialTtsMessage, setDialTtsMessage] = useState('Hello! This is an important automated alert from Voice Campaign. Have a great day!');
  const [dialLoopCount, setDialLoopCount] = useState(1);
  const [dialRetryOption, setDialRetryOption] = useState<'10' | '10_2' | '5' | '15' | '30' | '0'>('10');
  const [isDialing, setIsDialing] = useState(false);

  const handleInstantCall = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dialTo.trim()) {
      showToast('Please enter or select at least one recipient number.', 'error');
      return;
    }

    setIsDialing(true);
    try {
      let retryDelayMinutes = 10;
      let maxRetries = 1;
      if (dialRetryOption === '0') {
        retryDelayMinutes = 0;
        maxRetries = 0;
      } else if (dialRetryOption === '10_2') {
        retryDelayMinutes = 10;
        maxRetries = 2;
      } else if (dialRetryOption === '5') {
        retryDelayMinutes = 5;
        maxRetries = 1;
      } else if (dialRetryOption === '15') {
        retryDelayMinutes = 15;
        maxRetries = 1;
      } else if (dialRetryOption === '30') {
        retryDelayMinutes = 30;
        maxRetries = 1;
      }

      const res = await fetch('/api/calls/instant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: dialTo,
          audio_id: dialAudioId || settings.default_audio_id,
          play_mode: dialPlayMode,
          tts_message: dialTtsMessage,
          loop_count: dialLoopCount,
          retry_delay_minutes: retryDelayMinutes,
          max_retries: maxRetries,
          schedule_name: 'Instant Dialer',
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to dispatch call');

      showToast(`🎉 Call dispatched to ${data.recipients?.length || 1} recipient(s)! (UUID: ${data.callUuid?.slice(0, 8)}...)`, 'success');
      fetchLogs();
      fetchStats();
      fetchSchedules();
    } catch (err: any) {
      showToast(err.message, 'error');
    } finally {
      setIsDialing(false);
    }
  };

  // ----------------- CONTACTS STATE -----------------
  const [totalContacts, setTotalContacts] = useState(0);
  const [selectAllAcrossCrm, setSelectAllAcrossCrm] = useState(false);
  const [isDeduplicating, setIsDeduplicating] = useState(false);
  const [contactSearch, setContactSearch] = useState('');
  const [selectedGroup, setSelectedGroup] = useState('All Groups');
  const [selectedContactIds, setSelectedContactIds] = useState<string[]>([]);
  const [showAddContactModal, setShowAddContactModal] = useState(false);
  const [newContact, setNewContact] = useState({ name: '', phone: '', email: '', organization: '', group_tag: 'Farmer-Group' });
  const [vcfFile, setVcfFile] = useState<File | null>(null);
  const [isUploadingVcf, setIsUploadingVcf] = useState(false);
  const [vcfProgress, setVcfProgress] = useState<{ current: number; total: number; percent: number; status: string } | null>(null);

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setContactSearch(val);
    setSelectAllAcrossCrm(false);
    fetchContacts(val, selectedGroup);
  };

  const handleGroupFilter = (grp: string) => {
    setSelectedGroup(grp);
    setSelectAllAcrossCrm(false);
    fetchContacts(contactSearch, grp);
  };

  const toggleSelectContact = (id: string) => {
    if (selectAllAcrossCrm) {
      setSelectAllAcrossCrm(false);
      setSelectedContactIds(contacts.map((c) => c.id).filter((x) => x !== id));
    } else {
      setSelectedContactIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
    }
  };

  const handleSelectAllContacts = () => {
    if (selectedContactIds.length === contacts.length || selectAllAcrossCrm) {
      setSelectedContactIds([]);
      setSelectAllAcrossCrm(false);
    } else {
      setSelectedContactIds(contacts.map((c) => c.id));
      setSelectAllAcrossCrm(false);
    }
  };

  const handlePopulateDialerFromContacts = async () => {
    let numbers = '';
    let count = 0;

    if (selectAllAcrossCrm) {
      showToast(`Loading all ${totalContacts.toLocaleString()} contacts from CRM...`, 'success');
      try {
        const queryParams = new URLSearchParams({ all_phones: 'true' });
        if (contactSearch) queryParams.set('search', contactSearch);
        if (selectedGroup && selectedGroup !== 'All Groups') queryParams.set('group', selectedGroup);

        const res = await fetch(`/api/contacts?${queryParams.toString()}`);
        const data = await res.json();
        const allPhones = data.phones || [];
        numbers = allPhones.join('<');
        count = allPhones.length;
      } catch (err: any) {
        showToast(`Failed to load contact phones: ${err.message}`, 'error');
        return;
      }
    } else {
      const chosen = contacts.filter((c) => selectedContactIds.includes(c.id));
      if (chosen.length === 0) {
        showToast('Select one or more contacts to dial.', 'error');
        return;
      }
      numbers = chosen.map((c) => c.phone).join('<');
      count = chosen.length;
    }

    setDialTo(numbers);
    setActiveTab('dialer');
    showToast(`🎯 Loaded ${count.toLocaleString()} recipient(s) into Instant Call Launcher!`, 'success');
  };

  const handleDialAllContacts = async () => {
    showToast(`Loading all ${totalContacts.toLocaleString()} contacts from directory...`, 'success');
    try {
      const queryParams = new URLSearchParams({ all_phones: 'true' });
      if (selectedGroup && selectedGroup !== 'All Groups') queryParams.set('group', selectedGroup);

      const res = await fetch(`/api/contacts?${queryParams.toString()}`);
      const data = await res.json();
      const allPhones = data.phones || [];
      if (allPhones.length === 0) {
        showToast('No dialable phone numbers found in directory.', 'error');
        return;
      }
      setDialTo(allPhones.join('<'));
      setActiveTab('dialer');
      showToast(`🎯 Loaded ALL ${allPhones.length.toLocaleString()} contacts into Instant Call Launcher!`, 'success');
    } catch (err: any) {
      showToast(`Error loading contacts: ${err.message}`, 'error');
    }
  };

  const handleDeduplicate = async () => {
    setIsDeduplicating(true);
    try {
      const res = await fetch('/api/contacts/deduplicate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ merge_by_name: false }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      if (data.duplicates_removed > 0) {
        showToast(
          `🎉 Extensive Deduplication Complete: Removed ${data.duplicates_removed.toLocaleString()} duplicate(s), merged ${data.clusters_merged} cluster(s), and enriched ${data.fields_enriched} field(s)!`,
          'success'
        );
      } else {
        showToast(
          `✅ All ${data.original_count?.toLocaleString() || 'contacts'} are unique! Scanned canonical E.164 formats across entire directory. (${data.name_groups_count || 0} multi-number name groups detected)`,
          'success'
        );
      }
      fetchContacts(contactSearch, selectedGroup);
    } catch (err: any) {
      showToast(err.message, 'error');
    } finally {
      setIsDeduplicating(false);
    }
  };

  const handleBulkDeleteContacts = async () => {
    if (!selectAllAcrossCrm && selectedContactIds.length === 0) {
      showToast('Please select at least one contact to delete.', 'error');
      return;
    }

    const countToDelete = selectAllAcrossCrm ? totalContacts : selectedContactIds.length;
    if (
      !confirm(
        selectAllAcrossCrm
          ? `⚠️ DANGER: Are you sure you want to delete ALL ${totalContacts.toLocaleString()} contacts across the entire database?`
          : `Are you sure you want to delete ${selectedContactIds.length} selected contact(s)?`
      )
    ) {
      return;
    }

    try {
      if (selectAllAcrossCrm) {
        const res = await fetch('/api/contacts?all=true', { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        showToast('All contacts cleared from database.', 'success');
      } else {
        const res = await fetch('/api/contacts', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: selectedContactIds }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        showToast(data.message || `Deleted ${selectedContactIds.length} contact(s).`, 'success');
      }
      setSelectedContactIds([]);
      setSelectAllAcrossCrm(false);
      fetchContacts(contactSearch, selectedGroup);
    } catch (err: any) {
      showToast(err.message, 'error');
    }
  };

  const handleClearAllContacts = async () => {
    if (contacts.length === 0) return;
    if (!confirm('⚠️ Are you sure you want to delete ALL contacts? This action is permanent and cannot be undone.')) {
      return;
    }

    try {
      const res = await fetch('/api/contacts?all=true', { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      showToast('All contacts cleared from directory.', 'info');
      setSelectedContactIds([]);
      fetchContacts('', 'All Groups');
    } catch (err: any) {
      showToast(err.message, 'error');
    }
  };

  const handleAddContactSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newContact.phone) return;
    try {
      const res = await fetch('/api/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newContact),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      showToast(`Added contact ${newContact.name}`, 'success');
      setNewContact({ name: '', phone: '', email: '', organization: '', group_tag: 'Farmer-Group' });
      setShowAddContactModal(false);
      fetchContacts();
    } catch (err: any) {
      showToast(err.message, 'error');
    }
  };

  const handleVcfImport = async () => {
    if (!vcfFile) return;
    setIsUploadingVcf(true);
    setVcfProgress({ current: 0, total: 0, percent: 0, status: 'Reading & parsing VCF file...' });

    try {
      const text = await vcfFile.text();
      const parsed = parseVcfText(text, '+91', 'VCF-Import');

      if (parsed.length === 0) {
        throw new Error('No valid phone numbers found in VCF file.');
      }

      setVcfProgress({
        current: 0,
        total: parsed.length,
        percent: 0,
        status: `Found ${parsed.length} contacts. Uploading in batches...`,
      });

      const BATCH_SIZE = 400;
      let totalImported = 0;

      for (let i = 0; i < parsed.length; i += BATCH_SIZE) {
        const batch = parsed.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(parsed.length / BATCH_SIZE);

        setVcfProgress({
          current: i,
          total: parsed.length,
          percent: Math.round((i / parsed.length) * 100),
          status: `Uploading batch ${batchNum} of ${totalBatches}...`,
        });

        const res = await fetch('/api/contacts/import-vcf', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contacts: batch,
            group_tag: 'VCF-Import',
          }),
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Failed on batch ${batchNum}`);

        totalImported += data.imported || batch.length;
      }

      setVcfProgress({
        current: parsed.length,
        total: parsed.length,
        percent: 100,
        status: 'Import completed successfully!',
      });

      showToast(`🎉 Successfully imported ${totalImported} contact(s) from ${vcfFile.name}!`, 'success');
      setVcfFile(null);
      fetchContacts(contactSearch, selectedGroup);
    } catch (err: any) {
      showToast(err.message, 'error');
    } finally {
      setIsUploadingVcf(false);
      setTimeout(() => setVcfProgress(null), 3000);
    }
  };

  // ----------------- AUDIO STUDIO STATE -----------------
  const [audioTab, setAudioTab] = useState<'record' | 'upload' | 'tts'>('record');
  const [isRecording, setIsRecording] = useState(false);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [recordedUrl, setRecordedUrl] = useState<string | null>(null);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [audioCustomName, setAudioCustomName] = useState('');
  const [uploadAudioFile, setUploadAudioFile] = useState<File | null>(null);
  const [isSavingAudio, setIsSavingAudio] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<any>(null);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunksRef.current = [];
      const mr = new MediaRecorder(stream);
      mediaRecorderRef.current = mr;

      mr.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      mr.onstop = () => {
        const blob = new Blob(audioChunksRef.current, { type: 'audio/wav' });
        setRecordedBlob(blob);
        setRecordedUrl(URL.createObjectURL(blob));
      };

      mr.start();
      setIsRecording(true);
      setRecordingSeconds(0);
      timerRef.current = setInterval(() => setRecordingSeconds((s) => s + 1), 1000);
    } catch (err: any) {
      showToast(`Microphone permission denied or unsupported: ${err.message}`, 'error');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach((track) => track.stop());
      setIsRecording(false);
      clearInterval(timerRef.current);
    }
  };

  const discardRecording = () => {
    setRecordedBlob(null);
    setRecordedUrl(null);
    setRecordingSeconds(0);
  };

  const uploadBlobToS3 = async (blob: Blob, filename: string, customName: string) => {
    setIsSavingAudio(true);
    try {
      // 1. Get S3 Presigned Upload URL
      const presignedRes = await fetch('/api/audio/request-upload-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, content_type: blob.type || 'audio/wav' }),
      });
      const presigned = await presignedRes.json();
      if (!presignedRes.ok) throw new Error(presigned.error);

      // 2. Direct upload to Supabase Storage S3
      const s3UploadRes = await fetch(presigned.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': blob.type || 'audio/wav' },
        body: blob,
      });
      if (!s3UploadRes.ok) throw new Error(`S3 upload failed: HTTP ${s3UploadRes.status}`);

      // 3. Confirm in database
      const confirmRes = await fetch('/api/audio/confirm-s3-upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: presigned.key,
          public_url: presigned.publicUrl,
          filename,
          custom_name: customName || filename,
          file_size_bytes: blob.size,
          mime_type: blob.type || 'audio/wav',
          source_type: 'recorded',
        }),
      });
      const confirmData = await confirmRes.json();
      if (!confirmRes.ok) throw new Error(confirmData.error);

      showToast(confirmData.message, 'success');
      discardRecording();
      fetchAudio();
      fetchSettings();
    } catch (err: any) {
      showToast(err.message, 'error');
    } finally {
      setIsSavingAudio(false);
    }
  };

  const handleSaveRecording = () => {
    if (!recordedBlob) return;
    const name = audioCustomName.trim() || `Voice Note ${new Date().toLocaleTimeString()}`;
    uploadBlobToS3(recordedBlob, `rec_${Date.now()}.wav`, name);
  };

  const handleFileUpload = async () => {
    if (!uploadAudioFile) return;
    const name = audioCustomName.trim() || uploadAudioFile.name;
    await uploadBlobToS3(uploadAudioFile, uploadAudioFile.name, name);
    setUploadAudioFile(null);
    setAudioCustomName('');
  };

  const handleSetDefaultAudio = async (id: string) => {
    try {
      const res = await fetch(`/api/audio/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ set_default: true }),
      });
      if (res.ok) {
        showToast('Set as active prompt for calls!', 'success');
        fetchAudio();
        fetchSettings();
      }
    } catch (e) {}
  };

  const handleDeleteAudio = async (id: string) => {
    if (!confirm('Delete this audio track?')) return;
    try {
      const res = await fetch(`/api/audio/${id}`, { method: 'DELETE' });
      if (res.ok) {
        showToast('Audio track deleted.', 'info');
        fetchAudio();
        fetchSettings();
      }
    } catch (e) {}
  };

  // ----------------- SCHEDULES STATE -----------------
  const [schedName, setSchedName] = useState('');
  const [schedTo, setSchedTo] = useState('');
  const [schedType, setSchedType] = useState<'once' | 'interval'>('once');
  const [schedDatetime, setSchedDatetime] = useState('');
  const [schedIntervalVal, setSchedIntervalVal] = useState(30);
  const [schedIntervalUnit, setSchedIntervalUnit] = useState('minutes');

  const handleCreateSchedule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!schedTo.trim()) {
      showToast('Destination phone number(s) required.', 'error');
      return;
    }

    try {
      const res = await fetch('/api/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: schedName || `Campaign ${new Date().toLocaleTimeString()}`,
          to_number: schedTo,
          schedule_type: schedType,
          scheduled_datetime: schedDatetime || null,
          interval_value: schedIntervalVal,
          interval_unit: schedIntervalUnit,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      showToast(data.message, 'success');
      setSchedName('');
      setSchedTo('');
      fetchSchedules();
      fetchStats();
    } catch (err: any) {
      showToast(err.message, 'error');
    }
  };

  const handleRunScheduleNow = async (id: string) => {
    try {
      const res = await fetch(`/api/schedules/${id}/run`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      showToast(data.message, 'success');
      fetchSchedules();
      fetchLogs();
    } catch (err: any) {
      showToast(err.message, 'error');
    }
  };

  const handleDeleteSchedule = async (id: string) => {
    if (!confirm('Delete this scheduled campaign?')) return;
    try {
      await fetch(`/api/schedules/${id}`, { method: 'DELETE' });
      showToast('Campaign deleted.', 'info');
      fetchSchedules();
      fetchStats();
    } catch (e) {}
  };

  // ----------------- RENDER -----------------
  return (
    <div className="flex flex-col min-h-screen">
      {/* Toast Alert */}
      {toast && (
        <div
          className={`fixed top-4 right-4 z-50 flex items-center px-4 py-3 rounded-xl shadow-2xl text-sm font-medium border backdrop-blur-md transition-all duration-300 ${
            toast.type === 'success'
              ? 'bg-emerald-950/90 text-emerald-200 border-emerald-700/80'
              : toast.type === 'error'
              ? 'bg-rose-950/90 text-rose-200 border-rose-700/80'
              : 'bg-blue-950/90 text-blue-200 border-blue-700/80'
          }`}
        >
          {toast.type === 'success' ? (
            <CheckCircle2 className="w-5 h-5 mr-2 text-emerald-400" />
          ) : (
            <AlertCircle className="w-5 h-5 mr-2 text-rose-400" />
          )}
          {toast.message}
        </div>
      )}

      {/* Top Navbar */}
      <header className="border-b border-gray-800 bg-[#0f172a]/90 backdrop-blur sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-9 h-9 rounded-lg bg-blue-600 flex items-center justify-center text-white shadow-lg shadow-blue-500/20">
              <Phone className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <span className="font-bold text-base tracking-tight text-white">Voice Campaign</span>
                <span className="text-[10px] bg-blue-950 text-blue-400 border border-blue-800 px-2 py-0.5 rounded-full font-mono">
                  Next.js + Vobiz
                </span>
              </div>
              <p className="text-[11px] text-gray-400">Automated Outbound Voice Calling Engine</p>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            <span className="flex items-center text-xs text-emerald-400 bg-emerald-950/70 border border-emerald-800/80 px-2.5 py-1 rounded-full">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse mr-2"></span>
              Supabase S3 Active
            </span>
          </div>
        </div>
      </header>

      {/* Navigation Tabs Bar */}
      <nav className="border-b border-gray-800 bg-[#0d131f]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex space-x-1 overflow-x-auto py-2">
          {[
            { id: 'dialer', label: 'Instant Call', icon: PhoneCall },
            { id: 'contacts', label: 'Contacts CRM', icon: Users, badge: contacts.length },
            { id: 'audio', label: 'Audio Studio', icon: Mic, badge: audioAssets.length },
            { id: 'schedules', label: 'Campaigns', icon: Calendar, badge: schedules.length },
            { id: 'history', label: 'Call Logs', icon: BarChart3 },
            { id: 'settings', label: 'Settings', icon: Settings },
          ].map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`flex items-center space-x-2 px-3.5 py-2 rounded-lg text-xs font-medium transition-all ${
                  isActive
                    ? 'bg-blue-600 text-white shadow-md shadow-blue-600/30 font-semibold'
                    : 'text-gray-400 hover:text-white hover:bg-slate-800/60'
                }`}
              >
                <Icon className="w-4 h-4" />
                <span>{tab.label}</span>
                {tab.badge !== undefined && tab.badge > 0 && (
                  <span
                    className={`ml-1 px-1.5 py-0.2 rounded-full text-[10px] ${
                      isActive ? 'bg-blue-800 text-blue-100' : 'bg-slate-800 text-gray-300'
                    }`}
                  >
                    {tab.badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </nav>

      {/* Main Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        {/* KPI Header Bar */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {[
            { label: 'Total Calls', value: stats.total_calls, color: 'text-white' },
            { label: 'Completed', value: stats.completed_calls, color: 'text-emerald-400' },
            { label: 'Failed / Busy', value: stats.failed_calls, color: 'text-rose-400' },
            { label: 'Total Duration', value: `${stats.total_duration_sec}s`, color: 'text-blue-400' },
            { label: 'Active Campaigns', value: stats.active_schedules, color: 'text-amber-400' },
          ].map((kpi, idx) => (
            <div key={idx} className="bg-[#111827] border border-gray-800/80 rounded-xl p-3.5">
              <p className="text-[11px] text-gray-400 font-medium">{kpi.label}</p>
              <p className={`text-xl font-bold mt-1 ${kpi.color}`}>
                {loadingStats ? <span className="animate-pulse opacity-50">...</span> : kpi.value}
              </p>
            </div>
          ))}
        </div>

        {/* ----------------- TAB: INSTANT CALL DIALER ----------------- */}
        {activeTab === 'dialer' && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 bg-[#111827] border border-gray-800 rounded-xl p-6 space-y-5">
              <div className="flex items-center justify-between border-b border-gray-800 pb-4">
                <div>
                  <h2 className="text-base font-semibold text-white flex items-center">
                    <PhoneCall className="w-5 h-5 mr-2 text-blue-400" />
                    Instant Outbound Dialer
                  </h2>
                  <p className="text-xs text-gray-400 mt-0.5">
                    Trigger calls immediately with custom S3 voice recordings or Text-to-Speech via Vobiz.
                  </p>
                </div>
                {settings.caller_id && (
                  <span className="text-xs bg-slate-800 px-2.5 py-1 rounded-lg border border-slate-700 text-gray-300 font-mono">
                    Caller ID: <b className="text-white">{settings.caller_id}</b>
                  </span>
                )}
              </div>

              <form onSubmit={handleInstantCall} className="space-y-4">
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs font-medium text-gray-300">Destination Phone Number(s)</label>
                    <div className="flex items-center space-x-2">
                      {totalContacts > 0 && (
                        <button
                          type="button"
                          onClick={handleDialAllContacts}
                          className="text-xs text-indigo-400 hover:text-indigo-300 flex items-center font-medium"
                        >
                          <Phone className="w-3.5 h-3.5 mr-1" /> Load All ({totalContacts.toLocaleString()})
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setActiveTab('contacts')}
                        className="text-xs text-blue-400 hover:text-blue-300 flex items-center"
                      >
                        <Users className="w-3.5 h-3.5 mr-1" /> Pick from Contacts
                      </button>
                    </div>
                  </div>

                  {/* Recipient Audience Stats Pill */}
                  {dialTo.trim() && (
                    <div className="mb-2 p-2 bg-slate-900/70 border border-slate-800 rounded-lg flex items-center justify-between text-xs">
                      <div className="flex items-center space-x-2 text-blue-300">
                        <Phone className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                        <span>
                          Target Audience:{' '}
                          <strong className="text-white font-mono">
                            {dialTo.split(/[<,;\n]/).filter(Boolean).length.toLocaleString()}
                          </strong>{' '}
                          Recipients
                        </span>
                        {dialTo.split(/[<,;\n]/).filter(Boolean).length > 500 && (
                          <span className="bg-blue-950 text-blue-400 text-[10px] px-2 py-0.5 rounded border border-blue-800 font-mono">
                            ⚡ Auto-Chunking into {Math.ceil(dialTo.split(/[<,;\n]/).filter(Boolean).length / 500)} Carrier Batches
                          </span>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => setDialTo('')}
                        className="text-gray-400 hover:text-rose-400 text-[11px] underline"
                      >
                        Clear
                      </button>
                    </div>
                  )}

                  <textarea
                    rows={3}
                    value={dialTo}
                    onChange={(e) => setDialTo(e.target.value)}
                    placeholder="+919876543210 (or separate multiple with < like +91987...<+91988...)"
                    className="w-full bg-[#0b0f17] border border-gray-700 rounded-lg px-3.5 py-2 text-xs text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none font-mono"
                  />
                  <p className="text-[11px] text-gray-500 mt-1">
                    Format: International E.164 (`+91...`). Supports broadcasting to thousands of recipients separated by `&lt;`. Batches exceeding 500 are automatically chunked into carrier-safe queue batches.
                  </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label className="text-xs font-medium text-gray-300 block mb-1.5">Audio Prompt to Play</label>
                    <select
                      value={dialAudioId}
                      onChange={(e) => setDialAudioId(e.target.value)}
                      className="w-full bg-[#0b0f17] border border-gray-700 rounded-lg px-3 py-2 text-xs text-white focus:border-blue-500 focus:outline-none"
                    >
                      <option value="">⭐ Active Default Audio Prompt</option>
                      {audioAssets.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name} ({a.source_type?.toUpperCase()})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="text-xs font-medium text-gray-300 block mb-1.5">Repeat Audio (Loop)</label>
                    <input
                      type="number"
                      min={1}
                      max={10}
                      value={dialLoopCount}
                      onChange={(e) => setDialLoopCount(parseInt(e.target.value) || 1)}
                      className="w-full bg-[#0b0f17] border border-gray-700 rounded-lg px-3 py-2 text-xs text-white focus:border-blue-500 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="text-xs font-medium text-gray-300 block mb-1.5 flex items-center justify-between">
                      <span>Auto-Redial if Unanswered</span>
                      <span className="text-[10px] text-emerald-400 font-semibold">10m Cooldown</span>
                    </label>
                    <select
                      value={dialRetryOption}
                      onChange={(e) => setDialRetryOption(e.target.value as any)}
                      className="w-full bg-[#0b0f17] border border-gray-700 rounded-lg px-3 py-2 text-xs text-white focus:border-blue-500 focus:outline-none"
                    >
                      <option value="10">🔄 Redial after 10 mins (1 retry) [Recommended]</option>
                      <option value="10_2">🔄 Redial after 10 mins (2 retries)</option>
                      <option value="5">🔄 Redial after 5 mins (1 retry)</option>
                      <option value="15">🔄 Redial after 15 mins (1 retry)</option>
                      <option value="30">🔄 Redial after 30 mins (1 retry)</option>
                      <option value="0">❌ Disabled (Single attempt only)</option>
                    </select>
                  </div>
                </div>

                <div className="space-y-2 pt-1">
                  <label className="text-xs font-medium text-gray-300 block">Playback Method</label>
                  <div className="flex space-x-4">
                    <label className="flex items-center space-x-2 text-xs text-gray-300 cursor-pointer">
                      <input
                        type="radio"
                        checked={dialPlayMode === 'audio'}
                        onChange={() => setDialPlayMode('audio')}
                        className="text-blue-600 focus:ring-blue-500"
                      />
                      <span>Pre-recorded Audio File (S3 Public CDN)</span>
                    </label>
                    <label className="flex items-center space-x-2 text-xs text-gray-300 cursor-pointer">
                      <input
                        type="radio"
                        checked={dialPlayMode === 'tts'}
                        onChange={() => setDialPlayMode('tts')}
                        className="text-blue-600 focus:ring-blue-500"
                      />
                      <span>Custom Text-to-Speech (TTS)</span>
                    </label>
                  </div>

                  {dialPlayMode === 'tts' && (
                    <div className="pt-2">
                      <textarea
                        rows={3}
                        value={dialTtsMessage}
                        onChange={(e) => setDialTtsMessage(e.target.value)}
                        placeholder="Enter the speech script to synthesize during the live phone call..."
                        className="w-full bg-[#0b0f17] border border-gray-700 rounded-lg p-3 text-xs text-white focus:border-blue-500 focus:outline-none"
                      />
                    </div>
                  )}
                </div>

                <button
                  type="submit"
                  disabled={isDialing}
                  className="w-full mt-2 bg-blue-600 hover:bg-blue-500 text-white font-medium py-3 rounded-lg text-xs flex items-center justify-center transition-all shadow-lg shadow-blue-600/30 disabled:opacity-50"
                >
                  {isDialing ? (
                    <>
                      <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin mr-2"></div>
                      Connecting to Vobiz Telephony Gateway...
                    </>
                  ) : (
                    <>
                      <Send className="w-4 h-4 mr-2" />
                      🚀 Dispatch Outbound Call Now
                    </>
                  )}
                </button>
              </form>
            </div>

            {/* Quick S3 Audio Track Preview */}
            <div className="bg-[#111827] border border-gray-800 rounded-xl p-6 space-y-4">
              <h3 className="text-sm font-semibold text-white flex items-center">
                <Volume2 className="w-4 h-4 mr-2 text-emerald-400" />
                Active Call Prompt Preview
              </h3>
              {audioAssets.length === 0 ? (
                <div className="p-4 bg-slate-900/40 rounded-lg border border-slate-800 text-center text-xs text-gray-400">
                  No audio tracks recorded yet. Visit the Audio Studio tab to record or upload one.
                </div>
              ) : (
                <div className="space-y-3">
                  {audioAssets.slice(0, 3).map((a) => (
                    <div
                      key={a.id}
                      className={`p-3 rounded-lg border text-xs space-y-2 ${
                        a.is_default
                          ? 'bg-blue-950/40 border-blue-800/80'
                          : 'bg-slate-900/40 border-slate-800/60'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-white">{a.name}</span>
                        {a.is_default && (
                          <span className="text-[10px] bg-blue-600 text-white px-2 py-0.5 rounded-full font-bold">
                            ACTIVE
                          </span>
                        )}
                      </div>
                      {a.external_url && (
                        <audio controls src={a.external_url} className="w-full h-8 mt-1" />
                      )}
                    </div>
                  ))}
                  <button
                    onClick={() => setActiveTab('audio')}
                    className="w-full text-center text-xs text-blue-400 hover:underline pt-1"
                  >
                    Open Full Audio Studio →
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ----------------- TAB: CONTACTS DIRECTORY ----------------- */}
        {activeTab === 'contacts' && (
          <div className="bg-[#111827] border border-gray-800 rounded-xl p-6 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-gray-800 pb-4">
              <div>
                <h2 className="text-base font-semibold text-white flex items-center">
                  <Users className="w-5 h-5 mr-2 text-emerald-400" />
                  Contacts & Audience Directory
                </h2>
                <p className="text-xs text-gray-400 mt-0.5">
                  Manage audience phone numbers, deduplicate duplicate records, and bulk select for calling.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={handlePopulateDialerFromContacts}
                  disabled={selectedContactIds.length === 0 && !selectAllAcrossCrm}
                  className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-xs px-3 py-2 rounded-lg flex items-center font-medium shadow-sm transition-all"
                >
                  <PhoneCall className="w-3.5 h-3.5 mr-1.5" />
                  Dial Selected ({selectAllAcrossCrm ? totalContacts.toLocaleString() : selectedContactIds.length})
                </button>

                {totalContacts > 0 && (
                  <button
                    onClick={handleDialAllContacts}
                    className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs px-3 py-2 rounded-lg flex items-center font-medium shadow-sm transition-all"
                    title={`Load all ${totalContacts.toLocaleString()} contacts into dialer`}
                  >
                    <PhoneForwarded className="w-3.5 h-3.5 mr-1.5" />
                    Dial All ({totalContacts.toLocaleString()})
                  </button>
                )}

                <button
                  onClick={handleBulkDeleteContacts}
                  disabled={selectedContactIds.length === 0 && !selectAllAcrossCrm}
                  className="bg-rose-600 hover:bg-rose-500 disabled:opacity-40 text-white text-xs px-3 py-2 rounded-lg flex items-center font-medium shadow-sm transition-all"
                >
                  <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                  Delete Selected ({selectAllAcrossCrm ? totalContacts.toLocaleString() : selectedContactIds.length})
                </button>

                <button
                  onClick={handleDeduplicate}
                  disabled={isDeduplicating}
                  className="bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-xs px-3 py-2 rounded-lg flex items-center font-medium transition-all"
                  title="Extensive multi-pass phone normalization and contact fusion"
                >
                  <Sparkles className={`w-3.5 h-3.5 mr-1.5 ${isDeduplicating ? 'animate-spin' : ''}`} />
                  {isDeduplicating ? 'Deduplicating...' : 'Deduplicate'}
                </button>

                <button
                  onClick={() => setShowAddContactModal(true)}
                  className="bg-slate-800 hover:bg-slate-700 text-white text-xs px-3 py-2 rounded-lg flex items-center border border-slate-700 transition-all"
                >
                  <UserPlus className="w-3.5 h-3.5 mr-1.5" />
                  Add Contact
                </button>

                {contacts.length > 0 && (
                  <button
                    onClick={handleClearAllContacts}
                    className="border border-red-900/60 hover:bg-red-950/40 text-red-400 text-xs px-2.5 py-2 rounded-lg flex items-center transition-all"
                    title="Clear All Contacts"
                  >
                    Clear All
                  </button>
                )}
              </div>
            </div>

            {/* Filter and Search Bar */}
            <div className="flex flex-col sm:flex-row items-center gap-3">
              <div className="relative flex-1 w-full">
                <Search className="w-4 h-4 text-gray-400 absolute left-3 top-2.5" />
                <input
                  type="text"
                  value={contactSearch}
                  onChange={handleSearchChange}
                  placeholder="🔍 Search contacts by name, phone (+91...), organization, group..."
                  className="w-full bg-[#0b0f17] border border-gray-700 rounded-lg pl-9 pr-3 py-2 text-xs text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none"
                />
              </div>

              {groups.length > 0 && (
                <div className="flex items-center space-x-2">
                  <span className="text-xs text-gray-400">Group:</span>
                  <select
                    value={selectedGroup}
                    onChange={(e) => handleGroupFilter(e.target.value)}
                    className="bg-[#0b0f17] border border-gray-700 rounded-lg px-2.5 py-2 text-xs text-white focus:outline-none"
                  >
                    <option value="All Groups">All Groups ({contacts.length})</option>
                    {groups.map((g) => (
                      <option key={g} value={g}>
                        {g}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            {/* Selection Announcement Banner (Gmail-style CRM Selection) */}
            {selectedContactIds.length === contacts.length && contacts.length > 0 && totalContacts > contacts.length && (
              <div className="bg-blue-950/40 border border-blue-800/60 rounded-lg px-4 py-2.5 text-center text-xs text-blue-200 flex items-center justify-center gap-2">
                {!selectAllAcrossCrm ? (
                  <>
                    <span>All <strong>{contacts.length.toLocaleString()}</strong> contacts on this page are selected.</span>
                    <button
                      onClick={() => setSelectAllAcrossCrm(true)}
                      className="text-white underline font-semibold hover:text-blue-100 ml-1 cursor-pointer"
                    >
                      Select all {totalContacts.toLocaleString()} contacts across entire CRM
                    </button>
                  </>
                ) : (
                  <>
                    <span>🎯 All <strong>{totalContacts.toLocaleString()}</strong> contacts across the entire CRM are selected.</span>
                    <button
                      onClick={() => {
                        setSelectAllAcrossCrm(false);
                        setSelectedContactIds([]);
                      }}
                      className="text-white underline font-semibold hover:text-blue-100 ml-1 cursor-pointer"
                    >
                      Clear selection
                    </button>
                  </>
                )}
              </div>
            )}

            {/* Contacts Table */}
            <div className="overflow-x-auto min-h-[200px]">
              {loadingContacts ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <div className="w-7 h-7 border-2 border-blue-400 border-t-transparent rounded-full animate-spin mb-3"></div>
                  <p className="text-xs text-blue-300">Loading contacts from Supabase...</p>
                </div>
              ) : contacts.length === 0 ? (
                <div className="text-center py-12 text-gray-500 text-xs">
                  No contacts found. Click "Add Contact" or import a VCF file below.
                </div>
              ) : (
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-gray-800 text-gray-400">
                    <tr>
                      <th className="py-2 w-8">
                        <input
                          type="checkbox"
                          checked={
                            selectAllAcrossCrm ||
                            (selectedContactIds.length === contacts.length && contacts.length > 0)
                          }
                          onChange={handleSelectAllContacts}
                        />
                      </th>
                      <th className="py-2">Name</th>
                      <th>Phone Number</th>
                      <th>Group Tag</th>
                      <th>Organization</th>
                      <th className="text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800/80">
                    {contacts.map((c) => {
                      const isSelected = selectAllAcrossCrm || selectedContactIds.includes(c.id);
                      return (
                        <tr key={c.id} className={isSelected ? 'bg-blue-950/20' : ''}>
                          <td className="py-2.5">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => toggleSelectContact(c.id)}
                            />
                          </td>
                          <td className="font-medium text-white">{c.name}</td>
                          <td className="font-mono text-emerald-400">{c.phone}</td>
                          <td>
                            {c.group_tag && (
                              <span className="bg-slate-800 text-gray-300 px-2 py-0.5 rounded text-[10px]">
                                {c.group_tag}
                              </span>
                            )}
                          </td>
                          <td className="text-gray-400">{c.organization || '—'}</td>
                          <td className="text-right">
                            <button
                              onClick={() => {
                                setDialTo(c.phone);
                                setActiveTab('dialer');
                              }}
                              className="text-blue-400 hover:underline mr-3"
                            >
                              Dial
                            </button>
                            <button
                              onClick={async () => {
                                if (confirm(`Delete ${c.name}?`)) {
                                  await fetch(`/api/contacts?id=${c.id}`, { method: 'DELETE' });
                                  fetchContacts(contactSearch, selectedGroup);
                                }
                              }}
                              className="text-rose-400 hover:underline"
                            >
                              Delete
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {/* VCF Import Section */}
            <div className="mt-4 p-4 bg-slate-900/40 rounded-xl border border-slate-800 flex flex-col gap-3">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                <div className="flex items-center space-x-3">
                  <FileText className="w-6 h-6 text-blue-400 shrink-0" />
                  <div>
                    <p className="text-xs font-medium text-white">Import Contacts from .VCF File (Bulk Upload)</p>
                    <p className="text-[11px] text-gray-400">
                      Client-side batch parser supports huge VCF contact lists (5MB, 20MB, 50MB+) without 413 payload limits.
                    </p>
                  </div>
                </div>

                <div className="flex items-center space-x-2 w-full sm:w-auto">
                  <input
                    type="file"
                    accept=".vcf"
                    disabled={isUploadingVcf}
                    onChange={(e) => setVcfFile(e.target.files?.[0] || null)}
                    className="text-xs text-gray-400 file:mr-2 file:py-1 file:px-3 file:rounded file:border-0 file:text-xs file:bg-slate-800 file:text-gray-200"
                  />
                  <button
                    onClick={handleVcfImport}
                    disabled={!vcfFile || isUploadingVcf}
                    className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs px-3.5 py-1.5 rounded-lg flex items-center font-medium shrink-0"
                  >
                    {isUploadingVcf ? 'Importing...' : 'Upload VCF'}
                  </button>
                </div>
              </div>

              {/* Live Batch Progress Bar */}
              {isUploadingVcf && vcfProgress && (
                <div className="pt-2 border-t border-slate-800/80">
                  <div className="flex justify-between items-center text-[11px] text-gray-300 mb-1.5 font-medium">
                    <span className="flex items-center text-blue-300">
                      <RefreshCw className="w-3 h-3 mr-1.5 animate-spin" />
                      {vcfProgress.status}
                    </span>
                    <span className="font-mono text-xs font-bold text-blue-400">
                      {vcfProgress.percent}% ({vcfProgress.current.toLocaleString()} / {vcfProgress.total.toLocaleString()})
                    </span>
                  </div>
                  <div className="w-full bg-slate-800 rounded-full h-2 overflow-hidden border border-slate-700/50">
                    <div
                      className="bg-gradient-to-r from-blue-600 to-indigo-500 h-2 rounded-full transition-all duration-150"
                      style={{ width: `${vcfProgress.percent}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ----------------- TAB: AUDIO STUDIO ----------------- */}
        {activeTab === 'audio' && (
          <div className="space-y-6">
            <div className="bg-[#111827] border border-gray-800 rounded-xl p-6 space-y-5">
              <div className="flex items-center justify-between border-b border-gray-800 pb-4">
                <div>
                  <h2 className="text-base font-semibold text-white flex items-center">
                    <Mic className="w-5 h-5 mr-2 text-rose-400" />
                    Supabase S3 Voice Studio
                  </h2>
                  <p className="text-xs text-gray-400 mt-0.5">
                    Record from your microphone or upload standard telephony audio (MP3/WAV) directly into Supabase Storage.
                  </p>
                </div>

                <div className="flex space-x-2">
                  <button
                    onClick={() => setAudioTab('record')}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium ${
                      audioTab === 'record' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:bg-slate-800'
                    }`}
                  >
                    🎙️ Record Mic
                  </button>
                  <button
                    onClick={() => setAudioTab('upload')}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium ${
                      audioTab === 'upload' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:bg-slate-800'
                    }`}
                  >
                    📁 Upload MP3/WAV
                  </button>
                </div>
              </div>

              {audioTab === 'record' && (
                <div className="space-y-4">
                  <div className="p-6 bg-[#0b0f17] border border-gray-800 rounded-xl flex flex-col items-center justify-center text-center space-y-3">
                    <div
                      className={`w-16 h-16 rounded-full flex items-center justify-center text-white transition-all ${
                        isRecording ? 'bg-rose-600 animate-pulse ring-8 ring-rose-600/20' : 'bg-slate-800'
                      }`}
                    >
                      <Mic className="w-7 h-7" />
                    </div>

                    <div>
                      <p className="text-sm font-semibold text-white">
                        {isRecording ? `Recording Live... (${recordingSeconds}s)` : 'Ready to Record Voice Announcement'}
                      </p>
                      <p className="text-xs text-gray-400 mt-0.5">
                        {isRecording
                          ? 'Speak clearly into your microphone.'
                          : 'Click start recording to capture an announcement.'}
                      </p>
                    </div>

                    <div className="flex items-center space-x-3 pt-2">
                      {!isRecording ? (
                        <button
                          onClick={startRecording}
                          className="bg-rose-600 hover:bg-rose-500 text-white text-xs px-5 py-2.5 rounded-lg flex items-center font-medium shadow-lg shadow-rose-600/30"
                        >
                          <Play className="w-3.5 h-3.5 mr-2" /> Start Recording
                        </button>
                      ) : (
                        <button
                          onClick={stopRecording}
                          className="bg-slate-700 hover:bg-slate-600 text-white text-xs px-5 py-2.5 rounded-lg flex items-center font-medium"
                        >
                          <Square className="w-3.5 h-3.5 mr-2" /> Stop Recording
                        </button>
                      )}
                    </div>
                  </div>

                  {recordedUrl && (
                    <div className="p-4 bg-slate-900/60 border border-slate-800 rounded-xl space-y-3">
                      <p className="text-xs font-medium text-white">🎧 Preview Recorded Audio:</p>
                      <audio controls src={recordedUrl} className="w-full" />
                      <div className="flex flex-col sm:flex-row items-center gap-3 pt-2">
                        <input
                          type="text"
                          value={audioCustomName}
                          onChange={(e) => setAudioCustomName(e.target.value)}
                          placeholder="Audio Title (e.g. Fertilizer Subsidy Broadcast)"
                          className="flex-1 bg-[#0b0f17] border border-gray-700 rounded-lg px-3 py-2 text-xs text-white"
                        />
                        <button
                          onClick={handleSaveRecording}
                          disabled={isSavingAudio}
                          className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs px-4 py-2 rounded-lg font-medium flex items-center disabled:opacity-50"
                        >
                          {isSavingAudio ? 'Uploading to S3...' : '💾 Save Recording to S3'}
                        </button>
                        <button
                          onClick={discardRecording}
                          className="text-xs text-gray-400 hover:text-rose-400 px-3 py-2"
                        >
                          Discard
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {audioTab === 'upload' && (
                <div className="space-y-4">
                  <div className="p-6 bg-[#0b0f17] border border-gray-800 rounded-xl space-y-4">
                    <div>
                      <label className="text-xs font-medium text-gray-300 block mb-1.5">Audio Track Label</label>
                      <input
                        type="text"
                        value={audioCustomName}
                        onChange={(e) => setAudioCustomName(e.target.value)}
                        placeholder="e.g. Morning Frost Warning"
                        className="w-full bg-[#111827] border border-gray-700 rounded-lg px-3 py-2 text-xs text-white"
                      />
                    </div>

                    <div>
                      <label className="text-xs font-medium text-gray-300 block mb-1.5">Choose MP3 or WAV File</label>
                      <input
                        type="file"
                        accept="audio/mp3,audio/wav,audio/*"
                        onChange={(e) => setUploadAudioFile(e.target.files?.[0] || null)}
                        className="w-full text-xs text-gray-400 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-xs file:bg-blue-600 file:text-white hover:file:bg-blue-500 cursor-pointer"
                      />
                    </div>

                    <button
                      onClick={handleFileUpload}
                      disabled={!uploadAudioFile || isSavingAudio}
                      className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs px-5 py-2.5 rounded-lg flex items-center font-medium"
                    >
                      {isSavingAudio ? 'Uploading directly to S3...' : '🚀 Upload to Supabase Storage S3'}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Audio Library */}
            <div className="bg-[#111827] border border-gray-800 rounded-xl p-6 space-y-4">
              <div className="flex items-center justify-between border-b border-gray-800 pb-3">
                <h3 className="text-sm font-semibold text-white flex items-center">
                  <Volume2 className="w-4 h-4 mr-2 text-blue-400" />
                  Saved Audio Library ({audioAssets.length})
                </h3>
                <button onClick={fetchAudio} className="text-xs text-blue-400 hover:underline flex items-center">
                  <RefreshCw className="w-3 h-3 mr-1" /> Refresh
                </button>
              </div>

              {loadingAudio ? (
                <div className="py-8 text-center text-xs text-gray-500">Loading audio library from Supabase S3...</div>
              ) : audioAssets.length === 0 ? (
                <div className="py-8 text-center text-xs text-gray-500">
                  No audio tracks found in Supabase Storage. Record or upload one above.
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {audioAssets.map((asset) => (
                    <div
                      key={asset.id}
                      className={`p-4 rounded-xl border space-y-3 ${
                        asset.is_default
                          ? 'bg-blue-950/30 border-blue-800'
                          : 'bg-[#0b0f17] border-gray-800/80'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="font-semibold text-white text-xs">{asset.name}</p>
                          <p className="text-[10px] text-gray-400 font-mono mt-0.5">
                            Format: {asset.mime_type} • Size: {Math.round((asset.file_size_bytes || 0) / 1024)} KB
                          </p>
                        </div>
                        {asset.is_default && (
                          <span className="text-[10px] bg-emerald-950 text-emerald-400 border border-emerald-800 px-2 py-0.5 rounded-full font-bold">
                            ⭐ ACTIVE PROMPT
                          </span>
                        )}
                      </div>

                      {asset.external_url && (
                        <audio controls src={asset.external_url} className="w-full h-8" />
                      )}

                      <div className="flex items-center justify-between pt-1">
                        {!asset.is_default ? (
                          <button
                            onClick={() => handleSetDefaultAudio(asset.id)}
                            className="text-xs text-blue-400 hover:underline"
                          >
                            ⭐ Set as Active Prompt
                          </button>
                        ) : (
                          <span className="text-xs text-emerald-400">Used for All Outbound Calls</span>
                        )}

                        <button
                          onClick={() => handleDeleteAudio(asset.id)}
                          className="text-xs text-rose-400 hover:underline flex items-center"
                        >
                          <Trash2 className="w-3.5 h-3.5 mr-1" /> Delete
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ----------------- TAB: CAMPAIGNS & SCHEDULES ----------------- */}
        {activeTab === 'schedules' && (
          <div className="space-y-6">
            <div className="bg-[#111827] border border-gray-800 rounded-xl p-6 space-y-4">
              <h2 className="text-base font-semibold text-white flex items-center border-b border-gray-800 pb-3">
                <Calendar className="w-5 h-5 mr-2 text-amber-400" />
                Create Automated Calling Campaign
              </h2>

              <form onSubmit={handleCreateSchedule} className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs font-medium text-gray-300 block mb-1">Campaign Label</label>
                    <input
                      type="text"
                      value={schedName}
                      onChange={(e) => setSchedName(e.target.value)}
                      placeholder="e.g. Evening Irrigation Alert"
                      className="w-full bg-[#0b0f17] border border-gray-700 rounded-lg px-3 py-2 text-xs text-white"
                    />
                  </div>

                  <div>
                    <label className="text-xs font-medium text-gray-300 block mb-1">Target Phone Number(s)</label>
                    <input
                      type="text"
                      value={schedTo}
                      onChange={(e) => setSchedTo(e.target.value)}
                      placeholder="+919876543210 (or multiple with <)"
                      className="w-full bg-[#0b0f17] border border-gray-700 rounded-lg px-3 py-2 text-xs text-white font-mono"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs font-medium text-gray-300 block mb-1">Cadence / Schedule Type</label>
                    <select
                      value={schedType}
                      onChange={(e) => setSchedType(e.target.value as any)}
                      className="w-full bg-[#0b0f17] border border-gray-700 rounded-lg px-3 py-2 text-xs text-white"
                    >
                      <option value="once">One-Time Run (Specific Date & Time)</option>
                      <option value="interval">Recurring Interval (Every N Minutes / Hours)</option>
                    </select>
                  </div>

                  {schedType === 'once' ? (
                    <div>
                      <label className="text-xs font-medium text-gray-300 block mb-1">Trigger Datetime (IST)</label>
                      <input
                        type="datetime-local"
                        value={schedDatetime}
                        onChange={(e) => setSchedDatetime(e.target.value)}
                        className="w-full bg-[#0b0f17] border border-gray-700 rounded-lg px-3 py-2 text-xs text-white"
                      />
                    </div>
                  ) : (
                    <div className="flex space-x-2">
                      <div className="flex-1">
                        <label className="text-xs font-medium text-gray-300 block mb-1">Interval Value</label>
                        <input
                          type="number"
                          min={1}
                          value={schedIntervalVal}
                          onChange={(e) => setSchedIntervalVal(parseInt(e.target.value) || 1)}
                          className="w-full bg-[#0b0f17] border border-gray-700 rounded-lg px-3 py-2 text-xs text-white"
                        />
                      </div>
                      <div className="w-32">
                        <label className="text-xs font-medium text-gray-300 block mb-1">Unit</label>
                        <select
                          value={schedIntervalUnit}
                          onChange={(e) => setSchedIntervalUnit(e.target.value)}
                          className="w-full bg-[#0b0f17] border border-gray-700 rounded-lg px-3 py-2 text-xs text-white"
                        >
                          <option value="minutes">Minutes</option>
                          <option value="hours">Hours</option>
                        </select>
                      </div>
                    </div>
                  )}
                </div>

                <button
                  type="submit"
                  className="bg-amber-600 hover:bg-amber-500 text-white text-xs px-5 py-2.5 rounded-lg flex items-center font-medium"
                >
                  <Plus className="w-4 h-4 mr-1.5" /> Save & Activate Campaign
                </button>
              </form>
            </div>

            {/* Active Schedules Table */}
            <div className="bg-[#111827] border border-gray-800 rounded-xl p-6 space-y-4">
              <h3 className="text-sm font-semibold text-white flex items-center border-b border-gray-800 pb-3">
                <Clock className="w-4 h-4 mr-2 text-blue-400" />
                Active Scheduled Campaigns ({schedules.length})
              </h3>

              {loadingSchedules ? (
                <div className="py-8 text-center text-xs text-gray-500">Loading schedules...</div>
              ) : schedules.length === 0 ? (
                <div className="py-8 text-center text-xs text-gray-500">No automated campaigns created yet.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-gray-800 text-gray-400">
                      <tr>
                        <th className="py-2">Campaign Name</th>
                        <th>Target Recipient(s)</th>
                        <th>Cadence</th>
                        <th>Status</th>
                        <th>Total Runs</th>
                        <th>Next Run</th>
                        <th className="text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-800">
                      {schedules.map((s) => (
                        <tr key={s.id}>
                          <td className="py-2.5 font-medium text-white">
                            {s.name.startsWith('Auto-Retry:') ? (
                              <span className="flex items-center">
                                <span className="bg-blue-950 text-blue-300 border border-blue-800 text-[10px] px-1.5 py-0.5 rounded font-mono mr-2 shrink-0">
                                  🔁 REDIAL
                                </span>
                                {s.name}
                              </span>
                            ) : (
                              s.name
                            )}
                          </td>
                          <td className="font-mono text-emerald-400">{s.to_number}</td>
                          <td>{s.schedule_type === 'interval' ? `Every ${s.interval_value} ${s.interval_unit}` : 'One-Time'}</td>
                          <td>
                            <span className="bg-emerald-950 text-emerald-400 px-2 py-0.5 rounded text-[10px] font-bold">
                              {s.status?.toUpperCase()}
                            </span>
                          </td>
                          <td>{s.total_runs}</td>
                          <td className="font-mono text-gray-400">
                            {s.next_run_at ? s.next_run_at.replace('T', ' ').slice(0, 16) : '—'}
                          </td>
                          <td className="text-right">
                            <button
                              onClick={() => handleRunScheduleNow(s.id)}
                              className="text-blue-400 hover:underline mr-3"
                            >
                              Run Now
                            </button>
                            <button
                              onClick={() => handleDeleteSchedule(s.id)}
                              className="text-rose-400 hover:underline"
                            >
                              Delete
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ----------------- TAB: CALL HISTORY & CDR ----------------- */}
        {activeTab === 'history' && (
          <div className="bg-[#111827] border border-gray-800 rounded-xl p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-gray-800 pb-4">
              <div>
                <h2 className="text-base font-semibold text-white flex items-center">
                  <BarChart3 className="w-5 h-5 mr-2 text-blue-400" />
                  Call Detail Records (CDR) & Analytics
                </h2>
                <p className="text-xs text-gray-400 mt-0.5">
                  Real-time telephony events, answer status, and duration from Vobiz webhooks.
                </p>
              </div>

              <button
                onClick={fetchLogs}
                className="text-xs bg-slate-800 hover:bg-slate-700 text-gray-300 px-3 py-1.5 rounded-lg border border-slate-700 flex items-center"
              >
                <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Refresh Records
              </button>
            </div>

            {loadingLogs ? (
              <div className="py-12 text-center text-xs text-gray-500">Retrieving CDR records from Supabase...</div>
            ) : callLogs.length === 0 ? (
              <div className="py-12 text-center text-xs text-gray-500">No outbound call logs recorded yet.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-gray-800 text-gray-400">
                    <tr>
                      <th className="py-2">Time (IST)</th>
                      <th>Destination</th>
                      <th>Caller ID</th>
                      <th>Campaign</th>
                      <th>Status</th>
                      <th>Duration</th>
                      <th>Hangup Cause</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800">
                    {callLogs.map((log) => {
                      const isSuccess = log.status === 'completed';
                      return (
                        <tr key={log.id}>
                          <td className="py-2.5 font-mono text-gray-400">
                            {(log.initiated_at || '').replace('T', ' ').slice(0, 19)}
                          </td>
                          <td className="font-medium text-white">{log.to_number}</td>
                          <td className="text-gray-400">{log.from_number}</td>
                          <td>{log.schedule_name || 'Instant'}</td>
                          <td>
                            {(() => {
                              const s = (log.status || '').toLowerCase();
                              let colorClass = 'bg-slate-800 text-gray-400 border border-gray-700';
                              if (s === 'completed') colorClass = 'bg-emerald-950 text-emerald-400 border border-emerald-800';
                              else if (s === 'in-progress' || s === 'answered') colorClass = 'bg-blue-950 text-blue-300 border border-blue-800 animate-pulse';
                              else if (s === 'ringing') colorClass = 'bg-purple-950 text-purple-300 border border-purple-800 animate-pulse';
                              else if (s === 'queued') colorClass = 'bg-amber-950 text-amber-300 border border-amber-800';
                              else if (s === 'busy') colorClass = 'bg-orange-950 text-orange-400 border border-orange-800';
                              else if (s === 'no-answer') colorClass = 'bg-zinc-800 text-zinc-400 border border-zinc-700';
                              else if (s === 'failed') colorClass = 'bg-rose-950 text-rose-400 border border-rose-800';

                              return (
                                <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${colorClass}`}>
                                  {log.status?.toUpperCase()}
                                </span>
                              );
                            })()}
                          </td>
                          <td>{log.duration || 0}s</td>
                          <td className="text-gray-400">
                            <div>{log.hangup_cause || '—'}</div>
                            {log.notes && log.notes.includes('Auto-redial scheduled') && (
                              <div className="text-[10px] text-blue-400 flex items-center mt-0.5 font-medium">
                                <RefreshCw className="w-2.5 h-2.5 mr-1 animate-spin shrink-0" />
                                {log.notes.split('🔄')[1] ? log.notes.split('🔄')[1].trim() : 'Auto-redial scheduled in 10m'}
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ----------------- TAB: SETTINGS & DIAGNOSTICS ----------------- */}
        {activeTab === 'settings' && (
          <div className="bg-[#111827] border border-gray-800 rounded-xl p-6 space-y-6">
            <h2 className="text-base font-semibold text-white flex items-center border-b border-gray-800 pb-3">
              <Settings className="w-5 h-5 mr-2 text-blue-400" />
              Telephony Engine & Cloud Infrastructure Configuration
            </h2>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-4">
                <h3 className="text-xs font-semibold uppercase text-gray-400 tracking-wider">
                  🔑 Vobiz API Credentials
                </h3>
                <div className="space-y-2 text-xs">
                  <div className="flex justify-between p-2.5 bg-[#0b0f17] rounded-lg border border-gray-800">
                    <span className="text-gray-400">Auth ID:</span>
                    <span className="font-mono text-white">{settings.auth_id || 'Not set'}</span>
                  </div>
                  <div className="flex justify-between p-2.5 bg-[#0b0f17] rounded-lg border border-gray-800">
                    <span className="text-gray-400">Outbound Caller ID:</span>
                    <span className="font-mono text-emerald-400">{settings.caller_id || 'Not set'}</span>
                  </div>
                  <div className="flex justify-between p-2.5 bg-[#0b0f17] rounded-lg border border-gray-800">
                    <span className="text-gray-400">Auth Token:</span>
                    <span className="font-mono text-gray-400">••••••••••••••••</span>
                  </div>
                </div>
              </div>

              <div className="space-y-4">
                <h3 className="text-xs font-semibold uppercase text-gray-400 tracking-wider">
                  ☁️ Supabase Cloud Persistence
                </h3>
                <div className="space-y-2 text-xs">
                  <div className="flex justify-between p-2.5 bg-[#0b0f17] rounded-lg border border-gray-800">
                    <span className="text-gray-400">Database Engine:</span>
                    <span className="text-emerald-400 font-medium">Supabase PostgreSQL (AWS ap-northeast-2)</span>
                  </div>
                  <div className="flex justify-between p-2.5 bg-[#0b0f17] rounded-lg border border-gray-800">
                    <span className="text-gray-400">Audio Storage Bucket:</span>
                    <span className="font-mono text-white">farmcalling-audio (S3 Protocol)</span>
                  </div>
                  <div className="flex justify-between p-2.5 bg-[#0b0f17] rounded-lg border border-gray-800">
                    <span className="text-gray-400">Active Architecture:</span>
                    <span className="text-blue-400 font-medium">Next.js 14 App Router + Vercel Serverless</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Inline Modal: Add Contact */}
      {showAddContactModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#111827] border border-gray-800 rounded-xl max-w-md w-full p-6 space-y-4 shadow-2xl">
            <h3 className="text-sm font-semibold text-white">Add New Contact</h3>
            <form onSubmit={handleAddContactSubmit} className="space-y-3">
              <div>
                <label className="text-xs text-gray-400 block mb-1">Full Name</label>
                <input
                  type="text"
                  required
                  value={newContact.name}
                  onChange={(e) => setNewContact({ ...newContact, name: e.target.value })}
                  placeholder="e.g. Ramesh Patil"
                  className="w-full bg-[#0b0f17] border border-gray-700 rounded-lg px-3 py-2 text-xs text-white"
                />
              </div>
              <div>
                <label className="text-xs text-gray-400 block mb-1">Phone Number (E.164)</label>
                <input
                  type="text"
                  required
                  value={newContact.phone}
                  onChange={(e) => setNewContact({ ...newContact, phone: e.target.value })}
                  placeholder="+919876543210"
                  className="w-full bg-[#0b0f17] border border-gray-700 rounded-lg px-3 py-2 text-xs text-white font-mono"
                />
              </div>
              <div>
                <label className="text-xs text-gray-400 block mb-1">Group Tag</label>
                <input
                  type="text"
                  value={newContact.group_tag}
                  onChange={(e) => setNewContact({ ...newContact, group_tag: e.target.value })}
                  placeholder="e.g. Irrigation-Zone-A"
                  className="w-full bg-[#0b0f17] border border-gray-700 rounded-lg px-3 py-2 text-xs text-white"
                />
              </div>
              <div className="flex justify-end space-x-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddContactModal(false)}
                  className="px-3 py-1.5 text-xs text-gray-400 hover:text-white"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="bg-blue-600 hover:bg-blue-500 text-white text-xs px-4 py-1.5 rounded-lg font-medium"
                >
                  Save Contact
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

