import React, { useCallback, useEffect, useState } from 'react';
import { Cloud, Loader2, KeyRound, Trash2, Plus, RefreshCw, AlertTriangle, ShieldCheck } from 'lucide-react';
import toast from 'react-hot-toast';
import { Panel } from '../ui';
import { bytesToGb, catalogBar, catalogErrorHelp, installModeExplanation, mbToBytes, relativeTime, TONE_CLASSES } from '../../lib/acMercyView';

const input = 'input-field !py-1.5 !px-3 !rounded-lg text-xs';

// Where the server list comes from, which signing key to trust, and whether content installs by itself. Everything is
// validated by the main process before it is saved; nothing here can point the launcher at an unsigned production
// catalog, and an address is never written to a log or a diagnostics copy.
export default function AcCatalogSettingsPanel({ onChanged }: { onChanged: () => void }) {
  const api = window.electronAPI.assettoCorsa;
  const [settings, setSettings] = useState<AcCatalogSettings | null>(null);
  const [status, setStatus] = useState<AcCatalogStatus | null>(null);
  const [url, setUrl] = useState('');
  const [keys, setKeys] = useState<{ keyId: string; publicKey: string }[]>([]);
  const [newId, setNewId] = useState(''); const [newKey, setNewKey] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState<'save' | 'refresh' | 'reset' | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const apply = (s: AcCatalogSettings) => { setSettings(s); setUrl(s.baseUrl ?? ''); setKeys(s.trustedKeys); };
  const load = useCallback(async () => {
    const [c, st] = await Promise.all([api.getCatalogSettings(), api.catalogStatus()]);
    if (c.success) apply(c.settings);
    if (st.success) setStatus(st.status);
  }, []);
  useEffect(() => { load(); const off = api.onCatalogEvent((e) => setStatus(e.status)); const t = setInterval(() => setNow(Date.now()), 30_000); return () => { off(); clearInterval(t); }; }, [load]);

  const save = async (patch: Partial<AcCatalogSettings>, quiet = false) => {
    setBusy('save'); setErrors([]);
    try {
      const r = await api.setCatalogSettings(patch);
      if (!r.success) { setErrors([r.error]); return false; }
      apply(r.settings); setStatus(r.status); setErrors(r.errors);
      if (!r.errors.length && !quiet) toast.success('Saved on this computer.');
      onChanged();
      return r.errors.length === 0;
    } finally { setBusy(null); }
  };
  const saveAddress = async () => { if (await save({ baseUrl: url.trim() || null, trustedKeys: keys })) { setBusy('refresh'); try { await api.refreshCatalog('manual'); await load(); onChanged(); } finally { setBusy(null); } } };
  const addKey = () => {
    if (!newId.trim() || !newKey.trim()) { setErrors(['Enter both a key id and the public key.']); return; }
    setErrors([]); setKeys((k) => [...k.filter((x) => x.keyId !== newId.trim()), { keyId: newId.trim(), publicKey: newKey.trim() }]); setNewId(''); setNewKey('');
  };
  const refreshNow = async () => { setBusy('refresh'); try { const r = await api.refreshCatalog('manual'); if (r.success) { setStatus(r.status); if (r.result.outcome === 'rejected' || r.result.outcome === 'unavailable') toast.error(r.result.error?.message ?? 'Could not refresh.'); else toast.success('Catalog refreshed.'); onChanged(); } } finally { setBusy(null); } };
  const reset = async () => { if (!confirmReset) { setConfirmReset(true); return; } setBusy('reset'); try { const r = await api.resetCatalog(); if (r.success) { setStatus(r.status); toast.success('Catalog forgotten. Your installed content was not touched.'); onChanged(); } } finally { setBusy(null); setConfirmReset(false); } };

  if (!settings) return null;
  const v = catalogBar(status, now, settings);
  return (
    <Panel className="space-y-4" data-testid="catalog-settings">
      <div className="flex items-start gap-2">
        <Cloud size={15} className="text-surface-400 mt-0.5" />
        <div>
          <h2 className="text-sm font-bold text-surface-100">Server catalog</h2>
          <p className="text-[11px] text-surface-500 mt-0.5">The owner publishes a signed list of servers and what each one needs. Mercy Launcher checks it at startup, when you open Mercy's Servers, and in the background, so a new track or car appears here without a new launcher. Nothing on your computer is deleted because it left the list.</p>
        </div>
      </div>

      <div className={`flex items-center gap-2 text-[11px] px-3 py-2 rounded-xl border ${TONE_CLASSES[v.tone].chip}`}>
        <span className="font-semibold">{v.title}</span><span className="opacity-80">· {v.detail}</span>
        {status?.nextAttemptAt && status.configured && <span className="ml-auto opacity-70">next check {new Date(status.nextAttemptAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
      </div>
      {v.warnings.map((w, i) => <p key={i} className="flex gap-2 text-[11px] text-amber-200/90"><AlertTriangle size={12} className="shrink-0 mt-0.5" />{w}</p>)}
      {(() => { const h = catalogErrorHelp(status?.lastError); return h ? <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-2.5" data-testid="catalog-error-help"><p className="text-[11px] font-bold text-amber-200">{h.title}</p><p className="text-[11px] text-surface-300 mt-0.5">{h.hint}</p></div> : null; })()}

      <div className="grid grid-cols-1 gap-3">
        <label className="space-y-1"><span className="text-[11px] text-surface-400">Catalog address</span>
          <input className={input} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://… (the address the server owner gave you)" spellCheck={false} />
          <span className="block text-[10px] text-surface-600">Must start with https://. Plain http is accepted only for a private network address, for testing. Nothing is built in or guessed.</span></label>

        <div className="space-y-2">
          <p className="flex items-center gap-1.5 text-[11px] text-surface-400"><KeyRound size={11} /> Trusted signing keys</p>
          {keys.length === 0 && <p className="text-[11px] text-amber-200/90">No key is pinned, so no catalog will be accepted. Ask the server owner for their <span className="font-semibold">public</span> key. Never paste a private key here.</p>}
          {keys.map((k) => (
            <div key={k.keyId} className="flex items-center gap-2 text-[11px] p-2 rounded-lg border border-overlay-6">
              <ShieldCheck size={12} className="text-surface-500 shrink-0" /><span className="font-mono text-surface-200">{k.keyId}</span><span className="font-mono text-surface-500 truncate flex-1">{k.publicKey.replace(/-----[^-]+-----|\s+/g, '').slice(0, 24)}…</span>
              <button onClick={() => setKeys((all) => all.filter((x) => x.keyId !== k.keyId))} className="text-surface-500 hover:text-red-300" aria-label={`Remove key ${k.keyId}`}><Trash2 size={12} /></button>
            </div>
          ))}
          <div className="grid grid-cols-1 md:grid-cols-[180px_1fr_auto] gap-2 items-start">
            <input className={input} value={newId} onChange={(e) => setNewId(e.target.value)} placeholder="key id (e.g. mercy-ac-2026-10)" spellCheck={false} />
            <textarea className={`${input} font-mono h-16`} value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder="Public key (PEM, or 32 bytes in base64)" spellCheck={false} />
            <button onClick={addKey} className="btn-secondary text-[11px] py-1.5 px-3 flex items-center gap-1.5"><Plus size={12} /> Add key</button>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={saveAddress} disabled={!!busy} className="btn-primary text-xs py-1.5 px-4 disabled:opacity-50 flex items-center gap-1.5">{busy === 'save' || busy === 'refresh' ? <Loader2 size={12} className="animate-spin" /> : null} Save &amp; refresh</button>
        <button onClick={refreshNow} disabled={!!busy || !status?.configured} className="btn-secondary text-xs py-1.5 px-3 disabled:opacity-50 flex items-center gap-1.5"><RefreshCw size={12} /> Refresh now</button>
        <button onClick={reset} disabled={!!busy} className="ml-auto text-[11px] text-surface-400 hover:text-red-300 px-2">{confirmReset ? 'Click again to forget the catalog and its history' : 'Reset catalog…'}</button>
      </div>
      {errors.map((e, i) => <p key={i} className="text-[11px] text-red-300">{e}</p>)}

      <div className="border-t border-overlay-6 pt-3 space-y-3">
        <p className="text-[11px] font-bold uppercase tracking-wider text-surface-500">Installing what a server needs</p>
        <div className="space-y-2">
          {(['review', 'auto'] as const).map((m) => (
            <label key={m} className={`flex items-start gap-3 p-2.5 rounded-xl border cursor-pointer ${settings.installMode === m ? 'border-primary-500/30 bg-primary-500/5' : 'border-overlay-6 hover:bg-overlay-4'}`}>
              <input type="radio" name="install-mode" className="mt-0.5 accent-primary-500" checked={settings.installMode === m} onChange={() => save({ installMode: m }, true)} />
              <span><span className="text-xs font-semibold text-surface-100">{m === 'review' ? 'Review before install (default)' : 'Install automatically'}</span>
                <span className="block text-[11px] text-surface-400 mt-0.5">{m === 'review' ? 'Metadata updates on its own; content only installs after you approve it.' : 'For servers you mark "keep ready" on their card.'}</span></span>
            </label>
          ))}
        </div>
        <p className="text-[11px] text-surface-400" data-testid="install-mode-explanation">{installModeExplanation(settings.installMode, settings.autoUpdateExisting, settings.maxAutoDownloadBytes)}</p>
        {settings.installMode === 'auto' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="flex items-start gap-2 text-[11px] text-surface-300"><input type="checkbox" className="mt-0.5 accent-primary-500" checked={settings.autoUpdateExisting} onChange={(e) => save({ autoUpdateExisting: e.target.checked }, true)} /> Also update content I already have (a backup is always kept)</label>
            <label className="space-y-1"><span className="text-[11px] text-surface-400">Largest automatic download per run (GB)</span>
              <input className={input} type="number" min={0.1} max={16} step={0.5} defaultValue={bytesToGb(settings.maxAutoDownloadBytes)} onBlur={(e) => { const n = Number(e.target.value); if (Number.isFinite(n) && n > 0) save({ maxAutoDownloadBytes: mbToBytes(n) }, true); }} /></label>
          </div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="space-y-1"><span className="text-[11px] text-surface-400">Check for changes every (minutes)</span>
            <input className={input} type="number" min={5} max={120} defaultValue={settings.intervalMinutes} onBlur={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) save({ intervalMinutes: n }, true); }} />
            <span className="block text-[10px] text-surface-600">5–120. Failed checks back off automatically (1 to 30 minutes).</span></label>
          <label className="flex items-start gap-2 text-[11px] text-surface-300 md:pt-5"><input type="checkbox" className="mt-0.5 accent-primary-500" checked={settings.allowUnsignedDev} onChange={(e) => save({ allowUnsignedDev: e.target.checked }, true)} /> <span>Accept <span className="font-semibold">unsigned development</span> catalogs from a private network address (testing only). Never applies to a production catalog, and never installs automatically.</span></label>
        </div>
      </div>
    </Panel>
  );
}
