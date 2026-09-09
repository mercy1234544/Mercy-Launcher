import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import toast from 'react-hot-toast';
import {
  Package,
  Search,
  RefreshCw,
  ToggleLeft,
  ToggleRight,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Loader2,
  Filter,
  Info,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FolderOpen,
  Trash2,
  GitBranch,
} from 'lucide-react';
import { useAppStore } from '../stores/useAppStore';

interface Resource {
  name: string;
  path: string;
  version: string | null;
  author: string | null;
  description: string | null;
  dependencies: string[];
  enabled: boolean;
  category: string;
  hasManifest: boolean;
  manifestType: string;
  issues: string[];
}

const DEMO_RESOURCES: Resource[] = [
  { name: 'ox_lib', path: '', version: '3.20.0', author: 'overextended', description: 'Shared function library', dependencies: [], enabled: true, category: '[core]', hasManifest: true, manifestType: 'fxmanifest', issues: [] },
  { name: 'oxmysql', path: '', version: '2.7.6', author: 'overextended', description: 'MySQL wrapper', dependencies: [], enabled: true, category: '[core]', hasManifest: true, manifestType: 'fxmanifest', issues: [] },
  { name: 'es_extended', path: '', version: '1.10.0', author: 'esx-framework', description: 'ESX Legacy framework', dependencies: ['oxmysql'], enabled: true, category: '[framework]', hasManifest: true, manifestType: 'fxmanifest', issues: [] },
  { name: 'pma-voice', path: '', version: '5.0.1', author: 'AvarianKnight', description: 'Voice chat system', dependencies: [], enabled: true, category: '[voice]', hasManifest: true, manifestType: 'fxmanifest', issues: [] },
  { name: 'esx_policejob', path: '', version: '1.4.0', author: 'esx-framework', description: 'Police job', dependencies: ['es_extended'], enabled: true, category: '[police]', hasManifest: true, manifestType: 'fxmanifest', issues: [] },
  { name: 'esx_ambulancejob', path: '', version: '1.3.0', author: 'esx-framework', description: 'EMS job', dependencies: ['es_extended'], enabled: true, category: '[ems]', hasManifest: true, manifestType: 'fxmanifest', issues: [] },
  { name: 'esx_vehicleshop', path: '', version: '1.2.0', author: 'esx-framework', description: 'Vehicle dealer', dependencies: ['es_extended'], enabled: false, category: '[vehicles]', hasManifest: true, manifestType: 'fxmanifest', issues: [] },
  { name: 'esx_mechanicjob', path: '', version: null, author: 'esx-framework', description: 'Mechanic job', dependencies: ['es_extended'], enabled: true, category: '[jobs]', hasManifest: true, manifestType: '__resource', issues: ['Using deprecated __resource.lua'] },
  { name: 'old_resource', path: '', version: null, author: null, description: null, dependencies: [], enabled: false, category: '[custom]', hasManifest: false, manifestType: 'none', issues: ['No manifest file found'] },
  { name: 'ox_inventory', path: '', version: '2.37.0', author: 'overextended', description: 'Inventory system', dependencies: ['ox_lib', 'oxmysql'], enabled: true, category: '[core]', hasManifest: true, manifestType: 'fxmanifest', issues: [] },
  { name: 'ox_target', path: '', version: '1.16.0', author: 'overextended', description: 'Target system', dependencies: ['ox_lib'], enabled: true, category: '[core]', hasManifest: true, manifestType: 'fxmanifest', issues: [] },
  { name: 'esx_basicneeds', path: '', version: '1.1.0', author: 'esx-framework', description: 'Hunger/thirst', dependencies: ['es_extended'], enabled: true, category: '[standalone]', hasManifest: true, manifestType: 'fxmanifest', issues: [] },
];

