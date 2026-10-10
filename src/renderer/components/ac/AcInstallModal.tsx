import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, Download, ShieldCheck, FileArchive, Loader2, CheckCircle2, XCircle, AlertTriangle, FolderOpen, Info, Undo2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { defaultApproved, formatBytes, PHASE_LABEL, planChoices, totalDownloadBytes } from '../../lib/acMercyView';

interface Props {
  server: AcMercyServerProfile;
  plan: AcInstallPlan;
  /** Items to tick when the dialog opens (e.g. the one a problem line's button referred to). */
  focusIds?: string[];
  onClose: () => void;
  /** Called after an install attempt finished (success or not) so the caller re-checks. */
  onFinished: () => void;
}

type Stage = 'review' | 'running' | 'result';
const basename = (p: string) => p.split(/[\\/]/).pop() || p;
const hostOf = (u: string) => { try { return new URL(u).hostname; } catch { return u; } };

/** A track beyond the first that needs a file from the player: choose it, have it checked read-only, then approve. */
function ExtraTrackPicker({ item, api, approved, onApprove }: { item: AcPlanItem; api: Window['electronAPI']['assettoCorsa']; approved: boolean; onApprove: (on: boolean, file?: string) => void }) {
  const [check, setCheck] = useState<AcTrackValidation | null>(null);
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<string | null>(null);
  const trackId = item.id.replace(/^track:/, '');
  const choose = async () => {
    const f = await api.pickSrpArchive(); if (!f) return;
    setBusy(true); setCheck(null); setFile(null); onApprove(false);
    try {
      const r = await api.validateSrpTrackArchive(f, trackId);
      const v: AcTrackValidation = r.success ? r.validation : { ok: false, summary: r.error, checks: [], identicalToOwnersCopy: null, fileName: basename(f) };
      setCheck(v);
      if (v.ok) { setFile(f); onApprove(true, f); }
    } catch (e: any) { setCheck({ ok: false, summary: e?.message || 'The archive could not be checked.', checks: [], identicalToOwnersCopy: null, fileName: basename(f) }); }
    finally { setBusy(false); }
  };
  return (
    <div className="p-3 rounded-xl border border-overlay-6 space-y-2 mt-2" data-testid="extra-track-picker">
      <p className="text-xs font-semibold text-surface-100">{item.label}</p>
      <p className="text-[11px] text-surface-400">{item.reason}</p>
      <div className="flex gap-2 text-[11px] text-amber-200/90 bg-amber-500/10 border border-amber-500/20 rounded-lg p-2"><Info size={13} className="shrink-0 mt-0.5" /><span>{item.blocked}</span></div>
      <ol className="list-decimal ml-5 text-[11px] text-surface-300 space-y-0.5">{(item.manualSteps ?? []).map((s, i) => <li key={i}>{s}</li>)}</ol>
      <div className="flex items-center gap-2">
        <button onClick={choose} disabled={busy} className="btn-secondary text-[11px] py-1.5 px-3 flex items-center gap-1.5 disabled:opacity-50"><FileArchive size={12} /> {check ? 'Choose a different archive' : 'Choose the downloaded archive'}</button>
        {busy && <span className="flex items-center gap-1.5 text-[11px] text-surface-400"><Loader2 size={12} className="animate-spin" /> Checking the archive…</span>}
      </div>
      {check && (
        <div className={`rounded-lg border p-2.5 space-y-1 ${check.ok ? 'border-emerald-500/25 bg-emerald-500/5' : 'border-red-500/25 bg-red-500/5'}`}>
          <p className={`flex items-center gap-1.5 text-xs font-semibold ${check.ok ? 'text-emerald-300' : 'text-red-300'}`}>{check.ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />} {check.summary}</p>
          <ul className="space-y-1">{check.checks.map((c) => <li key={c.id} className="flex gap-1.5 text-[11px]">{c.ok ? <CheckCircle2 size={12} className="text-emerald-300 shrink-0 mt-0.5" /> : <XCircle size={12} className="text-red-300 shrink-0 mt-0.5" />}<span className="text-surface-300"><span className="font-semibold">{c.label}.</span> <span className="text-surface-400">{c.detail}</span></span></li>)}</ul>
        </div>
      )}
      {file && <label className="flex items-center gap-2 text-[11px] text-surface-300"><input type="checkbox" className="accent-primary-500" checked={approved} onChange={(e) => onApprove(e.target.checked, file)} /> Install it. The archive was checked first; anything it replaces is kept in a backup.</label>}
    </div>
  );
}

