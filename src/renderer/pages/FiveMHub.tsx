import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import {
  Server, Package, Download, HardDrive, Search, FileText, Cpu,
  ArrowRight, ArrowLeft, Zap, Loader2, X, AlertTriangle, Sparkles, Car, RefreshCw,
  Settings as SettingsIcon, FolderOpen,
} from 'lucide-react';
import { useAppStore } from '../stores/useAppStore';
import { Panel, SectionHeading } from '../components/ui';
import toast from 'react-hot-toast';

// The FiveM hub — Mercy Launcher's first fully functional game hub. This is the
// original Dashboard content (hero/stats/shortcuts/import), moved here and
// re-headed under the new "FiveM" identity; nothing about how it works changed.
// It links out to the existing, working ServerManager-backed pages rather than
// re-implementing any of them.
const containerVariants = { hidden: { opacity: 0 }, show: { opacity: 1, transition: { staggerChildren: 0.06 } } };
const itemVariants = { hidden: { opacity: 0, y: 16 }, show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.4, 0, 0.2, 1] } } };

export default function FiveMHub() {
  const navigate = useNavigate();
  const { servers, setServers, logAction } = useAppStore();
  const [refreshing, setRefreshing] = useState(false);

  const loadServers = async () => {
    if (!window.electronAPI) return;
    try {
      const data = await window.electronAPI.server.getAll();
      setServers(data);
    } catch (err) {
      console.error('Failed to load servers from backend:', err);
    }
  };
  useEffect(() => { loadServers(); }, []);

  const handleRefresh = async () => { setRefreshing(true); await loadServers(); setRefreshing(false); toast.success('Refreshed'); };

  // Import existing server
  const [showImportModal, setShowImportModal] = useState(false);
  const [importPath, setImportPath] = useState('');
  const [importName, setImportName] = useState('');
  const [importing, setImporting] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<{
    framework: string; artifactVersion: string; resourceCount: number; hasServerCfg: boolean; hasFXServer: boolean; serverName: string;
  } | null>(null);

  const handleBrowseImport = async () => {
    if (!window.electronAPI) return;
    const dir = await window.electronAPI.openDirectory();
    if (!dir) return;
    setImportPath(dir); setScanResult(null); setScanning(true);
    try {
      const result = await window.electronAPI.server.scan(dir);
      setScanResult(result); setImportName(result.serverName);
    } catch { toast.error('Failed to scan folder'); } finally { setScanning(false); }
  };

  const handleImportServer = async () => {
    if (!window.electronAPI || !importPath) return;
    setImporting(true);
    try {
      const result = await window.electronAPI.server.import(importPath, importName || undefined);
      if (result.success && result.server) {
        await loadServers();
        logAction('Server Imported', `${result.server.name} (${result.detected?.framework || 'custom'})`, 'success');
        toast.success(`Imported "${result.server.name}" successfully!`);
        setShowImportModal(false); setImportPath(''); setImportName(''); setScanResult(null);
      } else toast.error(result.error || 'Failed to import server');
    } catch (err: any) { toast.error(`Import failed: ${err.message}`); } finally { setImporting(false); }
  };

  const totalResources = servers.reduce((sum, s) => sum + s.resourceCount, 0);
  const runningServers = servers.filter((s) => s.status === 'running').length;

  return (
    <motion.div variants={containerVariants} initial="hidden" animate="show" className="p-6 space-y-6 max-w-6xl mx-auto">
      {/* Header */}
      <motion.div variants={itemVariants}>
        <button onClick={() => navigate('/')} className="flex items-center gap-1.5 text-xs font-semibold text-surface-500 hover:text-surface-100 transition-colors mb-3">
          <ArrowLeft size={13} /> Back to Home
        </button>
        <SectionHeading
          icon={Car}
          iconClass="bg-orange-500/15 border-orange-500/25 text-orange-300"
          title="FiveM"
          subtitle="FiveM Management"
          action={
            <div className="flex items-center gap-2">
              <button onClick={handleRefresh} disabled={refreshing} className="btn-secondary text-xs py-2 flex items-center gap-1.5">
                {refreshing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Refresh
              </button>
              <button onClick={() => navigate('/settings')} className="btn-secondary text-xs py-2 flex items-center gap-1.5">
                <SettingsIcon size={13} /> Settings
              </button>
            </div>
          }
        />
      </motion.div>

      {/* Stats */}
      <motion.div variants={itemVariants} className="grid grid-cols-3 gap-4">
        {[
          { icon: Server, value: String(servers.length), label: 'Total Servers', tint: 'bg-emerald-600/20 text-emerald-400 border-emerald-500/20' },
          { icon: Zap, value: String(runningServers), label: 'Running Now', tint: 'bg-purple-600/20 text-purple-400 border-purple-500/20' },
          { icon: Package, value: totalResources.toLocaleString(), label: 'Total Resources', tint: 'bg-amber-600/20 text-amber-400 border-amber-500/20' },
        ].map((s) => (
          <Panel key={s.label}>
            <div className={`w-11 h-11 rounded-xl border flex items-center justify-center mb-4 ${s.tint}`}><s.icon size={19} /></div>
            <p className="text-3xl font-extrabold text-surface-100 tracking-tight">{s.value}</p>
            <p className="text-xs text-surface-500 mt-0.5">{s.label}</p>
          </Panel>
        ))}
      </motion.div>

      {/* Primary entry points. Browse Servers deliberately isn't repeated
          here — it's already a global entry point (Home's Quick Actions) —
          so My Servers and Marketplace are FiveM's own two obvious first
          choices instead. */}
      <motion.div variants={itemVariants} className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {[
          { icon: Server, title: 'My Servers', sub: `${servers.length} server${servers.length !== 1 ? 's' : ''} configured`, tint: 'bg-emerald-600/20 text-emerald-400 border-emerald-500/20', path: '/servers' },
          { icon: Package, title: 'Marketplace', sub: 'Vehicles, scripts, MLOs & more', tint: 'bg-blue-600/20 text-blue-400 border-blue-500/20', path: '/marketplace' },
        ].map((c) => (
          <Panel as="button" interactive key={c.title} padding="lg" onClick={() => navigate(c.path)} className="group flex items-center gap-5">
            <div className={`w-14 h-14 rounded-2xl border flex items-center justify-center shrink-0 ${c.tint}`}><c.icon size={24} /></div>
            <div className="flex-1 min-w-0">
              <p className="text-base font-bold text-surface-100">{c.title}</p>
              <p className="text-xs text-surface-500 mt-0.5">{c.sub}</p>
            </div>
            <ArrowRight size={17} className="text-surface-600 group-hover:text-primary-300 group-hover:translate-x-0.5 transition-all shrink-0" />
          </Panel>
        ))}
      </motion.div>

      {/* Secondary shortcuts */}
      <motion.div variants={itemVariants} className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {[
          { icon: Sparkles, title: 'Create Server', sub: 'Set up a new server', tint: 'bg-purple-600/20 text-purple-400 border-purple-500/20', path: '/create' },
          { icon: Car, title: 'Vehicle Studio', sub: 'Tune & diagnose vehicles', tint: 'bg-sky-600/20 text-sky-400 border-sky-500/20', path: '/vehicle-studio' },
          { icon: Download, title: 'Import Server', sub: 'Bring in an existing folder', tint: 'bg-rose-600/20 text-rose-400 border-rose-500/20', onClick: () => setShowImportModal(true) },
        ].map((c: any) => (
          <Panel as="button" interactive key={c.title} padding="sm" onClick={() => (c.onClick ? c.onClick() : navigate(c.path))} className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 ${c.tint}`}><c.icon size={17} /></div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-surface-100">{c.title}</p>
              <p className="text-xs text-surface-500 truncate">{c.sub}</p>
            </div>
          </Panel>
        ))}
      </motion.div>

      {/* Import Server Modal */}
      <AnimatePresence>
        {showImportModal && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md"
            onClick={() => !importing && (setShowImportModal(false), setScanResult(null), setImportPath(''))}>
            <motion.div initial={{ opacity: 0, scale: 0.9, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9, y: 20 }}
              transition={{ type: 'spring', stiffness: 400, damping: 30 }} onClick={(e) => e.stopPropagation()} className="glass-panel p-6 max-w-lg w-full mx-4">
              <div className="flex items-start gap-4 mb-5">
                <div className="w-12 h-12 rounded-xl bg-primary-500/10 border border-primary-500/20 flex items-center justify-center shrink-0"><HardDrive size={22} className="text-primary-400" /></div>
                <div className="flex-1">
                  <h3 className="text-lg font-bold text-surface-100">Import Existing Server</h3>
                  <p className="text-sm text-surface-400 mt-0.5">Select your existing FiveM server folder</p>
                </div>
                <button onClick={() => !importing && (setShowImportModal(false), setScanResult(null), setImportPath(''))} className="p-1.5 rounded-lg text-surface-500 hover:text-surface-100 hover:bg-overlay-6 transition-all"><X size={16} /></button>
              </div>

              <div className="mb-5">
                <label className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2 block">Server Folder</label>
                <div className="flex gap-2">
                  <div className="flex-1 bg-overlay-3 border border-overlay-6 rounded-xl px-4 py-2.5 text-sm text-surface-300 truncate font-mono">{importPath || 'No folder selected...'}</div>
                  <button onClick={handleBrowseImport} disabled={importing} className="px-4 py-2.5 rounded-xl text-sm font-semibold bg-primary-500/10 text-primary-400 hover:bg-primary-500/20 border border-primary-500/20 transition-all"><FolderOpen size={16} /></button>
                </div>
              </div>

              {scanning && (
                <div className="flex items-center gap-3 mb-5 p-4 rounded-xl bg-primary-500/5 border border-primary-500/10">
                  <Loader2 size={18} className="text-primary-400 animate-spin" /><span className="text-sm text-primary-300">Scanning server folder...</span>
                </div>
              )}

              {scanResult && !scanning && (
                <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mb-5 space-y-4">
                  <div>
                    <label className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2 block">Server Name</label>
                    <input type="text" value={importName} onChange={(e) => setImportName(e.target.value)}
                      className="w-full bg-overlay-3 border border-overlay-6 rounded-xl px-4 py-2.5 text-sm text-surface-100 placeholder-surface-600 focus:outline-none focus:border-primary-500/40 focus:ring-1 focus:ring-primary-500/20 transition-all" placeholder="Server name..." />
                  </div>
                  <div className="bg-overlay-3 border border-overlay-6 rounded-xl p-4 space-y-3">
                    <h4 className="text-xs font-semibold text-surface-400 uppercase tracking-wider flex items-center gap-2"><Search size={12} /> Detected Configuration</h4>
                    <div className="grid grid-cols-2 gap-3">
                      <DetectionItem icon={Cpu} label="Framework" value={scanResult.framework === 'qbcore' ? 'QBCore' : scanResult.framework === 'esx' ? 'ESX Legacy' : 'Custom'} color={scanResult.framework === 'qbcore' ? 'text-blue-400' : scanResult.framework === 'esx' ? 'text-orange-400' : 'text-surface-400'} />
                      <DetectionItem icon={Package} label="Resources" value={`${scanResult.resourceCount} found`} color="text-purple-400" />
                      <DetectionItem icon={HardDrive} label="Artifacts" value={scanResult.artifactVersion === 'unknown' ? 'Not detected' : `Build ${scanResult.artifactVersion}`} color={scanResult.artifactVersion === 'unknown' ? 'text-amber-400' : 'text-emerald-400'} />
                      <DetectionItem icon={FileText} label="server.cfg" value={scanResult.hasServerCfg ? 'Found' : 'Missing'} color={scanResult.hasServerCfg ? 'text-emerald-400' : 'text-red-400'} />
                    </div>
                  </div>
                  {!scanResult.hasFXServer && (
                    <div className="bg-amber-500/8 border border-amber-500/15 rounded-xl p-3"><p className="text-xs text-amber-300 flex items-center gap-2"><AlertTriangle size={13} className="shrink-0" /> No FXServer executable found. You may need to download artifacts.</p></div>
                  )}
                  {!scanResult.hasServerCfg && (
                    <div className="bg-amber-500/8 border border-amber-500/15 rounded-xl p-3"><p className="text-xs text-amber-300 flex items-center gap-2"><AlertTriangle size={13} className="shrink-0" /> No server.cfg found. You'll need to create one or use the Health Scanner.</p></div>
                  )}
                </motion.div>
              )}

              <div className="flex gap-3">
                <button onClick={() => !importing && (setShowImportModal(false), setScanResult(null), setImportPath(''))} disabled={importing} className="flex-1 btn-secondary">Cancel</button>
                <button onClick={handleImportServer} disabled={importing || !importPath || !scanResult} className="flex-1 btn-primary flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed">
                  {importing ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} {importing ? 'Importing...' : 'Import Server'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function DetectionItem({ icon: Icon, label, value, color }: { icon: any; label: string; value: string; color: string }) {
  return (
    <div className="flex items-center gap-2.5 bg-overlay-2 rounded-lg p-2.5">
      <Icon size={14} className={color} />
      <div className="min-w-0"><p className="text-[10px] text-surface-500 uppercase tracking-wider">{label}</p><p className={`text-xs font-semibold ${color} truncate`}>{value}</p></div>
    </div>
  );
}