export default function ResourceManager() {
  const { activeServerId, servers, logAction } = useAppStore();
  const [resources, setResources] = useState<Resource[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [filterCategory, setFilterCategory] = useState('all');
  const [expandedResource, setExpandedResource] = useState<string | null>(null);
  const [marketplaceContent, setMarketplaceContent] = useState<FiveMInstalledContent[]>([]);

  const activeServer = servers.find(s => s.id === activeServerId);

  const refreshMarketplaceContent = () => {
    if (!activeServer) { setMarketplaceContent([]); return; }
    window.electronAPI.fivemMarketplace.listInstalled(activeServer.id).then(setMarketplaceContent).catch(() => setMarketplaceContent([]));
  };

  useEffect(() => {
    if (activeServer) { scanResources(); refreshMarketplaceContent(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeServerId]);

  const marketplaceRecordFor = (resourceName: string) => marketplaceContent.find((c) => c.resourceName === resourceName);

  const removeMarketplaceResource = async (resourceName: string) => {
    if (!activeServer) return;
    const record = marketplaceRecordFor(resourceName);
    if (!record) return;
    const result = await window.electronAPI.fivemMarketplace.removeResource(activeServer.id, record.id);
    if (result.success) {
      toast.success(`${resourceName} removed`);
      logAction('Resource Removed', resourceName, 'info');
      refreshMarketplaceContent();
      scanResources();
    } else {
      toast.error(result.error || 'Failed to remove resource');
    }
  };

  const openMarketplaceResourceFolder = async (resourceName: string) => {
    if (!activeServer) return;
    const record = marketplaceRecordFor(resourceName);
    if (!record) return;
    const ok = await window.electronAPI.fivemMarketplace.openResourceFolder(activeServer.id, record.id);
    if (!ok) toast.error('Could not open this resource\'s folder — it may have been moved.');
  };

  const scanResources = async () => {
    if (!activeServer) return;
    setLoading(true);
    try {
      if (window.electronAPI) {
        const result = await window.electronAPI.resource.scan(activeServer.installPath);
        setResources(result);
      } else {
        await new Promise(r => setTimeout(r, 800));
        setResources(DEMO_RESOURCES);
      }
      logAction('Resources Scanned', `Found ${resources.length || DEMO_RESOURCES.length} resources`, 'info');
    } catch {
      toast.error('Failed to scan resources');
    } finally {
      setLoading(false);
    }
  };

  const toggleResource = async (resource: Resource) => {
    if (window.electronAPI && activeServer) {
      try {
        const record = marketplaceRecordFor(resource.name);
        if (record) {
          // Keep Mercy's own installation record in sync — same real
          // server.cfg ensure-line toggle, just also remembered.
          await window.electronAPI.fivemMarketplace.setResourceEnabled(activeServer.id, record.id, !resource.enabled);
          refreshMarketplaceContent();
        } else {
          await window.electronAPI.resource.toggle(activeServer.installPath, resource.name, !resource.enabled);
        }
      } catch {}
    }
    setResources(resources.map(r =>
      r.name === resource.name ? { ...r, enabled: !r.enabled } : r
    ));
    toast.success(`${resource.name} ${resource.enabled ? 'disabled' : 'enabled'}`);
    logAction(resource.enabled ? 'Resource Disabled' : 'Resource Enabled', resource.name, 'info');
  };

  const categories = ['all', ...new Set(resources.map(r => r.category))].sort();
  const filtered = resources.filter(r => {
    const matchesSearch = r.name.toLowerCase().includes(search.toLowerCase()) ||
      (r.author || '').toLowerCase().includes(search.toLowerCase());
    const matchesCategory = filterCategory === 'all' || r.category === filterCategory;
    return matchesSearch && matchesCategory;
  });

  const enabledCount = resources.filter(r => r.enabled).length;
  const issueCount = resources.filter(r => r.issues.length > 0).length;

  if (!activeServer) {
    return (
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center justify-center h-full">
        <Package size={48} className="text-surface-600 mb-4" />
        <p className="text-surface-400 mb-1">No server selected</p>
        <p className="text-xs text-surface-500">Select a server from the sidebar to manage resources</p>
      </motion.div>
    );
  }

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-surface-100">Resource Manager</h1>
          <p className="text-sm text-surface-400 mt-1">
            {activeServer.name} Â· {filtered.length} resources Â· {enabledCount} enabled
            {issueCount > 0 && <span className="text-amber-400"> Â· {issueCount} with issues</span>}
          </p>
        </div>
        <button onClick={scanResources} disabled={loading} className="btn-secondary flex items-center gap-2">
          {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          Rescan
        </button>
      </div>

      {/* Filters */}
      <div className="flex gap-3">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
          <input type="text" className="input-field pl-9" placeholder="Search resources..." value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <select className="input-field w-44" value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)}>
          {categories.map(cat => (
            <option key={cat} value={cat}>{cat === 'all' ? 'All Categories' : cat}</option>
          ))}
        </select>
      </div>

      {/* Resource List */}
      {loading ? (
        <div className="flex flex-col items-center justify-center py-16">
          <Loader2 size={32} className="animate-spin text-primary-500 mb-3" />
          <p className="text-sm text-surface-400">Scanning resources...</p>
        </div>
      ) : (
        <div className="space-y-1.5">
          <AnimatePresence>
            {filtered.map((resource, i) => (
              <motion.div
                key={resource.name}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.02 }}
              >
                <ResourceRow
                  resource={resource}
                  onToggle={() => toggleResource(resource)}
                  expanded={expandedResource === resource.name}
                  onExpand={() => setExpandedResource(expandedResource === resource.name ? null : resource.name)}
                  marketplaceRecord={marketplaceRecordFor(resource.name)}
                  onRemoveMarketplace={() => removeMarketplaceResource(resource.name)}
                  onOpenFolder={() => openMarketplaceResourceFolder(resource.name)}
                />
              </motion.div>
            ))}
          </AnimatePresence>
          {filtered.length === 0 && (
            <div className="text-center py-12 text-surface-400">
              {search ? 'No resources match your search' : 'No resources found. Run a scan to detect resources.'}
            </div>
          )}
        </div>
      )}
    </motion.div>
  );
}

