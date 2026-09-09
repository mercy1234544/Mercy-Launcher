// HTN-Panel-style server management page: click a server on the Dashboard and
// land here. Left rail lists your servers; the main area has a header with
// Start/Stop/Restart/Open Folder and tabs: Overview & Console, File Manager,
// Resources, Backups. Everything runs over the existing IPC surface.

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import toast from 'react-hot-toast';
import {
  Server, Play, Square, RotateCw, FolderOpen, Trash2, Settings as SettingsIcon,
  Terminal, Folder, FolderPlus, FilePlus, File as FileIcon, ChevronRight, ChevronDown,
  Package, Archive, Loader2, Search, Save, Upload, RefreshCw, ArrowDown, ArrowLeft,
  ToggleLeft, ToggleRight, AlertTriangle, Globe, X, Download, HardDrive,
  Wrench, HeartPulse, FileCode, Import as ImportIcon, Car, Palette, FolderTree, ListOrdered,
  CornerDownLeft, Lightbulb,
} from 'lucide-react';
import { useAppStore, Server as ServerType } from '../stores/useAppStore';

// ── Console line colouring (compact version of ServerConsole's parser) ───────
function lineClass(l: string): string {
  const s = l.toLowerCase();
  if (l.startsWith('>') || l.startsWith('---')) return 'text-primary-400 font-semibold';
  if (s.includes('error') || s.includes('failed') || s.includes("couldn't start")) return 'text-red-400';
  if (s.includes('warn') || s.includes('not loaded')) return 'text-amber-400';
  if (s.includes('started resource') || s.includes('authenticated') || s.includes('succeeded')) return 'text-emerald-400';
  return 'text-surface-300';
}

// ── txAdmin-style status indicator ────────────────────────────────────────────
// green = online, yellow (pulsing) = starting/partial, red = offline/error.
const STATUS_META: Record<string, { dot: string; label: string; text: string; pulse?: boolean }> = {
  running:  { dot: 'bg-emerald-400', label: 'Online',   text: 'text-emerald-400' },
  starting: { dot: 'bg-amber-400',   label: 'Starting', text: 'text-amber-400', pulse: true },
  stopped:  { dot: 'bg-red-500',     label: 'Offline',  text: 'text-red-400' },
  error:    { dot: 'bg-red-500',     label: 'Error',    text: 'text-red-400' },
};

function StatusDot({ status, size = 8, showLabel = false }: { status: string; size?: number; showLabel?: boolean }) {
  const m = STATUS_META[status] || STATUS_META.stopped;
  return (
    <span className="inline-flex items-center gap-1.5 shrink-0">
      <span className={`rounded-full ${m.dot} ${m.pulse ? 'animate-pulse' : ''}`} style={{ width: size, height: size }} />
      {showLabel && <span className={`text-[10px] font-bold ${m.text}`}>{m.label}</span>}
    </span>
  );
}

// ── File tree types ───────────────────────────────────────────────────────────
interface FileEntry {
  name: string; path: string; type: 'directory' | 'file';
  size: number; modified: string; extension: string;
}
interface TreeNode extends FileEntry { children?: TreeNode[]; expanded?: boolean; loaded?: boolean; }

const TEXT_EXTS = new Set([
  '.lua', '.js', '.ts', '.json', '.cfg', '.txt', '.md', '.xml', '.yml', '.yaml',
  '.html', '.css', '.sql', '.ini', '.log', '.meta', '.toml', '.env', '.bat', '.sh', '',
]);
const MAX_EDIT_SIZE = 2 * 1024 * 1024; // 2 MB

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

type Tab = 'overview' | 'files' | 'resources' | 'backups' | 'tools';

