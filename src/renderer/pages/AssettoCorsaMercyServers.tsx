import React, { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Globe2, Loader2, ArrowRight, Server } from 'lucide-react';
import { Panel, SectionHeading, EmptyState } from '../components/ui';
import AcSectionNav from '../components/AcSectionNav';
import AcServerCard from '../components/ac/AcServerCard';
import AcCatalogBar from '../components/ac/AcCatalogBar';

// Mercy's Servers for Assetto Corsa — the OFFICIAL servers Mercy runs, for players to join. Deliberately
// separate from "My Servers" (dedicated servers the user hosts themselves). The cards are built from the
// owner's signed server catalog (or the built-in package when none is configured), so each shows exactly what that server needs.
export default function AssettoCorsaMercyServers() {
  const navigate = useNavigate();
  const [profiles, setProfiles] = useState<AcMercyServerProfile[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The list comes from the signed server catalog when one is configured (otherwise the built-in package). It reloads
  // by itself whenever the catalog changes, so a track or car added on the server shows up here without a new launcher.
  const loadProfiles = useCallback(async () => {
    try { setProfiles(await window.electronAPI.assettoCorsa.listSrpServers()); setError(null); }
    catch (e: any) { setError(e?.message || 'Could not load the server list.'); }
  }, []);
  useEffect(() => { loadProfiles(); }, [loadProfiles]);
  const onCatalogChanged = useCallback(() => { loadProfiles(); window.dispatchEvent(new Event('mercy:ac-content-changed')); }, [loadProfiles]);

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="p-6 space-y-5 max-w-5xl mx-auto pb-16">
      <button onClick={() => navigate('/')} className="flex items-center gap-1.5 text-xs font-semibold text-surface-500 hover:text-surface-100 transition-colors">
        <ArrowLeft size={13} /> Back to Home
      </button>
      <SectionHeading icon={Globe2} iconClass="bg-rose-500/15 border-rose-500/25 text-rose-300" title="Mercy's Servers" subtitle="Official Assetto Corsa servers run by Mercy — check your install, get what's missing, then join" />
      <AcSectionNav />
      <AcCatalogBar refreshOnOpen onCatalogChanged={onCatalogChanged} />

      <Panel padding="sm" className="flex items-center gap-3 text-xs text-surface-400">
        <Globe2 size={15} className="text-primary-300 shrink-0" />
        <p className="flex-1"><span className="font-semibold text-surface-200">These are Mercy's own servers.</span> You join them; you can't change them. To run a server of your own, use <span className="font-semibold text-surface-200">My Servers</span>.</p>
        <button onClick={() => navigate('/assetto-corsa')} className="text-primary-300 hover:text-primary-200 font-semibold flex items-center gap-1 shrink-0"><Server size={12} /> My Servers <ArrowRight size={12} /></button>
      </Panel>

      {error ? <Panel padding="lg"><p className="text-sm text-red-300">{error}</p></Panel>
        : !profiles ? <Panel className="flex items-center justify-center py-12"><Loader2 size={20} className="animate-spin text-primary-400" /></Panel>
        : profiles.length === 0 ? <Panel padding="lg"><EmptyState icon={Globe2} title="No official servers listed" description="No server profiles are available. The catalog may not be configured yet, or it lists no servers." /></Panel>
        : <div className="space-y-5">{profiles.map((p) => <AcServerCard key={p.id} profile={p} onOpenSetup={() => navigate('/assetto-corsa/setup')} />)}</div>}
    </motion.div>
  );
}
