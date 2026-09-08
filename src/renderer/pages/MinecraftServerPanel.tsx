import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import * as Tabs from '@radix-ui/react-tabs';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Blocks, ArrowLeft, Play, Square, RotateCcw, Loader2, Terminal, Settings2, Users,
  Archive, FolderOpen, LayoutDashboard, Cpu, MemoryStick, Clock, Hash, Save, Trash2,
  Download, RefreshCw, AlertTriangle, File as FileIcon, Folder, ChevronRight, Copy, Trash,
} from 'lucide-react';
import { Panel, SectionHeading, Toggle, EmptyState } from '../components/ui';
import { useMinecraftStore } from '../stores/useMinecraftStore';
import toast from 'react-hot-toast';

const STATUS_META: Record<string, { label: string; dot: string; text: string }> = {
  running: { label: 'Online', dot: 'bg-emerald-400', text: 'text-emerald-300' },
  starting: { label: 'Starting…', dot: 'bg-amber-400', text: 'text-amber-300' },
  stopping: { label: 'Stopping…', dot: 'bg-amber-400', text: 'text-amber-300' },
  stopped: { label: 'Offline', dot: 'bg-surface-600', text: 'text-surface-400' },
  error: { label: 'Error', dot: 'bg-red-400', text: 'text-red-300' },
};

