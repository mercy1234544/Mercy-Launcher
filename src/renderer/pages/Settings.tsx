import React, { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import * as Tabs from '@radix-ui/react-tabs';
import { useNavigate } from 'react-router-dom';
import {
  HardDrive, Cpu, MemoryStick, Activity, Info, Database,
  Shield, KeyRound, LogOut, SlidersHorizontal, Download, Gamepad2, RefreshCw,
  UserCircle2, FolderOpen, Power, PictureInPicture2, CheckCircle2, Loader2,
  ArrowUpCircle, Star, Server as ServerIcon, Package, ChevronRight, Palette,
  Check, RotateCcw, ImagePlus, Trash2, X,
} from 'lucide-react';
import { useAppStore } from '../stores/useAppStore';
import { useLocalAccess } from '../stores/useLocalAccess';
import { useAppAuth } from '../stores/useAppAuth';
import { useFavorites } from '../stores/useFavorites';
import { useTheme } from '../stores/useTheme';
import { isSupabaseConfigured } from '../lib/supabase';
import MercyLogo from '../components/MercyLogo';
import { Panel, Toggle, SectionHeading } from '../components/ui';
import { GAMES } from '../config/games';
import { THEMES, NAV_COLOR_TARGETS, CUSTOMIZABLE_TOKEN_GROUPS, getTheme } from '../config/themes';
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
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'downloads', label: 'Downloads', icon: Download },
  { id: 'games', label: 'Games', icon: Gamepad2 },
  { id: 'updates', label: 'Updates', icon: RefreshCw },
  { id: 'account', label: 'Account', icon: UserCircle2 },
  { id: 'system', label: 'System', icon: Cpu },
  { id: 'about', label: 'About', icon: Info },
] as const;
type CategoryId = typeof CATEGORIES[number]['id'];

