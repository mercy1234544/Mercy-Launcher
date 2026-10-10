import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronUp, Loader2, LogIn, RefreshCw, Users, Bot, Route, Wrench, Home, AlertTriangle, CheckCircle2, XCircle, Info } from 'lucide-react';
import toast from 'react-hot-toast';
import { Panel } from '../ui';
import AcInstallModal from './AcInstallModal';
import { TONE_CLASSES } from '../../lib/acMercyView';
import { hudCompanionLine } from '../../lib/acMercyView';
import { ACCENT_CLASSES, accentOf, connectionLines, firstSentence, issueLines, joinButtonModel, joinOutcome, primaryAction, ROW_STATE_VIEW, rowFacts, rowState, type IssueLine, type JoinOutcome, type Phase } from '../../lib/acJoinView';

const CONTENT_CHANGED_EVENT = 'mercy:ac-content-changed';
const POLL_MS = 20_000;

// One official server as a compact row: who it is, whether it is up, whether YOU can join, and one Join button.
// Everything shown is real: a number or state that is not known is simply not shown, and "Ready to Join" only appears
// when the main process's joinCheck found a usable address, a live status page, an open game port and nothing missing.
export default function AcServerRow({ profile }: { profile: AcMercyServerProfile }) {
  const api = window.electronAPI.assettoCorsa;
  const navigate = useNavigate();
  const [check, setCheck] = useState<AcJoinCheck | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [live, setLive] = useState<AcServerLiveStatus | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [outcome, setOutcome] = useState<JoinOutcome | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<{ plan: AcInstallPlan; focusIds: string[] } | null>(null);
  const joining = useRef(false);

  // A fresh check (retry, install finished, catalog changed) supersedes the message from the last Join press: an old
  // "Opening Content Manager…" must never sit next to a row that is no longer ready.
  const loadCheck = useCallback(async () => {
    try {
      const r = await api.srpJoinCheck(profile.id);
      if (r.success) { setCheck(r.check); setCheckError(null); if (!joining.current) { setOutcome(null); setPhase('idle'); } } else setCheckError(r.error);
    } catch (e: any) { setCheckError(e?.message || 'The check failed.'); }
  }, [profile.id]);
  const loadLive = useCallback(async () => {
    try { const r = await api.srpStatus(profile.id, false); if (r.success) setLive(r.status); } catch { /* the row still works without it */ }
  }, [profile.id]);

  useEffect(() => { loadCheck(); loadLive(); const t = setInterval(loadLive, POLL_MS); return () => clearInterval(t); }, [loadCheck, loadLive]);
  // An install on one server can change what another needs (shared cars, the track), so every row re-checks when any install finishes.
  useEffect(() => {
    const onChanged = () => { loadCheck(); loadLive(); };
    window.addEventListener(CONTENT_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(CONTENT_CHANGED_EVENT, onChanged);
  }, [loadCheck, loadLive]);

  const state = rowState(check);
  const view = ROW_STATE_VIEW[state];
  const facts = rowFacts(profile, live, check);
  const accent = ACCENT_CLASSES[accentOf(profile)];
  const jb = joinButtonModel(check, phase);
  const lines = issueLines(check);
  const next = primaryAction(check);

  const doJoin = async () => {
    if (joining.current) return;
    joining.current = true; setPhase('working'); setOutcome(null);
    try {
      const r = await api.srpJoin(profile.id);
      if (r.check) setCheck(r.check);
      const o = joinOutcome(r); setOutcome(o);
      setPhase(r.success ? 'handed-off' : 'failed');
    } catch (e: any) { setOutcome(joinOutcome({ success: false, stage: 'blocked', error: e?.message })); setPhase('failed'); }
    finally { joining.current = false; }
  };

  const runFix = async (a: NonNullable<IssueLine['action']>) => {
    if (a.kind === 'retry') { setOutcome(null); setPhase('idle'); await loadCheck(); await loadLive(); return; }
    if (a.kind === 'setup') { navigate('/assetto-corsa/setup'); return; }
    if (a.kind === 'adopt-host') {
      setBusy(true);
      try {
        const r = await api.srpAdoptCatalogHost();
        if (r.success) {
          const ok = r.adopt.results.filter((x) => x.adopted).length;
          if (ok) toast.success(`Connected ${ok} server${ok === 1 ? '' : 's'} over your home network.`); else toast.error(r.adopt.results.find((x) => !x.adopted)?.reason ?? 'Could not connect over your home network.');
        } else toast.error(r.error);
        window.dispatchEvent(new Event(CONTENT_CHANGED_EVENT));
      } finally { setBusy(false); }
      return;
    }
    // install / manual: the install dialog lists exactly what is missing, what can be downloaded and what you must get yourself
    if (a.kind === 'install' || (a.kind === 'manual' && check?.issues.some((i) => i.kind === 'content'))) {
      setBusy(true);
      try { const p = await api.planSrpInstall(profile.id); if (p.success) setModal({ plan: p.plan, focusIds: a.planItemIds ?? [] }); else toast.error(p.error); }
      finally { setBusy(false); }
      return;
    }
    setOpen(true);
  };

  const ActionIcon = ({ kind }: { kind: string }) => (kind === 'adopt-host' ? <Home size={12} /> : kind === 'retry' ? <RefreshCw size={12} /> : <Wrench size={12} />);
  const Tone = ({ tone }: { tone: IssueLine['tone'] }) => (tone === 'bad' ? <XCircle size={13} className="text-red-300 shrink-0 mt-0.5" /> : tone === 'info' ? <Info size={13} className="text-sky-300 shrink-0 mt-0.5" /> : <AlertTriangle size={13} className="text-amber-300 shrink-0 mt-0.5" />);

  return (
    <Panel padding="sm" className="relative overflow-hidden" data-testid={`server-row-${profile.id}`}>
      <div className={`absolute left-0 top-0 bottom-0 w-1 ${accent.bar}`} />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 pl-2">
        <div className={`w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 ${accent.icon}`}>{(profile.aiTraffic ?? 0) > 0 ? <Bot size={18} /> : <Route size={18} />}</div>

        <div className="min-w-0 flex-1 basis-56">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-sm font-extrabold text-surface-100 truncate">{facts.name}</h2>
            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${accent.chip}`}>{facts.typeLabel}</span>
            {profile.serverState === 'maintenance' && <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/25" title="The server owner marked this server as being in maintenance.">Maintenance</span>}
          </div>
          <p className="text-xs text-surface-400 mt-0.5 truncate">{facts.trackLine}</p>
          <div className="flex items-center gap-3 mt-1 text-[11px] text-surface-500 flex-wrap">
            {facts.players ? <span className="flex items-center gap-1 text-surface-300"><Users size={11} /> {facts.players}</span> : facts.slots && <span className="flex items-center gap-1"><Users size={11} /> {facts.slots}</span>}
            {facts.ai && <span className="flex items-center gap-1"><Bot size={11} /> {facts.ai}</span>}
          </div>
        </div>

        <div className="flex items-center gap-3 shrink-0 ml-auto">
          <span className={`inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-full border ${TONE_CLASSES[view.tone].chip}`} data-testid="row-state" title={check?.connection.reason}>
            {state === 'checking' ? <Loader2 size={11} className="animate-spin" /> : <span className={`w-1.5 h-1.5 rounded-full ${TONE_CLASSES[view.tone].dot}`} />} {view.label}
          </span>
          <button onClick={doJoin} disabled={!jb.enabled} title={jb.title} data-testid="join-button"
            className="btn-primary text-xs py-2 px-5 flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed">
            {phase === 'working' ? <Loader2 size={13} className="animate-spin" /> : <LogIn size={13} />} {jb.label}
          </button>
        </div>
      </div>

      {checkError && <p className="mt-2 pl-2 text-[11px] text-red-300 flex items-center gap-2">Could not check this server: {checkError} <button onClick={loadCheck} className="underline">Try again</button></p>}

      {outcome && (
        <div className={`mt-2.5 ml-2 rounded-lg border p-2.5 text-[11px] ${outcome.tone === 'good' ? 'border-emerald-500/25 bg-emerald-500/5 text-emerald-200' : 'border-red-500/25 bg-red-500/5 text-red-200'}`} data-testid="join-outcome">
          <p className="font-semibold flex items-center gap-1.5">{outcome.tone === 'good' ? <CheckCircle2 size={13} /> : <XCircle size={13} />} {outcome.headline}</p>
          <p className="mt-0.5 text-surface-300">{outcome.detail}</p>
        </div>
      )}

      {next && (
        <div className="mt-2.5 ml-2 flex items-center gap-2 flex-wrap text-[11px]" data-testid="row-next">
          <span className="text-surface-300 min-w-0 flex-1 basis-48"><span className="font-semibold text-surface-100">{next.title}.</span> {firstSentence(lines.find((l) => l.title === next.title)?.detail ?? '')}</span>
          {next.action && <button onClick={() => runFix(next.action!)} disabled={busy} className="btn-secondary text-[11px] py-1.5 px-3 flex items-center gap-1.5 disabled:opacity-50">{busy ? <Loader2 size={12} className="animate-spin" /> : <ActionIcon kind={next.action.kind} />} {next.action.label}</button>}
          <button onClick={() => setOpen((v) => !v)} className="text-surface-400 hover:text-surface-100 flex items-center gap-1" aria-expanded={open}>Details {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}</button>
        </div>
      )}
      {!next && check && (
        <div className="mt-1 ml-2 flex justify-end"><button onClick={() => setOpen((v) => !v)} className="text-[11px] text-surface-500 hover:text-surface-200 flex items-center gap-1" aria-expanded={open}>Details {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}</button></div>
      )}

      {open && check && (
        <div className="mt-2 ml-2 pt-2.5 border-t border-overlay-6 space-y-3 text-[11px]" data-testid="row-details">
          {lines.length > 0 && (
            <ul className="space-y-2">
              {lines.map((l) => (
                <li key={l.id} className="flex gap-2"><Tone tone={l.tone} /><span className="min-w-0"><span className="font-semibold text-surface-100">{l.title}.</span> <span className="text-surface-400">{l.detail}</span>
                  {l.action && <button onClick={() => runFix(l.action!)} disabled={busy} className="ml-2 text-primary-300 hover:text-primary-200 underline disabled:opacity-50">{l.action.label}</button>}</span></li>
              ))}
            </ul>
          )}
          {check.missing.length > 0 && (
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-surface-500 mb-1">Missing or out of date</p>
              <ul className="space-y-0.5 max-h-40 overflow-y-auto pr-1">{check.missing.map((m) => <li key={m.id} className="flex items-center gap-2 text-surface-300" title={m.detail}><span className="flex-1 truncate">{m.name}{!m.required && <span className="text-surface-500"> (optional)</span>}</span><span className={`shrink-0 px-2 py-0.5 rounded-full border ${m.state === 'manual' ? TONE_CLASSES.warn.chip : TONE_CLASSES.bad.chip}`}>{m.state === 'manual' ? 'Get it yourself' : m.state === 'outdated' ? 'Out of date' : m.state === 'incompatible' ? 'Different version' : 'Missing'}</span></li>)}</ul>
            </div>
          )}
          <div className="text-surface-500 space-y-0.5">{connectionLines(check).map((t, i) => <p key={i}>{t}</p>)}<p data-testid="hud-companion">{hudCompanionLine(profile).hud}. {hudCompanionLine(profile).companion}.</p></div>
        </div>
      )}

      {modal && <AcInstallModal server={profile} plan={modal.plan} focusIds={modal.focusIds} onClose={() => setModal(null)} onFinished={() => window.dispatchEvent(new Event(CONTENT_CHANGED_EVENT))} />}
    </Panel>
  );
}
