// Vehicle Studio — top-level, server-independent vehicle development workspace.
// Phase 2 (shell) + Phase 3 (scanner/classifier/diagnostics). Import a folder or
// ZIP → real scan (main VehicleStudio service) → workspace with Overview,
// Vehicles, Files, and Diagnostics. Editing engines (Smart Tuning, handling.meta
// editor, fixer, build/export, server install) arrive in later phases and are
// clearly marked "coming next" — no faked controls.
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import toast from 'react-hot-toast';
import {
  Car, FolderOpen, FileArchive, Upload, Wrench, Sparkles, AlertTriangle,
  CheckCircle2, XCircle, Info, Loader2, ArrowLeft, Package, FileCode, Clock,
  Gauge, ShieldCheck, RefreshCw, Boxes, Save, RotateCcw, Download, Search,
  X, Server, ChevronRight, ChevronDown, Undo2, Cog, Lock, Shield,
} from 'lucide-react';
import { useAppStore } from '../stores/useAppStore';
import { OverviewTab } from '../components/vehicle-studio/OverviewTab';
import { CategoryTab } from '../components/vehicle-studio/CategoryTab';
import { HandlingTab } from '../components/vehicle-studio/HandlingTab';
import { SmartTuneTab } from '../components/vehicle-studio/SmartTuneTab';
import { PresetsTab } from '../components/vehicle-studio/PresetsTab';
import { ChangesTab } from '../components/vehicle-studio/ChangesTab';
import { NoHandling, TuneMissing } from '../components/vehicle-studio/repair';

const RECENT_KEY = 'vs_recent';
interface Recent { name: string; path: string; type: string; at: number; }
const loadRecent = (): Recent[] => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; } };
const saveRecent = (r: Recent[]) => localStorage.setItem(RECENT_KEY, JSON.stringify(r.slice(0, 8)));

type Tab = 'overview' | 'tune' | 'presets' | 'changes' | 'performance' | 'transmission' | 'handling' | 'brakes' | 'traction' | 'suspension' | 'drivetrain' | 'damage' | 'vehicles' | 'variations' | 'lighting' | 'files' | 'diagnostics';

