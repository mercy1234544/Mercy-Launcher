import React, { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, Wrench, FolderOpen, RefreshCw, Loader2, CheckCircle2, AlertTriangle, XCircle, Copy, Globe2, Lock, ShieldCheck, ScrollText } from 'lucide-react';
import toast from 'react-hot-toast';
import { Panel, SectionHeading } from '../components/ui';
import AcSectionNav from '../components/AcSectionNav';
import AcCatalogSettingsPanel from '../components/ac/AcCatalogSettingsPanel';
import AcReadinessPanel from '../components/ac/AcReadinessPanel';
import AcRequirementsPanel from '../components/ac/AcRequirementsPanel';
import { summarizeReport, TONE_CLASSES } from '../lib/acMercyView';

function Row({ label, value, tone }: { label: string; value: React.ReactNode; tone?: 'good' | 'warn' | 'bad' | 'neutral' }) {
  const Icon = tone === 'good' ? CheckCircle2 : tone === 'warn' ? AlertTriangle : tone === 'bad' ? XCircle : null;
  const color = tone === 'good' ? 'text-emerald-300' : tone === 'warn' ? 'text-amber-300' : tone === 'bad' ? 'text-red-300' : 'text-surface-300';
  return (
    <div className="flex items-start gap-3 py-2 border-b border-overlay-6 last:border-0">
      <p className="w-44 shrink-0 text-xs text-surface-500">{label}</p>
      <div className={`flex-1 min-w-0 text-xs break-words ${color} flex items-start gap-1.5`}>{Icon && <Icon size={13} className="mt-0.5 shrink-0" />}<span className="min-w-0">{value}</span></div>
    </div>
  );
}

