import React, { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowLeft,
  Car,
  Upload,
  FolderOpen,
  FileArchive,
  Check,
  AlertCircle,
  Loader2,
  Package,
  File,
  Image,
  Wrench,
  Plus,
  CheckCircle2,
  XCircle,
  Trash2,
  Info,
  ArrowRight,
  Sparkles,
} from 'lucide-react';
import { useAppStore } from '../stores/useAppStore';
import toast from 'react-hot-toast';

interface VehicleAnalysis {
  name: string;
  sourcePath: string;
  isZip: boolean;
  hasManifest: boolean;
  hasStream: boolean;
  metaFiles: string[];
  streamFileCount: number;
  vehicleCount: number;
  needsManifest: boolean;
}

interface ImportResult {
  name: string;
  success: boolean;
  error?: string;
  generatedManifest?: boolean;
}

export default function VehiclePackManager() {
  const navigate = useNavigate();
  const { servers, activeServerId } = useAppStore();
  const activeServer = servers.find((s) => s.id === activeServerId);

  const [vehicles, setVehicles] = useState<VehicleAnalysis[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [importing, setImporting] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Map<string, ImportResult>>(new Map());
  const [isDragOver, setIsDragOver] = useState(false);

  const pickVehicles = async () => {
    try {
      const paths = await window.electronAPI.vehicle.pick();
      if (paths && paths.length > 0) {
        await analyzeVehicles(paths);
      }
    } catch (error: any) {
      toast.error(`Failed to select files: ${error.message}`);
    }
  };

  const analyzeVehicles = async (paths: string[]) => {
    setAnalyzing(true);
    const newVehicles: VehicleAnalysis[] = [];
    for (const p of paths) {
      try {
        const analysis = await window.electronAPI.vehicle.analyze(p);
        newVehicles.push({ ...analysis, sourcePath: p });
      } catch (error: any) {
        toast.error(`Failed to analyze ${p}: ${error.message}`);
      }
    }
    setVehicles((prev) => [...prev, ...newVehicles]);
    setAnalyzing(false);
    if (newVehicles.length > 0) {
      toast.success(`Analyzed ${newVehicles.length} vehicle pack${newVehicles.length > 1 ? 's' : ''}`);
    }
  };

  const importVehicle = async (vehicle: VehicleAnalysis) => {
    if (!activeServer) {
      toast.error('Select a server first');
      return;
    }
    setImporting((prev) => new Set(prev).add(vehicle.name));
    try {
      const result = await window.electronAPI.vehicle.import({
        sourcePath: vehicle.sourcePath,
        serverPath: activeServer.installPath,
        resourceName: vehicle.name,
      });
      setResults((prev) => new Map(prev).set(vehicle.name, { name: vehicle.name, ...result }));
      if (result.success) {
        toast.success(
          `Imported ${vehicle.name}${result.generatedManifest ? ' (manifest generated)' : ''}`
        );
      } else {
        toast.error(`Failed to import ${vehicle.name}: ${result.error}`);
      }
    } catch (error: any) {
      setResults((prev) =>
        new Map(prev).set(vehicle.name, { name: vehicle.name, success: false, error: error.message })
      );
      toast.error(`Error: ${error.message}`);
    } finally {
      setImporting((prev) => {
        const next = new Set(prev);
        next.delete(vehicle.name);
        return next;
      });
    }
  };

  const importAll = async () => {
    for (const vehicle of vehicles) {
      if (!results.has(vehicle.name) || !results.get(vehicle.name)?.success) {
        await importVehicle(vehicle);
      }
    }
  };

  const removeFromQueue = (name: string) => {
    setVehicles((prev) => prev.filter((v) => v.name !== name));
    setResults((prev) => {
      const next = new Map(prev);
      next.delete(name);
      return next;
    });
  };

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

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
      const paths: string[] = [];
      for (const file of Array.from(e.dataTransfer.files)) {
        paths.push((file as any).path || file.name);
      }
      if (paths.length > 0) {
        await analyzeVehicles(paths);
      }
    },
    []
  );

  const pendingCount = vehicles.filter((v) => !results.get(v.name)?.success).length;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -12 }}
      className="h-full flex flex-col overflow-hidden"
    >
      {/* Header */}
      <div className="px-8 pt-8 pb-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate(-1)} className="p-2 rounded-lg text-surface-500 hover:text-surface-100 hover:bg-overlay-6 transition-colors shrink-0"><ArrowLeft size={16} /></button>
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500/20 to-orange-600/10 border border-amber-500/20 flex items-center justify-center">
              <Car size={20} className="text-amber-400" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-surface-100">Vehicle Pack Manager</h1>
              <p className="text-sm text-surface-400">
                Import vehicle packs with auto-manifest generation
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {pendingCount > 0 && (
              <motion.button
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                onClick={importAll}
                disabled={!activeServer}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-amber-600 to-orange-500 text-surface-100 font-medium text-sm hover:from-amber-500 hover:to-orange-400 transition-all shadow-lg shadow-amber-500/20 disabled:opacity-40"
              >
                <Upload size={16} />
                Import All ({pendingCount})
              </motion.button>
            )}
            <button
              onClick={pickVehicles}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-overlay-6 border border-overlay-8 text-surface-200 font-medium text-sm hover:bg-overlay-10 hover:border-overlay-10 transition-all"
            >
              <FolderOpen size={16} />
              Browse Files
            </button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-8 pb-8">
        {vehicles.length === 0 ? (
          <div className="space-y-6">
            {/* Drop Zone */}
            <motion.div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              className={`relative rounded-2xl border-2 border-dashed transition-all duration-300 ${
                isDragOver
                  ? 'border-amber-500/50 bg-amber-500/[0.06] scale-[1.01]'
                  : 'border-overlay-8 bg-overlay-2 hover:border-overlay-15 hover:bg-overlay-4'
              }`}
            >
              <div className="flex flex-col items-center justify-center py-20">
                <motion.div
                  animate={isDragOver ? { scale: 1.1, y: -4 } : { scale: 1, y: 0 }}
                  className="w-20 h-20 rounded-2xl bg-gradient-to-br from-amber-500/15 to-orange-600/10 border border-amber-500/15 flex items-center justify-center mb-5"
                >
                  <Car size={36} className="text-amber-400/70" />
                </motion.div>
                <h3 className="text-lg font-semibold text-surface-200 mb-2">
                  {isDragOver ? 'Drop Vehicle Packs Here' : 'Import Vehicle Packs'}
                </h3>
                <p className="text-sm text-surface-500 text-center max-w-lg mb-6">
                  Drag and drop vehicle pack folders or ZIP files here. The builder will
                  automatically detect vehicle data, generate manifests if needed, and install
                  everything into your server's <code className="text-amber-400/70">[vehicles]</code> folder.
                </p>
                <button
                  onClick={pickVehicles}
                  className="flex items-center gap-2 px-6 py-3 rounded-xl bg-gradient-to-r from-amber-600 to-orange-500 text-surface-100 font-medium hover:from-amber-500 hover:to-orange-400 transition-all shadow-lg shadow-amber-500/20"
                >
                  <Plus size={18} />
                  Select Vehicle Packs
                </button>
              </div>
            </motion.div>

            {/* Info cards */}
            <div className="grid grid-cols-3 gap-4">
              {[
                {
                  icon: Sparkles,
                  title: 'Auto Manifest',
                  desc: 'Generates fxmanifest.lua with correct data_file entries for vehicles.meta, handling.meta, carcols, and more.',
                  color: 'amber',
                },
                {
                  icon: Image,
                  title: 'Stream Detection',
                  desc: 'Automatically detects .yft, .ytd, and .ydr stream files and sets up the stream folder correctly.',
                  color: 'orange',
                },
                {
                  icon: Wrench,
                  title: 'Auto Config',
                  desc: 'Adds ensure lines to server.cfg and installs into the [vehicles] category folder automatically.',
                  color: 'yellow',
                },
              ].map((card) => (
                <div
                  key={card.title}
                  className="rounded-xl bg-overlay-3 border border-overlay-6 p-5"
                >
                  <div
                    className={`w-9 h-9 rounded-lg bg-${card.color}-500/10 flex items-center justify-center mb-3`}
                  >
                    <card.icon size={18} className={`text-${card.color}-400`} />
                  </div>
                  <h4 className="text-sm font-semibold text-surface-200 mb-1">{card.title}</h4>
                  <p className="text-xs text-surface-500 leading-relaxed">{card.desc}</p>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {/* Analyzing indicator */}
            {analyzing && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                className="flex items-center gap-3 px-4 py-3 rounded-xl bg-amber-500/[0.08] border border-amber-500/15"
              >
                <Loader2 size={16} className="text-amber-400 animate-spin" />
                <span className="text-sm text-amber-300">Analyzing vehicle packs...</span>
              </motion.div>
            )}

            {/* Vehicle list */}
            <AnimatePresence>
              {vehicles.map((vehicle, index) => {
                const isImporting = importing.has(vehicle.name);
                const result = results.get(vehicle.name);

                return (
                  <motion.div
                    key={vehicle.name}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, x: -20 }}
                    transition={{ delay: index * 0.03 }}
                    className={`group rounded-xl border transition-all ${
                      result?.success
                        ? 'bg-emerald-500/[0.04] border-emerald-500/20'
                        : result && !result.success
                        ? 'bg-red-500/[0.04] border-red-500/20'
                        : 'bg-overlay-3 border-overlay-6 hover:border-overlay-10'
                    }`}
                  >
                    <div className="flex items-center gap-4 p-4">
                      {/* Icon */}
                      <div
                        className={`w-12 h-12 rounded-xl flex items-center justify-center shrink-0 ${
                          result?.success
                            ? 'bg-emerald-500/15'
                            : result && !result.success
                            ? 'bg-red-500/15'
                            : 'bg-amber-500/10'
                        }`}
                      >
                        {isImporting ? (
                          <Loader2 size={22} className="text-amber-400 animate-spin" />
                        ) : result?.success ? (
                          <CheckCircle2 size={22} className="text-emerald-400" />
                        ) : result && !result.success ? (
                          <XCircle size={22} className="text-red-400" />
                        ) : (
                          <Car size={22} className="text-amber-400" />
                        )}
                      </div>

                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1.5">
                          <h3 className="text-sm font-semibold text-surface-100 truncate">
                            {vehicle.name}
                          </h3>
                          {vehicle.isZip && (
                            <span className="px-2 py-0.5 rounded-md bg-blue-500/10 text-[10px] font-medium text-blue-400 flex items-center gap-1">
                              <FileArchive size={9} /> ZIP
                            </span>
                          )}
                          {vehicle.needsManifest && (
                            <span className="px-2 py-0.5 rounded-md bg-amber-500/15 text-[10px] font-medium text-amber-400 flex items-center gap-1">
                              <Sparkles size={9} /> Will Generate Manifest
                            </span>
                          )}
                          {vehicle.hasManifest && (
                            <span className="px-2 py-0.5 rounded-md bg-emerald-500/10 text-[10px] font-medium text-emerald-400">
                              Has Manifest
                            </span>
                          )}
                          {result?.generatedManifest && (
                            <span className="px-2 py-0.5 rounded-md bg-purple-500/10 text-[10px] font-medium text-purple-400 flex items-center gap-1">
                              <Sparkles size={9} /> Manifest Generated
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-4 text-xs text-surface-500">
                          <span className="flex items-center gap-1">
                            <Car size={11} />
                            {vehicle.vehicleCount} vehicle{vehicle.vehicleCount !== 1 ? 's' : ''}
                          </span>
                          <span className="flex items-center gap-1">
                            <File size={11} />
                            {vehicle.metaFiles.length} meta file{vehicle.metaFiles.length !== 1 ? 's' : ''}
                          </span>
                          <span className="flex items-center gap-1">
                            <Image size={11} />
                            {vehicle.streamFileCount} stream file{vehicle.streamFileCount !== 1 ? 's' : ''}
                          </span>
                          {vehicle.hasStream && (
                            <span className="flex items-center gap-1 text-emerald-500">
                              <Check size={11} />
                              Stream folder
                            </span>
                          )}
                        </div>

                        {result && !result.success && result.error && (
                          <p className="mt-1.5 text-xs text-red-400">{result.error}</p>
                        )}
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          onClick={() => removeFromQueue(vehicle.name)}
                          className="p-2 rounded-lg text-surface-600 hover:text-red-400 hover:bg-red-500/10 transition-all opacity-0 group-hover:opacity-100"
                          title="Remove"
                        >
                          <Trash2 size={14} />
                        </button>

                        {(!result || !result.success) && (
                          <button
                            onClick={() => importVehicle(vehicle)}
                            disabled={isImporting || !activeServer}
                            className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-amber-600/20 border border-amber-500/20 text-amber-400 text-xs font-medium hover:bg-amber-600/30 hover:border-amber-500/30 transition-all disabled:opacity-40"
                          >
                            {isImporting ? (
                              <Loader2 size={13} className="animate-spin" />
                            ) : (
                              <Upload size={13} />
                            )}
                            {isImporting ? 'Importing...' : 'Import'}
                          </button>
                        )}
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </AnimatePresence>

            {/* Add more */}
            <motion.button
              onClick={pickVehicles}
              className="w-full flex items-center justify-center gap-2 py-4 rounded-xl border-2 border-dashed border-overlay-6 text-surface-500 text-sm hover:border-amber-500/20 hover:text-amber-400 hover:bg-amber-500/[0.03] transition-all"
            >
              <Plus size={16} />
              Add More Vehicle Packs
            </motion.button>
          </div>
        )}

        {/* No server warning */}
        {!activeServer && vehicles.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-4 flex items-center gap-3 px-4 py-3 rounded-xl bg-amber-500/[0.08] border border-amber-500/15"
          >
            <AlertCircle size={16} className="text-amber-400 shrink-0" />
            <span className="text-sm text-amber-300">
              Select a server from the sidebar before importing vehicle packs
            </span>
          </motion.div>
        )}
      </div>
    </motion.div>
  );
}