function ResourceRow({ resource, onToggle, expanded, onExpand, marketplaceRecord, onRemoveMarketplace, onOpenFolder }: {
  resource: Resource; onToggle: () => void; expanded: boolean; onExpand: () => void;
  marketplaceRecord?: FiveMInstalledContent; onRemoveMarketplace: () => void; onOpenFolder: () => void;
}) {
  const hasIssues = resource.issues.length > 0;

  return (
    <div className={`card py-2.5 transition-all ${!resource.enabled ? 'opacity-60' : ''}`}>
      <div className="flex items-center gap-3">
        <button onClick={onToggle} className="shrink-0 transition-transform hover:scale-110">
          {resource.enabled ? (
            <ToggleRight size={26} className="text-green-400" />
          ) : (
            <ToggleLeft size={26} className="text-surface-500" />
          )}
        </button>

        <button onClick={onExpand} className="shrink-0 p-0.5">
          {expanded ? <ChevronDown size={14} className="text-surface-400" /> : <ChevronRight size={14} className="text-surface-500" />}
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-surface-100 text-sm truncate">{resource.name}</span>
            {resource.version && (
              <span className="text-[10px] px-1.5 py-0.5 bg-surface-700 rounded text-surface-400">v{resource.version}</span>
            )}
            <span className="text-[10px] px-1.5 py-0.5 bg-surface-800 rounded text-surface-500">{resource.category}</span>
            {hasIssues && <AlertTriangle size={13} className="text-amber-400 shrink-0" />}
            {marketplaceRecord && (
              <span className="text-[10px] px-1.5 py-0.5 bg-primary-500/15 text-primary-300 border border-primary-500/25 rounded flex items-center gap-1" title={`Installed by Mercy from ${marketplaceRecord.repo}`}>
                <GitBranch size={9} /> Marketplace
              </span>
            )}
          </div>
          {resource.author && (
            <span className="text-xs text-surface-500">{resource.author}</span>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {resource.dependencies.length > 0 && (
            <span className="text-[10px] text-surface-500">{resource.dependencies.length} deps</span>
          )}
          {resource.hasManifest ? (
            <CheckCircle2 size={15} className="text-green-500/70" />
          ) : (
            <XCircle size={15} className="text-red-400/70" />
          )}
        </div>
      </div>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="pt-3 mt-3 border-t border-surface-700/50 space-y-2">
              {resource.description && (
                <p className="text-xs text-surface-300">{resource.description}</p>
              )}
              <div className="flex flex-wrap gap-3 text-xs text-surface-400">
                <span>Manifest: {resource.manifestType}</span>
                {resource.dependencies.length > 0 && (
                  <span>Dependencies: {resource.dependencies.join(', ')}</span>
                )}
              </div>
              {hasIssues && (
                <div className="space-y-1">
                  {resource.issues.map((issue, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs text-amber-300">
                      <AlertTriangle size={11} />
                      {issue}
                    </div>
                  ))}
                </div>
              )}
              {marketplaceRecord && (
                <div className="flex items-center gap-3 pt-2 border-t border-overlay-6">
                  <span className="text-[11px] text-surface-500">Source: {marketplaceRecord.repo}</span>
                  <button onClick={() => window.electronAPI?.openExternal(`https://github.com/${marketplaceRecord.repo}`)} className="text-[11px] text-primary-400 hover:underline flex items-center gap-1"><ExternalLink size={10} /> View source</button>
                  <button onClick={onOpenFolder} className="text-[11px] text-surface-400 hover:text-surface-200 flex items-center gap-1"><FolderOpen size={10} /> Open folder</button>
                  <button onClick={onRemoveMarketplace} className="text-[11px] text-red-400 hover:text-red-300 flex items-center gap-1 ml-auto"><Trash2 size={10} /> Remove</button>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