function EndpointEditor({ profile, onSaved }: { profile: AcMercyServerProfile; onSaved: () => void }) {
  const api = window.electronAPI.assettoCorsa;
  const [lan, setLan] = useState(''); const [pub, setPub] = useState(''); const [tcp, setTcp] = useState(''); const [http, setHttp] = useState('');
  const [busy, setBusy] = useState(false);
  const [tests, setTests] = useState<{ public?: AcEndpointTest; lan?: AcEndpointTest }>({});
  const [testing, setTesting] = useState<'public' | 'lan' | null>(null);
  const runTest = async (scope: 'public' | 'lan') => {
    setTesting(scope);
    try {
      const r = await api.testSrpEndpoint(profile.id, scope);
      setTests((t) => ({ ...t, [scope]: r.success ? r.test : { configured: true, message: r.error } }));
    } finally { setTesting(null); }
  };
  useEffect(() => { (async () => {
    const r = await api.getSrpEndpoints(profile.id);
    if (r.success) { setLan(r.settings.lanHost ?? ''); setPub(r.settings.publicHostOverride ?? ''); setTcp(r.settings.publicTcpPortOverride?.toString() ?? ''); setHttp(r.settings.publicHttpPortOverride?.toString() ?? ''); }
  })(); }, [profile.id]);
  const num = (s: string) => (s.trim() ? Number(s) : null);
  const save = async () => {
    setBusy(true);
    try {
      const r = await api.setSrpEndpoints(profile.id, { lanHost: lan.trim() || null, publicHostOverride: pub.trim() || null, publicTcpPortOverride: num(tcp), publicHttpPortOverride: num(http) });
      if (r.success) { toast.success('Saved on this computer.'); onSaved(); } else toast.error(r.error ?? 'Could not save.');
    } finally { setBusy(false); }
  };
  const input = 'input-field !py-1.5 !px-3 !rounded-lg text-xs';
  return (
    <div className="p-3 rounded-xl border border-overlay-6 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <p className="text-xs font-bold text-surface-100">{profile.name}</p>
        <span className={`text-[10px] px-2 py-0.5 rounded-full border ${profile.endpoint.publicConfigured ? TONE_CLASSES.good.chip : TONE_CLASSES.warn.chip}`}>
          {profile.endpoint.publicConfigured ? `Public endpoint set (${profile.endpoint.publicSource === 'release' ? 'from release' : 'local override'})` : 'Public endpoint NOT configured (PUBLIC_HOST_TBD)'}
        </span>
        {profile.endpoint.lanConfigured && <span className={`text-[10px] px-2 py-0.5 rounded-full border ${TONE_CLASSES.info.chip}`}>LAN address set on this PC</span>}
      </div>
      {profile.endpoint.problems.filter((p) => !/PUBLIC_HOST_TBD/.test(p)).map((p, i) => <p key={i} className="text-[11px] text-red-300">{p}</p>)}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="space-y-1"><span className="flex items-center gap-1 text-[11px] text-surface-400"><Lock size={11} /> LAN address — this PC only</span>
          <input className={input} value={lan} onChange={(e) => setLan(e.target.value)} placeholder="your server PC's local address" />
          <span className="block text-[10px] text-surface-600">For the owner joining from the home network. Stored only on this computer — never in the app, a release, a log, or sent anywhere.</span></label>
        <label className="space-y-1"><span className="flex items-center gap-1 text-[11px] text-surface-400"><Globe2 size={11} /> Public host name (override)</span>
          <input className={input} value={pub} onChange={(e) => setPub(e.target.value)} placeholder="the owner's public host name" />
          <span className="block text-[10px] text-surface-600">What remote players use. Leave empty to use the release's value. Private addresses are rejected here.</span></label>
        <label className="space-y-1"><span className="text-[11px] text-surface-400">Public game port (only if your router maps a different one)</span>
          <input className={input} value={tcp} onChange={(e) => setTcp(e.target.value.replace(/\D/g, ''))} placeholder="default from the server's settings" /></label>
        <label className="space-y-1"><span className="text-[11px] text-surface-400">Public HTTP port (only if remapped)</span>
          <input className={input} value={http} onChange={(e) => setHttp(e.target.value.replace(/\D/g, ''))} placeholder="default from the server's settings" /></label>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={save} disabled={busy} className="btn-secondary text-xs py-1.5 px-3 disabled:opacity-50">{busy ? 'Saving…' : 'Save for this computer'}</button>
        <button onClick={() => runTest('public')} disabled={!!testing} className="btn-secondary text-xs py-1.5 px-3 disabled:opacity-50 flex items-center gap-1.5">{testing === 'public' ? <Loader2 size={12} className="animate-spin" /> : <Globe2 size={12} />} Test public endpoint</button>
        {profile.endpoint.lanConfigured && <button onClick={() => runTest('lan')} disabled={!!testing} className="btn-secondary text-xs py-1.5 px-3 disabled:opacity-50 flex items-center gap-1.5">{testing === 'lan' ? <Loader2 size={12} className="animate-spin" /> : <Lock size={12} />} Test LAN endpoint</button>}
      </div>
      {(['public', 'lan'] as const).map((scope) => tests[scope] && (
        <div key={scope} className="rounded-lg border border-overlay-6 bg-surface-950/40 p-2.5 space-y-1.5" data-testid={`endpoint-test-${scope}`}>
          <p className="text-[11px] font-bold text-surface-300">{scope === 'public' ? 'Public endpoint' : 'LAN endpoint'} test</p>
          {!tests[scope]!.configured ? <p className="text-[11px] text-amber-200">{tests[scope]!.message}</p> : (<>
            {tests[scope]!.diagnosis!.checks.map((c) => (
              <p key={c.id} className="flex gap-1.5 text-[11px]">
                {c.state === 'pass' ? <CheckCircle2 size={12} className="text-emerald-300 shrink-0 mt-0.5" /> : c.state === 'fail' ? <XCircle size={12} className="text-red-300 shrink-0 mt-0.5" /> : c.state === 'warn' ? <AlertTriangle size={12} className="text-amber-300 shrink-0 mt-0.5" /> : <span className="w-3 shrink-0" />}
                <span className="text-surface-300"><span className="font-semibold">{c.label}.</span> <span className="text-surface-400">{c.detail}</span></span>
              </p>
            ))}
            {tests[scope]!.diagnosis!.hints.map((h, i) => <p key={i} className="text-[11px] text-amber-200/90 pl-4">→ {h}</p>)}
            {tests[scope]!.diagnosis!.reachable && <p className="text-[11px] text-surface-500 pl-4">TCP and the status page answered from this computer. That is not proof a remote player can join — test from another network and do a real join.</p>}
          </>)}
        </div>
      ))}
    </div>
  );
}

