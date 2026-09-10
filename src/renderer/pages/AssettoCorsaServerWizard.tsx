import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, FlagTriangleRight, FolderOpen, Loader2, XCircle, AlertTriangle, Plus, Trash2, Info } from 'lucide-react';
import { Panel, SectionHeading, Toggle } from '../components/ui';
import toast from 'react-hot-toast';

export default function AssettoCorsaServerWizard() {
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [installPath, setInstallPath] = useState('');
  const [contentRoot, setContentRoot] = useState('');
  const [detectingRoot, setDetectingRoot] = useState(true);

  const [tracks, setTracks] = useState<AcTrackInfo[]>([]);
  const [cars, setCars] = useState<AcCarInfo[]>([]);
  const [weatherPresets, setWeatherPresets] = useState<string[]>([]);
  const [loadingContent, setLoadingContent] = useState(false);

  const [track, setTrack] = useState('');
  const [trackLayout, setTrackLayout] = useState('');
  const [selectedCars, setSelectedCars] = useState<AcCarEntry[]>([]);

  const [maxClients, setMaxClients] = useState(18);
  const [udpPort, setUdpPort] = useState(9600);
  const [httpPort, setHttpPort] = useState(8081);
  const [password, setPassword] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [registerToLobby, setRegisterToLobby] = useState(true);

  const [practiceEnabled, setPracticeEnabled] = useState(true);
  const [practiceMinutes, setPracticeMinutes] = useState(10);
  const [qualifyEnabled, setQualifyEnabled] = useState(true);
  const [qualifyMinutes, setQualifyMinutes] = useState(10);
  const [raceEnabled, setRaceEnabled] = useState(true);
  const [raceLaps, setRaceLaps] = useState(10);

  const [damageMultiplier, setDamageMultiplier] = useState(100);
  const [fuelRate, setFuelRate] = useState(100);
  const [tyreWearRate, setTyreWearRate] = useState(100);
  const [absAllowed, setAbsAllowed] = useState<0 | 1 | 2>(1);
  const [tcAllowed, setTcAllowed] = useState<0 | 1 | 2>(1);
  const [stabilityAllowed, setStabilityAllowed] = useState(false);
  const [autoclutchAllowed, setAutoclutchAllowed] = useState(true);
  const [tyreBlanketsAllowed, setTyreBlanketsAllowed] = useState(true);

  const [sunAngle, setSunAngle] = useState(48);
  const [weatherGraphics, setWeatherGraphics] = useState('3_clear');

  const [creating, setCreating] = useState(false);

  useEffect(() => {
    (async () => {
      const detected = await window.electronAPI.assettoCorsa.detectContentRoot();
      if (detected) setContentRoot(detected);
      setDetectingRoot(false);
    })();
  }, []);

  useEffect(() => {
    if (!contentRoot) { setTracks([]); setCars([]); setWeatherPresets([]); return; }
    setLoadingContent(true);
    Promise.all([
      window.electronAPI.assettoCorsa.detectTracks(contentRoot),
      window.electronAPI.assettoCorsa.detectCars(contentRoot),
      window.electronAPI.assettoCorsa.detectWeatherPresets(contentRoot),
    ]).then(([t, c, w]) => { setTracks(t.filter((x) => x.valid)); setCars(c.filter((x) => x.valid)); setWeatherPresets(w); if (w.length && !w.includes(weatherGraphics)) setWeatherGraphics(w[0]); })
      .finally(() => setLoadingContent(false));
  }, [contentRoot]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedTrack = tracks.find((t) => t.id === track) || null;

  const browseInstallPath = async () => {
    const dir = await window.electronAPI?.openDirectory();
    if (dir) setInstallPath(dir);
  };
  const browseContentRoot = async () => {
    const dir = await window.electronAPI?.openDirectory();
    if (dir) setContentRoot(dir);
  };

  const addCar = (model: string) => {
    if (selectedCars.some((c) => c.model === model)) return;
    const carInfo = cars.find((c) => c.id === model);
    setSelectedCars((prev) => [...prev, { model, skin: carInfo?.skins[0] || '', ballastKg: 0, restrictor: 0, spectatorMode: false }]);
  };
  const removeCar = (model: string) => setSelectedCars((prev) => prev.filter((c) => c.model !== model));
  const setCarSkin = (model: string, skin: string) => setSelectedCars((prev) => prev.map((c) => (c.model === model ? { ...c, skin } : c)));

  const canCreate = name.trim() && installPath && contentRoot && track && selectedCars.length > 0
    && udpPort > 0 && udpPort < 65536 && httpPort > 0 && httpPort < 65536 && !creating
    && !(selectedTrack && selectedTrack.layouts.length > 0 && !trackLayout);

  const handleCreate = async () => {
    if (!canCreate) return;
    setCreating(true);
    try {
      const result = await window.electronAPI.assettoCorsa.create({
        name: name.trim(), installPath, contentRoot, track, trackLayout: trackLayout || undefined, cars: selectedCars,
        maxClients, udpPort, tcpPort: udpPort, httpPort, password, adminPassword, registerToLobby,
        sessions: {
          practice: { enabled: practiceEnabled, name: 'Practice', timeMinutes: practiceMinutes, laps: 0, waitTimeSeconds: 0 },
          qualify: { enabled: qualifyEnabled, name: 'Qualify', timeMinutes: qualifyMinutes, laps: 0, waitTimeSeconds: 0 },
          race: { enabled: raceEnabled, name: 'Race', timeMinutes: 0, laps: raceLaps, waitTimeSeconds: 60 },
        },
        damageMultiplier, fuelRate, tyreWearRate, absAllowed, tcAllowed, stabilityAllowed, autoclutchAllowed, tyreBlanketsAllowed,
        sunAngle, weatherGraphics,
      });
      if (result.success && result.server) {
        toast.success('Server created');
        navigate(`/assetto-corsa/server/${result.server.id}`);
      } else {
        toast.error(result.error || 'Server creation failed');
      }
    } catch (e: any) {
      toast.error(e?.message || 'Server creation failed');
    } finally {
      setCreating(false);
    }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="p-6 space-y-5 max-w-3xl mx-auto pb-16">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/assetto-corsa')} className="p-2 rounded-lg text-surface-500 hover:text-surface-100 hover:bg-overlay-6 transition-colors"><ArrowLeft size={16} /></button>
        <SectionHeading icon={FlagTriangleRight} iconClass="bg-rose-500/15 border-rose-500/25 text-rose-300" title="Create Assetto Corsa Server" subtitle="Configured from your real installed cars and tracks" />
      </div>

      <Panel>
        <label className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2 block">Server Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} className="input-field" placeholder="My Assetto Corsa Server" />
      </Panel>

      <Panel>
        <label className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2 block">Server Location</label>
        <div className="flex gap-2">
          <div className="flex-1 bg-overlay-3 border border-overlay-6 rounded-xl px-4 py-2.5 text-sm text-surface-300 truncate font-mono">{installPath || 'Choose an empty folder…'}</div>
          <button onClick={browseInstallPath} className="px-4 py-2.5 rounded-xl text-sm font-semibold bg-primary-500/10 text-primary-400 hover:bg-primary-500/20 border border-primary-500/20 transition-all"><FolderOpen size={16} /></button>
        </div>
        <p className="text-[11px] text-surface-600 mt-2">Copy the real Assetto Corsa dedicated server files (acServer.exe/acServer) into this folder — Mercy writes cfg/server_cfg.ini and cfg/entry_list.ini here, but does not download the server binary itself.</p>
      </Panel>

      <Panel>
        <label className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2 block">Content Location</label>
        <div className="flex gap-2">
          <div className="flex-1 bg-overlay-3 border border-overlay-6 rounded-xl px-4 py-2.5 text-sm text-surface-300 truncate font-mono">{detectingRoot ? 'Detecting…' : contentRoot || 'Choose your Assetto Corsa content folder…'}</div>
          <button onClick={browseContentRoot} className="px-4 py-2.5 rounded-xl text-sm font-semibold bg-primary-500/10 text-primary-400 hover:bg-primary-500/20 border border-primary-500/20 transition-all"><FolderOpen size={16} /></button>
        </div>
      </Panel>

      {!contentRoot ? null : loadingContent ? (
        <Panel className="flex items-center justify-center py-8"><Loader2 size={18} className="animate-spin text-primary-400" /></Panel>
      ) : (
        <>
          <Panel>
            <label className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2 block">Track</label>
            {tracks.length === 0 ? (
              <div className="flex items-center gap-2 text-xs text-error"><XCircle size={14} className="shrink-0" /> No valid tracks found in that content folder.</div>
            ) : (
              <>
                <select value={track} onChange={(e) => { setTrack(e.target.value); setTrackLayout(''); }} className="input-field">
                  <option value="">Select a track…</option>
                  {tracks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                {selectedTrack && selectedTrack.layouts.length > 0 && (
                  <select value={trackLayout} onChange={(e) => setTrackLayout(e.target.value)} className="input-field mt-2">
                    <option value="">Select a layout…</option>
                    {selectedTrack.layouts.map((l) => <option key={l.layout} value={l.layout}>{l.name}</option>)}
                  </select>
                )}
              </>
            )}
          </Panel>

          <Panel>
            <label className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2 block">Cars</label>
            {cars.length === 0 ? (
              <div className="flex items-center gap-2 text-xs text-error"><XCircle size={14} className="shrink-0" /> No valid cars found in that content folder.</div>
            ) : (
              <>
                <select value="" onChange={(e) => e.target.value && addCar(e.target.value)} className="input-field">
                  <option value="">Add a car…</option>
                  {cars.filter((c) => !selectedCars.some((s) => s.model === c.id)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                {selectedCars.length > 0 && (
                  <div className="space-y-2 mt-3">
                    {selectedCars.map((entry) => {
                      const info = cars.find((c) => c.id === entry.model);
                      return (
                        <div key={entry.model} className="flex items-center gap-2 p-2.5 rounded-lg bg-overlay-3 border border-overlay-6">
                          <span className="text-sm text-surface-200 flex-1 truncate">{info?.name || entry.model}</span>
                          {info && info.skins.length > 0 && (
                            <select value={entry.skin} onChange={(e) => setCarSkin(entry.model, e.target.value)} className="input-field text-xs py-1.5 w-auto">
                              {info.skins.map((s) => <option key={s} value={s}>{s}</option>)}
                            </select>
                          )}
                          <button onClick={() => removeCar(entry.model)} className="p-1.5 rounded-lg text-surface-500 hover:text-error hover:bg-overlay-6 transition-colors"><Trash2 size={13} /></button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </Panel>
        </>
      )}

      <Panel>
        <label className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-3 block">Server Settings</label>
        <div className="grid grid-cols-2 gap-4">
          <div><label className="text-[11px] text-surface-500 mb-1 block">Max Clients</label><input type="number" min={1} max={128} value={maxClients} onChange={(e) => setMaxClients(parseInt(e.target.value) || 18)} className="input-field" /></div>
          <div><label className="text-[11px] text-surface-500 mb-1 block">UDP/TCP Port</label><input type="number" min={1} max={65535} value={udpPort} onChange={(e) => setUdpPort(parseInt(e.target.value) || 9600)} className="input-field" /></div>
          <div><label className="text-[11px] text-surface-500 mb-1 block">HTTP Port</label><input type="number" min={1} max={65535} value={httpPort} onChange={(e) => setHttpPort(parseInt(e.target.value) || 8081)} className="input-field" /></div>
          <div className="flex items-center justify-between pt-4"><span className="text-xs text-surface-300">Register to Lobby</span><Toggle checked={registerToLobby} onChange={setRegisterToLobby} /></div>
          <div><label className="text-[11px] text-surface-500 mb-1 block">Password (optional)</label><input type="text" value={password} onChange={(e) => setPassword(e.target.value)} className="input-field" /></div>
          <div><label className="text-[11px] text-surface-500 mb-1 block">Admin Password (optional)</label><input type="text" value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} className="input-field" /></div>
        </div>
      </Panel>

      <Panel>
        <label className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-3 block">Sessions</label>
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <Toggle checked={practiceEnabled} onChange={setPracticeEnabled} />
            <span className="text-sm text-surface-200 w-20">Practice</span>
            <input type="number" min={0} value={practiceMinutes} onChange={(e) => setPracticeMinutes(parseInt(e.target.value) || 0)} disabled={!practiceEnabled} className="input-field w-24 disabled:opacity-40" />
            <span className="text-xs text-surface-500">minutes</span>
          </div>
          <div className="flex items-center gap-3">
            <Toggle checked={qualifyEnabled} onChange={setQualifyEnabled} />
            <span className="text-sm text-surface-200 w-20">Qualify</span>
            <input type="number" min={0} value={qualifyMinutes} onChange={(e) => setQualifyMinutes(parseInt(e.target.value) || 0)} disabled={!qualifyEnabled} className="input-field w-24 disabled:opacity-40" />
            <span className="text-xs text-surface-500">minutes</span>
          </div>
          <div className="flex items-center gap-3">
            <Toggle checked={raceEnabled} onChange={setRaceEnabled} />
            <span className="text-sm text-surface-200 w-20">Race</span>
            <input type="number" min={0} value={raceLaps} onChange={(e) => setRaceLaps(parseInt(e.target.value) || 0)} disabled={!raceEnabled} className="input-field w-24 disabled:opacity-40" />
            <span className="text-xs text-surface-500">laps</span>
          </div>
        </div>
      </Panel>

      <Panel>
        <label className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-3 block">Rules & Assists</label>
        <div className="grid grid-cols-3 gap-4 mb-3">
          <div><label className="text-[11px] text-surface-500 mb-1 block">Damage %</label><input type="number" min={0} max={100} value={damageMultiplier} onChange={(e) => setDamageMultiplier(parseInt(e.target.value) || 0)} className="input-field" /></div>
          <div><label className="text-[11px] text-surface-500 mb-1 block">Fuel Rate %</label><input type="number" min={0} value={fuelRate} onChange={(e) => setFuelRate(parseInt(e.target.value) || 0)} className="input-field" /></div>
          <div><label className="text-[11px] text-surface-500 mb-1 block">Tyre Wear %</label><input type="number" min={0} value={tyreWearRate} onChange={(e) => setTyreWearRate(parseInt(e.target.value) || 0)} className="input-field" /></div>
        </div>
        <div className="grid grid-cols-2 gap-4 mb-3">
          <div><label className="text-[11px] text-surface-500 mb-1 block">ABS</label><select value={absAllowed} onChange={(e) => setAbsAllowed(Number(e.target.value) as 0 | 1 | 2)} className="input-field"><option value={0}>Off</option><option value={1}>Factory-fitted only</option><option value={2}>Forced on</option></select></div>
          <div><label className="text-[11px] text-surface-500 mb-1 block">Traction Control</label><select value={tcAllowed} onChange={(e) => setTcAllowed(Number(e.target.value) as 0 | 1 | 2)} className="input-field"><option value={0}>Off</option><option value={1}>Factory-fitted only</option><option value={2}>Forced on</option></select></div>
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between"><span className="text-xs text-surface-300">Stability Control</span><Toggle checked={stabilityAllowed} onChange={setStabilityAllowed} /></div>
          <div className="flex items-center justify-between"><span className="text-xs text-surface-300">Autoclutch</span><Toggle checked={autoclutchAllowed} onChange={setAutoclutchAllowed} /></div>
          <div className="flex items-center justify-between"><span className="text-xs text-surface-300">Tyre Blankets</span><Toggle checked={tyreBlanketsAllowed} onChange={setTyreBlanketsAllowed} /></div>
        </div>
      </Panel>

      <Panel>
        <label className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-3 block">Time of Day & Weather</label>
        <div className="grid grid-cols-2 gap-4">
          <div><label className="text-[11px] text-surface-500 mb-1 block">Sun Angle</label><input type="number" min={0} max={360} value={sunAngle} onChange={(e) => setSunAngle(parseInt(e.target.value) || 0)} className="input-field" /></div>
          <div>
            <label className="text-[11px] text-surface-500 mb-1 block">Weather Preset</label>
            {weatherPresets.length === 0 ? (
              <input type="text" value={weatherGraphics} onChange={(e) => setWeatherGraphics(e.target.value)} className="input-field" placeholder="3_clear" />
            ) : (
              <select value={weatherGraphics} onChange={(e) => setWeatherGraphics(e.target.value)} className="input-field">
                {weatherPresets.map((w) => <option key={w} value={w}>{w}</option>)}
              </select>
            )}
          </div>
        </div>
        <div className="flex items-start gap-2 mt-3 p-3 rounded-xl bg-overlay-4 border border-overlay-8 text-[11px] text-surface-400">
          <Info size={13} className="shrink-0 mt-0.5" />
          Sun Angle and this weather preset are real, static server settings — not a day/night cycle or live weather transitions. Those (and AI traffic) are Content Manager/CSP client-side features the dedicated server has no control over.
        </div>
      </Panel>

      <button onClick={handleCreate} disabled={!canCreate} className="w-full btn-primary py-3 flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed">
        {creating ? <Loader2 size={16} className="animate-spin" /> : <FlagTriangleRight size={16} />} {creating ? 'Creating…' : 'Create Server'}
      </button>
    </motion.div>
  );
}
