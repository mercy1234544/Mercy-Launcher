import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { RefreshCw, Loader2, AlertTriangle, ListChecks, X, CheckCircle2, Info } from 'lucide-react';
import toast from 'react-hot-toast';
import { catalogErrorHelp, relativeTime, TONE_CLASSES } from '../../lib/acMercyView';
import { stripView } from '../../lib/acJoinView';

interface Props {
  /** Called when the catalog contents changed (servers added/removed/updated) so the page can reload its list. */
  onCatalogChanged?: () => void;
  /** Refresh once when the section is opened (rate-limited in the main process). */
  refreshOnOpen?: boolean;
}

// The slim line above the server list: how fresh the list is, a Refresh button, and a link to Setup only when something
// needs fixing. Signature, key and address details live in Setup & Diagnostics; failures are never hidden behind old data.
export default function AcCatalogBar({ onCatalogChanged, refreshOnOpen }: Props) {
  const api = window.electronAPI.assettoCorsa;
  const navigate = useNavigate();
  const [status, setStatus] = useState<AcCatalogStatus | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [refreshing, setRefreshing] = useState(false);
  const [changes, setChanges] = useState<string[]>([]);
  const [autoNote, setAutoNote] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  // Developer options (Settings → System) reveal the catalog address/keys and the link to them; players get plain wording only.
  const [developer, setDeveloper] = useState(false);
  useEffect(() => { window.electronAPI.settings?.get('developerMode').then((v: unknown) => setDeveloper(v === true)).catch(() => undefined); }, []);
  const changed = useRef(onCatalogChanged);
  changed.current = onCatalogChanged;

  const load = useCallback(async () => { try { const s = await api.catalogStatus(); if (s.success) setStatus(s.status); } catch { /* informational only */ } }, []);

  useEffect(() => {
    load();
    if (refreshOnOpen) { api.refreshCatalog('section-open').then((r) => { if (r.success) setStatus(r.status); }).catch(() => undefined); }
    const off = api.onCatalogEvent((e) => {
      setStatus(e.status);
      if (e.type === 'changed') {
        if (e.diff && !e.diff.firstSync && e.diff.summary.length) setChanges(e.diff.summary);
        changed.current?.();
      }
    });
    const offAuto = api.onCatalogAutoInstall((e) => {
      if (e.phase === 'started') setAutoNote('Installing updated content automatically…');
      else setAutoNote(e.success ? 'Updated content was installed automatically.' : `Automatic install did not finish: ${e.error ?? 'see the install log in Setup & Diagnostics.'}`);
      window.dispatchEvent(new Event('mercy:ac-content-changed'));
    });
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => { off(); offAuto(); clearInterval(tick); };
  }, [load, refreshOnOpen]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const r = await api.refreshCatalog('manual');
      if (!r.success) { toast.error(r.error); return; }
      setStatus(r.status);
      const o = r.result;
      if (o.outcome === 'updated') toast.success(o.changed ? 'Server list updated.' : 'Server list refreshed.');
      else if (o.outcome === 'unchanged') toast.success('Already up to date.');
      else if (o.outcome === 'unconfigured') toast('The live server list is not set up yet.');
      else if (o.outcome === 'skipped') toast('Just refreshed. Try again in a moment.');
      else toast.error(o.error?.message ?? 'Could not refresh the server list.');
    } catch (e: any) { toast.error(e?.message || 'Could not refresh the server list.'); }
    finally { setRefreshing(false); }
  };

  const v = stripView(status, (iso) => relativeTime(iso, now), developer);
  const help = catalogErrorHelp(status?.lastError, developer ? 'developer' : 'player');
  const Icon = v.tone === 'good' ? CheckCircle2 : v.tone === 'neutral' ? Info : AlertTriangle;
  const unsafe = status?.environment === 'development' || status?.unsignedDev;
  return (
    <div className="space-y-2" data-testid="catalog-bar">
      <div className="flex items-center gap-2.5 flex-wrap rounded-xl border border-overlay-6 bg-surface-900/40 px-3 py-2">
        <Icon size={14} className={`${TONE_CLASSES[v.tone].text} shrink-0`} />
        <p className="text-xs text-surface-300 flex-1 min-w-0 basis-60">{v.text}{unsafe && <span title="These servers run on a private test network. They can only be joined from the same network." className="ml-2 text-[10px] font-bold px-2 py-0.5 rounded-full border bg-amber-500/15 text-amber-300 border-amber-500/25">{status?.unsignedDev ? 'UNSIGNED TEST LIST' : developer ? 'TEST LIST' : 'TEST NETWORK'}</span>}</p>
        {help && <button onClick={() => setShowHelp((x) => !x)} className="text-[11px] text-surface-400 hover:text-surface-100 underline">{showHelp ? 'Hide' : 'Why?'}</button>}
        {v.showSetup && <button onClick={() => navigate('/assetto-corsa/setup', { state: { focus: 'catalog' } })} className="text-[11px] font-semibold text-primary-300 hover:text-primary-200 underline" data-testid="open-catalog-settings">{v.setupLabel}</button>}
        {status?.configured && (
          <button onClick={refresh} disabled={refreshing || !!status?.syncing} className="btn-secondary text-[11px] py-1 px-2.5 flex items-center gap-1.5 disabled:opacity-50" title="Refresh the server list">
            {refreshing || status?.syncing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Refresh
          </button>
        )}
      </div>
      {help && showHelp && <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-2.5" data-testid="catalog-error-help"><p className="text-[11px] font-bold text-amber-200">{help.title}</p><p className="text-[11px] text-surface-300 mt-0.5">{help.hint}</p></div>}
      {autoNote && <p className="flex gap-2 text-[11px] text-sky-200/90" data-testid="auto-install-note"><ListChecks size={12} className="shrink-0 mt-0.5" />{autoNote}<button onClick={() => setAutoNote(null)} className="ml-auto text-surface-500 hover:text-surface-200" aria-label="Dismiss"><X size={12} /></button></p>}
      {changes.length > 0 && (
        <div className="rounded-lg border border-sky-500/25 bg-sky-500/5 p-2.5" data-testid="catalog-changes">
          <div className="flex items-center gap-2"><p className="text-[11px] font-bold text-sky-200">What changed</p><button onClick={() => setChanges([])} className="ml-auto text-surface-500 hover:text-surface-200" aria-label="Dismiss"><X size={12} /></button></div>
          <ul className="mt-1 space-y-0.5 text-[11px] text-surface-300 list-disc ml-4">{changes.map((c, i) => <li key={i}>{c}</li>)}</ul>
          <p className="mt-1 text-[10px] text-surface-500">Nothing on your computer was removed. Content that left the list stays installed.</p>
        </div>
      )}
    </div>
  );
}