// What the installer keeps on disk: the downloaded archive (so repairs don't re-download 4.8 GB) and a backup of every
// folder it replaced. Both are visible here and can be deleted — nothing accumulates silently.
function StoragePanel({ onChanged }: { onChanged: () => void }) {
  const api = window.electronAPI.assettoCorsa;
  const [s, setS] = useState<AcStorageInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => { const r = await api.srpStorage(); if (r.success) setS(r.storage); }, []);
  useEffect(() => { load(); }, [load]);
  const fmt = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
  const del = async (key: string, fn: () => Promise<{ success: boolean; freedBytes: number; error?: string }>) => {
    setBusy(key);
    try { const r = await fn(); if (r.success) toast.success(`Freed ${fmt(r.freedBytes)}.`); else toast.error(r.error ?? 'Could not delete.'); await load(); onChanged(); } finally { setBusy(null); }
  };
  if (!s) return null;
  return (
    <Panel>
      <h2 className="text-sm font-bold text-surface-100 mb-1">Storage used by the installer</h2>
      <p className="text-[11px] text-surface-500 mb-2">The launcher keeps the archive it downloaded (so a repair doesn't download it again) and a backup of anything it replaced. Delete them whenever you like — your installed cars and tracks are never touched here.</p>
      <div className="flex items-center gap-3 py-2 border-b border-overlay-6">
        <p className="w-44 shrink-0 text-xs text-surface-500">Downloaded archives</p>
        <p className="flex-1 text-xs text-surface-300">{s.downloads.files.length === 0 ? 'None.' : `${s.downloads.files.length} file${s.downloads.files.length === 1 ? '' : 's'} · ${fmt(s.downloads.totalBytes)} (${s.downloads.files.map((f) => f.name).join(', ')})`}</p>
        {s.downloads.files.length > 0 && <button onClick={() => del('dl', () => api.deleteSrpDownloads())} disabled={!!busy} className="btn-secondary text-[11px] py-1 px-2.5 disabled:opacity-50">{busy === 'dl' ? 'Deleting…' : 'Delete downloads'}</button>}
      </div>
      {s.backups.length === 0 ? <p className="text-xs text-surface-500 py-2">No backups. (They appear when an install replaces or moves something.)</p> : s.backups.map((b) => (
        <div key={b.id} className="flex items-start gap-3 py-2 border-b border-overlay-6 last:border-0" data-testid="backup-row">
          <div className="w-44 shrink-0"><p className="text-xs text-surface-500">Backup</p><p className="text-[10px] text-surface-600">{b.createdAt ? new Date(b.createdAt).toLocaleString() : b.id}</p></div>
          <div className="flex-1 min-w-0"><p className="text-xs text-surface-300">{fmt(b.bytes)}{b.inProgress ? ' — from an install that did not finish (needed until the next install rolls it back)' : ''}</p><p className="text-[11px] text-surface-500 break-words">{b.items.length ? b.items.join(' · ') : 'no replaced folders'}</p></div>
          <button onClick={() => api.revealSrpBackup(b.path)} className="text-[11px] text-primary-300 hover:text-primary-200 shrink-0">Show</button>
          <button onClick={() => del(b.id, () => api.deleteSrpBackup(b.id))} disabled={!!busy || b.inProgress} className="btn-secondary text-[11px] py-1 px-2.5 shrink-0 disabled:opacity-50">{busy === b.id ? 'Deleting…' : 'Delete'}</button>
        </div>
      ))}
    </Panel>
  );
}

