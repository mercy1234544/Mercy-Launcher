import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle, XCircle, CircleDashed, Circle, Loader2 } from 'lucide-react';
import { CONTENT_STATE_VIEW, contentSummaryLine, countRows, sortContentRows, STEP_TONE, TONE_CLASSES } from '../../lib/acMercyView';

const CONTENT_CHANGED_EVENT = 'mercy:ac-content-changed';

const StepIcon = ({ state }: { state: AcReadiness['steps'][number]['state'] }) =>
  state === 'done' ? <CheckCircle2 size={14} className="text-emerald-300" />
  : state === 'blocked' ? <XCircle size={14} className="text-red-300" />
  : state === 'warn' || state === 'todo' ? <AlertTriangle size={14} className="text-amber-300" />
  : <CircleDashed size={14} className="text-surface-500" />;

// "Can I join?" as a checklist: catalog → game install → content → Custom Shaders Patch → server address → join.
// Each step is a separate fact. The panel never merges them into one "online" claim and always says that the final
// connection is handed to Content Manager and has not been verified.
export default function AcReadinessPanel({ serverId, refreshKey }: { serverId: string; refreshKey?: number }) {
  const api = window.electronAPI.assettoCorsa;
  const [data, setData] = useState<{ readiness: AcReadiness; content: AcContentStatus } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.srpReadiness(serverId);
      if (r.success) { setData({ readiness: r.readiness, content: r.content }); setError(null); } else setError(r.error);
    } catch (e: any) { setError(e?.message || 'Could not check readiness.'); }
    finally { setLoading(false); }
  }, [serverId]);

  useEffect(() => { load(); }, [load, refreshKey]);
  useEffect(() => {
    const onChanged = () => load();
    window.addEventListener(CONTENT_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(CONTENT_CHANGED_EVENT, onChanged);
  }, [load]);

  if (error) return <p className="text-xs text-red-300">{error}</p>;
  if (!data) return <p className="flex items-center gap-2 text-xs text-surface-400"><Loader2 size={13} className="animate-spin" /> Checking readiness…</p>;
  const { readiness: rd, content } = data;
  const rows = sortContentRows(content.rows.filter((r) => r.kind === 'car' || r.kind === 'track' || r.kind === 'layout'));
  const f = rd.facts;
  return (
    <div className="space-y-3" data-testid="readiness-panel">
      <ol className="space-y-1.5">
        {rd.steps.map((s, i) => (
          <li key={`${s.id}-${i}`} className="flex gap-2 text-xs">
            <span className="mt-0.5 shrink-0"><StepIcon state={s.state} /></span>
            <span className="min-w-0"><span className={`font-semibold ${TONE_CLASSES[STEP_TONE[s.state]].text}`}>{s.label}.</span> <span className="text-surface-400">{s.detail}</span></span>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-1.5 text-[10px]" data-testid="readiness-facts">
        <span className={`px-2 py-0.5 rounded-full border ${f.catalogAvailable ? TONE_CLASSES.good.chip : TONE_CLASSES.neutral.chip}`}>Catalog: {f.catalogAvailable ? 'available' : 'not from a live catalog'}</span>
        <span className={`px-2 py-0.5 rounded-full border ${f.contentReady ? TONE_CLASSES.good.chip : TONE_CLASSES.warn.chip}`}>Content: {f.contentReady ? 'ready' : 'not ready'}</span>
        <span className={`px-2 py-0.5 rounded-full border ${TONE_CLASSES.neutral.chip}`}>Game port: {f.gamePort}</span>
        <span className={`px-2 py-0.5 rounded-full border ${TONE_CLASSES.neutral.chip}`}>Status page: {f.infoPage}</span>
        <span className={`px-2 py-0.5 rounded-full border ${TONE_CLASSES.neutral.chip}`}>Join: not verified</span>
      </div>
      <div>
        <p className="text-[10px] font-bold uppercase tracking-wider text-surface-500 mb-1 flex items-center gap-2">Content on this PC {loading && <Loader2 size={10} className="animate-spin" />}</p>
        <p className="text-[11px] text-surface-400 mb-1.5" data-testid="content-summary">{contentSummaryLine(countRows(rows))}</p>
        <ul className="space-y-0.5 max-h-56 overflow-y-auto pr-1">
          {rows.map((r) => {
            const v = CONTENT_STATE_VIEW[r.state];
            return (
              <li key={r.id} className="flex items-center gap-2 text-[11px]" title={r.detail}>
                <Circle size={6} className={`shrink-0 ${r.required ? 'text-surface-400 fill-surface-400' : 'text-surface-600'}`} />
                <span className="flex-1 min-w-0 truncate text-surface-300">{r.name}{!r.required && <span className="text-surface-500"> (optional)</span>}</span>
                <span className={`shrink-0 px-2 py-0.5 rounded-full border ${TONE_CLASSES[v.tone].chip}`}>{v.label}</span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
