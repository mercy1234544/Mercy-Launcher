import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Package, Car, Map as MapIcon, FolderOpen, Upload, Loader2, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { Panel, SectionHeading, EmptyState } from '../components/ui';
import toast from 'react-hot-toast';

type Tab = 'cars' | 'tracks';

export default function AssettoCorsaContent() {
  const navigate = useNavigate();
  const [contentRoot, setContentRoot] = useState('');
  const [loadingRoot, setLoadingRoot] = useState(true);
  const [tab, setTab] = useState<Tab>('cars');
  const [cars, setCars] = useState<AcCarInfo[]>([]);
  const [tracks, setTracks] = useState<AcTrackInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [importingCar, setImportingCar] = useState(false);
  const [importingTrack, setImportingTrack] = useState(false);

  useEffect(() => {
    (async () => {
      const detected = await window.electronAPI.assettoCorsa.detectContentRoot();
      if (detected) setContentRoot(detected);
      setLoadingRoot(false);
    })();
  }, []);

  const loadContent = async () => {
    if (!contentRoot) { setCars([]); setTracks([]); return; }
    setLoading(true);
    try {
      const [c, t] = await Promise.all([window.electronAPI.assettoCorsa.detectCars(contentRoot), window.electronAPI.assettoCorsa.detectTracks(contentRoot)]);
      setCars(c); setTracks(t);
    } catch { toast.error('Could not scan content folder'); } finally { setLoading(false); }
  };
  useEffect(() => { if (!loadingRoot) loadContent(); }, [contentRoot, loadingRoot]); // eslint-disable-line react-hooks/exhaustive-deps

  const browseContentRoot = async () => {
    const dir = await window.electronAPI?.openDirectory();
    if (dir) setContentRoot(dir);
  };

  const importCar = async () => {
    if (!contentRoot) { toast.error('Set a content location first'); return; }
    const zipPath = await window.electronAPI.openFile([{ name: 'Car Package', extensions: ['zip'] }]);
    if (!zipPath) return;
    setImportingCar(true);
    try {
      const result = await window.electronAPI.assettoCorsa.importCarContent(contentRoot, zipPath);
      if (result.success) { toast.success(`Installed car: ${result.carId}`); loadContent(); } else toast.error(result.error || 'Import failed');
    } finally { setImportingCar(false); }
  };

  const importTrack = async () => {
    if (!contentRoot) { toast.error('Set a content location first'); return; }
    const zipPath = await window.electronAPI.openFile([{ name: 'Track Package', extensions: ['zip'] }]);
    if (!zipPath) return;
    setImportingTrack(true);
    try {
      const result = await window.electronAPI.assettoCorsa.importTrackContent(contentRoot, zipPath);
      if (result.success) { toast.success(`Installed track: ${result.trackId}`); loadContent(); } else toast.error(result.error || 'Import failed');
    } finally { setImportingTrack(false); }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="p-6 space-y-5 max-w-5xl mx-auto pb-16">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/assetto-corsa')} className="p-2 rounded-lg text-surface-500 hover:text-surface-100 hover:bg-overlay-6 transition-colors"><ArrowLeft size={16} /></button>
        <SectionHeading icon={Package} iconClass="bg-blue-500/15 border-blue-500/25 text-blue-300" title="Content Library" subtitle="Cars and tracks you already have installed" />
      </div>

      <Panel className="flex items-center gap-3">
        <FolderOpen size={16} className="text-surface-500 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-xs text-surface-500">Content Location</p>
          <p className="text-sm font-mono text-surface-200 truncate mt-0.5">{loadingRoot ? 'Detecting…' : contentRoot || 'Not set'}</p>
        </div>
        <button onClick={browseContentRoot} className="btn-secondary text-xs py-2 px-3 shrink-0">Change</button>
      </Panel>

      {!loadingRoot && !contentRoot ? (
        <Panel>
          <EmptyState icon={AlertTriangle} title="No Assetto Corsa content location set" description="Mercy couldn't find a real Steam installation automatically. Point it at your Assetto Corsa install's content folder (contains cars/ and tracks/) to see and manage your installed content." />
        </Panel>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <div className="flex gap-1 p-1 rounded-xl bg-overlay-4 border border-overlay-8 w-fit">
              <button onClick={() => setTab('cars')} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${tab === 'cars' ? 'bg-primary-600/20 text-primary-300' : 'text-surface-400 hover:text-surface-200'}`}><Car size={13} /> Cars ({cars.length})</button>
              <button onClick={() => setTab('tracks')} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${tab === 'tracks' ? 'bg-primary-600/20 text-primary-300' : 'text-surface-400 hover:text-surface-200'}`}><MapIcon size={13} /> Tracks ({tracks.length})</button>
            </div>
            {tab === 'cars' ? (
              <button onClick={importCar} disabled={importingCar} className="btn-primary text-xs py-2 px-4 flex items-center gap-1.5 disabled:opacity-60">
                {importingCar ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />} Import Car
              </button>
            ) : (
              <button onClick={importTrack} disabled={importingTrack} className="btn-primary text-xs py-2 px-4 flex items-center gap-1.5 disabled:opacity-60">
                {importingTrack ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />} Import Track
              </button>
            )}
          </div>

          {loading ? (
            <Panel className="flex items-center justify-center py-16"><Loader2 size={20} className="animate-spin text-primary-400" /></Panel>
          ) : tab === 'cars' ? (
            cars.length === 0 ? (
              <Panel><EmptyState icon={Car} title="No cars found" description="Install cars through Steam/Content Manager, or import a real car package (.zip with ui/ui_car.json + data.acd or data/)." /></Panel>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                {cars.map((c) => (
                  <Panel key={c.id} padding="sm" className="flex items-center gap-3">
                    <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${c.valid ? 'bg-primary-500/15 text-primary-300' : 'bg-error-bg text-error'}`}>{c.valid ? <CheckCircle2 size={15} /> : <XCircle size={15} />}</div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-surface-100 truncate">{c.name}</p>
                      <p className="text-[11px] text-surface-500 truncate">{c.brand || c.id} · {c.skins.length} skin{c.skins.length === 1 ? '' : 's'}{!c.valid ? ' · incomplete install' : ''}</p>
                    </div>
                  </Panel>
                ))}
              </div>
            )
          ) : tracks.length === 0 ? (
            <Panel><EmptyState icon={MapIcon} title="No tracks found" description="Install tracks through Steam/Content Manager, or import a real track package (.zip with a ui/ui_track.json, directly or per-layout)." /></Panel>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {tracks.map((t) => (
                <Panel key={t.id} padding="sm" className="flex items-center gap-3">
                  <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${t.valid ? 'bg-primary-500/15 text-primary-300' : 'bg-error-bg text-error'}`}>{t.valid ? <CheckCircle2 size={15} /> : <XCircle size={15} />}</div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-surface-100 truncate">{t.name}</p>
                    <p className="text-[11px] text-surface-500 truncate">{t.layouts.length > 0 ? `${t.layouts.length} layout${t.layouts.length === 1 ? '' : 's'}` : 'Single layout'}{!t.valid ? ' · incomplete install' : ''}</p>
                  </div>
                </Panel>
              ))}
            </div>
          )}
        </>
      )}
    </motion.div>
  );
}