export default function AssettoCorsaSetup() {
  const navigate = useNavigate();
  const location = useLocation();
  const api = window.electronAPI.assettoCorsa;
  const [dg, setDg] = useState<AcDiagnostics | null>(null);
  const [profiles, setProfiles] = useState<AcMercyServerProfile[]>([]);
  const [reports, setReports] = useState<Record<string, AcRequirementsReport | null>>({});
  const [loading, setLoading] = useState(true);
  const [openDetail, setOpenDetail] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [d, ps] = await Promise.all([api.srpDiagnostics(), api.listSrpServers()]);
      if (d.success) setDg(d.diagnostics); else toast.error(d.error);
      setProfiles(ps);
      const out: Record<string, AcRequirementsReport | null> = {};
      for (const p of ps) { const r = await api.checkSrpRequirements(p.id, { deep: true }); out[p.id] = r.success ? r.report : null; }
      setReports(out);
    } catch (e: any) { toast.error(e?.message || 'Could not load diagnostics.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);
  // "Catalog settings" on Mercy's Servers lands here and brings the catalog panel into view.
  useEffect(() => {
    if ((location.state as { focus?: string } | null)?.focus !== 'catalog' || !dg) return;
    document.querySelector('[data-testid="catalog-settings"]')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [dg, location.state]);

  const chooseFolder = async () => {
    const dir = await api.pickSrpFolder(); if (!dir) return;
    const r = await api.setSrpAcRoot(dir);
    if (r.success) { toast.success('Game folder saved.'); load(); } else toast.error(r.error ?? 'That folder was not accepted.');
  };
  const autoDetect = async () => { await api.setSrpAcRoot(null); toast('Using automatic detection.'); load(); };
  const copy = async () => { if (!dg) return; await navigator.clipboard.writeText(JSON.stringify({ ...dg, note: 'Addresses are redacted. Safe to share.' }, null, 2)); toast.success('Diagnostics copied (no addresses included).'); };

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="p-6 space-y-5 max-w-5xl mx-auto pb-16">
      <button onClick={() => navigate('/assetto-corsa')} className="flex items-center gap-1.5 text-xs font-semibold text-surface-500 hover:text-surface-100 transition-colors"><ArrowLeft size={13} /> Back to Assetto Corsa</button>
      <SectionHeading icon={Wrench} iconClass="bg-sky-500/15 border-sky-500/25 text-sky-300" title="Setup & Diagnostics" subtitle="Your game install, what Mercy's servers need, and what to check when something's off"
        action={<button onClick={load} disabled={loading} className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5">{loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Refresh</button>} />
      <AcSectionNav />

      {!dg ? <Panel className="flex items-center justify-center py-12"><Loader2 size={20} className="animate-spin text-primary-400" /></Panel> : (<>
        <Panel>
          <h2 className="text-sm font-bold text-surface-100 mb-1">Game &amp; tools</h2>
          <Row label="Assetto Corsa folder" tone={dg.acRoot ? 'good' : 'bad'} value={dg.acRoot ? <><span className="font-mono">{dg.acRoot}</span> <span className="text-surface-500">({dg.acRootSource === 'manual' ? 'chosen by you' : 'detected automatically'})</span></> : 'Not found. Install Assetto Corsa through Steam, or choose its folder.'} />
          <Row label="Installed content" value={dg.acRoot ? `${dg.content.cars} cars · ${dg.content.tracks} tracks · ${dg.freeGb ?? '?'} GB free on that drive` : '—'} />
          <Row label="Custom Shaders Patch" tone={dg.csp.installed ? 'good' : dg.acRoot ? 'bad' : 'neutral'} value={dg.csp.installed ? `Installed${dg.csp.version ? ` — version ${dg.csp.version}${dg.csp.build ? ` b${dg.csp.build}` : ''} (read from the log of the last game launch)` : ' — version unknown until the game has been started once'}` : 'Not found. You install and update it yourself (Content Manager can do it); Mercy Launcher never does.'} />
          <Row label="Content Manager" tone={dg.contentManager.protocolHandler ? 'good' : 'warn'} value={dg.contentManager.protocolHandler ? 'Found — "Join Server" opens its join link.' : 'Its acmanager:// link handler was not found, so "Join Server" is unavailable.'} />
          <Row label="Archive tool" tone={dg.archiveTool === 'none' ? 'bad' : 'good'} value={dg.archiveTool === '7z' ? '7-Zip' : dg.archiveTool === 'bsdtar' ? "Windows' built-in tar.exe" : 'None found — .7z content cannot be unpacked. Install 7-Zip.'} />
          <Row label="Documents folder" tone={dg.documentsExists ? 'good' : 'warn'} value={<span className="font-mono">{dg.documentsDir}</span>} />
          <div className="flex gap-2 pt-3">
            <button onClick={chooseFolder} className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5"><FolderOpen size={12} /> Choose game folder…</button>
            {dg.acRootSource === 'manual' && <button onClick={autoDetect} className="text-xs text-surface-400 hover:text-surface-100 px-2">Use automatic detection</button>}
          </div>
        </Panel>

        <AcCatalogSettingsPanel onChanged={load} />

        <Panel>
          <h2 className="text-sm font-bold text-surface-100 mb-1">Content verification</h2>
          <p className="text-[11px] text-surface-500 mb-2">A read-only check of your install against each official server. Technical detail lives here; the server list shows only what you need to join.</p>
          {profiles.map((p) => {
            const s = summarizeReport(reports[p.id] ?? null);
            return (
              <div key={p.id} className="py-2 border-b border-overlay-6 last:border-0" data-testid={`verification-${p.id}`}>
                <div className="flex items-center gap-3">
                  <p className="text-xs font-semibold text-surface-100 w-40 shrink-0">{p.name}</p>
                  <span className={`text-[11px] px-2.5 py-0.5 rounded-full border ${TONE_CLASSES[s.tone].chip}`}>{s.headline}</span>
                  <button onClick={() => setOpenDetail((v) => (v === p.id ? null : p.id))} className="ml-auto text-[11px] text-surface-400 hover:text-surface-100" aria-expanded={openDetail === p.id}>{openDetail === p.id ? 'Hide full report' : 'Full report'}</button>
                  <button onClick={() => navigate('/mercy-servers/assettocorsa')} className="text-[11px] text-primary-300 hover:text-primary-200">Open</button>
                </div>
                {openDetail === p.id && (
                  <div className="mt-3 space-y-4 pl-1" data-testid="full-report">
                    <AcReadinessPanel serverId={p.id} />
                    {reports[p.id] && <AcRequirementsPanel report={reports[p.id]!} plan={null} onAction={() => undefined} />}
                  </div>
                )}
              </div>
            );
          })}
        </Panel>

        <Panel>
          <h2 className="text-sm font-bold text-surface-100 mb-1">Companion app &amp; HUD</h2>
          <Row label="SRP Board" tone={dg.srpBoard?.installed ? 'good' : 'warn'} value={dg.srpBoard?.installed ? `Installed${dg.srpBoard.version ? ` — version ${dg.srpBoard.version}` : ''}` : 'Not installed (optional). It hides the F9 position strip on Mercy\'s AssettoServer.'} />
          {dg.srpBoard?.installed && <Row label="Servers it matches" tone={dg.srpBoard.stamped && dg.srpBoard.stamped.length ? 'neutral' : 'warn'} value={dg.srpBoard.stamped === null ? 'Could not read its server list.' : dg.srpBoard.stamped.length === 0 ? 'None — it is not stamped, so it does nothing.' : dg.srpBoard.stamped.map((s) => `${s.kind} :${s.port}`).join('   ·   ')} />}
          {dg.srpBoard?.installed && dg.srpBoard.coverage?.map((c) => {
            const p = profiles.find((x) => x.id === c.serverId);
            const parts = [c.public === null ? 'public: not configured' : c.public ? 'public: matched' : 'public: NOT in the stamp', c.lan === null ? null : c.lan ? 'LAN: matched' : 'LAN: NOT in the stamp'].filter(Boolean).join('   ·   ');
            const bad = c.public === false || c.lan === false;
            return <Row key={c.serverId} label={`Stamp vs. endpoints — ${p?.name ?? c.serverId}`} tone={bad ? 'warn' : c.public === null && c.lan === null ? 'neutral' : 'good'} value={bad ? `${parts}. Reinstall the SRP Board (Mercy's Servers → Fix) so it matches the endpoints saved on this computer.` : parts} />;
          })}
          <Row label="Old dev HUD app" tone={dg.srpHudConflict ? 'bad' : 'good'} value={dg.srpHudConflict ? 'apps\\lua\\srp_hud is installed and would show a second HUD. On a server card in Mercy\'s Servers, press "Move aside" to put it in a backup folder.' : 'Not installed — no double-HUD conflict.'} />
          <Row label="Server-delivered HUD" value="Sent by the server when you join. Nothing to install." />
          <p className="text-[11px] text-surface-500 pt-2 flex gap-1.5"><ShieldCheck size={12} className="shrink-0 mt-0.5" />The SRP Board is stamped on this computer when installed, using the endpoints below. Only the owner's PC (with a LAN address set) gets a LAN entry; nobody else's stamp ever contains it.</p>
        </Panel>

        <Panel className="space-y-3">
          <div>
            <h2 className="text-sm font-bold text-surface-100">Connection endpoints</h2>
            <p className="text-[11px] text-surface-500 mt-0.5">Remote players join through a <span className="text-surface-300">public host name</span>; you, at home, can also set a <span className="text-surface-300">LAN address</span>. Nothing is configured by default and no address is built into the app. Public connectivity has <span className="text-surface-300">not been tested</span>.</p>
          </div>
          {profiles.map((p) => <EndpointEditor key={p.id} profile={p} onSaved={load} />)}
        </Panel>

        <StoragePanel onChanged={load} />

        <Panel>
          <div className="flex items-center gap-2 mb-1">
            <ScrollText size={14} className="text-surface-400" /><h2 className="text-sm font-bold text-surface-100">Troubleshooting</h2>
            <button onClick={copy} className="ml-auto btn-secondary text-[11px] py-1 px-2.5 flex items-center gap-1.5"><Copy size={11} /> Copy diagnostics</button>
          </div>
          <p className="text-[11px] text-surface-500 mb-2">Everything here has IP addresses and host names removed, so it is safe to paste into a support message.</p>
          {dg.interruptedInstalls.length > 0 && <div className="p-2.5 rounded-lg border border-amber-500/25 bg-amber-500/10 text-[11px] text-amber-200 mb-2">An earlier installation was interrupted. It will be rolled back automatically the next time you install something, so your files are restored.</div>}
          <h3 className="text-[11px] font-bold uppercase tracking-wider text-surface-500 mt-2 mb-1">SRP lines from the last game session</h3>
          {dg.cspLogSrpLines.length === 0 ? <p className="text-[11px] text-surface-500">None found. Join an SRP server once, then refresh.</p>
            : <pre className="text-[10px] leading-relaxed text-surface-300 bg-surface-950/60 border border-overlay-6 rounded-lg p-2.5 overflow-x-auto whitespace-pre-wrap">{dg.cspLogSrpLines.join('\n')}</pre>}
          <h3 className="text-[11px] font-bold uppercase tracking-wider text-surface-500 mt-3 mb-1">Recent install log</h3>
          {dg.installLog.length === 0 ? <p className="text-[11px] text-surface-500">Nothing installed yet.</p>
            : <pre className="text-[10px] leading-relaxed text-surface-300 bg-surface-950/60 border border-overlay-6 rounded-lg p-2.5 overflow-x-auto whitespace-pre-wrap max-h-56">{dg.installLog.join('\n')}</pre>}
        </Panel>
      </>)}
    </motion.div>
  );
}
