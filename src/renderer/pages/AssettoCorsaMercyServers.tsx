import React, { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Globe2, Loader2 } from 'lucide-react';
import { Panel, SectionHeading, EmptyState } from '../components/ui';
import AcSectionNav from '../components/AcSectionNav';
import AcServerRow from '../components/ac/AcServerRow';
import AcCatalogBar from '../components/ac/AcCatalogBar';

// Mercy's Servers for Assetto Corsa: a compact list of the OFFICIAL servers, each with live status and one Join button.
// The list comes from the signed server catalog when one is configured (otherwise the built-in package) and reloads by
// itself when the catalog changes. Technical setup (catalog address, signing keys, diagnostics) lives in Setup & Diagnostics.
export default function AssettoCorsaMercyServers() {
  const navigate = useNavigate();
  const [profiles, setProfiles] = useState<AcMercyServerProfile[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadProfiles = useCallback(async () => {
    try { setProfiles(await window.electronAPI.assettoCorsa.listSrpServers()); setError(null); }
    catch (e: any) { setError(e?.message || 'Could not load the server list.'); }
  }, []);
  useEffect(() => { loadProfiles(); }, [loadProfiles]);
  const onCatalogChanged = useCallback(() => { loadProfiles(); window.dispatchEvent(new Event('mercy:ac-content-changed')); }, [loadProfiles]);

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="p-6 space-y-4 max-w-4xl mx-auto pb-16">
      <button onClick={() => navigate('/')} className="flex items-center gap-1.5 text-xs font-semibold text-surface-500 hover:text-surface-100 transition-colors">
        <ArrowLeft size={13} /> Back to Home
      </button>
      <SectionHeading icon={Globe2} iconClass="bg-rose-500/15 border-rose-500/25 text-rose-300" title="Mercy's Servers" subtitle="Official Assetto Corsa servers — pick one and join" />
      <AcSectionNav />
      <AcCatalogBar refreshOnOpen onCatalogChanged={onCatalogChanged} />

      {error ? <Panel padding="lg"><p className="text-sm text-red-300">{error}</p></Panel>
        : !profiles ? <Panel className="flex items-center justify-center py-12"><Loader2 size={20} className="animate-spin text-primary-400" /></Panel>
        : profiles.length === 0 ? <Panel padding="lg"><EmptyState icon={Globe2} title="No servers listed" description="The server list is empty. The catalog may not be set up yet, or it lists no servers." /></Panel>
        : <div className="space-y-2.5">{profiles.map((p) => <AcServerRow key={p.id} profile={p} />)}</div>}
    </motion.div>
  );
}
