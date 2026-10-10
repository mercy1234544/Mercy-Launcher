import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { RefreshCw, Loader2, CloudOff, Cloud, AlertTriangle, ListChecks, X, ShieldCheck, Settings2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { Panel } from '../ui';
import { catalogBar, catalogErrorHelp, TONE_CLASSES } from '../../lib/acMercyView';

interface Props {
  /** Called when the catalog contents changed (servers added/removed/updated) so the page can reload its list. */
  onCatalogChanged?: () => void;
  /** Refresh once when the section is opened (rate-limited in the main process). */
  refreshOnOpen?: boolean;
}

// Where the server list came from and how fresh it is: the last successful sync, any problem, what changed, and a
// manual Refresh. It never hides a failure behind old data — if the list is stale, built-in or expired it says so.
export default function AcCatalogBar({ onCatalogChanged, refreshOnOpen }: Props) {
  const api = window.electronAPI.assettoCorsa;
  const navigate = useNavigate();
  const [status, setStatus] = useState<AcCatalogStatus | null>(null);
  const [settings, setSettings] = useState<AcCatalogSettings | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [refreshing, setRefreshing] = useState(false);
  const [changes, setChanges] = useState<string[]>([]);
  const [autoNote, setAutoNote] = useState<string | null>(null);
  const changed = useRef(onCatalogChanged);
  changed.current = onCatalogChanged;

  const load = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([api.catalogStatus(), api.getCatalogSettings()]);
      if (s.success) setStatus(s.status);
      if (c.success) setSettings(c.settings);
    } catch { /* the bar is informational; the list below still works */ }
  }, []);

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
      if (o.outcome === 'updated') toast.success(o.changed ? 'Server catalog updated.' : 'Server catalog refreshed.');
      else if (o.outcome === 'unchanged') toast.success('Already up to date.');
      else if (o.outcome === 'unconfigured') toast('No catalog address is set yet. Add it in Setup & Diagnostics.');
      else if (o.outcome === 'skipped') toast('Just refreshed — try again in a moment.');
      else toast.error(o.error?.message ?? 'Could not refresh the catalog.');
    } catch (e: any) { toast.error(e?.message || 'Could not refresh the catalog.'); }
    finally { setRefreshing(false); }
  };

  const v = catalogBar(status, now, settings);
  const Icon = !status || !status.configured || status.source === 'builtin' ? CloudOff : v.tone === 'good' ? Cloud : AlertTriangle;
  return (
    <Panel padding="sm" className="space-y-2" data-testid="catalog-bar">
      <div className="flex items-center gap-3 flex-wrap">
        <Icon size={15} className={`${TONE_CLASSES[v.tone].text} shrink-0`} />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-surface-100 flex items-center gap-2 flex-wrap">
            {v.title}
            {v.badges.map((b) => <span key={b.label} title={b.title} className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${TONE_CLASSES[b.tone].chip}`}>{b.label === 'Signature verified' ? <span className="inline-flex items-center gap-1"><ShieldCheck size={10} />{b.label}</span> : b.label}</span>)}
          </p>
          <p className="text-[11px] text-surface-400">{v.detail}</p>
        </div>
        <button onClick={() => navigate('/assetto-corsa/setup', { state: { focus: 'catalog' } })} className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5" data-testid="open-catalog-settings" title="Catalog address and trusted signing keys">
          <Settings2 size={12} /> {status?.configured ? 'Catalog settings' : 'Set up catalog'}
        </button>
        {v.canRefresh && (
          <button onClick={refresh} disabled={refreshing || !!status?.syncing} className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5 disabled:opacity-50">
            {refreshing || status?.syncing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Refresh
          </button>
        )}
      </div>
      {v.warnings.map((w, i) => <p key={i} className="flex gap-2 text-[11px] text-amber-200/90"><AlertTriangle size={12} className="shrink-0 mt-0.5" />{w}</p>)}
      {(() => { const h = catalogErrorHelp(status?.lastError); return h ? <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-2.5" data-testid="catalog-error-help"><p className="text-[11px] font-bold text-amber-200">{h.title}</p><p className="text-[11px] text-surface-300 mt-0.5">{h.hint}</p></div> : null; })()}
      {status?.notices.map((n, i) => <p key={i} className="flex gap-2 text-[11px] text-sky-200/90"><ListChecks size={12} className="shrink-0 mt-0.5" />{n}</p>)}
      {autoNote && <p className="flex gap-2 text-[11px] text-sky-200/90" data-testid="auto-install-note"><ListChecks size={12} className="shrink-0 mt-0.5" />{autoNote}<button onClick={() => setAutoNote(null)} className="ml-auto text-surface-500 hover:text-surface-200" aria-label="Dismiss"><X size={12} /></button></p>}
      {changes.length > 0 && (
        <div className="rounded-lg border border-sky-500/25 bg-sky-500/5 p-2.5" data-testid="catalog-changes">
          <div className="flex items-center gap-2"><p className="text-[11px] font-bold text-sky-200">What changed</p><button onClick={() => setChanges([])} className="ml-auto text-surface-500 hover:text-surface-200" aria-label="Dismiss"><X size={12} /></button></div>
          <ul className="mt-1 space-y-0.5 text-[11px] text-surface-300 list-disc ml-4">{changes.map((c, i) => <li key={i}>{c}</li>)}</ul>
          <p className="mt-1 text-[10px] text-surface-500">Nothing on your computer was removed. Content that left the catalog stays installed.</p>
        </div>
      )}
    </Panel>
  );
}
