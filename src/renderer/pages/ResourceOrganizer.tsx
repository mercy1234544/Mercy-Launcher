import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import toast from 'react-hot-toast';
import {
  FolderTree,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Wand2,
  Info,
  ArrowLeft,
} from 'lucide-react';
import { useAppStore } from '../stores/useAppStore';

interface CategoryGroup {
  name: string;
  resources: string[];
  vendorProtected: string[];
}

export default function ResourceOrganizer() {
  const navigate = useNavigate();
  const { activeServerId, servers } = useAppStore();
  const [categories, setCategories] = useState<CategoryGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [analyzed, setAnalyzed] = useState(false);

  const activeServer = servers.find(s => s.id === activeServerId);

  const analyze = async () => {
    if (!activeServer || !window.electronAPI) return;
    setLoading(true);
    try {
      const resources = await window.electronAPI.resource.scan(activeServer.installPath);
      const categorized = await window.electronAPI.resource.categorize(resources);

      const groups: CategoryGroup[] = Object.entries(categorized).map(([name, items]: [string, any]) => ({
        name,
        resources: items.filter((r: any) => !isVendor(r.name)).map((r: any) => r.name),
        vendorProtected: items.filter((r: any) => isVendor(r.name)).map((r: any) => r.name),
      }));

      setCategories(groups);
      setAnalyzed(true);
    } catch {
      toast.error('Failed to analyze resources');
    } finally {
      setLoading(false);
    }
  };

  if (!activeServer) {
    return (
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center justify-center h-full">
        <FolderTree size={48} className="text-surface-600 mb-4" />
        <p className="text-surface-400">Select a server to organize resources</p>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-6"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate(-1)} className="p-2 rounded-lg text-surface-500 hover:text-surface-100 hover:bg-overlay-6 transition-colors shrink-0"><ArrowLeft size={16} /></button>
          <div>
            <h1 className="text-2xl font-bold text-surface-100">Resource Organizer</h1>
            <p className="text-sm text-surface-400 mt-1">Analyze and categorize your resources</p>
          </div>
        </div>
        <button
          onClick={analyze}
          disabled={loading}
          className="btn-primary flex items-center gap-2"
        >
          {loading ? <Loader2 size={16} className="animate-spin" /> : <Wand2 size={16} />}
          Analyze Resources
        </button>
      </div>

      {/* Vendor Warning */}
      <div className="flex items-start gap-3 p-4 bg-amber-500/10 border border-amber-500/30 rounded-xl">
        <AlertTriangle size={20} className="text-amber-400 shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-medium text-amber-200">Vendor Resources Protected</p>
          <p className="text-xs text-amber-300/70 mt-1">
            Resources from vendors (JG, TStudio, etc.) that require specific folder structures will not be moved.
          </p>
        </div>
      </div>

      {!analyzed && !loading && (
        <div className="card flex flex-col items-center py-12">
          <FolderTree size={48} className="text-surface-600 mb-4" />
          <p className="text-surface-400 mb-2">Click "Analyze Resources" to get started</p>
          <p className="text-xs text-surface-500">This will scan and suggest categories for your resources</p>
        </div>
      )}

      {analyzed && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {categories.map((category) => (
            <div key={category.name} className="card">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-3 h-3 rounded-full bg-primary-500" />
                <h3 className="font-semibold text-surface-100">{category.name}</h3>
                <span className="text-xs text-surface-400 ml-auto">
                  {category.resources.length + category.vendorProtected.length}
                </span>
              </div>

              <div className="space-y-1 max-h-40 overflow-y-auto">
                {category.resources.map(name => (
                  <div key={name} className="flex items-center gap-2 text-sm text-surface-300 py-0.5">
                    <CheckCircle2 size={12} className="text-green-400" />
                    <span className="truncate">{name}</span>
                  </div>
                ))}
                {category.vendorProtected.map(name => (
                  <div key={name} className="flex items-center gap-2 text-sm text-amber-300 py-0.5">
                    <AlertTriangle size={12} className="text-amber-400" />
                    <span className="truncate">{name}</span>
                    <span title="Vendor protected"><Info size={10} className="text-amber-500 shrink-0" /></span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </motion.div>
  );
}

function isVendor(name: string): boolean {
  const vendorPrefixes = ['jg-', 'jg_', 'tstudio-', 'tstudio_', 'ts-', 'ts_'];
  return vendorPrefixes.some(p => name.toLowerCase().startsWith(p));
}