// Access control is enforced app-wide by AppAccessGate (in Layout), so Vehicle
// Studio no longer gates itself — it renders directly.
export default function VehicleStudio() {
  const navigate = useNavigate();
  const [scan, setScan] = useState<VSScan | null>(null);
  const [loading, setLoading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [tab, setTab] = useState<Tab>('overview');
  const [recent, setRecent] = useState<Recent[]>(loadRecent());

  // copy=true on a fresh import (makes a safe workspace copy so the original is
  // never modified); re-opening a recent points at the existing workspace.
  const runScan = async (inputPath: string, copy: boolean) => {
    if (!inputPath || !window.electronAPI?.vehicleStudio) return;
    setLoading(true);
    try {
      const res = await window.electronAPI.vehicleStudio.scan(inputPath, copy);
      if (!res.ok || !res.data) { toast.error(res.error || 'Could not scan that vehicle'); return; }
      const data = res.data;
      setScan(data);
      setTab('overview');
      const next = [{ name: data.name, path: data.workspacePath, type: data.vehicles[0]?.type || 'Vehicle', at: Date.now() },
        ...recent.filter((r) => r.path !== data.workspacePath && r.path !== inputPath)];
      setRecent(next); saveRecent(next);
      toast.success(`Scanned ${data.name}`);
    } catch (e: any) { toast.error(e?.message || 'Scan failed'); }
    finally { setLoading(false); }
  };

  const importFolder = async () => { const p = await window.electronAPI?.vehicleStudio.pickFolder(); if (p) runScan(p, true); };
  const importZip = async () => { const p = await window.electronAPI?.vehicleStudio.pickZip(); if (p) runScan(p, true); };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    const f: any = e.dataTransfer.files?.[0];
    if (f?.path) runScan(f.path, true);
    else toast.error('Could not read that item — use Import Folder/ZIP instead.');
  };

  if (loading && !scan) return <Scanning />;
  if (scan) return <Workspace scan={scan} onBack={() => setScan(null)} onRescan={() => runScan(scan.workspacePath, false)} tab={tab} setTab={setTab} rescanning={loading} />;

  // ── Dashboard ────────────────────────────────────────────────────────────────
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="p-6 space-y-6 max-w-6xl mx-auto">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate(-1)} className="p-2 rounded-lg text-surface-500 hover:text-surface-100 hover:bg-overlay-6 transition-colors shrink-0"><ArrowLeft size={16} /></button>
        <div className="w-11 h-11 rounded-xl bg-primary-500/15 border border-primary-500/25 flex items-center justify-center"><Car size={22} className="text-primary-300" /></div>
        <div>
          <h1 className="text-2xl font-bold text-surface-100">Vehicle Studio</h1>
          <p className="text-sm text-surface-400">Import, tune, diagnose, and export FiveM vehicles — no server required.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Import + drop zone */}
        <div className="lg:col-span-2 space-y-3">
          <div className="flex gap-2">
            <button onClick={importFolder} className="flex-1 btn-secondary flex items-center justify-center gap-2 py-2.5"><FolderOpen size={15} /> Import Folder</button>
            <button onClick={importZip} className="flex-1 btn-secondary flex items-center justify-center gap-2 py-2.5"><FileArchive size={15} /> Open ZIP</button>
          </div>
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            onClick={importFolder}
            className={`cursor-pointer rounded-2xl border-2 border-dashed flex flex-col items-center justify-center text-center py-16 transition-all ${
              dragOver ? 'border-primary-500/60 bg-primary-500/10' : 'border-overlay-8 bg-overlay-2 hover:border-primary-500/30'
            }`}
          >
            <Upload size={34} className={dragOver ? 'text-primary-300' : 'text-surface-500'} />
            <p className="mt-3 text-sm font-semibold text-surface-200">Drop a FiveM vehicle here</p>
            <p className="text-xs text-surface-500 mt-1">A resource folder or a .zip — Vehicle Studio scans it automatically.</p>
          </div>
        </div>

        {/* Recent */}
        <div className="card">
          <p className="text-[10px] uppercase tracking-wider text-surface-500 mb-2 flex items-center gap-1.5"><Clock size={11} /> Recent Vehicles</p>
          {recent.length === 0 ? (
            <p className="text-xs text-surface-500 py-8 text-center">Nothing yet — import a vehicle to begin.</p>
          ) : (
            <div className="space-y-1">
              {recent.map((r) => (
                <button key={r.path} onClick={() => runScan(r.path, false)} className="w-full flex items-center gap-2.5 p-2 rounded-lg border border-transparent hover:bg-overlay-4 hover:border-overlay-6 text-left transition-all">
                  <Car size={14} className="text-primary-400 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold text-surface-100 truncate">{r.name}</p>
                    <p className="text-[10px] text-surface-500 truncate">{r.type}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Tools */}
      <div>
        <p className="text-[10px] uppercase tracking-wider text-surface-500 mb-3">Tools</p>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
          {[
            { icon: Gauge, label: 'Vehicle Editor', desc: 'handling.meta & more' },
            { icon: Sparkles, label: 'Smart Tuning', desc: 'type-aware presets' },
            { icon: ShieldCheck, label: 'Diagnostics', desc: 'validate the resource' },
            { icon: Wrench, label: 'Resource Fixer', desc: 'safe auto-repairs' },
            { icon: Boxes, label: 'Preset Manager', desc: 'built-in & custom' },
          ].map((t) => (
            <div key={t.label} onClick={() => toast('Import a vehicle to use this', { icon: '🚗' })}
              className="cursor-pointer rounded-xl border border-overlay-6 bg-overlay-2 p-4 hover:border-primary-500/30 transition-all">
              <t.icon size={18} className="text-primary-300 mb-2" />
              <p className="text-sm font-semibold text-surface-100">{t.label}</p>
              <p className="text-[11px] text-surface-500">{t.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </motion.div>
  );
}

function Scanning() {
  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="card flex flex-col items-center py-20">
        <Loader2 size={30} className="animate-spin text-primary-400 mb-3" />
        <p className="text-sm font-semibold text-surface-200">Scanning vehicle…</p>
        <p className="text-xs text-surface-500 mt-1">Detecting models, metadata, and references.</p>
      </div>
    </div>
  );
}

/* ═══════════════════ Workspace ═══════════════════ */
function Workspace({ scan, onBack, onRescan, tab, setTab, rescanning }: {
  scan: VSScan; onBack: () => void; onRescan: () => void; tab: Tab; setTab: (t: Tab) => void; rescanning: boolean;
}) {
  // Handling tab: any vehicle with a handlingId (broken ones get a repair panel).
  // Selection is by modelName so BOTH physics (via handlingId) and metadata
  // (via modelName) tabs stay scoped to one vehicle.
  const allVehicles = scan.vehicles;
  const firstGood = allVehicles.find((v) => v.hasHandling) || allVehicles[0];
  const [selModel, setSelModel] = useState<string | null>(firstGood?.modelName || null);
  const selVeh = allVehicles.find((v) => v.modelName === selModel) || firstGood;
  const handlingId = selVeh?.handlingId || null;
  const [showBuild, setShowBuild] = useState(false);
  const groups: { label: string; tabs: { id: Tab; label: string; icon: any }[] }[] = [
    { label: 'Vehicle', tabs: [
      { id: 'overview', label: 'Overview', icon: Info },
    ] },
    { label: 'Tuning', tabs: [
      { id: 'performance', label: 'Performance', icon: Gauge },
      { id: 'transmission', label: 'Transmission', icon: Cog },
      { id: 'drivetrain', label: 'Drivetrain', icon: Cog },
      { id: 'brakes', label: 'Brakes', icon: Cog },
      { id: 'traction', label: 'Traction', icon: Cog },
      { id: 'suspension', label: 'Suspension', icon: Cog },
      { id: 'damage', label: 'Damage', icon: Cog },
      { id: 'handling', label: 'Handling', icon: Cog },
    ] },
    { label: 'Smart', tabs: [
      { id: 'tune', label: 'Smart Tune', icon: Sparkles },
      { id: 'presets', label: 'Presets', icon: Boxes },
      { id: 'changes', label: 'Changes', icon: RotateCcw },
    ] },
    { label: 'Metadata', tabs: [
      { id: 'vehicles', label: 'Vehicles', icon: Car },
      { id: 'variations', label: 'Variations', icon: FileCode },
      { id: 'lighting', label: 'Lighting', icon: Sparkles },
    ] },
    { label: 'Tools', tabs: [
      { id: 'files', label: 'Files', icon: FileCode },
      { id: 'diagnostics', label: `Diagnostics (${scan.summary.errors + scan.summary.warnings})`, icon: ShieldCheck },
    ] },
  ];
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const ok = scan.summary.errors === 0;
  // Tabs scoped to the selected vehicle (show the vehicle picker).
  const scopedTabs = new Set(['overview', 'performance', 'transmission', 'drivetrain', 'brakes', 'traction', 'suspension', 'damage', 'handling', 'tune', 'presets', 'changes', 'vehicles', 'variations', 'lighting']);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="shrink-0 px-6 pt-5 pb-3 border-b border-overlay-6 flex items-center gap-4">
        <button onClick={onBack} className="p-2 rounded-lg text-surface-400 hover:text-surface-100 hover:bg-overlay-6 transition-all"><ArrowLeft size={16} /></button>
        <div className="w-11 h-11 rounded-xl bg-primary-500/15 border border-primary-500/25 flex items-center justify-center shrink-0"><Car size={20} className="text-primary-300" /></div>
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-bold text-surface-100 truncate">{scan.name}</h1>
          <p className="text-[11px] text-surface-500 font-mono truncate">{scan.workspacePath}</p>
        </div>
        <button onClick={onRescan} disabled={rescanning} className="btn-secondary flex items-center gap-2 text-xs py-2">
          {rescanning ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Re-scan
        </button>
        <button onClick={() => setShowBuild(true)} className="btn-primary flex items-center gap-2 text-xs py-2">
          <Package size={13} /> Build Vehicle
        </button>
      </div>

      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Left tabs — collapsible groups */}
        <div className="w-52 shrink-0 border-r border-overlay-6 p-2 space-y-2 overflow-y-auto">
          {allVehicles.length > 1 && scopedTabs.has(tab) && (
            <div className="pb-2 mb-1 border-b border-overlay-6">
              <p className="text-[9px] uppercase tracking-wider text-surface-600 px-1 mb-1">Editing vehicle</p>
              <select value={selModel || ''} onChange={(e) => setSelModel(e.target.value)}
                className="w-full bg-overlay-3 border border-overlay-6 rounded-lg px-2 py-1.5 text-xs text-surface-200 focus:outline-none">
                {allVehicles.map((v) => <option key={v.modelName} value={v.modelName}>{v.modelName}{!v.hasHandling ? ' ⚠' : ''}</option>)}
              </select>
            </div>
          )}
          {groups.map((g) => (
            <div key={g.label}>
              <button onClick={() => setCollapsed((c) => ({ ...c, [g.label]: !c[g.label] }))}
                className="w-full flex items-center gap-1 px-1 py-1 text-[9px] uppercase tracking-wider text-surface-600 hover:text-surface-400">
                {collapsed[g.label] ? <ChevronRight size={11} /> : <ChevronDown size={11} />} {g.label}
              </button>
              {!collapsed[g.label] && g.tabs.map((t) => (
                <button key={t.id} onClick={() => setTab(t.id)}
                  className={`w-full flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-left text-sm transition-all ${
                    tab === t.id ? 'bg-primary-500/10 text-primary-200 border border-primary-500/25' : 'text-surface-400 hover:bg-overlay-4 border border-transparent'
                  }`}>
                  <t.icon size={14} /> {t.label}
                </button>
              ))}
            </div>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0 overflow-y-auto p-6">
          {tab === 'overview' && <OverviewTab scan={scan} root={scan.root} handlingId={handlingId} vehicle={selVeh || null} />}
          {tab === 'tune' && (handlingId && selVeh?.hasHandling ? <SmartTuneTab root={scan.root} handlingId={handlingId} type={selVeh?.type || 'Unknown'} onChanged={onRescan} />
            : handlingId ? <TuneMissing modelName={selVeh?.modelName || ''} handlingId={handlingId} onGoHandling={() => setTab('handling')} /> : <NoHandling />)}
          {tab === 'presets' && (handlingId && selVeh?.hasHandling ? <PresetsTab root={scan.root} handlingId={handlingId} onChanged={onRescan} />
            : handlingId ? <TuneMissing modelName={selVeh?.modelName || ''} handlingId={handlingId} onGoHandling={() => setTab('handling')} /> : <NoHandling />)}
          {tab === 'changes' && (handlingId ? <ChangesTab root={scan.root} handlingId={handlingId} modelName={selVeh?.modelName || null} onChanged={onRescan} /> : <NoHandling />)}
          {tab === 'handling' && (handlingId ? <HandlingTab root={scan.root} handlingId={handlingId} modelName={selVeh?.modelName || ''} onChanged={onRescan} onGoDiagnostics={() => setTab('diagnostics')} /> : <NoHandling />)}
          {(['performance', 'transmission', 'drivetrain', 'brakes', 'traction', 'suspension', 'damage'] as Tab[]).includes(tab) && (
            handlingId ? <CategoryTab root={scan.root} handlingId={handlingId} categoryKey={tab} onChanged={onRescan} onGoHandling={() => setTab('handling')} /> : <NoHandling />
          )}
          {tab === 'vehicles' && (selVeh ? <MetaEditor root={scan.root} kind="vehicles" modelName={selVeh.modelName} title="Vehicle metadata" onChanged={onRescan} /> : <NoHandling />)}
          {tab === 'variations' && (selVeh ? <MetaEditor root={scan.root} kind="carvariations" modelName={selVeh.modelName} title="Variations (carvariations.meta)" onChanged={onRescan} /> : <NoHandling />)}
          {tab === 'lighting' && (selVeh ? <MetaEditor root={scan.root} kind="carcols" modelName={selVeh.modelName} title="Lighting & sirens (carcols.meta)" onChanged={onRescan} /> : <NoHandling />)}
          {tab === 'files' && <FilesTab scan={scan} />}
          {tab === 'diagnostics' && <DiagnosticsTab scan={scan} onRescan={onRescan} />}
        </div>
      </div>

      {showBuild && <BuildModal scan={scan} onClose={() => setShowBuild(false)} />}

      {/* Footer status */}
      <div className="shrink-0 px-6 py-2.5 border-t border-overlay-6 flex items-center gap-4 text-xs">
        <span className={`flex items-center gap-1.5 font-semibold ${ok ? 'text-emerald-400' : 'text-red-400'}`}>
          {ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />} {ok ? 'Valid' : 'Has errors'}
        </span>
        <span className="text-red-400">{scan.summary.errors} Errors</span>
        <span className="text-amber-400">{scan.summary.warnings} Warnings</span>
        <span className="text-sky-400">{scan.summary.info} Info</span>
        <span className="flex-1" />
        <button onClick={onRescan} disabled={rescanning} className="text-primary-300 hover:text-primary-200 font-semibold flex items-center gap-1.5">
          {rescanning ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />} Validate
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value, tone = 'text-surface-100' }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="rounded-xl border border-overlay-6 bg-overlay-2 px-4 py-3">
      <p className="text-[10px] uppercase tracking-wider text-surface-500 mb-0.5">{label}</p>
      <p className={`text-sm font-bold truncate ${tone}`}>{value}</p>
    </div>
  );
}

function VehiclesTab({ scan }: { scan: VSScan }) {
  if (scan.vehicles.length === 0) return <p className="text-sm text-surface-500">No vehicles.meta entries found. {scan.counts.yft > 0 ? 'Model files exist but have no definitions.' : ''}</p>;
  return (
    <div className="space-y-2 max-w-3xl">
      {scan.vehicles.map((v) => (
        <div key={v.modelName} className="card">
          <div className="flex items-center gap-3">
            <Car size={16} className="text-primary-400 shrink-0" />
            <span className="text-sm font-bold text-surface-100 flex-1 truncate">{v.modelName}</span>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-overlay-4 text-surface-300 border border-overlay-6">{v.type}</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-3 text-[11px]">
            <Field label="Handling ID" value={v.handlingId || '—'} ok={v.hasHandling} warn={!!v.handlingId && !v.hasHandling} />
            <Field label="Model (.yft)" value={v.hasModel ? 'Found' : 'Missing'} ok={v.hasModel} warn={!v.hasModel} />
            <Field label="TXD" value={v.txdName || '—'} />
            <Field label="Class" value={v.vehicleClass || 'Unknown'} />
          </div>
        </div>
      ))}
    </div>
  );
}

function Field({ label, value, ok, warn }: { label: string; value: string; ok?: boolean; warn?: boolean }) {
  return (
    <div>
      <p className="text-[9px] uppercase tracking-wider text-surface-600">{label}</p>
      <p className={`font-semibold truncate ${warn ? 'text-red-400' : ok ? 'text-emerald-400' : 'text-surface-200'}`}>{value}</p>
    </div>
  );
}

function FilesTab({ scan }: { scan: VSScan }) {
  const groups: { label: string; files: string[] }[] = [
    { label: 'handling.meta', files: scan.metaFiles.handling },
    { label: 'vehicles.meta', files: scan.metaFiles.vehicles },
    { label: 'carvariations.meta', files: scan.metaFiles.carvariations },
    { label: 'vehiclelayouts.meta', files: scan.metaFiles.vehiclelayouts },
  ];
  return (
    <div className="space-y-4 max-w-3xl">
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Model files (.yft)" value={scan.counts.yft} />
        <Stat label="Textures (.ytd)" value={scan.counts.ytd} />
        <Stat label="Meta files" value={scan.counts.meta} />
      </div>
      {groups.map((g) => (
        <div key={g.label}>
          <p className="text-[10px] uppercase tracking-wider text-surface-500 mb-1.5">{g.label}</p>
          {g.files.length === 0 ? <p className="text-xs text-surface-600">none</p> : (
            <div className="space-y-1">
              {g.files.map((f) => (
                <div key={f} className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-overlay-4 bg-overlay-2 text-xs">
                  <FileCode size={12} className="text-surface-500" /> <span className="font-mono text-surface-300 truncate">{f}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// Dispatch a single diagnostic's safe auto-fix; returns ok.
async function applyFix(root: string, d: VSDiagnostic): Promise<{ ok: boolean; error?: string }> {
  if (d.fixKind === 'generate-manifest') return window.electronAPI.vehicleStudio.generateManifest(root);
  if (d.fixKind === 'register-handling') return window.electronAPI.vehicleStudio.registerHandling(root);
  return { ok: false, error: 'Not auto-fixable' };
}

function DiagnosticsTab({ scan, onRescan }: { scan: VSScan; onRescan: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'error' | 'warning' | 'info'>('all');

  const safeFixable = scan.diagnostics.filter((d) => d.autoFixable && d.fixKind);
  const fixOne = async (d: VSDiagnostic) => {
    setBusy(d.id); const r = await applyFix(scan.root, d); setBusy(null);
    if (r.ok) { toast.success(`Fixed: ${d.problem}`); onRescan(); } else toast.error(r.error || 'Fix failed');
  };
  const fixAll = async () => {
    setBusy('all');
    // De-dupe by fixKind (manifest gen + register handling each run once).
    const kinds = Array.from(new Set(safeFixable.map((d) => d.fixKind)));
    let n = 0;
    for (const k of kinds) { const d = safeFixable.find((x) => x.fixKind === k)!; const r = await applyFix(scan.root, d); if (r.ok) n++; }
    setBusy(null);
    toast.success(`Applied ${n} safe fix${n !== 1 ? 'es' : ''}`); onRescan();
  };

  const order = { error: 0, warning: 1, info: 2 } as const;
  const shown = scan.diagnostics.filter((d) => filter === 'all' || d.severity === filter).sort((a, b) => order[a.severity] - order[b.severity]);
  const cats: VSDiagnostic['category'][] = ['Resource', 'Manifest', 'Vehicle', 'Handling', 'Metadata', 'Files'];

  return (
    <div className="space-y-4 max-w-3xl">
      <HealthBar summary={scan.summary} />

      {/* Summary chips + Fix All */}
      <div className="flex items-center gap-2 flex-wrap">
        {(['all', 'error', 'warning', 'info'] as const).map((f) => {
          const n = f === 'all' ? scan.diagnostics.length : scan.diagnostics.filter((d) => d.severity === f).length;
          const label = f === 'all' ? 'All' : f === 'error' ? 'Errors' : f === 'warning' ? 'Warnings' : 'Info';
          return (
            <button key={f} onClick={() => setFilter(f)}
              className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${filter === f ? 'bg-primary-500/15 text-primary-200 border-primary-500/30' : 'bg-overlay-3 text-surface-400 border-overlay-6 hover:bg-overlay-4'}`}>
              {label} <span className="opacity-70">{n}</span>
            </button>
          );
        })}
        <span className="flex-1" />
        {safeFixable.length > 0 && (
          <button onClick={fixAll} disabled={!!busy} className="btn-primary text-xs py-1.5 flex items-center gap-1.5">
            {busy === 'all' ? <Loader2 size={13} className="animate-spin" /> : <Wrench size={13} />} Fix {Array.from(new Set(safeFixable.map((d) => d.fixKind))).length} Safe Issue{Array.from(new Set(safeFixable.map((d) => d.fixKind))).length !== 1 ? 's' : ''}
          </button>
        )}
      </div>

      {scan.diagnostics.length === 0 ? (
        <div className="card flex flex-col items-center py-16 text-center">
          <CheckCircle2 size={34} className="text-emerald-400 mb-3" />
          <p className="text-sm font-bold text-surface-100">No problems detected</p>
          <p className="text-xs text-surface-500 mt-1">Models, metadata, and cross-references all check out.</p>
        </div>
      ) : (
        cats.map((cat) => {
          const items = shown.filter((d) => d.category === cat);
          if (items.length === 0) return null;
          return (
            <div key={cat}>
              <p className="text-[10px] uppercase tracking-wider text-surface-500 mb-1.5">{cat}</p>
              <div className="space-y-2">
                {items.map((d) => <DiagnosticRow key={d.id} d={d} busy={busy === d.id} canFix={!!(d.autoFixable && d.fixKind)} onFix={() => fixOne(d)} />)}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

function DiagnosticRow({ d, busy, canFix, onFix }: { d: VSDiagnostic; busy: boolean; canFix: boolean; onFix: () => void }) {
  const [showWhy, setShowWhy] = useState(false);
  const tone = d.severity === 'error' ? 'border-red-500/25 bg-red-500/5' : d.severity === 'warning' ? 'border-amber-500/25 bg-amber-500/5' : 'border-sky-500/25 bg-sky-500/5';
  const Icon = d.severity === 'error' ? XCircle : d.severity === 'warning' ? AlertTriangle : Info;
  const ic = d.severity === 'error' ? 'text-red-400' : d.severity === 'warning' ? 'text-amber-400' : 'text-sky-400';
  return (
    <div className={`rounded-xl border p-3 ${tone}`}>
      <div className="flex items-start gap-2.5">
        <Icon size={15} className={`${ic} shrink-0 mt-0.5`} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-surface-100">{d.problem}</p>
          <p className="text-xs text-surface-400 mt-0.5">{d.detail}</p>
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-overlay-4 text-surface-500 font-mono">{d.file}{d.line ? `:${d.line}` : ''}</span>
            {d.vehicle && <span className="text-[10px] px-1.5 py-0.5 rounded bg-overlay-4 text-surface-500">{d.vehicle}</span>}
            {d.why && <button onClick={() => setShowWhy((v) => !v)} className="text-[10px] text-primary-300 hover:text-primary-200">Why is this broken?</button>}
            {d.autoFixable && !canFix && <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary-500/15 text-primary-300 border border-primary-500/25">fix in Handling tab</span>}
          </div>
          {showWhy && d.why && <p className="text-[11px] text-surface-300 mt-2 leading-relaxed border-l-2 border-primary-500/40 pl-2">{d.why}</p>}
          {d.fix && <p className="text-[11px] text-emerald-300/90 mt-1.5 font-mono">Fix: {d.fix}</p>}
        </div>
        {canFix && (
          <button onClick={onFix} disabled={busy} className="shrink-0 btn-primary text-[11px] py-1.5 px-3 flex items-center gap-1.5">
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Wrench size={12} />} Fix
          </button>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════ Structured metadata editors (vehicles/carvariations/carcols) ═══════════════════ */
const META_TIPS: Record<string, string> = {
  handlingId: 'Which handling entry (in handling.meta) this vehicle uses.',
  vehicleClass: 'GTA class (VC_SPORT, VC_EMERGENCY, …) — affects category & AI.',
  type: 'VEHICLE_TYPE_CAR / _BIKE / _HELI etc.',
  flags: 'Space-separated FLAG_* behaviour flags.',
  layout: 'Seating/entry layout (LAYOUT_*).',
  audioNameHash: 'Which vehicle the engine sound is copied from.',
  wheelType: 'Default wheel category (VWT_SPORT, VWT_MUSCLE, …).',
  sirenSettings: 'The carcols siren ID this vehicle uses (links to carcols.meta).',
  lightSettings: 'The light configuration ID.',
};
function MetaEditor({ root, kind, modelName, title, onChanged }: { root: string; kind: 'vehicles' | 'carvariations' | 'carcols'; modelName: string; title: string; onChanged: () => void }) {
  const [fields, setFields] = useState<VSMetaField[]>([]);
  const [orig, setOrig] = useState<Record<string, string>>({});
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [summary, setSummary] = useState<Record<string, any> | null>(null);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [handlingNames, setHandlingNames] = useState<string[]>([]);

  const load = async () => {
    setLoading(true);
    const r = await window.electronAPI.vehicleStudio.readMeta(root, kind, modelName);
    setLoading(false);
    if (!r.ok || !r.fields) { setReadError(r.error || `${kind}.meta not found for ${modelName}`); return; }
    setReadError(null); setFields(r.fields); setSummary(r.summary || null);
    const o: Record<string, string> = {}; for (const f of r.fields) o[f.tag] = f.value;
    setOrig(o); setEdits({});
  };
  React.useEffect(() => { load(); if (kind === 'vehicles') window.electronAPI.vehicleStudio.listHandling(root).then((l) => setHandlingNames(l.map((e) => e.name))); }, [root, kind, modelName]);

  const val = (k: string) => (k in edits ? edits[k] : orig[k]) ?? '';
  const setVal = (k: string, v: string) => setEdits((e) => ({ ...e, [k]: v }));
  const resetField = (k: string) => setEdits((e) => { const n = { ...e }; delete n[k]; return n; });
  const dirty = Object.keys(edits).filter((k) => edits[k] !== orig[k]);

  const save = async () => {
    const editable = new Set(fields.filter((f) => f.editable).map((f) => f.tag));
    const changes = dirty.filter((k) => editable.has(k)).map((k) => ({ tag: k, value: edits[k] }));
    if (!changes.length) return;
    setSaving(true);
    const r = await window.electronAPI.vehicleStudio.writeMeta(root, kind, modelName, changes);
    setSaving(false);
    if (r.ok) { toast.success(`Saved ${r.applied} field(s) to ${kind}.meta`); await load(); onChanged(); } else toast.error(r.error || 'Save failed');
  };
  const undo = async () => { const r = await window.electronAPI.vehicleStudio.undoMeta(root, kind, modelName); if (r.ok) { toast.success('Reverted last save'); await load(); onChanged(); } else toast.error(r.error || 'Nothing to undo'); };

  if (loading) return <div className="flex items-center gap-2 text-sm text-surface-500"><Loader2 size={14} className="animate-spin" /> Reading {kind}.meta…</div>;
  if (readError) return (
    <div className="card flex flex-col items-center py-14 text-center max-w-xl">
      <FileCode size={28} className="text-surface-600 mb-3" />
      <p className="text-sm font-bold text-surface-100">No {title.toLowerCase()} for this vehicle</p>
      <p className="text-xs text-surface-500 mt-1 max-w-sm">{readError}. This is normal if the resource doesn't include a {kind}.meta entry for {modelName}.</p>
    </div>
  );

  const handlingVal = kind === 'vehicles' ? val('handlingId') : null;
  const handlingValid = handlingVal == null ? null : handlingNames.some((n) => n.toUpperCase() === handlingVal.toUpperCase());
  const match = (f: VSMetaField) => !search || f.friendly.toLowerCase().includes(search.toLowerCase()) || f.tag.toLowerCase().includes(search.toLowerCase());
  const shown = fields.filter(match);

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-center gap-2">
        <p className="text-sm font-bold text-surface-100 flex-1">{title} <span className="text-[11px] text-surface-500 font-normal font-mono">· {modelName}</span></p>
        {dirty.length > 0 && <span className="text-[11px] text-primary-300 flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-primary-400 animate-pulse" /> {dirty.length} unsaved</span>}
        <button onClick={undo} className="btn-secondary text-xs py-1.5 flex items-center gap-1.5"><Undo2 size={13} /> Undo</button>
        <button onClick={save} disabled={saving || !dirty.length} className="btn-primary text-xs py-1.5 flex items-center gap-1.5">{saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} Save{dirty.length ? ` (${dirty.length})` : ''}</button>
      </div>

      {/* cross-file handling reference validity (vehicles.meta) */}
      {handlingVal != null && (
        <div className={`rounded-xl border px-3 py-2 text-xs flex items-center gap-2 ${handlingValid ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300' : 'border-red-500/25 bg-red-500/10 text-red-300'}`}>
          {handlingValid ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
          {handlingValid ? `Valid handling reference — "${handlingVal}" exists in handling.meta` : `Broken handling reference — "${handlingVal}" is not in handling.meta`}
        </div>
      )}

      <div className="relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-500" />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search fields… (handling, class, siren…)"
          className="w-full bg-overlay-3 border border-overlay-6 rounded-xl pl-9 pr-3 py-2 text-sm text-surface-200 placeholder-surface-600 focus:outline-none focus:border-primary-500/40" />
      </div>

      <div className="card">
        <div className="space-y-2.5">
          {shown.length === 0 ? <p className="text-xs text-surface-500">No matching fields.</p> : shown.map((f) => {
            const isDirty = (f.tag in edits) && edits[f.tag] !== orig[f.tag];
            return (
              <div key={f.tag}>
                <div className="flex items-center gap-2">
                  <label className="text-xs text-surface-200 flex-1 truncate" title={META_TIPS[f.tag] || f.tag}>{f.friendly} {isDirty && <span className="inline-block w-1.5 h-1.5 rounded-full bg-primary-400 ml-1" />}</label>
                  {f.editable ? (
                    <input value={val(f.tag)} onChange={(e) => setVal(f.tag, e.target.value)} spellCheck={false} className={`w-44 bg-overlay-3 border rounded-lg px-2 py-1 text-xs font-mono text-right focus:outline-none ${isDirty ? 'border-primary-500/50 text-primary-200' : 'border-overlay-6 text-surface-200'}`} />
                  ) : (
                    <span className="w-44 text-right text-xs font-mono text-surface-500 flex items-center justify-end gap-1.5">{f.value} <span className="text-[9px] px-1 py-0.5 rounded bg-overlay-4 border border-overlay-6">read-only</span></span>
                  )}
                  {f.editable && <button onClick={() => resetField(f.tag)} disabled={!isDirty} title="Reset to last saved" className={`text-surface-500 hover:text-surface-200 ${!isDirty ? 'opacity-30' : ''}`}><RotateCcw size={12} /></button>}
                </div>
                <p className="text-[10px] text-surface-600 font-mono mt-0.5">{f.kind === 'attr' ? `<${f.tag} value="…" />` : `<${f.tag}>…</${f.tag}>`}{isDirty ? ` · was ${orig[f.tag]}` : ''}</p>
              </div>
            );
          })}
        </div>
      </div>

      {/* carvariations read-only summary */}
      {summary && (
        <div className="card">
          <p className="text-[10px] uppercase tracking-wider text-surface-500 mb-2">Variation data <span className="normal-case text-surface-600">— read-only</span></p>
          <div className="grid grid-cols-3 gap-3 text-xs">
            <div><p className="text-[9px] uppercase tracking-wider text-surface-600">Colour combos</p><p className="text-surface-200 font-semibold">{summary.colorCombos}</p></div>
            <div><p className="text-[9px] uppercase tracking-wider text-surface-600">Liveries</p><p className="text-surface-200 font-semibold">{summary.liveries}</p></div>
            <div><p className="text-[9px] uppercase tracking-wider text-surface-600">Mod kits</p><p className="text-surface-200 font-semibold truncate">{(summary.kits || []).join(', ') || '—'}</p></div>
          </div>
          <p className="text-[10px] text-surface-600 mt-2">Colour arrays, liveries and kits are preserved exactly — structured editing for these comes in a later phase (kept read-only rather than risk corrupting the arrays).</p>
        </div>
      )}

      <p className="text-[10px] text-surface-600">Edits are surgical — only the field you change is rewritten. Unknown elements, attributes and comments are preserved, and a backup is saved before every write.</p>
    </div>
  );
}

/* ═══════════════════ Build / Export / Install ═══════════════════ */
function BuildModal({ scan, onClose }: { scan: VSScan; onClose: () => void }) {
  const { servers } = useAppStore();
  const [busy, setBusy] = useState<string | null>(null);
  const [serverId, setServerId] = useState(servers[0]?.id || '');
  const [addEnsure, setAddEnsure] = useState(true);
  const resourceName = scan.name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
  const [spawn, setSpawn] = useState<{ vehicles: { modelName: string; spawnCode: string; hasModel: boolean; level: 'ok' | 'warn' | 'error'; issues: string[]; suggestion?: string }[]; modelFiles: string[] } | null>(null);
  const [exportAnyway, setExportAnyway] = useState(false);
  React.useEffect(() => { window.electronAPI.vehicleStudio.spawnReport(scan.root).then(setSpawn).catch(() => setSpawn(null)); }, [scan.root]);
  const spawnErrors = spawn ? spawn.vehicles.filter((v) => v.level === 'error').length : 0;
  const blockedBySpawn = spawnErrors > 0 && !exportAnyway;
  const guardSpawn = () => { if (blockedBySpawn) { toast.error('Fix the spawn-name errors below, or tick "export anyway".'); return false; } return true; };

  const exportZip = async () => { if (!guardSpawn()) return; setBusy('zip'); const r = await window.electronAPI.vehicleStudio.exportZip(scan.root, resourceName); setBusy(null); if (r.ok) toast.success('Exported ZIP'); else if (r.error !== 'cancelled') toast.error(r.error || 'Export failed'); };
  const exportFolder = async () => { if (!guardSpawn()) return; setBusy('folder'); const r = await window.electronAPI.vehicleStudio.exportFolder(scan.root, resourceName); setBusy(null); if (r.ok) toast.success('Exported folder'); else if (r.error !== 'cancelled') toast.error(r.error || 'Export failed'); };
  const install = async () => {
    if (!guardSpawn()) return;
    const srv = servers.find((s) => s.id === serverId); if (!srv) { toast.error('Pick a server'); return; }
    setBusy('install');
    const r = await window.electronAPI.vehicleStudio.install(scan.root, srv.installPath, resourceName, addEnsure);
    setBusy(null);
    if (r.ok) toast.success(`Installed to ${srv.name}${addEnsure ? ' + ensure added' : ''}`); else toast.error(r.error || 'Install failed');
  };

  const checks = [
    { ok: scan.manifest.exists, label: 'fxmanifest.lua' },
    { ok: scan.metaFiles.handling.length > 0, label: 'handling.meta' },
    { ok: scan.metaFiles.vehicles.length > 0, label: 'vehicles.meta' },
    { ok: scan.counts.yft > 0, label: 'Model files' },
    { ok: scan.summary.errors === 0, label: 'No blocking errors' },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="glass-panel p-6 max-w-md w-full mx-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-surface-100 flex items-center gap-2"><Package size={18} className="text-primary-300" /> Build {scan.name}</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg text-surface-500 hover:text-surface-100 hover:bg-overlay-6"><X size={16} /></button>
        </div>

        <div className="rounded-xl border border-overlay-6 bg-overlay-2 p-3 mb-4 space-y-1">
          {checks.map((c) => (
            <div key={c.label} className="flex items-center gap-2 text-xs">
              {c.ok ? <CheckCircle2 size={13} className="text-emerald-400" /> : <XCircle size={13} className="text-red-400" />}
              <span className={c.ok ? 'text-surface-300' : 'text-red-300'}>{c.label}</span>
            </div>
          ))}
        </div>

        {/* Spawn-name (spawn code) validation — the code players actually use in-game. */}
        <div className="rounded-xl border border-overlay-6 bg-overlay-2 p-3 mb-4">
          <p className="text-[10px] uppercase tracking-wider text-surface-500 mb-2 flex items-center gap-1.5"><Car size={11} /> Spawn codes {spawn && `(${spawn.vehicles.length})`}</p>
          {!spawn ? <div className="flex items-center gap-2 text-xs text-surface-500"><Loader2 size={12} className="animate-spin" /> Checking spawn names…</div>
            : spawn.vehicles.length === 0 ? <p className="text-xs text-surface-500">No vehicles.meta entries found to validate.</p>
            : (
              <div className="space-y-1.5 max-h-40 overflow-y-auto">
                {spawn.vehicles.map((v) => (
                  <div key={v.modelName} className="text-xs">
                    <div className="flex items-center gap-2">
                      {v.level === 'ok' ? <CheckCircle2 size={13} className="text-emerald-400 shrink-0" /> : v.level === 'warn' ? <AlertTriangle size={13} className="text-amber-400 shrink-0" /> : <XCircle size={13} className="text-red-400 shrink-0" />}
                      <span className="font-mono text-surface-100">{v.spawnCode}</span>
                      <span className="text-surface-600">— spawn code</span>
                    </div>
                    {v.issues.map((iss, i) => <p key={i} className={`ml-5 text-[10px] ${v.level === 'error' ? 'text-red-300' : 'text-amber-300'}`}>{iss}</p>)}
                  </div>
                ))}
              </div>
            )}
          {spawnErrors > 0 && (
            <label className="flex items-center gap-2 text-[11px] text-amber-300 mt-2 cursor-pointer">
              <input type="checkbox" checked={exportAnyway} onChange={(e) => setExportAnyway(e.target.checked)} /> Export anyway (I understand spawning may fail in-game)
            </label>
          )}
          {spawn && spawnErrors === 0 && <p className="text-[10px] text-emerald-400/80 mt-2 flex items-center gap-1"><CheckCircle2 size={10} /> Spawn names match model files — safe to import.</p>}
        </div>

        <div className="flex gap-2 mb-4">
          <button onClick={exportZip} disabled={!!busy || blockedBySpawn} className="flex-1 btn-secondary text-xs py-2.5 flex items-center justify-center gap-1.5">{busy === 'zip' ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} Export ZIP</button>
          <button onClick={exportFolder} disabled={!!busy || blockedBySpawn} className="flex-1 btn-secondary text-xs py-2.5 flex items-center justify-center gap-1.5">{busy === 'folder' ? <Loader2 size={13} className="animate-spin" /> : <FolderOpen size={13} />} Export Folder</button>
        </div>

        <div className="rounded-xl border border-overlay-6 bg-overlay-2 p-3">
          <p className="text-[10px] uppercase tracking-wider text-surface-500 mb-2 flex items-center gap-1.5"><Server size={11} /> Install to server (optional)</p>
          {servers.length === 0 ? (
            <p className="text-xs text-surface-500">No servers yet — create one in My Servers first.</p>
          ) : (
            <>
              <select value={serverId} onChange={(e) => setServerId(e.target.value)} className="w-full bg-overlay-3 border border-overlay-6 rounded-lg px-2 py-1.5 text-xs text-surface-200 mb-2 focus:outline-none">
                {servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <label className="flex items-center gap-2 text-xs text-surface-300 mb-2 cursor-pointer">
                <input type="checkbox" checked={addEnsure} onChange={(e) => setAddEnsure(e.target.checked)} /> Add <span className="font-mono">ensure {resourceName}</span> to server.cfg (backed up first)
              </label>
              <button onClick={install} disabled={!!busy} className="w-full btn-primary text-xs py-2 flex items-center justify-center gap-1.5">
                {busy === 'install' ? <Loader2 size={13} className="animate-spin" /> : <Server size={13} />} Install to {servers.find((s) => s.id === serverId)?.name || 'server'}
              </button>
              <p className="text-[10px] text-surface-600 mt-2">Copies to resources/[vehicles]/{resourceName}. An existing copy is backed up first.</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════ Health score ═══════════════════ */
export function healthScore(s: { errors: number; warnings: number }): number {
  return Math.max(0, 100 - s.errors * 15 - s.warnings * 5);
}
function HealthBar({ summary }: { summary: { errors: number; warnings: number; info: number } }) {
  const score = healthScore(summary);
  const tone = score >= 90 ? 'bg-emerald-500' : score >= 60 ? 'bg-amber-500' : 'bg-red-500';
  const txt = score >= 90 ? 'text-emerald-400' : score >= 60 ? 'text-amber-400' : 'text-red-400';
  return (
    <div className="card">
      <div className="flex items-center justify-between mb-2">
        <p className="text-[10px] uppercase tracking-wider text-surface-500">Resource Health</p>
        <span className={`text-lg font-extrabold ${txt}`}>{score}%</span>
      </div>
      <div className="h-2.5 rounded-full bg-overlay-4 overflow-hidden">
        <div className={`h-full ${tone} transition-all`} style={{ width: `${score}%` }} />
      </div>
      <div className="flex items-center gap-4 mt-2 text-xs">
        <span className="text-red-400">{summary.errors} Critical</span>
        <span className="text-amber-400">{summary.warnings} Warnings</span>
        <span className="text-sky-400">{summary.info} Info</span>
        {score === 100 && <span className="text-emerald-400 flex items-center gap-1"><CheckCircle2 size={12} /> All references valid</span>}
      </div>
    </div>
  );
}
