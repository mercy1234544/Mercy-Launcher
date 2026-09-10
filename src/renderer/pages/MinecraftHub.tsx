import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { Blocks, PlusCircle, FolderInput, Server, Zap, ArrowRight, ArrowLeft, Loader2, X, FolderOpen, CheckCircle2, AlertTriangle, Puzzle } from 'lucide-react';
import { useMinecraftStore } from '../stores/useMinecraftStore';
import { Panel, SectionHeading, EmptyState } from '../components/ui';
import toast from 'react-hot-toast';

const STATUS_DOT: Record<string, string> = {
  running: 'bg-emerald-400', starting: 'bg-amber-400', stopping: 'bg-amber-400', stopped: 'bg-surface-600', error: 'bg-red-400',
};

export default function MinecraftHub() {
  const navigate = useNavigate();
  const { servers, setServers } = useMinecraftStore();
  const [loading, setLoading] = useState(true);
  const [showImport, setShowImport] = useState(false);

  const load = async () => {
    if (!window.electronAPI?.minecraft) { setLoading(false); return; }
    try { setServers(await window.electronAPI.minecraft.getAll()); } catch {} finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const running = servers.filter((s) => s.status === 'running').length;

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="p-6 space-y-6 max-w-6xl mx-auto">
      <button onClick={() => navigate('/')} className="flex items-center gap-1.5 text-xs font-semibold text-surface-500 hover:text-surface-100 transition-colors">
        <ArrowLeft size={13} /> Back to Home
      </button>
      <SectionHeading
        icon={Blocks}
        iconClass="bg-emerald-500/15 border-emerald-500/25 text-emerald-300"
        title="Minecraft"
        subtitle="Create and manage your Minecraft servers"
      />

      <div className="grid grid-cols-2 gap-4">
        <Panel>
          <div className="w-11 h-11 rounded-xl border flex items-center justify-center mb-4 bg-emerald-600/20 text-emerald-400 border-emerald-500/20"><Server size={19} /></div>
          <p className="text-3xl font-extrabold text-surface-100 tracking-tight">{servers.length}</p>
          <p className="text-xs text-surface-500 mt-0.5">Total Servers</p>
        </Panel>
        <Panel>
          <div className="w-11 h-11 rounded-xl border flex items-center justify-center mb-4 bg-purple-600/20 text-purple-400 border-purple-500/20"><Zap size={19} /></div>
          <p className="text-3xl font-extrabold text-surface-100 tracking-tight">{running}</p>
          <p className="text-xs text-surface-500 mt-0.5">Running Now</p>
        </Panel>
      </div>

      {/* Primary entry points — matching FiveM's hub layout. Create Server is
          the main first action here (Minecraft has no separate "My Servers"
          page to link to instead — the list is already inline below), paired
          with Marketplace as FiveM's hub does. */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {[
          { icon: PlusCircle, title: 'Create Server', sub: 'Set up a new Vanilla or Paper server', tint: 'bg-purple-600/20 text-purple-400 border-purple-500/20', path: '/minecraft/create' },
          { icon: Puzzle, title: 'Marketplace', sub: 'Mods, plugins & datapacks', tint: 'bg-blue-600/20 text-blue-400 border-blue-500/20', path: '/minecraft/marketplace' },
        ].map((c) => (
          <Panel as="button" interactive key={c.title} padding="lg" onClick={() => navigate(c.path)} className="group flex items-center gap-5">
            <div className={`w-14 h-14 rounded-2xl border flex items-center justify-center shrink-0 ${c.tint}`}><c.icon size={24} /></div>
            <div className="flex-1 min-w-0 text-left">
              <p className="text-base font-bold text-surface-100">{c.title}</p>
              <p className="text-xs text-surface-500 mt-0.5">{c.sub}</p>
            </div>
            <ArrowRight size={17} className="text-surface-600 group-hover:text-primary-300 group-hover:translate-x-0.5 transition-all shrink-0" />
          </Panel>
        ))}
      </div>

      {/* Secondary shortcut */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Panel as="button" interactive padding="sm" onClick={() => setShowImport(true)} className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 bg-rose-600/20 text-rose-400 border-rose-500/20"><FolderInput size={17} /></div>
          <div className="flex-1 min-w-0 text-left">
            <p className="text-sm font-bold text-surface-100">Import Server</p>
            <p className="text-xs text-surface-500 truncate">Bring in an existing folder</p>
          </div>
        </Panel>
      </div>

      {loading ? (
        <Panel className="flex items-center justify-center py-12"><Loader2 size={20} className="animate-spin text-primary-400" /></Panel>
      ) : servers.length === 0 ? (
        <Panel padding="lg">
          <EmptyState
            icon={Blocks}
            title="No Minecraft servers yet"
            description="Create a new Vanilla or Paper server, or import one you already have running."
            action={
              <div className="flex items-center gap-2">
                <button onClick={() => setShowImport(true)} className="btn-secondary text-xs py-2 flex items-center gap-1.5"><FolderInput size={13} /> Import</button>
                <button onClick={() => navigate('/minecraft/create')} className="btn-primary text-xs py-2 flex items-center gap-1.5"><PlusCircle size={13} /> Create Server</button>
              </div>
            }
          />
        </Panel>
      ) : (
        <div className="space-y-3">
          {servers.map((s) => (
            <Panel as="button" interactive key={s.id} onClick={() => navigate(`/minecraft/server/${s.id}`)} className="group w-full flex items-center gap-4">
              <div className="w-10 h-10 rounded-xl bg-overlay-6 border border-overlay-10 flex items-center justify-center shrink-0"><Blocks size={17} className="text-emerald-300" /></div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold text-surface-100">{s.name}</p>
                  <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[s.status] || 'bg-surface-600'}`} />
                </div>
                <p className="text-xs text-surface-500 mt-0.5">{s.version} · {s.serverType === 'bedrock' ? 'Bedrock' : s.serverType === 'paper' ? 'Paper' : 'Vanilla'} · Port {s.port}</p>
              </div>
              <ArrowRight size={14} className="text-surface-600 shrink-0 transition-transform group-hover:translate-x-0.5" />
            </Panel>
          ))}
        </div>
      )}

      <AnimatePresence>
        {showImport && <ImportModal onClose={() => setShowImport(false)} onImported={() => { setShowImport(false); load(); }} />}
      </AnimatePresence>
    </motion.div>
  );
}

function ImportModal({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [dirPath, setDirPath] = useState('');
  const [name, setName] = useState('');
  const [ram, setRam] = useState(2048);
  const [detecting, setDetecting] = useState(false);
  const [detected, setDetected] = useState<Awaited<ReturnType<Window['electronAPI']['minecraft']['detectExisting']>> | null>(null);
  const [importing, setImporting] = useState(false);

  const browse = async () => {
    const dir = await window.electronAPI?.openDirectory();
    if (!dir) return;
    setDirPath(dir);
    setDetected(null);
    setDetecting(true);
    try {
      const result = await window.electronAPI.minecraft.detectExisting(dir);
      setDetected(result);
      if (result.valid && !name) setName(dir.split(/[\\/]/).pop() || 'Imported Server');
    } catch { toast.error('Could not scan that folder'); } finally { setDetecting(false); }
  };

  const doImport = async () => {
    if (!dirPath || !detected?.valid) return;
    setImporting(true);
    try {
      const result = await window.electronAPI.minecraft.import(dirPath, name || 'Imported Server', ram);
      if (result.success) { toast.success('Server imported'); onImported(); }
      else toast.error(result.error || 'Import failed');
    } catch (e: any) { toast.error(e?.message || 'Import failed'); } finally { setImporting(false); }
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md" onClick={() => !importing && onClose()}>
      <motion.div initial={{ opacity: 0, scale: 0.9, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9, y: 20 }}
        transition={{ type: 'spring', stiffness: 400, damping: 30 }} onClick={(e) => e.stopPropagation()} className="glass-panel p-6 max-w-lg w-full mx-4">
        <div className="flex items-start gap-4 mb-5">
          <div className="w-12 h-12 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center shrink-0"><FolderInput size={22} className="text-emerald-400" /></div>
          <div className="flex-1">
            <h3 className="text-lg font-bold text-surface-100">Import Existing Server</h3>
            <p className="text-sm text-surface-400 mt-0.5">Point Mercy at a Minecraft server folder you already have</p>
          </div>
          <button onClick={() => !importing && onClose()} className="p-1.5 rounded-lg text-surface-500 hover:text-surface-100 hover:bg-overlay-6 transition-all"><X size={16} /></button>
        </div>

        <div className="mb-4">
          <label className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2 block">Server Folder</label>
          <div className="flex gap-2">
            <div className="flex-1 bg-overlay-3 border border-overlay-6 rounded-xl px-4 py-2.5 text-sm text-surface-300 truncate font-mono">{dirPath || 'No folder selected...'}</div>
            <button onClick={browse} disabled={importing} className="px-4 py-2.5 rounded-xl text-sm font-semibold bg-primary-500/10 text-primary-400 hover:bg-primary-500/20 border border-primary-500/20 transition-all"><FolderOpen size={16} /></button>
          </div>
        </div>

        {detecting && <div className="flex items-center gap-2 text-sm text-surface-400 mb-4"><Loader2 size={14} className="animate-spin" /> Scanning…</div>}

        {detected && !detecting && (
          detected.valid ? (
            <div className="space-y-4 mb-5">
              <div className="bg-emerald-500/8 border border-emerald-500/15 rounded-xl p-3 flex items-center gap-2 text-xs text-emerald-300">
                <CheckCircle2 size={14} className="shrink-0" /> Detected a {detected.edition === 'bedrock' ? 'Bedrock Edition' : detected.serverType === 'paper' ? 'Paper' : 'Vanilla'} server{detected.hasWorld ? ' with a world' : ''}.
              </div>
              <div>
                <label className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2 block">Server Name</label>
                <input value={name} onChange={(e) => setName(e.target.value)} className="input-field" placeholder="Server name" />
              </div>
              {detected.edition !== 'bedrock' && (
                <div>
                  <label className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2 block">RAM Allocation (MB)</label>
                  <input type="number" min={512} step={512} value={ram} onChange={(e) => setRam(parseInt(e.target.value) || 2048)} className="input-field" />
                </div>
              )}
            </div>
          ) : (
            <div className="bg-amber-500/8 border border-amber-500/15 rounded-xl p-3 flex items-center gap-2 text-xs text-amber-300 mb-5">
              <AlertTriangle size={14} className="shrink-0" /> {detected.reason}
            </div>
          )
        )}

        <div className="flex gap-3">
          <button onClick={onClose} disabled={importing} className="flex-1 btn-secondary">Cancel</button>
          <button onClick={doImport} disabled={importing || !detected?.valid} className="flex-1 btn-primary flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed">
            {importing ? <Loader2 size={14} className="animate-spin" /> : <FolderInput size={14} />} {importing ? 'Importing…' : 'Import Server'}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