export default function ServerPanel() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { servers, setServers, setActiveServer, updateServer, removeServer, logAction } = useAppStore();
  const [tab, setTab] = useState<Tab>('overview');
  const server = servers.find((s) => s.id === id) || null;

  // Keep backend as source of truth on mount.
  useEffect(() => {
    window.electronAPI?.server.getAll().then(setServers).catch(() => {});
  }, []);

  useEffect(() => { if (id) setActiveServer(id); }, [id]);

  // Live status updates.
  useEffect(() => {
    if (!window.electronAPI?.onServerStatusChange) return;
    return window.electronAPI.onServerStatusChange((d) => updateServer(d.serverId, { status: d.status as any }));
  }, []);

  // Auto-apply config fixes that shipped with app updates — existing servers
  // get patched when their panel opens, no reinstall needed.
  useEffect(() => {
    if (!id || !window.electronAPI?.server?.maintenance) return;
    window.electronAPI.server.maintenance(id).then((fixes) => {
      if (fixes && fixes.length > 0) {
        toast.success(`Auto-fixed ${fixes.length} server config issue${fixes.length !== 1 ? 's' : ''} from the latest update`, { duration: 6000 });
      }
    }).catch(() => {});
  }, [id]);

  // ── Console state (subscribes for the OPEN server only) ─────────────────────
  const [lines, setLines] = useState<string[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const consoleRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLines([]);
    if (!window.electronAPI || !id) return;
    return window.electronAPI.onServerConsole((d) => {
      if (d.serverId !== id) return;
      const raw = d.line.split('\n').filter((l) => l.trim());
      setLines((prev) => {
        const next = [...prev, ...raw];
        return next.length > 4000 ? next.slice(-3000) : next;
      });
    });
  }, [id]);

  useEffect(() => {
    if (autoScroll) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines, autoScroll]);

  const [busy, setBusy] = useState<'start' | 'stop' | 'restart' | null>(null);

  const doStart = async () => {
    if (!server || busy) return;
    setBusy('start');
    setLines((p) => [...p, '> Starting server...']);
    try {
      const r = await window.electronAPI.server.start(server.id);
      // Backend reports 'starting' immediately and promotes to 'running' when
      // the console shows the server is ready (yellow → green, like txAdmin).
      if (r.success) { updateServer(server.id, { status: 'starting' }); logAction('Server Started', server.name, 'success'); }
      else { toast.error(r.error || 'Failed to start'); setLines((p) => [...p, `> ERROR: ${r.error}`]); }
    } catch (e: any) { toast.error(e.message); }
    setBusy(null);
  };

  const doStop = async () => {
    if (!server || busy) return;
    setBusy('stop');
    setLines((p) => [...p, '> Stopping server...']);
    try {
      await window.electronAPI.server.stop(server.id);
      updateServer(server.id, { status: 'stopped' });
      logAction('Server Stopped', server.name, 'info');
    } catch (e: any) { toast.error(e.message); }
    setBusy(null);
  };

  const doRestart = async () => {
    if (!server || busy) return;
    setBusy('restart');
    setLines((p) => [...p, '> Restarting server...']);
    try {
      if (server.status === 'running' || server.status === 'starting') {
        await window.electronAPI.server.stop(server.id);
        await new Promise((r) => setTimeout(r, 1500));
      }
      const r = await window.electronAPI.server.start(server.id);
      if (r.success) { updateServer(server.id, { status: 'starting' }); toast.success('Server restarting'); }
      else toast.error(r.error || 'Failed to restart');
    } catch (e: any) { toast.error(e.message); }
    setBusy(null);
  };

  // ── Delete modal ─────────────────────────────────────────────────────────────
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const doDelete = async () => {
    if (!server) return;
    setDeleting(true);
    try {
      await window.electronAPI.server.delete(server.id);
      if (deleteFiles && server.installPath) {
        try { await window.electronAPI.file.delete(server.installPath); } catch {}
      }
      removeServer(server.id);
      logAction('Server Deleted', `${server.name} ${deleteFiles ? 'permanently deleted' : 'removed from builder'}`, 'warning');
      toast.success(`${server.name} ${deleteFiles ? 'deleted' : 'removed'}`);
      navigate('/servers');
    } catch (e: any) { toast.error(e.message); }
    setDeleting(false);
  };

  // "My Servers" with nothing selected (or a stale id): show the rail + an
  // HTN-style empty state instead of dumping the user back to the dashboard.
  if (!server) {
    return (
      <div className="h-full flex overflow-hidden">
        <div className="w-56 shrink-0 border-r border-overlay-6 bg-surface-950/40 flex flex-col">
          <p className="px-4 pt-4 pb-1 text-[10px] font-bold uppercase tracking-[0.12em] text-surface-500">Your Servers</p>
          <p className="px-4 pb-2 text-[10px] text-surface-600">{servers.filter((s) => s.status === 'running').length} active server{servers.filter((s) => s.status === 'running').length !== 1 ? 's' : ''}</p>
          <div className="flex-1 overflow-y-auto px-2 space-y-1">
            {servers.map((s) => (
              <button key={s.id} onClick={() => navigate(`/server/${s.id}`)}
                className="w-full flex items-center gap-2.5 p-2 rounded-xl border border-transparent hover:bg-overlay-4 hover:border-overlay-6 text-left transition-all">
                <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-primary-500/20 to-primary-600/5 border border-primary-500/15 flex items-center justify-center shrink-0">
                  <Server size={15} className="text-primary-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold text-surface-100 truncate">{s.name}</p>
                  <p className="text-[10px] text-surface-500 truncate">FiveM Server</p>
                </div>
                <StatusDot status={s.status} showLabel />
              </button>
            ))}
          </div>
          <div className="p-3 border-t border-overlay-6">
            <button onClick={() => navigate('/create')} className="w-full btn-primary text-xs py-2">+ New Server</button>
          </div>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center text-center">
          <div className="w-20 h-20 rounded-full bg-overlay-4 border border-overlay-6 flex items-center justify-center mb-5">
            <Terminal size={30} className="text-surface-500" />
          </div>
          {servers.length === 0 ? (
            <>
              <h2 className="text-lg font-bold text-surface-100 mb-1">No Servers Yet</h2>
              <p className="text-sm text-surface-500 mb-5">Create your first server to get started</p>
              <button onClick={() => navigate('/create')} className="btn-primary text-sm">Create Server</button>
            </>
          ) : (
            <>
              <h2 className="text-lg font-bold text-surface-100 mb-1">Select a Server</h2>
              <p className="text-sm text-surface-500">Pick one of your {servers.length} server{servers.length !== 1 ? 's' : ''} on the left to manage it</p>
            </>
          )}
        </div>
      </div>
    );
  }

  // 'starting' counts as up for button purposes (you can Stop a starting server).
  const isUp = server.status === 'running' || server.status === 'starting';

  return (
    <div className="h-full flex overflow-hidden">
      {/* ═══ Left rail — YOUR SERVERS ═══ */}
      <div className="w-56 shrink-0 border-r border-overlay-6 bg-surface-950/40 flex flex-col">
        <p className="px-4 pt-4 pb-2 text-[10px] font-bold uppercase tracking-[0.12em] text-surface-500">Your Servers</p>
        <div className="flex-1 overflow-y-auto px-2 space-y-1">
          {servers.map((s) => (
            <button
              key={s.id}
              onClick={() => navigate(`/server/${s.id}`)}
              className={`w-full flex items-center gap-2.5 p-2 rounded-xl border text-left transition-all ${
                s.id === server.id
                  ? 'bg-primary-500/10 border-primary-500/30'
                  : 'border-transparent hover:bg-overlay-4 hover:border-overlay-6'
              }`}
            >
              <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-primary-500/20 to-primary-600/5 border border-primary-500/15 flex items-center justify-center shrink-0">
                <Server size={15} className="text-primary-400" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-surface-100 truncate">{s.name}</p>
                <p className="text-[10px] text-surface-500 truncate">FiveM Server</p>
              </div>
              <StatusDot status={s.status} showLabel />
            </button>
          ))}
        </div>
        <div className="p-3 border-t border-overlay-6">
          <button onClick={() => navigate('/create')} className="w-full btn-primary text-xs py-2">+ New Server</button>
        </div>
      </div>

      {/* ═══ Main panel ═══ */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="shrink-0 px-6 pt-5 pb-0 border-b border-overlay-6">
          <div className="flex items-start justify-between gap-4 pb-4">
            <div className="flex items-center gap-4 min-w-0">
              <button onClick={() => navigate('/fivem')} className="p-2 rounded-lg text-surface-500 hover:text-surface-100 hover:bg-overlay-6 transition-colors shrink-0"><ArrowLeft size={16} /></button>
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-primary-500/25 to-purple-600/10 border border-primary-500/20 flex items-center justify-center shrink-0">
                <Server size={24} className="text-primary-400" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2.5 min-w-0">
                  <h1 className="text-xl font-extrabold text-surface-100 truncate">{server.name}</h1>
                  <StatusDot status={server.status} size={10} showLabel />
                </div>
                <p className="text-xs text-surface-500">FiveM Server &middot; {server.framework}</p>
                <p className="text-[10px] text-surface-600 font-mono truncate">{server.installPath}</p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {isUp ? (
                <button onClick={doStop} disabled={!!busy}
                  className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold bg-overlay-6 text-surface-200 hover:bg-overlay-10 border border-overlay-8 transition-all disabled:opacity-50">
                  {busy === 'stop' ? <Loader2 size={13} className="animate-spin" /> : <Square size={13} />} Stop
                </button>
              ) : (
                <button onClick={doStart} disabled={!!busy}
                  className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 border border-emerald-500/25 transition-all disabled:opacity-50">
                  {busy === 'start' ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} Start
                </button>
              )}
              <button onClick={doRestart} disabled={!!busy}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold bg-primary-600 text-white hover:bg-primary-500 transition-all disabled:opacity-50">
                {busy === 'restart' ? <Loader2 size={13} className="animate-spin" /> : <RotateCw size={13} />} Restart
              </button>
              <button onClick={() => window.electronAPI.openPath(server.installPath)}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold bg-overlay-6 text-surface-200 hover:bg-overlay-10 border border-overlay-8 transition-all">
                <FolderOpen size={13} /> Open Folder
              </button>
              <button
                onClick={() => {
                  window.electronAPI.txAdmin.open(server.installPath)
                    .then((r) => toast.success(`txAdmin: ${r.url}`))
                    .catch(() => toast.error('Failed to open txAdmin'));
                }}
                className="p-2 rounded-xl text-surface-400 hover:text-primary-300 hover:bg-overlay-6 border border-transparent hover:border-overlay-8 transition-all" title="Open txAdmin">
                <Globe size={15} />
              </button>
              <button onClick={() => setConfirmDelete(true)}
                className="p-2 rounded-xl text-surface-500 hover:text-red-400 hover:bg-red-500/10 border border-transparent hover:border-red-500/20 transition-all" title="Delete server">
                <Trash2 size={15} />
              </button>
              <button onClick={() => setTab('tools')}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold bg-overlay-6 text-surface-200 hover:bg-overlay-10 border border-overlay-8 transition-all">
                <Wrench size={13} /> Tools
              </button>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex items-center gap-1">
            {([
              { id: 'overview', label: 'Overview & Console', icon: Terminal },
              { id: 'files', label: 'File Manager', icon: Folder },
              { id: 'resources', label: 'Resources', icon: Package },
              { id: 'backups', label: 'Backups', icon: Archive },
              { id: 'tools', label: 'Tools', icon: Wrench },
            ] as { id: Tab; label: string; icon: any }[]).map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex items-center gap-2 px-4 py-2.5 text-xs font-semibold border-b-2 -mb-px transition-all ${
                  tab === t.id
                    ? 'border-primary-500 text-primary-300'
                    : 'border-transparent text-surface-500 hover:text-surface-200'
                }`}
              >
                <t.icon size={13} />
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* Tab content */}
        <div className="flex-1 min-h-0 overflow-hidden">
          {tab === 'overview' && (
            <OverviewTab
              server={server} lines={lines} autoScroll={autoScroll} setAutoScroll={setAutoScroll}
              bottomRef={bottomRef} consoleRef={consoleRef} onClear={() => setLines([])}
            />
          )}
          {tab === 'files' && <FileManagerTab server={server} />}
          {tab === 'resources' && <ResourcesTab server={server} />}
          {tab === 'backups' && <BackupsTab server={server} updateServer={updateServer} />}
          {tab === 'tools' && <ToolsTab />}
        </div>
      </div>

      {/* Delete confirm */}
      <AnimatePresence>
        {confirmDelete && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md"
            onClick={() => setConfirmDelete(false)}>
            <motion.div initial={{ scale: 0.92, y: 16 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.92, y: 16 }}
              onClick={(e) => e.stopPropagation()} className="glass-panel p-6 max-w-md w-full mx-4">
              <div className="flex items-start gap-3 mb-4">
                <div className="w-10 h-10 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-center shrink-0">
                  <AlertTriangle size={18} className="text-red-400" />
                </div>
                <div>
                  <h3 className="font-bold text-surface-100">Delete {server.name}?</h3>
                  <p className="text-xs text-surface-400 mt-1">Choose what to remove.</p>
                </div>
              </div>
              <div className="bg-overlay-3 border border-overlay-6 rounded-xl p-4 mb-4 space-y-3">
                <label className="flex items-start gap-3 cursor-pointer" onClick={() => setDeleteFiles(false)}>
                  <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center mt-0.5 shrink-0 transition-all ${!deleteFiles ? 'border-primary-400 bg-primary-500' : 'border-surface-600'}`}>
                    {!deleteFiles && <div className="w-2 h-2 rounded-full bg-white" />}
                  </div>
                  <div>
                    <p className="text-sm font-medium text-surface-100">Remove from builder only</p>
                    <p className="text-xs text-surface-400 mt-0.5">Keep server files on your computer</p>
                  </div>
                </label>
                <div className="border-t border-overlay-4" />
                <label className="flex items-start gap-3 cursor-pointer" onClick={() => setDeleteFiles(true)}>
                  <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center mt-0.5 shrink-0 transition-all ${deleteFiles ? 'border-red-400 bg-red-500' : 'border-surface-600'}`}>
                    {deleteFiles && <div className="w-2 h-2 rounded-full bg-white" />}
                  </div>
                  <div>
                    <p className="text-sm font-medium text-surface-100">Delete everything</p>
                    <p className="text-xs text-surface-400 mt-0.5">Remove from builder <span className="text-red-400 font-medium">AND delete all files</span></p>
                    <p className="text-[10px] text-surface-600 font-mono mt-1 truncate">{server.installPath}</p>
                  </div>
                </label>
              </div>
              {deleteFiles && (
                <div className="bg-red-500/8 border border-red-500/15 rounded-xl p-3 mb-4">
                  <p className="text-xs text-red-300 flex items-center gap-2">
                    <AlertTriangle size={13} className="shrink-0" />
                    Permanently deletes all server files, resources, and configs. Cannot be undone.
                  </p>
                </div>
              )}
              <div className="flex gap-2">
                <button onClick={() => !deleting && setConfirmDelete(false)} disabled={deleting} className="flex-1 btn-secondary text-sm">Cancel</button>
                <button onClick={doDelete} disabled={deleting} className="flex-1 btn-danger text-sm flex items-center justify-center gap-2">
                  {deleting ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                  {deleteFiles ? 'Delete Everything' : 'Remove'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ═══════════════════ Overview & Console ═══════════════════ */

// Pattern-matched explanations for common scary-but-known console output, so the
// live console tells you what's actually wrong instead of just scrolling errors.
const CONSOLE_HINTS: { id: string; test: RegExp; level: 'warn' | 'info'; text: string }[] = [
  {
    id: 'argmismatch', test: /Argument count mismatch \(passed 1, wanted 2\)/, level: 'warn',
    text: 'A set/sets line in server.cfg (or an exec\'d cfg like ox.cfg) has an empty "" value — FXServer drops the empty argument. Comment the line out or give it a real value (common: qbx:discordLink, inventory:webhook).',
  },
  {
    id: 'firstboot', test: /Running build tasks on resource|yarn is currently busy|Could not start dependency webpack/, level: 'info',
    text: 'First-boot build: yarn/webpack are compiling resources (chat, qbx_properties, …). They start automatically when the build finishes — restart the server once to clear the startup errors.',
  },
  {
    id: 'chattheme', test: /No such export registerMessageHook in resource chat/, level: 'warn',
    text: 'qbx_chat_theme loaded before chat finished its first-boot build — this clears itself after a restart.',
  },
  {
    id: 'projectname', test: /You don't have sv_projectName/, level: 'warn',
    text: 'sv_projectName / sv_projectDesc are not set — add them in server.cfg so your server name isn\'t cut off in the server list.',
  },
  {
    id: 'hitch', test: /thread hitch warning/, level: 'info',
    text: 'Thread hitch warnings are normal while resources compile on first boot — only worry if they continue with players on.',
  },
];

function OverviewTab({ server, lines, autoScroll, setAutoScroll, bottomRef, consoleRef, onClear }: {
  server: ServerType; lines: string[]; autoScroll: boolean; setAutoScroll: (v: boolean) => void;
  bottomRef: React.RefObject<HTMLDivElement>; consoleRef: React.RefObject<HTMLDivElement>; onClear: () => void;
}) {
  const handleScroll = () => {
    const el = consoleRef.current;
    if (!el) return;
    setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
  };

  const running = server.status === 'running';
  // stdin is available as soon as the process spawns — allow commands while starting.
  const consoleUp = running || server.status === 'starting';

  // ── Command input (writes to the FXServer console) ──────────────────────────
  const [cmd, setCmd] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);

  const sendCmd = async () => {
    const c = cmd.trim();
    if (!c) return;
    const ok = await window.electronAPI.server.sendCommand(server.id, c);
    if (!ok) toast.error('Server console not available — is the server running?');
    else setHistory((h) => [c, ...h.filter((x) => x !== c)].slice(0, 50));
    setCmd('');
    setHistIdx(-1);
  };

  const onCmdKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); sendCmd(); }
    else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const ni = Math.min(histIdx + 1, history.length - 1);
      if (ni >= 0 && history[ni] !== undefined) { setHistIdx(ni); setCmd(history[ni]); }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const ni = histIdx - 1;
      if (ni < 0) { setHistIdx(-1); setCmd(''); }
      else { setHistIdx(ni); setCmd(history[ni]); }
    }
  };

  // ── Console insights — dedupe hint matches across the buffer ───────────────
  const hints = React.useMemo(() => {
    const found: typeof CONSOLE_HINTS = [];
    for (const h of CONSOLE_HINTS) {
      if (lines.some((l) => h.test.test(l))) found.push(h);
    }
    return found.slice(0, 4);
  }, [lines]);

  const stats = [
    { label: 'Status',
      value: running ? 'Online' : server.status === 'starting' ? 'Starting…' : server.status === 'error' ? 'Error' : 'Offline',
      color: running ? 'text-emerald-400' : server.status === 'starting' ? 'text-amber-400' : 'text-red-400' },
    { label: 'Framework', value: server.framework || 'custom', color: 'text-surface-100' },
    { label: 'Artifacts', value: server.artifactVersion || 'unknown', color: 'text-surface-100' },
    { label: 'Resources', value: String(server.resourceCount ?? 0), color: 'text-surface-100' },
  ];

  return (
    <div className="h-full flex flex-col p-5 gap-3 overflow-hidden">
      <div className="grid grid-cols-4 gap-3 shrink-0">
        {stats.map((s) => (
          <div key={s.label} className="rounded-xl border border-overlay-6 bg-overlay-2 px-4 py-3">
            <p className="text-[10px] uppercase tracking-wider text-surface-500 mb-0.5">{s.label}</p>
            <p className={`text-sm font-bold truncate ${s.color}`}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Console insights */}
      {hints.length > 0 && (
        <div className="shrink-0 rounded-xl border border-overlay-6 bg-overlay-2 px-3 py-2 space-y-1.5">
          <p className="text-[10px] uppercase tracking-wider text-surface-500 flex items-center gap-1.5">
            <Lightbulb size={11} className="text-amber-400" /> Console insights
          </p>
          {hints.map((h) => (
            <p key={h.id} className={`text-[11px] leading-snug flex items-start gap-2 ${h.level === 'warn' ? 'text-amber-300' : 'text-sky-300/90'}`}>
              <span className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${h.level === 'warn' ? 'bg-amber-400' : 'bg-sky-400'}`} />
              {h.text}
            </p>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between shrink-0">
        <p className="text-xs font-semibold text-surface-400 flex items-center gap-2"><Terminal size={13} /> Live Console</p>
        <div className="flex items-center gap-2">
          {!autoScroll && (
            <button onClick={() => { setAutoScroll(true); bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }}
              className="p-1.5 rounded-lg text-primary-400 hover:bg-overlay-6" title="Scroll to bottom"><ArrowDown size={13} /></button>
          )}
          <button onClick={onClear} className="p-1.5 rounded-lg text-surface-500 hover:text-surface-200 hover:bg-overlay-6" title="Clear">
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      <div ref={consoleRef} onScroll={handleScroll}
        className="flex-1 min-h-0 bg-[#0d1117] rounded-xl border border-overlay-6 p-4 overflow-y-auto font-mono text-[11px] leading-[1.65]">
        {lines.length === 0 ? (
          <div className="text-surface-600 text-center py-12">
            {consoleUp ? 'Waiting for output…' : 'Start the server to see console output'}
          </div>
        ) : lines.map((l, i) => (
          <div key={i} className={`${lineClass(l)} break-words hover:bg-white/[0.02] -mx-2 px-2 rounded`}>{l}</div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Command input — like txAdmin's live console */}
      <div className={`shrink-0 flex items-center gap-2 rounded-xl border px-3 py-2 bg-[#0d1117] ${
        consoleUp ? 'border-overlay-8 focus-within:border-primary-500/40' : 'border-overlay-6 opacity-60'
      }`}>
        <ChevronRight size={14} className={consoleUp ? 'text-primary-400' : 'text-surface-600'} />
        <input
          value={cmd}
          onChange={(e) => { setCmd(e.target.value); setHistIdx(-1); }}
          onKeyDown={onCmdKey}
          disabled={!consoleUp}
          placeholder={consoleUp ? 'Type a server command… (restart <resource>, refresh, txadmin…)  ↑ for history' : 'Start the server to send commands'}
          className="flex-1 bg-transparent text-[12px] font-mono text-surface-100 placeholder-surface-600 focus:outline-none"
          spellCheck={false}
        />
        <button onClick={sendCmd} disabled={!consoleUp || !cmd.trim()}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-all ${
            consoleUp && cmd.trim() ? 'bg-primary-600 text-white hover:bg-primary-500' : 'bg-overlay-4 text-surface-600 cursor-not-allowed'
          }`}>
          <CornerDownLeft size={11} /> Send
        </button>
      </div>
    </div>
  );
}

/* ═══════════════════ File Manager ═══════════════════ */

function FileManagerTab({ server }: { server: ServerType }) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<TreeNode | null>(null);
  const [content, setContent] = useState<string>('');
  const [origContent, setOrigContent] = useState<string>('');
  const [loadingFile, setLoadingFile] = useState(false);
  const [binaryMsg, setBinaryMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  const [uploading, setUploading] = useState(false);
  // Directory the New File / New Folder / Upload actions target.
  const [targetDir, setTargetDir] = useState<string>(server.installPath);

  const loadDir = useCallback(async (dirPath: string): Promise<TreeNode[]> => {
    try {
      const entries: FileEntry[] = await window.electronAPI.file.readDir(dirPath);
      return entries.map((e) => ({ ...e, children: undefined, expanded: false, loaded: false }));
    } catch { return []; }
  }, []);

  useEffect(() => {
    setSelected(null); setContent(''); setOrigContent(''); setBinaryMsg(null);
    setTargetDir(server.installPath);
    loadDir(server.installPath).then(setTree);
  }, [server.id]);

  const refreshTree = async () => {
    // Re-load root and re-expand previously expanded dirs one level deep.
    setTree(await loadDir(server.installPath));
  };

  const toggleDir = async (node: TreeNode) => {
    const update = (nodes: TreeNode[]): TreeNode[] => nodes.map((n) => {
      if (n.path === node.path) {
        return { ...n, expanded: !n.expanded, loaded: true, children: n.loaded ? n.children : undefined };
      }
      if (n.children) return { ...n, children: update(n.children) };
      return n;
    });
    setTargetDir(node.path);
    if (!node.loaded) {
      const children = await loadDir(node.path);
      const inject = (nodes: TreeNode[]): TreeNode[] => nodes.map((n) => {
        if (n.path === node.path) return { ...n, expanded: true, loaded: true, children };
        if (n.children) return { ...n, children: inject(n.children) };
        return n;
      });
      setTree((t) => inject(t));
    } else {
      setTree((t) => update(t));
    }
  };

  const openFile = async (node: TreeNode) => {
    setSelected(node);
    setBinaryMsg(null);
    setContent(''); setOrigContent('');
    const ext = (node.extension || '').toLowerCase();
    if (!TEXT_EXTS.has(ext)) { setBinaryMsg(`Preview not available for ${ext || 'this'} files.`); return; }
    if (node.size > MAX_EDIT_SIZE) { setBinaryMsg(`File is too large to edit here (${fmtSize(node.size)}).`); return; }
    setLoadingFile(true);
    try {
      const r = await window.electronAPI.file.readFile(node.path);
      if (r) { setContent(r.content); setOrigContent(r.content); }
      else setBinaryMsg('Could not read file.');
    } catch { setBinaryMsg('Could not read file.'); }
    setLoadingFile(false);
  };

  const saveFile = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      const ok = await window.electronAPI.file.writeFile(selected.path, content);
      if (ok) { setOrigContent(content); toast.success(`Saved ${selected.name}`); }
      else toast.error('Save failed');
    } catch (e: any) { toast.error(e.message); }
    setSaving(false);
  };

  // Inline "new item" input (window.prompt is not supported in Electron).
  const [naming, setNaming] = useState<{ kind: 'file' | 'folder'; value: string } | null>(null);

  const commitNewItem = async () => {
    if (!naming) return;
    const name = naming.value.trim();
    setNaming(null);
    if (!name) return;
    if (/[\\/:*?"<>|]/.test(name)) { toast.error('Invalid name'); return; }
    const full = `${targetDir}\\${name}`;
    try {
      if (naming.kind === 'folder') await window.electronAPI.file.createDir(full);
      else await window.electronAPI.file.writeFile(full, '');
      toast.success(`Created ${name}`);
      await refreshTree();
    } catch (e: any) { toast.error(e.message); }
  };

  const deleteSelected = async () => {
    if (!selected) return;
    if (!window.confirm(`Delete ${selected.name}? This cannot be undone.`)) return;
    try {
      await window.electronAPI.file.delete(selected.path);
      toast.success(`Deleted ${selected.name}`);
      setSelected(null); setContent(''); setOrigContent(''); setBinaryMsg(null);
      await refreshTree();
    } catch (e: any) { toast.error(e.message); }
  };

  const uploadFiles = async () => {
    setUploading(true);
    try {
      const src = await window.electronAPI.openFile();
      if (src) {
        const b64 = await window.electronAPI.livery.readBinary(src);
        const fname = src.split(/[\\/]/).pop()!;
        const ok = await window.electronAPI.livery.writeFile(`${targetDir}\\${fname}`, b64);
        if (ok) { toast.success(`Uploaded ${fname}`); await refreshTree(); }
        else toast.error('Upload failed');
      }
    } catch (e: any) { toast.error(e.message || 'Upload failed'); }
    setUploading(false);
  };

  const createBackup = async () => {
    setBackingUp(true);
    try {
      await window.electronAPI.backup.create(server.id, { type: 'full' });
      toast.success('Backup created');
    } catch (e: any) { toast.error(e.message || 'Backup failed'); }
    setBackingUp(false);
  };

  const filterTree = (nodes: TreeNode[]): TreeNode[] => {
    if (!search.trim()) return nodes;
    const q = search.toLowerCase();
    return nodes
      .map((n) => {
        const kids = n.children ? filterTree(n.children) : undefined;
        const match = n.name.toLowerCase().includes(q) || (kids && kids.length > 0);
        return match ? { ...n, children: kids, expanded: true } : null;
      })
      .filter(Boolean) as TreeNode[];
  };

  const dirty = selected && content !== origContent;

  const renderNode = (node: TreeNode, depth: number) => (
    <div key={node.path}>
      <button
        onClick={() => (node.type === 'directory' ? toggleDir(node) : openFile(node))}
        className={`w-full flex items-center gap-1.5 px-2 py-[5px] rounded-lg text-left text-xs transition-colors ${
          selected?.path === node.path ? 'bg-primary-500/15 text-primary-200' : 'text-surface-300 hover:bg-overlay-4'
        }`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
      >
        {node.type === 'directory' ? (
          <>
            {node.expanded ? <ChevronDown size={12} className="shrink-0 text-surface-500" /> : <ChevronRight size={12} className="shrink-0 text-surface-500" />}
            <Folder size={13} className="shrink-0 text-sky-400" />
          </>
        ) : (
          <>
            <span className="w-3 shrink-0" />
            <FileIcon size={13} className="shrink-0 text-surface-500" />
          </>
        )}
        <span className="truncate flex-1">{node.name}</span>
        {node.type === 'file' && <span className="text-[9px] text-surface-600 shrink-0">{fmtSize(node.size)}</span>}
      </button>
      {node.expanded && node.children && node.children.map((c) => renderNode(c, depth + 1))}
    </div>
  );

  return (
    <div className="h-full flex overflow-hidden">
      {/* Tree column */}
      <div className="w-72 shrink-0 border-r border-overlay-6 flex flex-col">
        <div className="p-3 space-y-2 shrink-0">
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-surface-500" />
            <input
              value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search files…"
              className="w-full bg-overlay-3 border border-overlay-6 rounded-lg pl-8 pr-3 py-1.5 text-xs text-surface-200 placeholder-surface-600 focus:outline-none focus:border-primary-500/40"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button onClick={() => setNaming({ kind: 'file', value: '' })} className="flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-[11px] font-semibold bg-overlay-4 text-surface-300 hover:bg-overlay-8 border border-overlay-6 transition-all">
              <FilePlus size={12} /> New File
            </button>
            <button onClick={() => setNaming({ kind: 'folder', value: '' })} className="flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-[11px] font-semibold bg-overlay-4 text-surface-300 hover:bg-overlay-8 border border-overlay-6 transition-all">
              <FolderPlus size={12} /> New Folder
            </button>
          </div>
          {naming && (
            <div className="flex items-center gap-1.5">
              {naming.kind === 'folder' ? <Folder size={12} className="text-sky-400 shrink-0" /> : <FileIcon size={12} className="text-surface-400 shrink-0" />}
              <input
                autoFocus
                value={naming.value}
                onChange={(e) => setNaming({ ...naming, value: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter') commitNewItem(); if (e.key === 'Escape') setNaming(null); }}
                onBlur={() => setNaming(null)}
                placeholder={`New ${naming.kind} name… (Enter)`}
                className="flex-1 bg-overlay-3 border border-primary-500/40 rounded-lg px-2 py-1 text-[11px] text-surface-100 placeholder-surface-600 focus:outline-none"
              />
            </div>
          )}
          <p className="text-[9px] text-surface-600 font-mono truncate" title={targetDir}>{targetDir}</p>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {filterTree(tree).map((n) => renderNode(n, 0))}
          {tree.length === 0 && <p className="text-xs text-surface-600 text-center py-8">Empty folder</p>}
        </div>
        <div className="p-3 border-t border-overlay-6 space-y-2 shrink-0">
          <button onClick={uploadFiles} disabled={uploading}
            className="w-full flex items-center justify-center gap-2 py-2 rounded-xl text-xs font-semibold bg-primary-600 text-white hover:bg-primary-500 transition-all disabled:opacity-50">
            {uploading ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />} Upload File
          </button>
          <button onClick={createBackup} disabled={backingUp}
            className="w-full flex items-center justify-center gap-2 py-2 rounded-xl text-xs font-semibold bg-overlay-6 text-surface-200 hover:bg-overlay-10 border border-overlay-8 transition-all disabled:opacity-50">
            {backingUp ? <Loader2 size={13} className="animate-spin" /> : <Archive size={13} />} Create Backup
          </button>
        </div>
      </div>

      {/* Viewer column */}
      <div className="flex-1 min-w-0 flex flex-col">
        {!selected ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center">
            <Folder size={40} className="text-surface-700 mb-3" />
            <p className="text-sm text-surface-500">Select a file to view or edit</p>
            <p className="text-xs text-surface-600 mt-1">Clicking a folder sets the target for New File / Upload</p>
          </div>
        ) : (
          <>
            <div className="shrink-0 px-5 py-3 border-b border-overlay-6 flex items-center gap-3">
              <FileIcon size={15} className="text-primary-400 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-surface-100 truncate">{selected.name}</p>
                <p className="text-[10px] text-surface-500 font-mono truncate">
                  {selected.path.replace(server.installPath, '')} &middot; {fmtSize(selected.size)} &middot; {new Date(selected.modified).toLocaleString()}
                </p>
              </div>
              {dirty && (
                <button onClick={saveFile} disabled={saving}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 border border-emerald-500/25 transition-all">
                  {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} Save
                </button>
              )}
              <button onClick={deleteSelected}
                className="p-1.5 rounded-lg text-surface-500 hover:text-red-400 hover:bg-red-500/10 transition-all" title="Delete file">
                <Trash2 size={13} />
              </button>
            </div>
            <div className="flex-1 min-h-0 p-3">
              {loadingFile ? (
                <div className="h-full flex items-center justify-center"><Loader2 size={22} className="animate-spin text-primary-400" /></div>
              ) : binaryMsg ? (
                <div className="h-full flex flex-col items-center justify-center text-center">
                  <HardDrive size={32} className="text-surface-700 mb-3" />
                  <p className="text-sm text-surface-500">{binaryMsg}</p>
                </div>
              ) : (
                <textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  spellCheck={false}
                  className="w-full h-full bg-[#0d1117] border border-overlay-6 rounded-xl p-4 font-mono text-[11.5px] leading-[1.6] text-surface-200 resize-none focus:outline-none focus:border-primary-500/40"
                />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════ Resources ═══════════════════ */

interface Resource {
  name: string; path: string; version: string | null; author: string | null;
  enabled: boolean; category: string; issues: string[];
}

function ResourcesTab({ server }: { server: ServerType }) {
  const [resources, setResources] = useState<Resource[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [acting, setActing] = useState<string | null>(null); // "name:cmd" while a live command sends

  const live = server.status === 'running' || server.status === 'starting';

  const scan = async () => {
    setLoading(true);
    try { setResources(await window.electronAPI.resource.scan(server.installPath)); }
    catch { toast.error('Failed to scan resources'); }
    setLoading(false);
  };

  useEffect(() => { scan(); }, [server.id]);

  // Autostart toggle — adds/removes the `ensure` line in server.cfg.
  const toggle = async (r: Resource) => {
    try { await window.electronAPI.resource.toggle(server.installPath, r.name, !r.enabled); } catch {}
    setResources((rs) => rs.map((x) => x.name === r.name ? { ...x, enabled: !x.enabled } : x));
    toast.success(`${r.name} ${r.enabled ? 'removed from' : 'added to'} autostart`);
  };

  // Live control — sends start/stop/restart to the RUNNING server's console.
  const liveCmd = async (cmd: 'start' | 'stop' | 'restart', r: Resource) => {
    const key = `${r.name}:${cmd}`;
    setActing(key);
    const ok = await window.electronAPI.server.sendCommand(server.id, `${cmd} ${r.name}`);
    if (ok) toast.success(`${cmd} ${r.name} — sent to console`);
    else toast.error('Server console not available — is the server running?');
    setTimeout(() => setActing((a) => (a === key ? null : a)), 700);
  };

  const filtered = resources.filter((r) => r.name.toLowerCase().includes(search.toLowerCase()));
  const enabled = resources.filter((r) => r.enabled).length;

  const LiveBtn = ({ icon: Icon, cmd, r, tint, title }: { icon: any; cmd: 'start' | 'stop' | 'restart'; r: Resource; tint: string; title: string }) => (
    <button
      onClick={() => liveCmd(cmd, r)}
      disabled={!live || acting === `${r.name}:${cmd}`}
      title={live ? title : 'Start the server to use live controls'}
      className={`p-1.5 rounded-lg border border-transparent transition-all ${
        live ? `${tint} hover:bg-overlay-8 hover:border-overlay-10` : 'text-surface-700 cursor-not-allowed'
      }`}
    >
      {acting === `${r.name}:${cmd}` ? <Loader2 size={13} className="animate-spin" /> : <Icon size={13} />}
    </button>
  );

  return (
    <div className="h-full flex flex-col p-5 gap-3 overflow-hidden">
      <div className="flex items-center gap-3 shrink-0">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-500" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search resources…"
            className="w-full bg-overlay-3 border border-overlay-6 rounded-xl pl-9 pr-3 py-2 text-sm text-surface-200 placeholder-surface-600 focus:outline-none focus:border-primary-500/40" />
        </div>
        <span className={`text-[11px] px-2 py-1 rounded-lg border shrink-0 flex items-center gap-1.5 ${
          live ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/25' : 'bg-overlay-4 text-surface-500 border-overlay-6'
        }`}>
          <span className={`w-1.5 h-1.5 rounded-full ${live ? 'bg-emerald-400' : 'bg-surface-600'}`} />
          {live ? 'Live controls active' : 'Start server for live controls'}
        </span>
        <span className="text-xs text-surface-500 shrink-0">{enabled}/{resources.length} autostart</span>
        <button onClick={scan} disabled={loading} className="btn-secondary flex items-center gap-2 text-xs py-2">
          {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Rescan
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto space-y-1">
        {loading ? (
          <div className="flex flex-col items-center py-16"><Loader2 size={26} className="animate-spin text-primary-400 mb-2" /><p className="text-xs text-surface-500">Scanning…</p></div>
        ) : filtered.length === 0 ? (
          <p className="text-center text-sm text-surface-500 py-12">{search ? 'No matches' : 'No resources found'}</p>
        ) : filtered.map((r) => (
          <div key={r.name} className={`flex items-center gap-3 px-3 py-2 rounded-xl border border-overlay-4 bg-overlay-2 ${!r.enabled ? 'opacity-55' : ''}`}>
            {/* Live controls — restart / stop / start on the running server */}
            <div className="flex items-center gap-0.5 shrink-0 pr-2 border-r border-overlay-6">
              <LiveBtn icon={RotateCw} cmd="restart" r={r} tint="text-primary-300" title={`restart ${r.name}`} />
              <LiveBtn icon={Square} cmd="stop" r={r} tint="text-red-400" title={`stop ${r.name}`} />
              <LiveBtn icon={Play} cmd="start" r={r} tint="text-emerald-400" title={`start ${r.name}`} />
            </div>
            <span className="text-sm text-surface-100 font-medium truncate">{r.name}</span>
            {r.version && <span className="text-[10px] px-1.5 py-0.5 bg-overlay-6 rounded text-surface-400 shrink-0">v{r.version}</span>}
            <span className="text-[10px] px-1.5 py-0.5 bg-overlay-4 rounded text-surface-500 shrink-0">{r.category}</span>
            {r.issues?.length > 0 && <AlertTriangle size={13} className="text-amber-400 shrink-0" />}
            <span className="flex-1" />
            {r.author && <span className="text-[10px] text-surface-600 shrink-0 truncate max-w-[140px]">{r.author}</span>}
            {/* Autostart toggle — the on/off in server.cfg */}
            <button onClick={() => toggle(r)} className="shrink-0 flex items-center gap-1.5 hover:scale-105 transition-transform"
              title={r.enabled ? 'Autostarts with the server (ensure in server.cfg) — click to disable' : 'Not autostarted — click to enable'}>
              <span className="text-[9px] uppercase tracking-wider text-surface-600">auto</span>
              {r.enabled ? <ToggleRight size={22} className="text-emerald-400" /> : <ToggleLeft size={22} className="text-surface-500" />}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ═══════════════════ Backups ═══════════════════ */

function BackupsTab({ server, updateServer }: { server: ServerType; updateServer: (id: string, d: Partial<ServerType>) => void }) {
  const [backups, setBackups] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try { setBackups(await window.electronAPI.backup.list(server.id)); } catch {}
    setLoading(false);
  };
  useEffect(() => { load(); }, [server.id]);

  const create = async () => {
    setWorking('create');
    try {
      await window.electronAPI.backup.create(server.id, { type: 'full' });
      updateServer(server.id, { lastBackup: new Date().toISOString() });
      toast.success('Backup created');
      await load();
    } catch (e: any) { toast.error(e.message || 'Backup failed'); }
    setWorking(null);
  };

  const restore = async (b: any) => {
    if (!window.confirm(`Restore "${b.name}"? Current files will be overwritten.`)) return;
    setWorking(b.id);
    try {
      const ok = await window.electronAPI.backup.restore(b.id);
      ok ? toast.success('Backup restored') : toast.error('Restore failed');
    } catch (e: any) { toast.error(e.message); }
    setWorking(null);
  };

  const remove = async (b: any) => {
    if (!window.confirm(`Delete backup "${b.name}"?`)) return;
    setWorking(b.id);
    try { await window.electronAPI.backup.delete(b.id); await load(); toast.success('Backup deleted'); }
    catch (e: any) { toast.error(e.message); }
    setWorking(null);
  };

  return (
    <div className="h-full flex flex-col p-5 gap-3 overflow-hidden">
      <div className="flex items-center justify-between shrink-0">
        <p className="text-xs text-surface-500">{backups.length} backup{backups.length !== 1 ? 's' : ''} for this server</p>
        <button onClick={create} disabled={working === 'create'} className="btn-primary flex items-center gap-2 text-xs py-2">
          {working === 'create' ? <Loader2 size={13} className="animate-spin" /> : <Archive size={13} />} Create Backup
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto space-y-1.5">
        {loading ? (
          <div className="flex justify-center py-14"><Loader2 size={24} className="animate-spin text-primary-400" /></div>
        ) : backups.length === 0 ? (
          <div className="flex flex-col items-center py-14 text-center">
            <Archive size={34} className="text-surface-700 mb-3" />
            <p className="text-sm text-surface-500">No backups yet</p>
            <p className="text-xs text-surface-600 mt-1">Create one before making big changes</p>
          </div>
        ) : backups.map((b) => (
          <div key={b.id} className="flex items-center gap-3 px-4 py-3 rounded-xl border border-overlay-4 bg-overlay-2">
            <Archive size={16} className="text-amber-400 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-surface-100 truncate">{b.name}</p>
              <p className="text-[10px] text-surface-500">
                {fmtSize(b.size || 0)}{b.createdAt ? ` · ${new Date(b.createdAt).toLocaleString()}` : ''}
              </p>
            </div>
            <button onClick={() => restore(b)} disabled={working === b.id}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-overlay-6 text-surface-200 hover:bg-overlay-10 border border-overlay-8 transition-all disabled:opacity-50">
              {working === b.id ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />} Restore
            </button>
            <button onClick={() => remove(b)} disabled={working === b.id}
              className="p-1.5 rounded-lg text-surface-500 hover:text-red-400 hover:bg-red-500/10 transition-all">
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ═══════════════════ Tools ═══════════════════ */
// All the utilities that used to clutter the global sidebar — now scoped to the
// selected server (they operate on the active server set by this panel).

function ToolsTab() {
  const navigate = useNavigate();
  const tools = [
    { icon: HeartPulse, title: 'Health Scanner', desc: 'Scan for config issues & broken resources', path: '/health', tint: 'bg-emerald-600/20 text-emerald-400 border-emerald-500/20' },
    { icon: FileCode, title: 'server.cfg Editor', desc: 'Edit your server configuration', path: '/editor', tint: 'bg-sky-600/20 text-sky-400 border-sky-500/20' },
    { icon: ImportIcon, title: 'Import Resources', desc: 'Install scripts from ZIPs or folders', path: '/import', tint: 'bg-cyan-600/20 text-cyan-400 border-cyan-500/20' },
    { icon: RefreshCw, title: 'Resource Updater', desc: 'Update GitHub-installed resources', path: '/updater', tint: 'bg-teal-600/20 text-teal-400 border-teal-500/20' },
    { icon: Car, title: 'Vehicle Packs', desc: 'Import vehicle packs with auto manifests', path: '/vehicles', tint: 'bg-amber-600/20 text-amber-400 border-amber-500/20' },
    { icon: Palette, title: 'Livery Editor', desc: 'Paint vehicle liveries on the 3D model', path: '/livery', tint: 'bg-pink-600/20 text-pink-400 border-pink-500/20' },
    { icon: FolderTree, title: 'Organizer', desc: 'Sort resources into bracket categories', path: '/organizer', tint: 'bg-purple-600/20 text-purple-400 border-purple-500/20' },
    { icon: ListOrdered, title: 'Startup Order', desc: 'Reorder resource start sequence', path: '/startup', tint: 'bg-indigo-600/20 text-indigo-400 border-indigo-500/20' },
  ];
  return (
    <div className="h-full overflow-y-auto p-5">
      <div className="grid grid-cols-2 xl:grid-cols-3 gap-4">
        {tools.map((t) => (
          <button key={t.path} onClick={() => navigate(t.path)}
            className="group flex items-start gap-4 rounded-2xl border border-overlay-6 bg-surface-900/40 hover:bg-overlay-4 hover:border-overlay-10 p-5 text-left transition-all">
            <div className={`w-11 h-11 rounded-xl border flex items-center justify-center shrink-0 ${t.tint}`}>
              <t.icon size={19} />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-bold text-surface-100 group-hover:text-primary-200 transition-colors">{t.title}</p>
              <p className="text-xs text-surface-500 mt-0.5 leading-snug">{t.desc}</p>
            </div>
          </button>
        ))}
      </div>
      <p className="text-[11px] text-surface-600 mt-4">These tools work on this server — use the My Servers tab in the top bar to come back.</p>
    </div>
  );
}