function fmtUptime(ms: number | null): string {
  if (ms == null) return 'Not available';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

export default function MinecraftServerPanel() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { upsertServer } = useMinecraftStore();
  const [server, setServer] = useState<MinecraftServer | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('overview');

  const load = async () => {
    if (!id) return;
    const s = await window.electronAPI.minecraft.get(id);
    if (s) { setServer(s); upsertServer(s); }
  };
  useEffect(() => { load(); }, [id]);

  useEffect(() => {
    if (!id) return;
    const cleanup = window.electronAPI.onMinecraftStatusChange((data) => {
      if (data.serverId !== id) return;
      load();
    });
    return cleanup;
  }, [id]);

  if (!server) {
    return (
      <div className="p-6 max-w-5xl mx-auto">
        <Panel className="flex items-center justify-center py-16"><Loader2 size={20} className="animate-spin text-primary-400" /></Panel>
      </div>
    );
  }

  const meta = STATUS_META[server.status] || STATUS_META.stopped;
  const isRunning = server.status === 'running' || server.status === 'starting';

  const handleStart = async () => { setBusy(true); const r = await window.electronAPI.minecraft.start(server.id); if (!r.success) toast.error(r.error || 'Failed to start'); setBusy(false); load(); };
  const handleStop = async () => { setBusy(true); await window.electronAPI.minecraft.stop(server.id, false); setBusy(false); load(); };
  const handleForceStop = async () => { setBusy(true); await window.electronAPI.minecraft.stop(server.id, true); setBusy(false); load(); };
  const handleRestart = async () => { setBusy(true); await window.electronAPI.minecraft.restart(server.id); setBusy(false); load(); };

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="p-6 space-y-5 max-w-5xl mx-auto pb-16">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/minecraft')} className="p-2 rounded-lg text-surface-500 hover:text-surface-100 hover:bg-overlay-6 transition-colors"><ArrowLeft size={16} /></button>
        <SectionHeading
          icon={Blocks} iconClass="bg-emerald-500/15 border-emerald-500/25 text-emerald-300"
          title={server.name}
          subtitle={`${server.version} · ${server.serverType === 'paper' ? 'Paper' : 'Vanilla'}`}
          action={
            <div className="flex items-center gap-2">
              <span className={`flex items-center gap-1.5 text-xs font-semibold ${meta.text}`}><span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} /> {meta.label}</span>
              {!isRunning ? (
                <button onClick={handleStart} disabled={busy} className="btn-primary text-xs py-2 px-3 flex items-center gap-1.5">{busy ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} Start</button>
              ) : (
                <>
                  <button onClick={handleRestart} disabled={busy} className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5"><RotateCcw size={13} /> Restart</button>
                  <button onClick={handleStop} disabled={busy} className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5"><Square size={13} /> Stop</button>
                  <button onClick={handleForceStop} disabled={busy} className="p-2 rounded-lg text-surface-500 hover:text-error hover:bg-overlay-6 transition-colors" title="Force stop"><AlertTriangle size={14} /></button>
                </>
              )}
            </div>
          }
        />
      </div>

      <Tabs.Root value={tab} onValueChange={setTab}>
        <Tabs.List className="flex flex-wrap gap-1 mb-4" aria-label="Server management">
          {[
            { id: 'overview', label: 'Overview', icon: LayoutDashboard },
            { id: 'console', label: 'Console', icon: Terminal },
            { id: 'properties', label: 'Properties', icon: Settings2 },
            { id: 'players', label: 'Players', icon: Users },
            { id: 'backups', label: 'Backups', icon: Archive },
            { id: 'files', label: 'Files', icon: FolderOpen },
          ].map((t) => (
            <Tabs.Trigger key={t.id} value={t.id}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold transition-colors outline-none ${tab === t.id ? 'bg-primary-600/15 text-primary-300 border border-primary-500/25' : 'text-surface-400 hover:text-surface-200 hover:bg-overlay-4 border border-transparent'}`}>
              <t.icon size={13} /> {t.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>

        <Tabs.Content value="overview" className="outline-none"><OverviewTab server={server} onChange={load} /></Tabs.Content>
        <Tabs.Content value="console" className="outline-none"><ConsoleTab server={server} isRunning={isRunning} /></Tabs.Content>
        <Tabs.Content value="properties" className="outline-none"><PropertiesTab server={server} /></Tabs.Content>
        <Tabs.Content value="players" className="outline-none"><PlayersTab server={server} isRunning={isRunning} /></Tabs.Content>
        <Tabs.Content value="backups" className="outline-none"><BackupsTab server={server} /></Tabs.Content>
        <Tabs.Content value="files" className="outline-none"><FilesTab server={server} /></Tabs.Content>
      </Tabs.Root>
    </motion.div>
  );
}

// ── Overview ──────────────────────────────────────────────────────────────
function OverviewTab({ server, onChange }: { server: MinecraftServer; onChange: () => void }) {
  const [stats, setStats] = useState<{ pid: number | null; uptimeMs: number | null } | null>(null);
  useEffect(() => {
    let alive = true;
    const poll = () => window.electronAPI.minecraft.processStats(server.id).then((s) => alive && setStats(s)).catch(() => {});
    poll();
    const t = setInterval(poll, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [server.id]);

  const toggleAutoRestart = async (v: boolean) => { await window.electronAPI.minecraft.setAutoRestart(server.id, v); onChange(); };

  const cards = [
    { icon: Hash, label: 'PID', value: stats?.pid ?? server.pid ?? 'Not available' },
    { icon: Clock, label: 'Uptime', value: fmtUptime(stats?.uptimeMs ?? null) },
    { icon: Cpu, label: 'CPU', value: 'Not available' },
    { icon: MemoryStick, label: 'RAM Allocated', value: `${server.ramMB} MB` },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-4 gap-4">
        {cards.map((c) => (
          <Panel key={c.label} padding="sm">
            <c.icon size={15} className="text-surface-500 mb-2" />
            <p className="text-sm font-bold text-surface-100">{c.value}</p>
            <p className="text-[10px] text-surface-500 mt-0.5">{c.label}</p>
          </Panel>
        ))}
      </div>
      <Panel>
        <p className="text-xs font-bold text-surface-400 uppercase tracking-wider mb-3">Server Details</p>
        <div className="grid grid-cols-2 gap-x-8 gap-y-4">
          {[
            { label: 'Version', value: server.version }, { label: 'Server Type', value: server.serverType === 'paper' ? 'Paper' : 'Vanilla' },
            { label: 'Port', value: String(server.port) }, { label: 'Directory', value: server.installPath },
            { label: 'Jar File', value: server.jarFile }, { label: 'Created', value: new Date(server.createdAt).toLocaleString() },
          ].map((r) => (
            <div key={r.label} className="min-w-0"><p className="text-[10px] text-surface-500 uppercase tracking-wider mb-0.5">{r.label}</p><p className="text-sm text-surface-200 font-medium truncate">{r.value}</p></div>
          ))}
        </div>
      </Panel>
      <Panel className="flex items-center gap-4">
        <div className="flex-1"><p className="text-sm font-semibold text-surface-100">Auto-restart on crash</p><p className="text-xs text-surface-500 mt-0.5">Only restarts after an unexpected exit — never after a normal Stop.</p></div>
        <Toggle checked={server.autoRestart} onChange={toggleAutoRestart} />
      </Panel>
    </div>
  );
}

// ── Console ───────────────────────────────────────────────────────────────
function ConsoleTab({ server, isRunning }: { server: MinecraftServer; isRunning: boolean }) {
  const [lines, setLines] = useState<string[]>([]);
  const [command, setCommand] = useState('');
  const [search, setSearch] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.electronAPI.minecraft.consoleBuffer(server.id).then(setLines).catch(() => {});
    const cleanup = window.electronAPI.onMinecraftConsole((data) => {
      if (data.serverId !== server.id) return;
      setLines((prev) => [...prev.slice(-1999), data.line]);
    });
    return cleanup;
  }, [server.id]);

  useEffect(() => {
    if (autoScroll && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [lines, autoScroll]);

  const send = () => {
    if (!command.trim() || !isRunning) return;
    window.electronAPI.minecraft.sendCommand(server.id, command.trim());
    setCommand('');
  };

  const filtered = search ? lines.filter((l) => l.toLowerCase().includes(search.toLowerCase())) : lines;
  const copyLogs = () => { navigator.clipboard.writeText(lines.join('\n')); toast.success('Copied console output'); };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search console output…" className="input-field flex-1 text-xs py-2" />
        <button onClick={() => setAutoScroll((v) => !v)} className={`btn-secondary text-xs py-2 px-3 ${autoScroll ? 'text-primary-300' : ''}`}>Auto-scroll</button>
        <button onClick={copyLogs} className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5"><Copy size={12} /> Copy</button>
        <button onClick={() => setLines([])} className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5"><Trash size={12} /> Clear</button>
      </div>
      <div ref={scrollRef} className="h-96 overflow-y-auto rounded-xl border border-overlay-6 bg-black/40 p-3 font-mono text-[11px] leading-relaxed">
        {filtered.length === 0 ? (
          <p className="text-surface-600">{isRunning ? 'Waiting for output…' : 'Server is offline — start it to see live console output.'}</p>
        ) : filtered.map((line, i) => (
          <div key={i} className={line.includes('[ERROR]') ? 'text-red-400' : 'text-surface-300'}>{line}</div>
        ))}
      </div>
      <div className="flex gap-2">
        <input value={command} onChange={(e) => setCommand(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()}
          disabled={!isRunning} placeholder={isRunning ? 'Type a command (e.g. say hello, whitelist add Steve)…' : 'Server must be running to send commands'}
          className="input-field flex-1 font-mono text-xs disabled:opacity-50" />
        <button onClick={send} disabled={!isRunning || !command.trim()} className="btn-primary text-xs px-4 disabled:opacity-40">Send</button>
      </div>
    </div>
  );
}

// ── Properties ────────────────────────────────────────────────────────────
const PROPERTY_HINTS: Record<string, { label: string; type: 'bool' | 'number' | 'select' | 'text'; options?: string[] }> = {
  motd: { label: 'MOTD', type: 'text' },
  gamemode: { label: 'Game Mode', type: 'select', options: ['survival', 'creative', 'adventure', 'spectator'] },
  difficulty: { label: 'Difficulty', type: 'select', options: ['peaceful', 'easy', 'normal', 'hard'] },
  'max-players': { label: 'Max Players', type: 'number' },
  'online-mode': { label: 'Online Mode (verify accounts)', type: 'bool' },
  pvp: { label: 'PvP', type: 'bool' },
  'view-distance': { label: 'View Distance', type: 'number' },
  'simulation-distance': { label: 'Simulation Distance', type: 'number' },
  'spawn-protection': { label: 'Spawn Protection Radius', type: 'number' },
  'allow-flight': { label: 'Allow Flight', type: 'bool' },
  'white-list': { label: 'Whitelist Enabled', type: 'bool' },
  'enable-command-block': { label: 'Command Blocks', type: 'bool' },
  'server-port': { label: 'Server Port', type: 'number' },
};

function PropertiesTab({ server }: { server: MinecraftServer }) {
  const [entries, setEntries] = useState<{ key: string; value: string; isComment: boolean; raw: string }[]>([]);
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = () => { setLoading(true); window.electronAPI.minecraft.readProperties(server.id).then((e) => { setEntries(e); setEdited({}); }).finally(() => setLoading(false)); };
  useEffect(() => { load(); }, [server.id]);

  const known = entries.filter((e) => !e.isComment && PROPERTY_HINTS[e.key]);
  const unknown = entries.filter((e) => !e.isComment && !PROPERTY_HINTS[e.key]);

  const valueOf = (key: string, fallback: string) => edited[key] ?? fallback;
  const setValue = (key: string, value: string) => setEdited((prev) => ({ ...prev, [key]: value }));

  const save = async () => {
    if (Object.keys(edited).length === 0) return;
    setSaving(true);
    const result = await window.electronAPI.minecraft.writeProperties(server.id, edited);
    setSaving(false);
    if (result.success) { toast.success('server.properties saved — restart the server to apply changes'); load(); }
    else toast.error(result.error || 'Failed to save');
  };

  if (loading) return <Panel className="flex items-center justify-center py-12"><Loader2 size={18} className="animate-spin text-primary-400" /></Panel>;
  if (entries.length === 0) return <Panel><EmptyState icon={Settings2} title="No server.properties found" description="This server hasn't generated its properties file yet — start it once to create one." /></Panel>;

  return (
    <div className="space-y-4">
      <Panel>
        <p className="text-xs font-bold text-surface-400 uppercase tracking-wider mb-3">Common Settings</p>
        <div className="grid grid-cols-2 gap-4">
          {known.map(({ key, value }) => {
            const hint = PROPERTY_HINTS[key];
            const current = valueOf(key, value);
            return (
              <div key={key}>
                <label className="text-[11px] font-semibold text-surface-400 mb-1.5 block">{hint.label}</label>
                {hint.type === 'bool' ? (
                  <Toggle checked={current === 'true'} onChange={(v) => setValue(key, String(v))} />
                ) : hint.type === 'select' ? (
                  <select value={current} onChange={(e) => setValue(key, e.target.value)} className="input-field text-sm py-2">
                    {hint.options!.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : (
                  <input value={current} onChange={(e) => setValue(key, e.target.value)} type={hint.type === 'number' ? 'number' : 'text'} className="input-field text-sm py-2" />
                )}
              </div>
            );
          })}
        </div>
      </Panel>
      {unknown.length > 0 && (
        <Panel>
          <p className="text-xs font-bold text-surface-400 uppercase tracking-wider mb-1">Other Properties</p>
          <p className="text-[11px] text-surface-500 mb-3">{unknown.length} additional propert{unknown.length === 1 ? 'y is' : 'ies are'} preserved as-is and won't be touched by Mercy.</p>
          <div className="grid grid-cols-2 gap-2">
            {unknown.map(({ key, value }) => (
              <div key={key} className="text-[11px] font-mono text-surface-500 truncate">{key}={value}</div>
            ))}
          </div>
        </Panel>
      )}
      <div className="flex justify-end">
        <button onClick={save} disabled={saving || Object.keys(edited).length === 0} className="btn-primary text-xs py-2 px-4 flex items-center gap-1.5 disabled:opacity-40">
          {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} Save Properties
        </button>
      </div>
    </div>
  );
}

// ── Players (derived from real console join/leave lines) ───────────────────
function PlayersTab({ server, isRunning }: { server: MinecraftServer; isRunning: boolean }) {
  const [players, setPlayers] = useState<{ name: string; online: boolean; lastSeen: string }[]>([]);
  useEffect(() => {
    let alive = true;
    const poll = () => window.electronAPI.minecraft.players(server.id).then((p) => alive && setPlayers(p)).catch(() => {});
    poll();
    const t = setInterval(poll, 4000);
    return () => { alive = false; clearInterval(t); };
  }, [server.id]);

  const online = players.filter((p) => p.online);

  return (
    <Panel>
      <p className="text-xs font-bold text-surface-400 uppercase tracking-wider mb-1">Players</p>
      <p className="text-[11px] text-surface-500 mb-4">Derived from this server's own console output (join/leave messages) — no query protocol or RCON required. UUIDs aren't available this way.</p>
      {!isRunning ? (
        <EmptyState icon={Users} title="Server is offline" description="Start the server to see who's online." />
      ) : online.length === 0 ? (
        <EmptyState icon={Users} title="No players online" description={players.length > 0 ? `${players.length} known player${players.length === 1 ? '' : 's'} from this session, currently offline.` : "Nobody has joined yet this session."} />
      ) : (
        <div className="space-y-2">
          {online.map((p) => (
            <div key={p.name} className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-overlay-3 border border-overlay-6">
              <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
              <p className="text-sm font-semibold text-surface-100 flex-1">{p.name}</p>
              <p className="text-[10px] text-surface-500">Online</p>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

// ── Backups ───────────────────────────────────────────────────────────────
function BackupsTab({ server }: { server: MinecraftServer }) {
  const [backups, setBackups] = useState<MinecraftBackup[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const load = () => window.electronAPI.minecraft.listBackups(server.id).then(setBackups).finally(() => setLoading(false));
  useEffect(() => { load(); }, [server.id]);

  const create = async () => {
    setCreating(true);
    const result = await window.electronAPI.minecraft.createBackup(server.id);
    setCreating(false);
    if (result.success) { toast.success('Backup created'); load(); } else toast.error(result.error || 'Backup failed');
  };
  const restore = async (id: string) => {
    const result = await window.electronAPI.minecraft.restoreBackup(id);
    if (result.success) toast.success('Backup restored'); else toast.error(result.error || 'Restore failed');
  };
  const del = async (id: string) => { await window.electronAPI.minecraft.deleteBackup(id); load(); };
  const fmtSize = (b: number) => b > 1024 * 1024 * 1024 ? `${(b / 1024 / 1024 / 1024).toFixed(2)} GB` : `${(b / 1024 / 1024).toFixed(1)} MB`;

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button onClick={create} disabled={creating} className="btn-primary text-xs py-2 px-4 flex items-center gap-1.5 disabled:opacity-60">
          {creating ? <Loader2 size={13} className="animate-spin" /> : <Archive size={13} />} {creating ? 'Backing up…' : 'Create Backup'}
        </button>
      </div>
      {loading ? (
        <Panel className="flex items-center justify-center py-10"><Loader2 size={18} className="animate-spin text-primary-400" /></Panel>
      ) : backups.length === 0 ? (
        <Panel><EmptyState icon={Archive} title="No backups yet" description="Create a backup before making risky changes to properties or the world." /></Panel>
      ) : (
        <div className="space-y-2">
          {backups.slice().reverse().map((b) => (
            <Panel key={b.id} padding="sm" className="flex items-center gap-3">
              <Archive size={16} className="text-primary-300 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-surface-100 truncate">{b.name}</p>
                <p className="text-[11px] text-surface-500">{new Date(b.createdAt).toLocaleString()} · {fmtSize(b.size)}</p>
              </div>
              <button onClick={() => restore(b.id)} className="btn-secondary text-xs py-1.5 px-2.5">Restore</button>
              <button onClick={() => del(b.id)} className="p-1.5 rounded-lg text-surface-500 hover:text-error hover:bg-overlay-6 transition-colors"><Trash2 size={13} /></button>
            </Panel>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Files (restricted to this server's directory) ───────────────────────────
function FilesTab({ server }: { server: MinecraftServer }) {
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<{ name: string; path: string; type: 'file' | 'directory'; size: number }[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);

  const load = (p: string) => {
    setLoading(true);
    window.electronAPI.minecraft.listFiles(server.id, p).then((e) => setEntries(e || [])).finally(() => setLoading(false));
  };
  useEffect(() => { load(path); }, [server.id, path]);

  const openFile = async (relPath: string) => {
    const c = await window.electronAPI.minecraft.readFile(server.id, relPath);
    if (c === null) { toast.error('Could not open this file (it may be binary).'); return; }
    setEditing(relPath); setContent(c);
  };
  const saveFile = async () => {
    if (!editing) return;
    const ok = await window.electronAPI.minecraft.writeFile(server.id, editing, content);
    if (ok) toast.success('File saved'); else toast.error('Failed to save file');
  };

  if (editing) {
    return (
      <Panel>
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-bold text-surface-100 font-mono">{editing}</p>
          <div className="flex gap-2">
            <button onClick={() => setEditing(null)} className="btn-secondary text-xs py-1.5 px-3">Close</button>
            <button onClick={saveFile} className="btn-primary text-xs py-1.5 px-3 flex items-center gap-1.5"><Save size={12} /> Save</button>
          </div>
        </div>
        <textarea value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false}
          className="w-full h-96 rounded-xl border border-overlay-6 bg-black/40 p-3 font-mono text-xs text-surface-200 resize-none focus:outline-none focus:border-primary-500/40" />
      </Panel>
    );
  }

  return (
    <Panel>
      <div className="flex items-center gap-1.5 text-xs text-surface-500 mb-3">
        <button onClick={() => setPath('')} className="hover:text-primary-300">Server Root</button>
        {path.split(/[\\/]/).filter(Boolean).map((seg, i, arr) => (
          <React.Fragment key={i}>
            <ChevronRight size={12} />
            <button onClick={() => setPath(arr.slice(0, i + 1).join('/'))} className="hover:text-primary-300">{seg}</button>
          </React.Fragment>
        ))}
      </div>
      {loading ? (
        <div className="flex items-center justify-center py-10"><Loader2 size={18} className="animate-spin text-primary-400" /></div>
      ) : entries.length === 0 ? (
        <EmptyState icon={FolderOpen} title="Empty folder" />
      ) : (
        <div className="space-y-1">
          {entries.map((e) => (
            <button key={e.path} onClick={() => (e.type === 'directory' ? setPath(e.path) : openFile(e.path))}
              className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-overlay-4 transition-colors text-left">
              {e.type === 'directory' ? <Folder size={15} className="text-amber-300 shrink-0" /> : <FileIcon size={15} className="text-surface-500 shrink-0" />}
              <span className="text-sm text-surface-200 flex-1 truncate">{e.name}</span>
              {e.type === 'file' && <span className="text-[10px] text-surface-600">{(e.size / 1024).toFixed(1)} KB</span>}
            </button>
          ))}
        </div>
      )}
    </Panel>
  );
}