// Review → approve → live progress → honest result. Nothing runs until the player presses the button, only
// the ticked items are touched, anything that replaces existing files is unticked by default and says a
// backup is kept, and Custom Shaders Patch is explained but never offered.
export default function AcInstallModal({ server, plan, focusIds, onClose, onFinished }: Props) {
  const api = window.electronAPI.assettoCorsa;
  const choices = useMemo(() => planChoices(plan), [plan]);
  const [approved, setApproved] = useState<Set<string>>(() => new Set([...defaultApproved(plan), ...(focusIds ?? []).filter((id) => plan.items.some((i) => i.id === id && !i.blocked))]));
  const [trackFile, setTrackFile] = useState<string | null>(null);
  const [packFile, setPackFile] = useState<string | null>(null);
  // Servers from a catalog can need several tracks; every track beyond the first keeps its own chosen + validated archive.
  const [extraFiles, setExtraFiles] = useState<Record<string, string>>({});
  const [stage, setStage] = useState<Stage>('review');
  const [progress, setProgress] = useState<AcInstallProgress | null>(null);
  const [result, setResult] = useState<AcInstallResult | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const running = useRef(false);

  useEffect(() => api.onSrpInstallProgress((p) => { if (!p.serverId || p.serverId === server.id) setProgress(p); }), [server.id]);

  const toggle = (id: string) => setApproved((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  // The player's own track archive is checked read-only FIRST (version marker hash, required layouts) and can only be
  // approved if every check passes — the result, with a reason per check, is shown right here.
  const [trackCheck, setTrackCheck] = useState<AcTrackValidation | null>(null);
  const [validating, setValidating] = useState(false);
  const chooseTrack = async () => {
    const f = await api.pickSrpArchive(); if (!f) return;
    setValidating(true); setTrackCheck(null); setTrackFile(null); setApproved((s) => { const n = new Set(s); n.delete('track'); return n; });
    try {
      const r = await api.validateSrpTrackArchive(f, server.tracks?.[0]?.id);
      const v: AcTrackValidation = r.success ? r.validation : { ok: false, summary: r.error, checks: [], identicalToOwnersCopy: null, fileName: basename(f) };
      setTrackCheck(v);
      if (v.ok) { setTrackFile(f); setApproved((s) => new Set(s).add('track')); }
    } catch (e: any) { setTrackCheck({ ok: false, summary: e?.message || 'The archive could not be checked.', checks: [], identicalToOwnersCopy: null, fileName: basename(f) }); }
    finally { setValidating(false); }
  };
  const choosePack = async () => { const f = await api.pickSrpArchive(); if (f) setPackFile(f); };

  const ids = [...approved].filter((id) => { const it = plan.items.find((i) => i.id === id); return it && (!it.blocked || (it.needsLocalFile && (id === 'track' ? trackFile : extraFiles[id.replace(/^track:/, '')]))); });
  const carDownloads = plan.downloads.filter((d) => d.itemIds.some((x) => x.startsWith('car:') || x.startsWith('skin:')));
  const bytes = packFile ? 0 : totalDownloadBytes(plan, ids);
  const noTool = plan.archiveTool === 'none';
  const canGo = ids.length > 0 && !noTool && stage === 'review';

  const go = async () => {
    if (!canGo || running.current) return;
    running.current = true; setStage('running'); setProgress({ phase: 'preflight', message: 'Starting…' }); setFatal(null);
    try {
      const r = await api.installSrpContent(server.id, ids, { trackArchivePath: trackFile ?? undefined, carPackArchivePath: packFile ?? undefined, trackArchivePaths: Object.keys(extraFiles).length ? extraFiles : undefined });
      if (r.success) setResult(r.result); else setFatal(r.error);
    } catch (e: any) { setFatal(e?.message || 'The installation could not be started.'); }
    finally { running.current = false; setStage('result'); onFinished(); }
  };

  const pct = progress?.percent ?? (progress?.received && progress.total ? Math.round(progress.received / progress.total * 100) : undefined);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-6" onClick={() => stage !== 'running' && onClose()}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-2xl max-h-[88vh] flex flex-col bg-surface-900 border border-overlay-6 rounded-2xl shadow-2xl overflow-hidden" role="dialog" aria-label={`Install content for ${server.name}`}>
        <div className="shrink-0 flex items-center gap-3 px-5 py-3.5 border-b border-overlay-6 bg-surface-950/50">
          <Download size={16} className="text-primary-300" />
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-bold text-surface-100">Get ready for {server.name}</h2>
            <p className="text-[11px] text-surface-500">{stage === 'review' ? 'Review what will change, tick what you approve.' : stage === 'running' ? 'Installing — please keep Mercy Launcher open.' : 'Finished.'}</p>
          </div>
          {stage !== 'running' && <button onClick={onClose} className="p-1.5 rounded-lg text-surface-500 hover:text-surface-200 hover:bg-overlay-4" aria-label="Close"><X size={16} /></button>}
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {stage === 'review' && (<>
            {plan.csp.status !== 'ok' && (
              <div className="flex gap-2.5 p-3 rounded-xl border border-amber-500/25 bg-amber-500/10 text-xs text-amber-200">
                <ShieldCheck size={16} className="shrink-0 mt-0.5" />
                <div><p className="font-semibold">Custom Shaders Patch is yours to manage</p><p className="mt-0.5 text-amber-200/80">{plan.csp.message}</p></div>
              </div>
            )}
            {noTool && <div className="p-3 rounded-xl border border-red-500/25 bg-red-500/10 text-xs text-red-200">No archive tool was found (7-Zip, or Windows' built-in tar.exe), so .7z content cannot be unpacked. Install 7-Zip, then reopen this dialog.</div>}

            <section>
              <h3 className="text-[11px] font-bold uppercase tracking-wider text-surface-500 mb-2">Mercy Launcher can do these</h3>
              {choices.auto.length === 0 && <p className="text-xs text-surface-500">Nothing can be done automatically right now.</p>}
              <ul className="space-y-1.5">
                {choices.auto.map((it) => (
                  <li key={it.id}>
                    <label className={`flex items-start gap-3 p-2.5 rounded-xl border cursor-pointer ${approved.has(it.id) ? 'border-primary-500/30 bg-primary-500/5' : 'border-overlay-6 hover:bg-overlay-4'}`}>
                      <input type="checkbox" className="mt-0.5 accent-primary-500" checked={approved.has(it.id)} onChange={() => toggle(it.id)} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs font-semibold text-surface-100">{it.label}</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-overlay-6 text-surface-400 capitalize">{it.action === 'move-to-backup' ? 'move aside' : it.action}</span>
                          {it.destructive && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-300">replaces existing · backup kept</span>}
                          {it.optional && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-sky-500/15 text-sky-300">optional</span>}
                        </span>
                        <span className="block text-[11px] text-surface-400 mt-0.5">{it.reason}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              {plan.downloads.map((d) => (
                <p key={d.sourceId} className="mt-2 flex items-center gap-1.5 text-[11px] text-surface-400"><Download size={12} /> {d.name}: {formatBytes(d.bytes)} from <span className="font-mono text-surface-300">{hostOf(d.url)}</span> — size and SHA-256 are verified before anything is installed. Only the cars you tick are unpacked.</p>
              ))}
              {carDownloads.length === 1 && (
                <p className="mt-1.5 text-[11px] text-surface-500">Already downloaded the pack? <button onClick={choosePack} className="text-primary-300 hover:text-primary-200 underline">Use my file instead</button>{packFile && <span className="ml-1 font-mono text-surface-300">({basename(packFile)})</span>}</p>
              )}
            </section>

            {choices.needsFile.length > 0 && (
              <section>
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-surface-500 mb-2">Needs a file from you</h3>
                {choices.needsFile.filter((it) => it.id !== 'track').map((it) => (
                  <ExtraTrackPicker key={it.id} item={it} api={api} approved={approved.has(it.id)} onApprove={(on, file) => {
                    const tid = it.id.replace(/^track:/, '');
                    setExtraFiles((m) => { const n = { ...m }; if (file) n[tid] = file; else delete n[tid]; return n; });
                    setApproved((s) => { const n = new Set(s); on ? n.add(it.id) : n.delete(it.id); return n; });
                  }} />
                ))}
                {choices.needsFile.filter((it) => it.id === 'track').map((it) => (
                  <div key={it.id} className="p-3 rounded-xl border border-overlay-6 space-y-2">
                    <p className="text-xs font-semibold text-surface-100">{it.label}</p>
                    <p className="text-[11px] text-surface-400">{it.reason}</p>
                    <div className="flex gap-2 text-[11px] text-amber-200/90 bg-amber-500/10 border border-amber-500/20 rounded-lg p-2"><Info size={13} className="shrink-0 mt-0.5" /><span>{it.blocked}</span></div>
                    <ol className="list-decimal ml-5 text-[11px] text-surface-300 space-y-0.5">{(it.manualSteps ?? []).map((s, i) => <li key={i}>{s}</li>)}</ol>
                    <p className="text-[11px] text-surface-500">{server.fromCatalog ? "Only get this from the content owner's own channels." : "Only get this from the Shutoko Revival Project's own channels."} Mercy Launcher never downloads, hosts or substitutes this file for you.</p>
                    <div className="flex items-center gap-2">
                      <button onClick={chooseTrack} disabled={validating} className="btn-secondary text-[11px] py-1.5 px-3 flex items-center gap-1.5 disabled:opacity-50"><FileArchive size={12} /> {trackCheck ? 'Choose a different archive' : 'Choose the downloaded archive'}</button>
                      {validating && <span className="flex items-center gap-1.5 text-[11px] text-surface-400"><Loader2 size={12} className="animate-spin" /> Checking the archive…</span>}
                    </div>
                    {trackCheck && (
                      <div className={`rounded-lg border p-2.5 space-y-1.5 ${trackCheck.ok ? 'border-emerald-500/25 bg-emerald-500/5' : 'border-red-500/25 bg-red-500/5'}`} data-testid="track-validation">
                        <p className={`flex items-center gap-1.5 text-xs font-semibold ${trackCheck.ok ? 'text-emerald-300' : 'text-red-300'}`}>{trackCheck.ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />} {trackCheck.summary}</p>
                        <p className="text-[10px] font-mono text-surface-500 truncate">{trackCheck.fileName}</p>
                        <ul className="space-y-1">
                          {trackCheck.checks.map((c) => (
                            <li key={c.id} className="flex gap-1.5 text-[11px]">
                              {c.ok ? <CheckCircle2 size={12} className="text-emerald-300 shrink-0 mt-0.5" /> : <XCircle size={12} className="text-red-300 shrink-0 mt-0.5" />}
                              <span className="text-surface-300"><span className="font-semibold">{c.label}.</span> <span className="text-surface-400">{c.detail}</span></span>
                            </li>
                          ))}
                        </ul>
                        {trackCheck.identicalToOwnersCopy !== null && <p className="text-[10px] text-surface-500">{trackCheck.identicalToOwnersCopy ? 'This file is byte-for-byte the same as the copy the servers were built from.' : 'This file is not byte-identical to the owner\'s copy — that is fine if every check above passed (it can be the same build packaged differently).'}</p>}
                      </div>
                    )}
                    {trackFile && (
                      <label className="flex items-center gap-2 text-[11px] text-surface-300">
                        <input type="checkbox" className="accent-primary-500" checked={approved.has(it.id)} onChange={() => toggle(it.id)} />
                        Install it{it.destructive ? ' — replaces the installed track; the old one is kept in a backup' : ''}. The version is verified before anything is changed.
                      </label>
                    )}
                  </div>
                ))}
              </section>
            )}

            {choices.manual.length > 0 && (
              <section>
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-surface-500 mb-2">You'll need to do these yourself</h3>
                <ul className="space-y-1.5">
                  {choices.manual.map((it) => (
                    <li key={it.id} className="p-2.5 rounded-xl border border-overlay-6">
                      <p className="text-xs font-semibold text-surface-100">{it.label}</p>
                      <p className="text-[11px] text-surface-400 mt-0.5">{it.blocked ?? it.reason}</p>
                      {it.manualSteps && <ol className="list-decimal ml-5 mt-1 text-[11px] text-surface-300">{it.manualSteps.map((s, i) => <li key={i}>{s}</li>)}</ol>}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {plan.warnings.length > 0 && <ul className="space-y-1">{plan.warnings.map((w, i) => <li key={i} className="flex gap-2 text-[11px] text-amber-200/90"><AlertTriangle size={12} className="shrink-0 mt-0.5" />{w}</li>)}</ul>}
          </>)}

          {stage === 'running' && progress && (
            <div className="space-y-3 py-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-surface-100"><Loader2 size={16} className="animate-spin text-primary-300" /> {PHASE_LABEL[progress.phase] ?? progress.phase}</div>
              <p className="text-xs text-surface-400">{progress.message}</p>
              <div className="h-2 rounded-full bg-overlay-6 overflow-hidden"><div className="h-full bg-primary-500 transition-all" style={{ width: `${pct ?? 100}%`, opacity: pct === undefined ? 0.35 : 1 }} /></div>
              <div className="flex justify-between text-[11px] text-surface-500"><span>{pct !== undefined ? `${pct}%` : 'working…'}</span>{progress.received != null && <span>{formatBytes(progress.received)}{progress.total ? ` of ${formatBytes(progress.total)}` : ''}</span>}</div>
              <button onClick={() => { api.cancelSrpInstall(); toast('Cancelling — anything already changed will be restored.'); }} className="btn-secondary text-xs py-1.5 px-3">Cancel</button>
            </div>
          )}

          {stage === 'result' && (
            <div className="space-y-3">
              {fatal && <div className="flex gap-2 p-3 rounded-xl border border-red-500/25 bg-red-500/10 text-xs text-red-200"><XCircle size={16} className="shrink-0" />{fatal}</div>}
              {result?.cancelled && <div className="p-3 rounded-xl border border-amber-500/25 bg-amber-500/10 text-xs text-amber-200">Cancelled. Anything already changed was restored.</div>}
              {result?.groups.map((g, i) => (
                <div key={i} className={`p-3 rounded-xl border ${g.ok ? 'border-emerald-500/25 bg-emerald-500/5' : 'border-red-500/25 bg-red-500/5'}`}>
                  <p className="flex items-center gap-2 text-xs font-semibold text-surface-100">
                    {g.ok ? <CheckCircle2 size={14} className="text-emerald-300" /> : <XCircle size={14} className="text-red-300" />}
                    {{ preflight: 'Before starting', conflict: 'Old HUD app', cars: 'Cars', track: 'Tracks', companion: 'SRP Board' }[g.group] ?? g.group}: {g.ok ? 'done' : g.rolledBack ? 'failed — previous state restored' : 'failed'}
                  </p>
                  {g.error && <p className="text-[11px] text-red-200 mt-1">{g.error}</p>}
                  {g.notes.map((n, j) => <p key={j} className="text-[11px] text-surface-400 mt-0.5">{n}</p>)}
                  {g.backupDir && (
                    <button onClick={() => api.revealSrpBackup(g.backupDir!)} className="mt-1.5 text-[11px] text-primary-300 hover:text-primary-200 flex items-center gap-1"><Undo2 size={11} /> Replaced files were kept — show backup <FolderOpen size={11} /></button>
                  )}
                </div>
              ))}
              {result?.skipped.map((s) => <p key={s.id} className="text-[11px] text-surface-400 flex gap-2"><Info size={12} className="shrink-0 mt-0.5" />{s.id}: {s.reason}</p>)}
              {result?.report && <p className="text-xs text-surface-300">Re-check after installing: <span className="font-semibold">{result.report.summary.fail === 0 ? 'no blocking problems remain.' : `${result.report.summary.fail} problem${result.report.summary.fail === 1 ? ' still needs' : 's still need'} attention.`}</span></p>}
            </div>
          )}
        </div>

        <div className="shrink-0 flex items-center gap-3 px-5 py-3.5 border-t border-overlay-6 bg-surface-950/40">
          {stage === 'review' && (<>
            <p className="text-[11px] text-surface-500 flex-1">{ids.length} item{ids.length === 1 ? '' : 's'} approved{bytes ? ` · ${formatBytes(bytes)} to download` : ''}. Nothing happens until you press Install.</p>
            <button onClick={onClose} className="btn-secondary text-xs py-2 px-4">Not now</button>
            <button onClick={go} disabled={!canGo} className="btn-primary text-xs py-2 px-4 disabled:opacity-40 flex items-center gap-1.5"><Download size={13} /> Install {ids.length || ''}</button>
          </>)}
          {stage === 'result' && <button onClick={onClose} className="btn-primary text-xs py-2 px-4 ml-auto">Close</button>}
        </div>
      </div>
    </div>
  );
}
