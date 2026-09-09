import React, { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import toast from 'react-hot-toast';
import {
  Import,
  FolderOpen,
  FileArchive,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  ArrowLeft,
  ArrowLeftRight,
  Trash2,
  Plus,
  MapPin,
  Shield,
  Car,
  Phone,
  Wrench,
  Gamepad2,
  X,
} from 'lucide-react';
import { useAppStore } from '../stores/useAppStore';

interface AnalyzedResource {
  path: string;
  name: string;
  description: string;
  author: string;
  version: string;
  detectedType: string | null;
  suggestedFolder: string;
  isZip: boolean;
  dependencies: string[];
  conflicts: string[];
  conflictsInstalled: string[]; // conflicts that are actually installed on the server
  status: 'pending' | 'importing' | 'done' | 'error';
  error?: string;
  replaced?: string[];
}

const TYPE_LABELS: Record<string, string> = {
  police: 'ðŸ‘® Police System',
  ambulance: 'ðŸš‘ EMS / Ambulance',
  mechanic: 'ðŸ”§ Mechanic Job',
  inventory: 'ðŸŽ’ Inventory',
  phone: 'ðŸ“± Phone',
  hud: 'ðŸ“Š HUD',
  housing: 'ðŸ  Housing',
  clothing: 'ðŸ‘” Clothing / Appearance',
  multichar: 'ðŸ‘¥ Character Selection',
  garage: 'ðŸ…¿ï¸ Garage',
  vehicleshop: 'ðŸš— Vehicle Shop',
  banking: 'ðŸ¦ Banking',
  target: 'ðŸŽ¯ Target / Interaction',
  admin: 'ðŸ›¡ï¸ Admin Menu',
  weather: 'ðŸŒ¦ï¸ Weather System',
  voice: 'ðŸŽ™ï¸ Voice Chat',
  racing: 'ðŸ Racing',
  gangs: 'ðŸ’€ Gangs / Factions',
  prison: 'ðŸ”’ Prison / Jail',
  dispatch: 'ðŸ“Ÿ Dispatch / 911',
  doorlock: 'ðŸšª Door Lock',
  fuel: 'â›½ Fuel System',
  mlo: 'ðŸ—ï¸ MLO / Interior',
};

const TYPE_COLORS: Record<string, string> = {
  police: 'text-blue-400 bg-blue-500/10 border-blue-500/30',
  ambulance: 'text-red-400 bg-red-500/10 border-red-500/30',
  mechanic: 'text-orange-400 bg-orange-500/10 border-orange-500/30',
  inventory: 'text-amber-400 bg-amber-500/10 border-amber-500/30',
  phone: 'text-pink-400 bg-pink-500/10 border-pink-500/30',
  hud: 'text-sky-400 bg-sky-500/10 border-sky-500/30',
  mlo: 'text-lime-400 bg-lime-500/10 border-lime-500/30',
  admin: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/30',
  weather: 'text-green-400 bg-green-500/10 border-green-500/30',
  voice: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30',
};

export default function ImportResources() {
  const navigate = useNavigate();
  const { activeServerId, servers } = useAppStore();
  const activeServer = servers.find(s => s.id === activeServerId);

  const [queue, setQueue] = useState<AnalyzedResource[]>([]);
  const [installedResources, setInstalledResources] = useState<string[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);

  // Load installed resources when server changes
  useEffect(() => {
    if (activeServer && window.electronAPI) {
      window.electronAPI.import.scanInstalled(activeServer.installPath).then(setInstalledResources);
    }
  }, [activeServer]);

  const analyzeAndQueue = useCallback(async (paths: string[]) => {
    if (!window.electronAPI || !activeServer) return;
    setAnalyzing(true);

    for (const p of paths) {
      try {
        const result = await window.electronAPI.import.analyze(p);
        const conflictsInstalled = result.conflicts.filter((c: string) =>
          installedResources.some(ir => ir.toLowerCase() === c.toLowerCase())
        );

        setQueue(prev => [...prev, {
          path: p,
          name: result.name,
          description: result.description,
          author: result.author,
          version: result.version,
          detectedType: result.detectedType,
          suggestedFolder: result.suggestedFolder,
          isZip: result.isZip,
          dependencies: result.dependencies,
          conflicts: result.conflicts,
          conflictsInstalled,
          status: 'pending',
        }]);
      } catch (err: any) {
        toast.error(`Failed to analyze: ${p.split('\\').pop() || p}`);
      }
    }

    setAnalyzing(false);
  }, [activeServer, installedResources]);

  // Drag & drop handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    const files = Array.from(e.dataTransfer.files);
    const paths = files.map(f => (f as any).path).filter(Boolean);
    if (paths.length > 0) {
      analyzeAndQueue(paths);
    }
  }, [analyzeAndQueue]);

  // Browse button
  const handleBrowse = async () => {
    if (!window.electronAPI) return;
    const paths = await window.electronAPI.import.pickResources();
    if (paths && paths.length > 0) {
      analyzeAndQueue(paths);
    }
  };

  // Import a single resource
  const importOne = async (index: number) => {
    if (!window.electronAPI || !activeServer) return;
    const item = queue[index];

    setQueue(prev => prev.map((q, i) => i === index ? { ...q, status: 'importing' } : q));

    try {
      const result = await window.electronAPI.import.install({
        sourcePath: item.path,
        serverPath: activeServer.installPath,
        targetFolder: item.suggestedFolder,
        resourceName: item.name,
        replaceExisting: item.conflictsInstalled,
      });

      if (result.success) {
        setQueue(prev => prev.map((q, i) => i === index ? { ...q, status: 'done', replaced: result.replaced } : q));
        // Update installed list
        setInstalledResources(prev => [
          ...prev.filter(r => !result.replaced.includes(r)),
          item.name,
        ]);
        toast.success(
          result.replaced.length > 0
            ? `Installed ${item.name} â€” replaced ${result.replaced.join(', ')}`
            : `Installed ${item.name}`
        );
      } else {
        throw new Error(result.error);
      }
    } catch (err: any) {
      setQueue(prev => prev.map((q, i) => i === index ? { ...q, status: 'error', error: err.message } : q));
      toast.error(`Failed to import ${item.name}: ${err.message}`);
    }
  };

  // Import all pending
  const importAll = async () => {
    for (let i = 0; i < queue.length; i++) {
      if (queue[i].status === 'pending') {
        await importOne(i);
      }
    }
  };

  const removeFromQueue = (index: number) => {
    setQueue(prev => prev.filter((_, i) => i !== index));
  };

  const clearDone = () => {
    setQueue(prev => prev.filter(q => q.status !== 'done'));
  };

  const pendingCount = queue.filter(q => q.status === 'pending').length;
  const doneCount = queue.filter(q => q.status === 'done').length;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="h-full overflow-y-auto p-6"
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate(-1)} className="p-2 rounded-lg text-surface-500 hover:text-surface-100 hover:bg-overlay-6 transition-colors shrink-0"><ArrowLeft size={16} /></button>
          <div className="p-2 bg-primary-600/20 rounded-lg">
            <Import size={24} className="text-primary-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-surface-100">Import Resources</h1>
            <p className="text-sm text-surface-400">
              Drag & drop folders or ZIPs â€” auto-detects type, replaces conflicts, updates server.cfg
            </p>
          </div>
        </div>

        {pendingCount > 0 && (
          <button
            onClick={importAll}
            className="flex items-center gap-2 px-4 py-2 bg-primary-600 hover:bg-primary-500 rounded-lg text-sm font-medium text-surface-100 transition-colors"
          >
            <Import size={16} />
            Import All ({pendingCount})
          </button>
        )}
        {doneCount > 0 && (
          <button
            onClick={clearDone}
            className="flex items-center gap-2 px-3 py-2 bg-surface-700 hover:bg-surface-600 rounded-lg text-xs text-surface-300 transition-colors ml-2"
          >
            Clear Done
          </button>
        )}
      </div>

      {!activeServer && (
        <div className="card p-8 text-center">
          <AlertTriangle size={40} className="text-amber-400 mx-auto mb-3" />
          <p className="text-surface-300">Select a server from the sidebar first</p>
        </div>
      )}

      {activeServer && (
        <>
          {/* Drop Zone */}
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`relative border-2 border-dashed rounded-xl p-10 text-center transition-all duration-200 cursor-pointer mb-6 ${
              isDragOver
                ? 'border-primary-400 bg-primary-600/10 scale-[1.01]'
                : 'border-surface-600 hover:border-surface-500 bg-surface-800/30'
            }`}
            onClick={handleBrowse}
          >
            {analyzing ? (
              <div className="flex flex-col items-center gap-3">
                <Loader2 size={40} className="text-primary-400 animate-spin" />
                <p className="text-surface-300">Analyzing resources...</p>
              </div>
            ) : (
              <>
                <div className="flex justify-center gap-4 mb-4">
                  <FolderOpen size={36} className={`transition-colors ${isDragOver ? 'text-primary-400' : 'text-surface-500'}`} />
                  <FileArchive size={36} className={`transition-colors ${isDragOver ? 'text-primary-400' : 'text-surface-500'}`} />
                </div>
                <p className="text-lg font-medium text-surface-200 mb-1">
                  {isDragOver ? 'Drop resources here!' : 'Drag & drop resource folders or ZIPs here'}
                </p>
                <p className="text-sm text-surface-400">
                  Or click to browse â€¢ Supports folders, .zip files â€¢ MLOs, scripts, jobs, anything
                </p>
                <div className="flex justify-center gap-2 mt-4 flex-wrap">
                  {['MLO', 'Police', 'EMS', 'Phone', 'HUD', 'Inventory', 'Admin', 'Weather'].map(tag => (
                    <span key={tag} className="text-[10px] px-2 py-0.5 bg-surface-700/50 rounded-full text-surface-400 border border-surface-600/50">
                      {tag}
                    </span>
                  ))}
                  <span className="text-[10px] px-2 py-0.5 bg-surface-700/50 rounded-full text-surface-400 border border-surface-600/50">
                    + more
                  </span>
                </div>
              </>
            )}
          </div>

          {/* Import Queue */}
          <AnimatePresence>
            {queue.map((item, index) => (
              <motion.div
                key={`${item.path}-${index}`}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, x: -100 }}
                className={`card mb-3 ${
                  item.status === 'done'
                    ? 'border-green-500/30'
                    : item.status === 'error'
                    ? 'border-red-500/30'
                    : item.conflictsInstalled.length > 0
                    ? 'border-amber-500/30'
                    : ''
                }`}
              >
                <div className="flex items-start gap-4">
                  {/* Status Icon */}
                  <div className="pt-1">
                    {item.status === 'importing' ? (
                      <Loader2 size={20} className="text-primary-400 animate-spin" />
                    ) : item.status === 'done' ? (
                      <CheckCircle2 size={20} className="text-green-400" />
                    ) : item.status === 'error' ? (
                      <AlertTriangle size={20} className="text-red-400" />
                    ) : (
                      <div className="w-5 h-5 rounded-full border-2 border-surface-600" />
                    )}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="font-semibold text-surface-100">{item.name}</h3>
                      <span className="text-[10px] px-1.5 py-0.5 bg-surface-700 rounded text-surface-400">
                        v{item.version}
                      </span>
                      {item.isZip && (
                        <span className="text-[10px] px-1.5 py-0.5 bg-violet-500/10 border border-violet-500/30 rounded text-violet-300">
                          ZIP
                        </span>
                      )}
                      {item.detectedType && (
                        <span className={`text-[10px] px-2 py-0.5 rounded border ${
                          TYPE_COLORS[item.detectedType] || 'text-surface-300 bg-surface-700/50 border-surface-600'
                        }`}>
                          {TYPE_LABELS[item.detectedType] || item.detectedType}
                        </span>
                      )}
                    </div>

                    {item.description && (
                      <p className="text-xs text-surface-400 mb-1.5">{item.description}</p>
                    )}

                    <div className="flex items-center gap-3 text-[10px] text-surface-500">
                      <span>by {item.author}</span>
                      <span>â†’ {item.suggestedFolder}/{item.name}</span>
                    </div>

                    {/* Conflicts found */}
                    {item.conflictsInstalled.length > 0 && item.status === 'pending' && (
                      <div className="mt-2 p-2 bg-amber-500/5 border border-amber-500/20 rounded-lg">
                        <div className="flex items-center gap-1.5 text-xs text-amber-300 font-medium mb-1">
                          <ArrowLeftRight size={12} />
                          Will replace:
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {item.conflictsInstalled.map(c => (
                            <span key={c} className="text-[10px] px-2 py-0.5 bg-amber-500/10 border border-amber-500/30 rounded text-amber-200">
                              {c}
                            </span>
                          ))}
                        </div>
                        <p className="text-[10px] text-amber-400/70 mt-1">
                          Old resource will be removed and server.cfg updated automatically
                        </p>
                      </div>
                    )}

                    {/* Replaced confirmation */}
                    {item.replaced && item.replaced.length > 0 && (
                      <div className="mt-2 flex items-center gap-1.5 text-xs text-green-400">
                        <CheckCircle2 size={12} />
                        Replaced: {item.replaced.join(', ')}
                      </div>
                    )}

                    {/* Error */}
                    {item.error && (
                      <div className="mt-2 text-xs text-red-400">{item.error}</div>
                    )}

                    {/* Dependencies */}
                    {item.dependencies.length > 0 && (
                      <div className="flex items-center gap-1 mt-1.5 flex-wrap">
                        <span className="text-[10px] text-surface-500">Requires:</span>
                        {item.dependencies.map(dep => (
                          <span key={dep} className={`text-[10px] px-1.5 py-0.5 rounded ${
                            installedResources.includes(dep)
                              ? 'bg-green-500/10 text-green-400 border border-green-500/20'
                              : 'bg-surface-800 text-surface-400'
                          }`}>
                            {dep} {installedResources.includes(dep) ? 'âœ“' : ''}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2 shrink-0">
                    {item.status === 'pending' && (
                      <>
                        <button
                          onClick={() => importOne(index)}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-primary-600 hover:bg-primary-500 rounded-lg text-xs font-medium text-surface-100 transition-colors"
                        >
                          <Import size={12} />
                          {item.conflictsInstalled.length > 0 ? 'Replace & Import' : 'Import'}
                        </button>
                        <button
                          onClick={() => removeFromQueue(index)}
                          className="p-1.5 text-surface-500 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors"
                        >
                          <X size={14} />
                        </button>
                      </>
                    )}
                    {item.status === 'done' && (
                      <span className="text-xs text-green-400 font-medium">Installed âœ“</span>
                    )}
                  </div>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>

          {/* Empty state */}
          {queue.length === 0 && (
            <div className="text-center py-8">
              <p className="text-surface-500 text-sm">
                No resources in queue. Drag & drop files above or click to browse.
              </p>
            </div>
          )}

          {/* Info cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-6">
            <div className="card bg-surface-800/30">
              <h3 className="text-sm font-medium text-surface-200 mb-2 flex items-center gap-2">
                <MapPin size={14} className="text-lime-400" />
                MLOs & Interiors
              </h3>
              <p className="text-xs text-surface-400">
                Drop any MLO folder or ZIP â€” auto-placed in [mlo] folder with ensure added to server.cfg.
              </p>
            </div>
            <div className="card bg-surface-800/30">
              <h3 className="text-sm font-medium text-surface-200 mb-2 flex items-center gap-2">
                <ArrowLeftRight size={14} className="text-amber-400" />
                Smart Replace
              </h3>
              <p className="text-xs text-surface-400">
                Import a new police system? It auto-detects and replaces your existing one (qb-policejob, etc).
              </p>
            </div>
            <div className="card bg-surface-800/30">
              <h3 className="text-sm font-medium text-surface-200 mb-2 flex items-center gap-2">
                <Shield size={14} className="text-blue-400" />
                Auto Config
              </h3>
              <p className="text-xs text-surface-400">
                server.cfg is updated automatically â€” old ensures removed, new ones added. No manual editing needed.
              </p>
            </div>
          </div>
        </>
      )}
    </motion.div>
  );
}