export default function Settings() {
  const { servers } = useAppStore();
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

  // ── Appearance ─────────────────────────────────────────────────────────────
  const activeThemeId = useTheme((s) => s.activeThemeId);
  const customTokens = useTheme((s) => s.customTokens);
  const hasCustomTheme = useTheme((s) => s.hasCustomTheme);
  const avatarDataUrl = useTheme((s) => s.avatarDataUrl);
  const previewPreset = useTheme((s) => s.previewPreset);
  const previewToken = useTheme((s) => s.previewToken);
  const previewNavColor = useTheme((s) => s.previewNavColor);
  const saveTheme = useTheme((s) => s.save);
  const discardThemeChanges = useTheme((s) => s.discardChanges);
  const restoreDefaultTheme = useTheme((s) => s.restoreDefault);
  const pickAvatar = useTheme((s) => s.pickAvatar);
  const removeAvatarAction = useTheme((s) => s.removeAvatar);
  const [savingTheme, setSavingTheme] = useState(false);
  const activePreset = getTheme(activeThemeId);
  const tokenValue = (key: string) => customTokens[key] ?? (activePreset.tokens as any)[key] ?? '';
  const navColorValue = (navId: string) => customTokens[`nav-${navId}`] ?? '';
  const handleSaveTheme = async () => { setSavingTheme(true); await saveTheme(); setSavingTheme(false); toast.success('Theme saved'); };
  const handleAvatarPick = async () => {
    const res = await pickAvatar();
    if (!res.success && res.error) toast.error(res.error);
    else if (res.success) toast.success('Profile image updated');
  };

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

      <Tabs.Root value={tab} onValueChange={(v) => setTab(v as CategoryId)} orientation="vertical" className="flex gap-6 items-start">
        {/* Category rail */}
        <Tabs.List className="w-48 shrink-0 space-y-1" aria-label="Settings categories">
          {CATEGORIES.map((c) => {
            const active = tab === c.id;
            return (
              <Tabs.Trigger
                key={c.id}
                value={c.id}
                className={`relative w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm font-semibold transition-colors text-left outline-none ${
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
              </Tabs.Trigger>
            );
          })}
        </Tabs.List>

        {/* Content */}
        <div className="flex-1 min-w-0">
              {/* ═══ General ═══ */}
              <Tabs.Content value="general" className="space-y-4 outline-none">
                <>
                  <Row icon={Power} iconClass="bg-primary-600/20 border-primary-500/20 text-primary-400" title="Start with Windows" sub="Launch Mercy Launcher automatically when you sign in"
                    control={<Toggle checked={startWithWindows} onChange={handleStartWithWindows} />} />
                  <Row icon={PictureInPicture2} iconClass="bg-sky-600/20 border-sky-500/20 text-sky-400" title="Minimize to tray" sub="Keep running in the background when you close the window"
                    control={<Toggle checked={minimizeToTray} onChange={handleMinimizeToTray} />} />
                  <Row icon={Palette} iconClass="bg-purple-600/20 border-purple-500/20 text-purple-400" title="Appearance" sub="Themes, colors, and your profile image have their own tab now"
                    control={<button onClick={() => setTab('appearance')} className="btn-secondary text-xs py-2 px-3 shrink-0 flex items-center gap-1.5">Open <ChevronRight size={13} /></button>} />

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
              </Tabs.Content>

              {/* ═══ Appearance ═══ */}
              <Tabs.Content value="appearance" className="space-y-5 outline-none">
                {/* Profile image */}
                <Panel>
                  <p className="text-xs font-bold text-surface-400 uppercase tracking-wider mb-3">Profile Image</p>
                  <div className="flex items-center gap-4">
                    <div className="w-16 h-16 rounded-2xl bg-primary-500/15 border border-primary-500/25 flex items-center justify-center overflow-hidden shrink-0">
                      {avatarDataUrl ? <img src={avatarDataUrl} alt="" className="w-full h-full object-cover" /> : <UserCircle2 size={28} className="text-primary-300" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-surface-100">{avatarDataUrl ? 'Custom image set' : 'Using the default Mercy avatar'}</p>
                      <p className="text-xs text-surface-500 mt-0.5">PNG, JPG, WEBP, or GIF — shown in the sidebar and Settings.</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button onClick={handleAvatarPick} className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5"><ImagePlus size={13} /> Choose Image</button>
                      {avatarDataUrl && (
                        <button onClick={removeAvatarAction} className="p-2 rounded-lg text-surface-500 hover:text-error hover:bg-overlay-6 transition-colors"><Trash2 size={14} /></button>
                      )}
                    </div>
                  </div>
                </Panel>

                {/* Presets */}
                <Panel>
                  <p className="text-xs font-bold text-surface-400 uppercase tracking-wider mb-3">Theme Presets</p>
                  <div className="grid grid-cols-3 gap-3">
                    {THEMES.map((t) => {
                      const active = activeThemeId === t.id && !hasCustomTheme;
                      return (
                        <button key={t.id} onClick={() => previewPreset(t.id)}
                          className={`relative rounded-xl border p-3 text-left transition-all ${active ? 'border-primary-500/50 bg-primary-500/10' : 'border-overlay-6 bg-overlay-3 hover:bg-overlay-6 hover:border-overlay-10'}`}>
                          {active && <div className="absolute top-2 right-2 w-4 h-4 rounded-full bg-primary-500 flex items-center justify-center"><Check size={10} className="text-white" /></div>}
                          <div className="flex gap-1 mb-2">
                            {t.swatch.map((c, i) => <div key={i} className="w-5 h-5 rounded-md border border-overlay-10" style={{ background: c }} />)}
                          </div>
                          <p className="text-xs font-bold text-surface-100">{t.name}</p>
                          <p className="text-[10px] text-surface-500 mt-0.5 line-clamp-2">{t.description}</p>
                        </button>
                      );
                    })}
                  </div>
                </Panel>

                {/* Custom colors */}
                <Panel>
                  <p className="text-xs font-bold text-surface-400 uppercase tracking-wider mb-3">Custom Colors</p>
                  <div className="space-y-4">
                    {CUSTOMIZABLE_TOKEN_GROUPS.map((group) => (
                      <div key={group.label}>
                        <p className="text-[11px] font-semibold text-surface-400 mb-2">{group.label}</p>
                        <div className="flex flex-wrap gap-3">
                          {group.keys.map((key) => (
                            <label key={key} className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-overlay-3 border border-overlay-6 cursor-pointer hover:bg-overlay-6 transition-colors">
                              <input type="color" value={tokenValue(key).startsWith('#') ? tokenValue(key) : '#6366f1'}
                                onChange={(e) => previewToken(key, e.target.value)}
                                className="w-6 h-6 rounded border-0 bg-transparent cursor-pointer" />
                              <span className="text-[11px] text-surface-300 capitalize">{key.replace(/-/g, ' ')}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </Panel>

                {/* Navigation colors */}
                <Panel>
                  <p className="text-xs font-bold text-surface-400 uppercase tracking-wider mb-1">Navigation Colors</p>
                  <p className="text-[11px] text-surface-500 mb-3">Give individual sidebar items their own active color.</p>
                  <div className="flex flex-wrap gap-3">
                    {NAV_COLOR_TARGETS.map((nav) => (
                      <label key={nav.id} className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-overlay-3 border border-overlay-6 cursor-pointer hover:bg-overlay-6 transition-colors">
                        <input type="color" value={navColorValue(nav.id) || '#6366f1'}
                          onChange={(e) => previewNavColor(nav.id, e.target.value)}
                          className="w-6 h-6 rounded border-0 bg-transparent cursor-pointer" />
                        <span className="text-[11px] text-surface-300">{nav.label}</span>
                      </label>
                    ))}
                  </div>
                </Panel>

                {/* Live preview */}
                <Panel>
                  <p className="text-xs font-bold text-surface-400 uppercase tracking-wider mb-3">Preview</p>
                  <div className="rounded-xl border border-overlay-6 p-4 flex items-center gap-4" style={{ background: 'var(--bg-base)' }}>
                    <div className="w-32 rounded-lg p-2 space-y-1 shrink-0" style={{ background: 'var(--surface-925)' }}>
                      {['Home', 'Library', 'Settings'].map((label, i) => (
                        <div key={label} className="text-[10px] px-2 py-1.5 rounded-md" style={i === 0
                          ? { background: 'color-mix(in srgb, var(--primary-500) 15%, transparent)', color: 'var(--primary-400)' }
                          : { color: 'var(--text-muted)' }}>{label}</div>
                      ))}
                    </div>
                    <div className="flex-1 space-y-2">
                      <div className="rounded-lg p-3" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)' }}>
                        <p className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>Card title</p>
                        <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>Secondary text in this theme</p>
                      </div>
                      <div className="flex gap-2">
                        <div className="text-[10px] font-bold px-3 py-1.5 rounded-lg text-white" style={{ background: 'var(--primary-600)' }}>Primary Button</div>
                        <div className="text-[10px] font-bold px-2.5 py-1.5 rounded-lg badge-success">Success</div>
                        <div className="text-[10px] font-bold px-2.5 py-1.5 rounded-lg badge-danger">Error</div>
                      </div>
                    </div>
                  </div>
                </Panel>

                <div className="flex items-center justify-end gap-2">
                  <button onClick={discardThemeChanges} className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5"><X size={13} /> Discard</button>
                  <button onClick={restoreDefaultTheme} className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5"><RotateCcw size={13} /> Restore Default</button>
                  <button onClick={handleSaveTheme} disabled={savingTheme} className="btn-primary text-xs py-2 px-3 flex items-center gap-1.5"><Check size={13} /> {savingTheme ? 'Saving…' : 'Save Theme'}</button>
                </div>
              </Tabs.Content>

              {/* ═══ Downloads ═══ */}
              <Tabs.Content value="downloads" className="space-y-4 outline-none">
                <Row icon={FolderOpen} iconClass="bg-blue-600/20 border-blue-500/20 text-blue-400" title="Default download location" sub={downloadPath || 'Not set — using system default'}
                  control={<button onClick={pickDownloadPath} className="btn-secondary text-xs py-2 px-3 shrink-0">Choose Folder</button>} />
              </Tabs.Content>

              {/* ═══ Games ═══ */}
              <Tabs.Content value="games" className="space-y-4 outline-none">
                <div className="space-y-3">
                  {GAMES.map((g) => {
                    const count = g.id === 'fivem' ? servers.length : null;
                    return (
                      <Panel as="button" interactive key={g.id} onClick={() => navigate(g.path)} className="group w-full flex items-center gap-4">
                        <div className={`w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 ${g.tintBadge}`}><g.icon size={17} /></div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-surface-100">{g.label}</p>
                          <p className="text-xs text-surface-500 mt-0.5">
                            {g.hasRealHub ? `${count} server${count === 1 ? '' : 's'} configured` : 'Management hub coming soon'}
                          </p>
                        </div>
                        <ChevronRight size={14} className="text-surface-600 shrink-0 transition-transform group-hover:translate-x-0.5" />
                      </Panel>
                    );
                  })}
                </div>
              </Tabs.Content>

              {/* ═══ Updates ═══ */}
              <Tabs.Content value="updates" className="space-y-4 outline-none">
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
              </Tabs.Content>

              {/* ═══ Account ═══ */}
              <Tabs.Content value="account" className="space-y-4 outline-none">
                {showAccount ? (
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
                )}
              </Tabs.Content>

              {/* ═══ System ═══ */}
              <Tabs.Content value="system" className="space-y-4 outline-none">
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
              </Tabs.Content>

              {/* ═══ About ═══ */}
              <Tabs.Content value="about" className="space-y-4 outline-none">
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
              </Tabs.Content>
        </div>
      </Tabs.Root>
    </motion.div>
  );
}
