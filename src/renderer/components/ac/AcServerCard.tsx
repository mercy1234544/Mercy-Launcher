import React, { useCallback, useEffect, useState } from 'react';
import { BadgeCheck, Users, Bot, Layers, ShieldCheck, Loader2, RefreshCw, LogIn, Wrench, ChevronDown, ChevronUp, Globe2, AlertTriangle, CheckCircle2, Circle } from 'lucide-react';
import toast from 'react-hot-toast';
import { Panel } from '../ui';
import AcRequirementsPanel from './AcRequirementsPanel';
import AcInstallModal from './AcInstallModal';
import AcReadinessPanel from './AcReadinessPanel';
import { hudCompanionLine, joinButton, liveStatusChip, missingSummary, summarizeReport, TONE_CLASSES, type ItemAction } from '../../lib/acMercyView';

const CONTENT_CHANGED_EVENT = 'mercy:ac-content-changed';
const ENGINE_LABEL: Record<string, string> = { 'kunos-stock': 'Standard Kunos server', assettoserver: 'AssettoServer' };

interface Props { profile: AcMercyServerProfile; onOpenSetup: () => void }

// One OFFICIAL Mercy server. Everything shown is real data from the verified requirements package or a real
// check made just now — never an invented player count, status or address.
export default function AcServerCard({ profile, onOpenSetup }: Props) {
  const api = window.electronAPI.assettoCorsa;
  const [report, setReport] = useState<AcRequirementsReport | null>(null);
  const [plan, setPlan] = useState<AcInstallPlan | null>(null);
  const [status, setStatus] = useState<AcServerLiveStatus | null>(null);
  const [join, setJoin] = useState<AcJoinStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [modal, setModal] = useState<{ focusIds: string[] } | null>(null);
  const [showReady, setShowReady] = useState(false);
  const [keepReady, setKeepReady] = useState<{ on: boolean; auto: boolean } | null>(null);

  const loadStatus = useCallback(async (force = false) => {
    const r = await api.srpStatus(profile.id, force);
    setStatus(r.success ? r.status : { state: 'offline', reason: r.error });
  }, [profile.id]);

  const check = useCallback(async () => {
    setChecking(true); setError(null);
    try {
      const r = await api.checkSrpRequirements(profile.id, { deep: true });
      if (!r.success) { setError(r.error); return; }
      setReport(r.report);
      const [p, j] = await Promise.all([api.planSrpInstall(profile.id), api.srpJoinStatus(profile.id)]);
      setPlan(p.success ? p.plan : null);
      setJoin(j.success ? j.join : null);
      if (r.report.summary.fail > 0) setOpen(true);
    } catch (e: any) { setError(e?.message || 'The check failed.'); }
    finally { setChecking(false); }
  }, [profile.id]);

  useEffect(() => { check(); loadStatus(); }, [check, loadStatus]);

  // "Keep this server ready" only matters in automatic install mode; it is how a player opts a server in.
  const loadKeepReady = useCallback(async () => {
    try { const r = await api.getCatalogSettings(); if (r.success) setKeepReady({ on: r.settings.autoServers.includes(profile.id), auto: r.settings.installMode === 'auto' }); } catch { /* optional */ }
  }, [profile.id]);
  useEffect(() => { loadKeepReady(); }, [loadKeepReady]);
  const toggleKeepReady = async () => {
    const r = await api.getCatalogSettings(); if (!r.success) return;
    const set = new Set(r.settings.autoServers); set.has(profile.id) ? set.delete(profile.id) : set.add(profile.id);
    const w = await api.setCatalogSettings({ autoServers: [...set] });
    if (w.success) { toast.success(set.has(profile.id) ? 'This server will be kept ready automatically.' : 'Automatic install is off for this server.'); loadKeepReady(); } else toast.error(w.error);
  };

  // An install on one server can change what another needs (shared cars, the old HUD app, the track), so every
  // card re-checks when any install finishes — never leaving a stale "needs fixing" on screen.
  useEffect(() => {
    const onChanged = () => { check(); loadStatus(true); };
    window.addEventListener(CONTENT_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(CONTENT_CHANGED_EVENT, onChanged);
  }, [check, loadStatus]);

  const summary = summarizeReport(report);
  const chip = liveStatusChip(status);
  const jb = joinButton(join, report, checking || joining);
  const fixable = !!plan && plan.items.some((i) => !i.blocked && i.action !== 'manual');
  const needsAttention = !!plan && plan.items.length > 0;
  const missing = missingSummary(plan);
  const facts = hudCompanionLine(profile);

  const onAction = (a: ItemAction) => { if (a.kind === 'auto' || a.kind === 'needs-file') setModal({ focusIds: a.planItemIds }); };
  const doJoin = async () => {
    setJoining(true);
    try {
      const r = await api.srpJoin(profile.id);
      if (r.success) toast.success(r.note ?? 'Join request sent to Content Manager.', { duration: 7000 }); else toast.error(r.error ?? 'Could not start the join.');
    } finally { setJoining(false); }
  };

  return (
    <Panel padding="lg" className="relative overflow-hidden space-y-4">
      <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-rose-500/70 via-primary-500/70 to-transparent" />
      <div className="flex items-start gap-3">
        <div className="w-11 h-11 rounded-xl border bg-rose-500/15 border-rose-500/25 text-rose-300 flex items-center justify-center shrink-0"><Globe2 size={19} /></div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-base font-extrabold text-surface-100 truncate">{profile.name}</h2>
            <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-primary-500/15 text-primary-200 border border-primary-500/25"><BadgeCheck size={11} /> Official · Mercy</span>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-overlay-6 text-surface-400 border border-overlay-10">{ENGINE_LABEL[profile.engine] ?? profile.engine}</span>
            {profile.serverState === 'maintenance' && <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/25" title="The server owner marked this server as being in maintenance.">Maintenance</span>}
          </div>
          <p className="text-xs text-surface-400 mt-1">{profile.purpose}</p>
          {profile.description && <p className="text-[11px] text-surface-500 mt-0.5">{profile.description}</p>}
          <div className="flex items-center gap-3 mt-1.5 text-[11px] text-surface-500 flex-wrap">
            {profile.maxPlayers != null && <span className="flex items-center gap-1"><Users size={11} /> {profile.maxPlayers} slots</span>}
            {profile.aiTraffic != null && <span className="flex items-center gap-1"><Bot size={11} /> {profile.aiTraffic ? `${profile.aiTraffic} AI traffic cars` : 'No AI traffic'}</span>}
            <span className="flex items-center gap-1"><Layers size={11} /> {profile.fromCatalog && profile.tracks?.[0] ? `${profile.tracks[0].name}${profile.tracks.length > 1 ? ` +${profile.tracks.length - 1}` : ''}` : `SRP ${profile.trackVersion}`}</span>
            {profile.hud.delivered && <span className="flex items-center gap-1" title="Delivered by the server when you join — nothing to install"><ShieldCheck size={11} /> Server HUD {profile.hud.version}</span>}
          </div>
        </div>
        <button onClick={() => loadStatus(true)} title={chip.title || 'Refresh status'} className={`shrink-0 inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-full border ${TONE_CLASSES[chip.tone].chip}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${TONE_CLASSES[chip.tone].dot}`} /> {chip.label}
        </button>
      </div>

      {!profile.endpoint.publicConfigured && (
        <div className="flex gap-2.5 p-3 rounded-xl border border-amber-500/25 bg-amber-500/10 text-[11px] text-amber-200">
          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          <p><span className="font-semibold">No public address is configured for this server yet.</span> Remote players can't be pointed at it until the owner assigns a public host name{profile.endpoint.lanConfigured ? ' (your own LAN address is set, so you can still join from this network)' : ''}. <button onClick={onOpenSetup} className="underline hover:text-amber-100">Open Setup & Diagnostics</button></p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wider text-surface-500 mb-1.5">You need</p>
          <ul className="space-y-1">
            {profile.requiredContent.map((c) => (
              <li key={c.id} className="flex items-start gap-2 text-xs text-surface-300" title={c.detail}>
                <Circle size={7} className={`mt-1.5 shrink-0 ${c.required ? 'text-surface-400 fill-surface-400' : 'text-surface-600'}`} />
                <span>{c.name}{!c.required && <span className="text-surface-500"> (optional)</span>}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wider text-surface-500 mb-1.5">Your install</p>
          {checking && !report ? <p className="flex items-center gap-2 text-xs text-surface-400"><Loader2 size={13} className="animate-spin" /> Checking your Assetto Corsa…</p>
            : error ? <p className="text-xs text-red-300">{error}</p>
            : (
              <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-xl border text-xs font-semibold ${TONE_CLASSES[summary.tone].chip}`}>
                {summary.state === 'ready' ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />} {summary.headline}
              </div>
            )}
          {report && report.summary.blockers.length > 0 && <p className="text-[11px] text-surface-400 mt-2 line-clamp-2">First issue: {report.summary.blockers[0]}</p>}
          {missing && <p className="text-[11px] text-surface-300 mt-1.5" data-testid="missing-content"><span className="font-semibold">Missing or out of date:</span> {missing.text}{missing.manual > 0 ? ` (${missing.manual} you must get yourself)` : ''}</p>}
          <p className="text-[11px] text-surface-500 mt-1.5" data-testid="hud-companion">{facts.hud}. {facts.companion}.</p>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={() => check()} disabled={checking} className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5 disabled:opacity-50">
          {checking ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Check requirements
        </button>
        {needsAttention && (
          <button onClick={() => setModal({ focusIds: [] })} className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5 border-primary-500/30 text-primary-200">
            <Wrench size={13} /> {fixable ? 'Fix / install what\'s missing' : 'See what\'s needed'}
          </button>
        )}
        <button onClick={() => setOpen((v) => !v)} disabled={!report} className="text-xs text-surface-400 hover:text-surface-100 flex items-center gap-1 px-2 disabled:opacity-40">
          Details {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
        <button onClick={doJoin} disabled={!jb.enabled} title={jb.why}
          className="ml-auto btn-primary text-xs py-2 px-4 flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed">
          {joining ? <Loader2 size={13} className="animate-spin" /> : <LogIn size={13} />} {jb.label}
        </button>
      </div>
      {/* Requirement failures are already spelled out in "Your install" above; only add a hint for the other reasons (endpoint, Content Manager). */}
      {!jb.enabled && report && report.summary.fail === 0 && !checking && <p className="text-[11px] text-surface-500 -mt-2 text-right line-clamp-2">{jb.why}</p>}
      {jb.enabled && <p className="text-[11px] text-surface-500 -mt-2 text-right">Opens Content Manager's join link. Whether the connection succeeds has not been verified by Mercy Launcher.</p>}

      {open && report && <AcRequirementsPanel report={report} plan={plan} onAction={onAction} />}

      <div className="border-t border-overlay-6 pt-3 space-y-2">
        <div className="flex items-center gap-3 flex-wrap">
          <button onClick={() => setShowReady((v) => !v)} className="text-xs font-semibold text-surface-300 hover:text-surface-100 flex items-center gap-1" aria-expanded={showReady}>
            Join readiness {showReady ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
          {keepReady?.auto && (
            <label className="ml-auto flex items-center gap-2 text-[11px] text-surface-400 cursor-pointer" title="Automatic install is on. Tick this to let the launcher install verified, authorised content for this server when the catalog changes.">
              <input type="checkbox" className="accent-primary-500" checked={keepReady.on} onChange={toggleKeepReady} /> Keep this server ready automatically
            </label>
          )}
        </div>
        {showReady && <AcReadinessPanel serverId={profile.id} refreshKey={report?.checkedAt ? Date.parse(report.checkedAt) : 0} />}
      </div>

      {modal && plan && (
        <AcInstallModal server={profile} plan={plan} focusIds={modal.focusIds} onClose={() => setModal(null)} onFinished={() => window.dispatchEvent(new Event(CONTENT_CHANGED_EVENT))} />
      )}
    </Panel>
  );
}
