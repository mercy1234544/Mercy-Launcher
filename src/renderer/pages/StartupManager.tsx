import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import toast from 'react-hot-toast';
import {
  ListOrdered,
  AlertTriangle,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  Trash2,
  Plus,
  Save,
  RefreshCw,
  Loader2,
} from 'lucide-react';
import { useAppStore } from '../stores/useAppStore';

interface StartupEntry {
  resource: string;
  order: number;
  exists: boolean;
  hasDependencyIssue: boolean;
}

export default function StartupManager() {
  const navigate = useNavigate();
  const { activeServerId, servers } = useAppStore();
  const [entries, setEntries] = useState<StartupEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [newResource, setNewResource] = useState('');

  const activeServer = servers.find(s => s.id === activeServerId);

  useEffect(() => {
    if (activeServer) loadStartupOrder();
  }, [activeServerId]);

  const loadStartupOrder = async () => {
    if (!activeServer || !window.electronAPI) return;
    setLoading(true);
    try {
      const content = await window.electronAPI.file.readFile(
        `${activeServer.installPath}\\server.cfg`
      );
      if (content) {
        const lines = content.content.split('\n');
        const ensureEntries: StartupEntry[] = [];
        let order = 0;

        for (const line of lines) {
          const match = line.match(/^\s*(?:ensure|start)\s+(\S+)/);
          if (match) {
            ensureEntries.push({
              resource: match[1],
              order: order++,
              exists: true,
              hasDependencyIssue: false,
            });
          }
        }
        setEntries(ensureEntries);
      }
    } catch {
      toast.error('Failed to load startup order');
    } finally {
      setLoading(false);
    }
  };

  const moveUp = (index: number) => {
    if (index === 0) return;
    const newEntries = [...entries];
    [newEntries[index - 1], newEntries[index]] = [newEntries[index], newEntries[index - 1]];
    setEntries(newEntries.map((e, i) => ({ ...e, order: i })));
  };

  const moveDown = (index: number) => {
    if (index === entries.length - 1) return;
    const newEntries = [...entries];
    [newEntries[index], newEntries[index + 1]] = [newEntries[index + 1], newEntries[index]];
    setEntries(newEntries.map((e, i) => ({ ...e, order: i })));
  };

  const removeEntry = (index: number) => {
    setEntries(entries.filter((_, i) => i !== index));
  };

  const addEntry = () => {
    if (!newResource.trim()) return;
    setEntries([...entries, {
      resource: newResource.trim(),
      order: entries.length,
      exists: true,
      hasDependencyIssue: false,
    }]);
    setNewResource('');
  };

  const saveOrder = async () => {
    if (!activeServer || !window.electronAPI) return;
    try {
      const cfgPath = `${activeServer.installPath}\\server.cfg`;
      const content = await window.electronAPI.file.readFile(cfgPath);
      if (!content) return;

      // Remove existing ensure/start lines and rebuild
      let cfg = content.content.replace(/^\s*(ensure|start)\s+\S+\s*$/gm, '').trim();
      const ensureBlock = entries.map(e => `ensure ${e.resource}`).join('\n');
      cfg += '\n\n# Resources\n' + ensureBlock + '\n';

      await window.electronAPI.file.writeFile(cfgPath, cfg);
      toast.success('Startup order saved');
    } catch {
      toast.error('Failed to save startup order');
    }
  };

  if (!activeServer) {
    return (
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center justify-center h-full">
        <ListOrdered size={48} className="text-surface-600 mb-4" />
        <p className="text-surface-400">Select a server to manage startup order</p>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-4"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate(-1)} className="p-2 rounded-lg text-surface-500 hover:text-surface-100 hover:bg-overlay-6 transition-colors shrink-0"><ArrowLeft size={16} /></button>
          <div>
            <h1 className="text-2xl font-bold text-surface-100">Startup Order</h1>
            <p className="text-sm text-surface-400 mt-1">Manage resource load order in server.cfg</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={loadStartupOrder} className="btn-secondary flex items-center gap-2">
            <RefreshCw size={16} />
            Reload
          </button>
          <button onClick={saveOrder} className="btn-primary flex items-center gap-2">
            <Save size={16} />
            Save Order
          </button>
        </div>
      </div>

      {/* Add Resource */}
      <div className="flex gap-2">
        <input
          type="text"
          className="input-field"
          placeholder="Add resource to startup..."
          value={newResource}
          onChange={(e) => setNewResource(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addEntry()}
        />
        <button onClick={addEntry} className="btn-secondary flex items-center gap-2 whitespace-nowrap">
          <Plus size={16} />
          Add
        </button>
      </div>

      {/* Startup List */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 size={32} className="animate-spin text-primary-500" />
        </div>
      ) : (
        <div className="space-y-1">
          {entries.map((entry, index) => (
            <motion.div
              key={`${entry.resource}-${index}`}
              layout
              className="card flex items-center gap-3 py-2.5"
            >
              <span className="text-xs font-mono text-surface-500 w-6 text-right">{index + 1}</span>

              <div className="flex-1 flex items-center gap-2">
                <span className="text-sm font-medium text-surface-100">{entry.resource}</span>
                {entry.hasDependencyIssue && (
                  <AlertTriangle size={14} className="text-amber-400" />
                )}
              </div>

              <div className="flex items-center gap-1">
                <button
                  onClick={() => moveUp(index)}
                  disabled={index === 0}
                  className="p-1 rounded hover:bg-surface-700 disabled:opacity-30 transition-colors"
                >
                  <ArrowUp size={14} className="text-surface-300" />
                </button>
                <button
                  onClick={() => moveDown(index)}
                  disabled={index === entries.length - 1}
                  className="p-1 rounded hover:bg-surface-700 disabled:opacity-30 transition-colors"
                >
                  <ArrowDown size={14} className="text-surface-300" />
                </button>
                <button
                  onClick={() => removeEntry(index)}
                  className="p-1 rounded hover:bg-red-500/20 transition-colors"
                >
                  <Trash2 size={14} className="text-red-400" />
                </button>
              </div>
            </motion.div>
          ))}

          {entries.length === 0 && (
            <div className="text-center py-12 text-surface-400">
              No resources in startup order
            </div>
          )}
        </div>
      )}
    </motion.div>
  );
}
