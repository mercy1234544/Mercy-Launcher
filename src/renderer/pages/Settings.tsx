import React, { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import {
  Moon, Sun, Monitor, HardDrive, Cpu, MemoryStick, Activity, Info, Database,
  Shield, KeyRound, LogOut, SlidersHorizontal, Download, Gamepad2, RefreshCw,
  UserCircle2, FolderOpen, Power, PictureInPicture2, CheckCircle2, Loader2,
  ArrowUpCircle, Star, Server as ServerIcon, Package, ChevronRight,
} from 'lucide-react';
import { useAppStore } from '../stores/useAppStore';
import { useLocalAccess } from '../stores/useLocalAccess';
import { useAppAuth } from '../stores/useAppAuth';
import { useFavorites } from '../stores/useFavorites';
import { isSupabaseConfigured } from '../lib/supabase';
import MercyLogo from '../components/MercyLogo';
import { Panel, Toggle, SectionHeading } from '../components/ui';
import toast from 'react-hot-toast';

interface SysInfo {
  cpuModel: string; cpuCores: number; cpuUsage: number;
  totalMem: number; freeMem: number;
  platform: string; hostname: string;
  disk: { total: number; free: number } | null;
  appVersion: string; electron: string;
}

const gb = (n: number) => (n / 1024 / 1024 / 1024).toFixed(1);

function UsageBar({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="w-full h-1.5 bg-overlay-6 rounded-full overflow-hidden mt-3">
      <div className={`h-full rounded-full transition-all duration-700 ${color}`} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
    </div>
  );
}

function Row({ icon: Icon, iconClass, title, sub, control }: { icon: React.ComponentType<{ size?: number | string; className?: string }>; iconClass: string; title: string; sub: string; control: React.ReactNode }) {
  return (
    <Panel className="flex items-center gap-4">
      <div className={`w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 ${iconClass}`}>
        <Icon size={17} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-surface-100">{title}</p>
        <p className="text-xs text-surface-500 mt-0.5">{sub}</p>
      </div>
      {control}
    </Panel>
  );
}

const CATEGORIES = [
  { id: 'general', label: 'General', icon: SlidersHorizontal },
  { id: 'downloads', label: 'Downloads', icon: Download },
  { id: 'games', label: 'Games', icon: Gamepad2 },
  { id: 'updates', label: 'Updates', icon: RefreshCw },
  { id: 'account', label: 'Account', icon: UserCircle2 },
  { id: 'system', label: 'System', icon: Cpu },
  { id: 'about', label: 'About', icon: Info },
] as const;
type CategoryId = typeof CATEGORIES[number]['id'];

const GAME_ROWS = [
  { id: 'fivem', label: 'FiveM', path: '/fivem', real: true },
  { id: 'minecraft', label: 'Minecraft', path: '/minecraft', real: false },
  { id: 'assettocorsa', label: 'Assetto Corsa', path: '/assetto-corsa', real: false },
  { id: 'beamng', label: 'BeamNG.drive', path: '/beamng', real: false },
];

export default function Settings() {
  const { theme, toggleTheme, servers } = useAppStore();
  const [sys, setSys] = useState<SysInfo | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const navigate = useNavigate();
  const [tab, setTab] = useState<CategoryId>('general');

  const adminUnlocked = useLocalAccess((s) => s.unlocked);
  const adminHasPin = useLocalAccess((s) => s.hasPin);
  const adminLock = useLocalAccess((s) => s.lock);
  const authStatus = useAppAuth((s) => s.status);
  const signOut = useAppAuth((s) => s.signOut);
  const showAccount = !!authStatus?.enabled && !!authStatus?.authorized;
  const [signingOut, setSigningOut] = useState(false);
  const handleSignOut = async () => { setSigningOut(true); await signOut(); setSigningOut(false); toast('Signed out'); };
  const favoritesCount = useFavorites((s) => s.favorites.length);

  // ── General: launch behavior ──────────────────────────────────────────────
  const [startWithWindows, setStartWithWindows] = useState(false);
  const [minimizeToTray, setMinimizeToTray] = useState(false);
  useEffect(() => {
    window.electronAPI?.settings?.getLoginItem().then(setStartWithWindows).catch(() => {});
    window.electronAPI?.settings?.get('minimizeToTray').then((v) => setMinimizeToTray(!!v)).catch(() => {});
  }, []);
  const handleStartWithWindows = async (v: boolean) => {
    setStartWithWindows(v);
    await window.electronAPI?.settings?.setLoginItem(v).catch(() => {});
  };
  const handleMinimizeToTray = async (v: boolean) => {
    setMinimizeToTray(v);
    await window.electronAPI?.settings?.set('minimizeToTray', v).catch(() => {});
  };

  // ── Downloads: default location ───────────────────────────────────────────
  const [downloadPath, setDownloadPath] = useState<string | null>(null);
  useEffect(() => {
    window.electronAPI?.settings?.get('downloadPath').then(setDownloadPath).catch(() => {});
  }, []);
  const pickDownloadPath = async () => {
    const dir = await window.electronAPI?.openDirectory().catch(() => null);
    if (!dir) return;
    setDownloadPath(dir);
    await window.electronAPI?.settings?.set('downloadPath', dir).catch(() => {});
  };

  // ── Updates ────────────────────────────────────────────────────────────────
  const [autoUpdate, setAutoUpdate] = useState(true);
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'available' | 'current' | 'downloading' | 'ready' | 'error'>('idle');
  const [updateVersion, setUpdateVersion] = useState('');
  useEffect(() => {
    window.electronAPI?.settings?.get('autoUpdate').then((v) => setAutoUpdate(v !== false)).catch(() => {});
    const cleanup = window.electronAPI?.appUpdater?.onStatus((data) => {
      setUpdateStatus(data.status);
      if (data.version) setUpdateVersion(data.version);
    });
    return cleanup;
  }, []);
  const handleAutoUpdate = async (v: boolean) => {
    setAutoUpdate(v);
    await window.electronAPI?.settings?.set('autoUpdate', v).catch(() => {});
  };
  const handleCheckUpdates = async () => {
    setUpdateStatus('checking');
    const info = await window.electronAPI?.appUpdater?.check().catch(() => null);
    if (!info) setUpdateStatus((s) => (s === 'checking' ? 'current' : s));
  };
  const handleInstallUpdate = () => window.electronAPI?.appUpdater?.install();

  useEffect(() => {
    const poll = () => window.electronAPI?.system?.getInfo().then(setSys).catch(() => {});
    poll();
    timer.current = setInterval(poll, 2500);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, []);

  const running = servers.filter((s) => s.status === 'running').length;
  const memUsedPct = sys ? ((sys.totalMem - sys.freeMem) / sys.totalMem) * 100 : 0;
  const diskUsed = sys?.disk ? sys.disk.total - sys.disk.free : 0;
  const diskPct = sys?.disk ? (diskUsed / sys.disk.total) * 100 : 0;

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="p-6 max-w-6xl mx-auto">
      <div className="mb-6">
        <SectionHeading icon={SlidersHorizontal} title="Settings" subtitle="Manage Mercy Launcher's behavior, games, and your account" />
      </div>

      <div className="flex gap-6 items-start">
        {/* Category rail */}
        <div className="w-48 shrink-0 space-y-1">
          {CATEGORIES.map((c) => {
            const active = tab === c.id;
            return (
              <button
                key={c.id}
                onClick={() => setTab(c.id)}
                className={`relative w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm font-semibold transition-colors text-left ${
                  active ? 'text-primary-300' : 'text-surface-400 hover:text-surface-200 hover:bg-overlay-4'
                }`}
              >
                {active && (
                  <motion.span
                    layoutId="settings-tab-active"
                    transition={{ type: 'spring', stiffness: 500, damping: 40 }}
                    className="absolute inset-0 rounded-xl bg-primary-600/15 border border-primary-500/25"
                  />
                )}
                <c.icon size={15} className="relative" />
                <span className="relative">{c.label}</span>
              </button>
            );
          })}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div key={tab} className="space-y-4">

              {/* ═══ General ═══ */}
              {tab === 'general' && (
                <>
                  <Row icon={Power} iconClass="bg-primary-600/20 border-primary-500/20 text-primary-400" title="Start with Windows" sub="Launch Mercy Launcher automatically when you sign in"
                    control={<Toggle checked={startWithWindows} onChange={handleStartWithWindows} />} />
                  <Row icon={PictureInPicture2} iconClass="bg-sky-600/20 border-sky-500/20 text-sky-400" title="Minimize to tray" sub="Keep running in the background when you close the window"
                    control={<Toggle checked={minimizeToTray} onChange={handleMinimizeToTray} />} />
                  <Row icon={theme === 'dark' ? Moon : Sun} iconClass="bg-purple-600/20 border-purple-500/20 text-purple-400" title="Theme" sub="Switch between dark and light mode"
                    control={
                      <button onClick={toggleTheme} className="flex items-center gap-2 px-4 py-2 bg-overlay-6 rounded-xl hover:bg-overlay-10 border border-overlay-8 transition-colors">
                        {theme === 'dark' ? <Moon size={15} className="text-blue-400" /> : <Sun size={15} className="text-amber-400" />}
                        <span className="text-sm capitalize text-surface-200">{theme} Mode</span>
                      </button>
                    } />

                  {!isSupabaseConfigured() && (
                    <Row icon={Shield} iconClass="bg-primary-600/20 border-primary-500/25 text-primary-300" title={adminUnlocked ? 'Admin access is on for this computer' : adminHasPin ? 'Admin access' : 'Set up admin access'}
                      sub={adminUnlocked ? 'The Admin tab is available in the top bar.' : 'Protected by a 4-digit code. Only people with the code can see the Admin tab.'}
                      control={adminUnlocked ? (
                        <button onClick={() => adminLock()} className="flex items-center gap-1.5 btn-secondary text-xs py-2 shrink-0"><LogOut size={13} /> Sign out</button>
                      ) : (
                        <button onClick={() => navigate('/admin')} className="flex items-center gap-1.5 btn-primary text-xs py-2 shrink-0"><KeyRound size={13} /> {adminHasPin ? 'Enter code' : 'Set up'}</button>
                      )} />
                  )}
                </>
              )}

              {/* ═══ Downloads ═══ */}
              {tab === 'downloads' && (
                <Row icon={FolderOpen} iconClass="bg-blue-600/20 border-blue-500/20 text-blue-400" title="Default download location" sub={downloadPath || 'Not set — using system default'}
                  control={<button onClick={pickDownloadPath} className="btn-secondary text-xs py-2 px-3 shrink-0">Choose Folder</button>} />
              )}

              {/* ═══ Games ═══ */}
              {tab === 'games' && (
                <div className="space-y-3">
                  {GAME_ROWS.map((g) => {
                    const count = g.id === 'fivem' ? servers.length : null;
                    return (
                      <Panel as="button" interactive key={g.id} onClick={() => navigate(g.path)} className="group w-full flex items-center gap-4">
                        <div className="w-10 h-10 rounded-xl bg-overlay-6 border border-overlay-10 flex items-center justify-center shrink-0"><Gamepad2 size={17} className="text-primary-300" /></div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-surface-100">{g.label}</p>
                          <p className="text-xs text-surface-500 mt-0.5">
                            {g.real ? `${count} server${count === 1 ? '' : 's'} configured` : 'Management hub coming soon'}
                          </p>
                        </div>
                        <ChevronRight size={14} className="text-surface-600 shrink-0 transition-transform group-hover:translate-x-0.5" />
                      </Panel>
                    );
                  })}
                </div>
              )}

              {/* ═══ Updates ═══ */}
              {tab === 'updates' && (
                <>
                  <Row icon={RefreshCw} iconClass="bg-primary-600/20 border-primary-500/20 text-primary-400" title="Automatic updates" sub="Download updates in the background as soon as they're available"
                    control={<Toggle checked={autoUpdate} onChange={handleAutoUpdate} />} />
                  <Panel className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-xl bg-overlay-6 border border-overlay-10 flex items-center justify-center shrink-0">
                      {updateStatus === 'checking' || updateStatus === 'downloading' ? <Loader2 size={17} className="text-primary-400 animate-spin" /> :
                        updateStatus === 'ready' ? <CheckCircle2 size={17} className="text-emerald-400" /> :
                        updateStatus === 'available' ? <ArrowUpCircle size={17} className="text-primary-400" /> : <Info size={17} className="text-surface-400" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-surface-100">
                        {updateStatus === 'checking' && 'Checking for updates…'}
                        {updateStatus === 'downloading' && 'Downloading update…'}
                        {updateStatus === 'ready' && `Update ready — v${updateVersion}`}
                        {updateStatus === 'available' && `Update available — v${updateVersion}`}
                        {(updateStatus === 'idle' || updateStatus === 'current') && "You're up to date"}
                        {updateStatus === 'error' && 'Could not check for updates'}
                      </p>
                      <p className="text-xs text-surface-500 mt-0.5">Current version {sys?.appVersion ?? '…'}</p>
                    </div>
                    {updateStatus === 'ready' ? (
                      <button onClick={handleInstallUpdate} className="btn-primary text-xs py-2 px-3 shrink-0">Restart & Install</button>
                    ) : (
                      <button onClick={handleCheckUpdates} disabled={updateStatus === 'checking' || updateStatus === 'downloading'} className="btn-secondary text-xs py-2 px-3 shrink-0 disabled:opacity-50">
                        Check for Updates
                      </button>
                    )}
                  </Panel>
                </>
              )}

              {/* ═══ Account ═══ */}
              {tab === 'account' && (
                showAccount ? (
                  <>
                    <Panel className="flex items-center gap-4">
                      <div className="w-10 h-10 rounded-xl bg-primary-600/20 border border-primary-500/25 flex items-center justify-center shrink-0">
                        <UserCircle2 size={17} className="text-primary-300" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-surface-100 truncate">{authStatus?.username || 'Verified'}</p>
                        <p className="text-xs text-surface-500 mt-0.5 flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> {authStatus?.stale ? 'Offline' : 'Signed in with Discord'}
                        </p>
                      </div>
                      <button onClick={handleSignOut} disabled={signingOut} className="flex items-center gap-1.5 btn-secondary text-xs py-2 shrink-0">
                        <LogOut size={13} /> {signingOut ? 'Signing out…' : 'Sign out'}
                      </button>
                    </Panel>

                    {/* Profile foundation — real counts only, no invented content */}
                    <Panel>
                      <p className="text-xs font-bold text-surface-400 uppercase tracking-wider mb-3">Profile</p>
                      <div className="grid grid-cols-3 gap-4">
                        <div>
                          <div className="flex items-center gap-1.5 text-surface-500 mb-1"><ServerIcon size={12} /><span className="text-[10px] uppercase tracking-wider">Owned Servers</span></div>
                          <p className="text-lg font-extrabold text-surface-100">{servers.length}</p>
                        </div>
                        <div>
                          <div className="flex items-center gap-1.5 text-surface-500 mb-1"><Star size={12} /><span className="text-[10px] uppercase tracking-wider">Favorites</span></div>
                          <p className="text-lg font-extrabold text-surface-100">{favoritesCount}</p>
                        </div>
                        <div>
                          <div className="flex items-center gap-1.5 text-surface-500 mb-1"><Package size={12} /><span className="text-[10px] uppercase tracking-wider">Installed Content</span></div>
                          <p className="text-sm font-semibold text-surface-500 mt-0.5">Coming soon</p>
                        </div>
                      </div>
                      {authStatus?.entitlements?.length ? (
                        <div className="mt-4 pt-4 border-t border-overlay-6">
                          <p className="text-[10px] uppercase tracking-wider text-surface-500 mb-2">Permissions</p>
                          <div className="flex flex-wrap gap-1.5">
                            {authStatus.entitlements.map((e) => (
                              <span key={e} className="text-[10px] px-2 py-1 rounded-md bg-overlay-6 text-surface-300">{e}</span>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </Panel>
                  </>
                ) : (
                  <Panel padding="lg" className="text-center">
                    <p className="text-sm font-semibold text-surface-200">Not signed in</p>
                    <p className="text-xs text-surface-500 mt-1">Sign in with Discord to see your Mercy account here.</p>
                  </Panel>
                )
              )}

              {/* ═══ System ═══ */}
              {tab === 'system' && (
                <>
                  <div className="grid grid-cols-2 gap-4">
                    <Panel>
                      <div className="flex items-center gap-3 mb-1">
                        <div className="w-10 h-10 rounded-xl bg-blue-600/20 border border-blue-500/20 flex items-center justify-center"><HardDrive size={17} className="text-blue-400" /></div>
                        <div><p className="text-[11px] text-surface-500">Total Disk Usage</p><p className="text-xl font-extrabold text-surface-100">{sys?.disk ? `${gb(diskUsed)} GB` : '—'}</p></div>
                      </div>
                      <UsageBar pct={diskPct} color="bg-gradient-to-r from-blue-600 to-blue-400" />
                      <p className="text-[10px] text-surface-500 mt-2">{sys?.disk ? `${gb(diskUsed)} GB of ${gb(sys.disk.total)} GB used · ${gb(sys.disk.free)} GB free` : 'Reading disk…'}</p>
                    </Panel>
                    <Panel>
                      <div className="flex items-center gap-3 mb-1">
                        <div className="w-10 h-10 rounded-xl bg-purple-600/20 border border-purple-500/20 flex items-center justify-center"><Database size={17} className="text-purple-400" /></div>
                        <div><p className="text-[11px] text-surface-500">Servers Registered</p><p className="text-xl font-extrabold text-surface-100">{servers.length}</p></div>
                      </div>
                      <UsageBar pct={servers.length > 0 ? 100 : 0} color="bg-gradient-to-r from-purple-600 to-purple-400" />
                      <p className="text-[10px] text-surface-500 mt-2">{servers.length} server{servers.length !== 1 ? 's' : ''} managed by this app</p>
                    </Panel>
                  </div>

                  <div className="grid grid-cols-3 gap-4">
                    <Panel>
                      <div className="flex items-center gap-3"><div className="w-10 h-10 rounded-xl bg-emerald-600/20 border border-emerald-500/20 flex items-center justify-center"><Cpu size={17} className="text-emerald-400" /></div>
                        <div><p className="text-[11px] text-surface-500">CPU Usage</p><p className="text-xl font-extrabold text-surface-100">{sys ? `${sys.cpuUsage.toFixed(1)}%` : '—'}</p></div></div>
                      <UsageBar pct={sys?.cpuUsage ?? 0} color="bg-gradient-to-r from-emerald-600 to-emerald-400" />
                    </Panel>
                    <Panel>
                      <div className="flex items-center gap-3"><div className="w-10 h-10 rounded-xl bg-amber-600/20 border border-amber-500/20 flex items-center justify-center"><MemoryStick size={17} className="text-amber-400" /></div>
                        <div><p className="text-[11px] text-surface-500">RAM Usage</p><p className="text-xl font-extrabold text-surface-100">{sys ? `${memUsedPct.toFixed(1)}%` : '—'}</p></div></div>
                      <UsageBar pct={memUsedPct} color="bg-gradient-to-r from-amber-600 to-orange-400" />
                    </Panel>
                    <Panel>
                      <div className="flex items-center gap-3"><div className="w-10 h-10 rounded-xl bg-sky-600/20 border border-sky-500/20 flex items-center justify-center"><Activity size={17} className="text-sky-400" /></div>
                        <div><p className="text-[11px] text-surface-500">Active Servers</p><p className="text-xl font-extrabold text-surface-100">{running}</p></div></div>
                      <UsageBar pct={servers.length ? (running / servers.length) * 100 : 0} color="bg-gradient-to-r from-sky-600 to-sky-400" />
                    </Panel>
                  </div>

                  <Panel>
                    <h3 className="text-sm font-bold text-surface-100 mb-4">System Specifications</h3>
                    <div className="grid grid-cols-2 gap-x-8 gap-y-4">
                      {[
                        { label: 'Processor', value: sys ? `${sys.cpuModel} (${sys.cpuCores} threads)` : '—' },
                        { label: 'Memory', value: sys ? `${gb(sys.totalMem)} GB RAM · ${gb(sys.freeMem)} GB free` : '—' },
                        { label: 'Operating System', value: sys?.platform ?? '—' },
                        { label: 'Computer Name', value: sys?.hostname ?? '—' },
                      ].map((row) => (
                        <div key={row.label}>
                          <p className="text-[10px] text-surface-500 uppercase tracking-wider mb-0.5">{row.label}</p>
                          <p className="text-sm text-surface-200 font-medium">{row.value}</p>
                        </div>
                      ))}
                    </div>
                  </Panel>
                </>
              )}

              {/* ═══ About ═══ */}
              {tab === 'about' && (
                <Panel>
                  <div className="flex items-center gap-3 mb-4">
                    <MercyLogo size={40} />
                    <div><p className="text-sm font-bold text-surface-100">Mercy Launcher</p><p className="text-xs text-surface-500">Game Management Hub</p></div>
                  </div>
                  <div className="grid grid-cols-3 gap-4">
                    {[
                      { label: 'App Version', value: sys?.appVersion ?? '…' },
                      { label: 'Electron', value: sys?.electron ?? '…' },
                      { label: 'Games Supported', value: 'FiveM · more coming soon' },
                    ].map((r) => (
                      <div key={r.label}>
                        <p className="text-[10px] text-surface-500 uppercase tracking-wider mb-0.5">{r.label}</p>
                        <p className="text-sm text-surface-200 font-medium flex items-center gap-1.5"><Info size={11} className="text-surface-600" /> {r.value}</p>
                      </div>
                    ))}
                  </div>
                </Panel>
              )}
          </div>
        </div>
      </div>
    </motion.div>
  );
}
