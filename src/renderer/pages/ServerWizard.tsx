import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Server,
  Database,
  Download,
  FolderOpen,
  Loader2,
  Zap,
  Shield,
  Globe,
  Box,
  Package,
} from 'lucide-react';
import { useAppStore } from '../stores/useAppStore';

// Servers are always built for Windows locally — you test on this machine.
// (Pushing a finished server to a remote Linux box will be its own feature.)
const STEPS = [
  { title: 'Framework', description: 'Choose your server framework' },
  { title: 'Database', description: 'Choose database engine' },
  { title: 'Artifacts', description: 'Select artifact version' },
  { title: 'Details', description: 'Name and install location' },
  { title: 'Build', description: 'Create your server' },
];

const FRAMEWORKS = [
  { id: 'qbcore', name: 'QBCore', description: 'Official QBCore recipe â€” 50+ resources including phone, inventory, jobs, banking, housing, gangs & more', icon: Zap, color: 'from-purple-600 to-purple-800', border: 'border-purple-500/30' },
  { id: 'qbox', name: 'Qbox', description: 'Modern QBCore successor â€” ox_lib, ox_inventory, ox_target, NPWD phone, 60+ resources with overextended stack', icon: Package, color: 'from-emerald-600 to-emerald-800', border: 'border-emerald-500/30' },
  { id: 'esx', name: 'ESX Legacy', description: 'ESX Legacy recipe â€” framework, jobs, inventory, phone, HUD, voice, and all core dependencies', icon: Globe, color: 'from-blue-600 to-blue-800', border: 'border-blue-500/30' },
  { id: 'custom', name: 'Custom', description: 'Default CFX resources + oxmysql only â€” add your own framework and resources', icon: Box, color: 'from-amber-600 to-amber-800', border: 'border-amber-500/30' },
  { id: 'blank', name: 'Blank Server', description: 'Server artifacts only â€” no resources. Full control, set everything up manually', icon: Server, color: 'from-surface-600 to-surface-800', border: 'border-surface-500/30' },
];

export default function ServerWizard() {
  const navigate = useNavigate();
  const { addServer, logAction } = useAppStore();
  const [step, setStep] = useState(0);
  const [building, setBuilding] = useState(false);
  const [buildProgress, setBuildProgress] = useState(0);
  const [buildStep, setBuildStep] = useState('');
  const [buildComplete, setBuildComplete] = useState(false);

  const [config, setConfig] = useState({
    name: '',
    framework: '',
    os: 'windows' as 'windows' | 'linux',
    database: 'mariadb' as 'mariadb' | 'mysql',
    // Default to the LATEST build: CFX's "recommended" channel lags months
    // behind and ships an outdated txAdmin. Latest = current txAdmin.
    artifactVersion: 'experimental',
    licenseKey: '',
    installPath: '',
  });

  const canProceed = () => {
    switch (step) {
      case 0: return !!config.framework;
      case 1: return !!config.database;
      case 2: return !!config.artifactVersion;
      case 3: return !!config.installPath && !!config.name && !!config.licenseKey;
      default: return true;
    }
  };

  const handleNext = () => {
    if (step < STEPS.length - 1) setStep(step + 1);
  };

  const handleBack = () => {
    if (step > 0) setStep(step - 1);
  };

  const handleBuild = async () => {
    setBuilding(true);
    setBuildProgress(0);
    setBuildStep('Preparing build...');

    // Listen for real-time progress from the Electron backend
    let progressCleanup: (() => void) | null = null;
    if (window.electronAPI?.onBuildProgress) {
      progressCleanup = window.electronAPI.onBuildProgress((data: { current: number; total: number; resource: string; message: string }) => {
        const pct = data.total > 0 ? Math.round((data.current / data.total) * 100) : 0;
        setBuildProgress(pct);
        setBuildStep(data.message);
      });
    }

    try {
      let server;
      if (window.electronAPI) {
        setBuildStep('Downloading FiveM server artifacts...');
        setBuildProgress(5);
        server = await window.electronAPI.server.create(config);
      } else {
        // Demo mode â€” simulate artifact download only (txAdmin handles the rest)
        for (let pct = 0; pct <= 100; pct += 10) {
          setBuildStep(`Downloading FiveM server artifacts: ${pct}%`);
          setBuildProgress(pct);
          await new Promise(r => setTimeout(r, 300));
        }

        server = {
          id: Date.now().toString(36) + Math.random().toString(36).substring(2, 8),
          ...config,
          resourceCount: 0,
          status: 'running' as const,
          lastBackup: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }

      addServer(server);
      logAction('Server Created', `${config.name} (${config.framework}) â€” txAdmin launching for framework deployment`, 'success');
      setBuildComplete(true);
      toast.success('Server created successfully!');

      // Auto-open txAdmin in browser so the user doesn't have to go to the dashboard
      if (window.electronAPI?.txAdmin && config.installPath) {
        try {
          await window.electronAPI.txAdmin.open(config.installPath);
        } catch {}
      }
    } catch (error: any) {
      toast.error(`Build failed: ${error.message}`);
      logAction('Build Failed', error.message, 'error');
    } finally {
      setBuilding(false);
      if (progressCleanup) progressCleanup();
    }
  };

  const selectDirectory = async () => {
    if (window.electronAPI) {
      const dir = await window.electronAPI.openDirectory();
      if (dir) setConfig({ ...config, installPath: dir });
    } else {
      const name = config.name || 'my-server';
      setConfig({ ...config, installPath: `C:\\FiveM\\servers\\${name.toLowerCase().replace(/\s+/g, '-')}` });
    }
  };

  if (buildComplete) {
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="max-w-lg mx-auto text-center py-16"
      >
        <motion.div
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ type: 'spring', delay: 0.2 }}
          className="w-20 h-20 rounded-full bg-green-500/20 border-2 border-green-500/50 flex items-center justify-center mx-auto mb-6"
        >
          <Check size={36} className="text-green-400" />
        </motion.div>
        <h2 className="text-2xl font-bold text-surface-100 mb-2">Server Created!</h2>
        <p className="text-surface-400 mb-2">
          {config.name} is ready â€” all resources have been downloaded.
        </p>
        <p className="text-surface-400 mb-4 text-sm">
          txAdmin has opened in your browser. Complete the setup:
        </p>
        <div className="bg-surface-800/60 border border-surface-700/50 rounded-xl p-4 mb-6 text-left max-w-md mx-auto">
          <ol className="list-decimal list-inside space-y-2 text-sm text-surface-300">
            <li>Create your <span className="text-surface-100 font-medium">txAdmin account</span></li>
            <li>Enter your server name</li>
            <li>Select <span className="text-surface-100 font-medium">"Use Existing Server Data"</span></li>
            <li>Point it to: <code className="text-xs bg-surface-900 px-1.5 py-0.5 rounded text-primary-300">{config.installPath}</code></li>
          </ol>
        </div>
        <div className="flex gap-3 justify-center">
          <button onClick={() => navigate('/')} className="btn-primary flex items-center gap-2">
            Go to Dashboard
            <ArrowRight size={16} />
          </button>
          <button
            onClick={() => { setBuildComplete(false); setStep(0); setConfig({ name: '', framework: '', os: 'windows', database: 'mariadb', artifactVersion: 'experimental', licenseKey: '', installPath: '' }); }}
            className="btn-secondary"
          >
            Create Another
          </button>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className="max-w-3xl mx-auto space-y-6"
    >
      <div>
        <h1 className="text-2xl font-bold text-surface-100">Create New Server</h1>
        <p className="text-sm text-surface-400 mt-1">Follow the wizard to set up your FiveM server</p>
      </div>

      {/* Progress */}
      <div className="flex items-center gap-1">
        {STEPS.map((s, i) => (
          <React.Fragment key={i}>
            <div className="flex items-center gap-2">
              <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold border-2 transition-all duration-300 ${
                i < step ? 'bg-primary-600 border-primary-600 text-surface-100' :
                i === step ? 'border-primary-500 text-primary-400' :
                'border-surface-600 text-surface-500'
              }`}>
                {i < step ? <Check size={14} /> : i + 1}
              </div>
              <span className="text-xs font-medium hidden md:inline text-surface-400">{s.title}</span>
            </div>
            {i < STEPS.length - 1 && (
              <div className={`flex-1 h-0.5 mx-1 rounded transition-all duration-300 ${i < step ? 'bg-primary-600' : 'bg-surface-700'}`} />
            )}
          </React.Fragment>
        ))}
      </div>

      {/* Step Content */}
      <div className="glass-panel p-6 min-h-[340px]">
        <AnimatePresence mode="wait">
          <motion.div
            key={step}
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            transition={{ duration: 0.2 }}
          >
            {step === 0 && (
              <div className="space-y-4">
                <h2 className="text-lg font-semibold">Choose Framework</h2>
                <p className="text-sm text-surface-400">Select the base framework for your server</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {FRAMEWORKS.map((fw) => {
                    const Icon = fw.icon;
                    return (
                      <motion.button
                        key={fw.id}
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.98 }}
                        onClick={() => setConfig({ ...config, framework: fw.id })}
                        className={`p-4 rounded-xl border-2 text-left transition-all ${
                          config.framework === fw.id
                            ? `border-primary-500 bg-primary-500/10`
                            : `${fw.border} hover:border-surface-500 bg-surface-800/30`
                        }`}
                      >
                        <div className={`w-10 h-10 rounded-lg bg-gradient-to-br ${fw.color} flex items-center justify-center mb-3`}>
                          <Icon size={18} className="text-surface-100" />
                        </div>
                        <h3 className="font-semibold text-surface-100">{fw.name}</h3>
                        <p className="text-xs text-surface-400 mt-1">{fw.description}</p>
                      </motion.button>
                    );
                  })}
                </div>
              </div>
            )}

            {step === 1 && (
              <div className="space-y-4">
                <h2 className="text-lg font-semibold">Database Engine</h2>
                <p className="text-sm text-surface-400">Choose your database server</p>
                <div className="grid grid-cols-2 gap-4 mt-4">
                  {[
                    { id: 'mariadb', name: 'MariaDB', desc: 'Recommended â€” fast and compatible', tag: 'Recommended' },
                    { id: 'mysql', name: 'MySQL', desc: 'Traditional and widely supported', tag: null },
                  ].map((db) => (
                    <motion.button
                      key={db.id}
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      onClick={() => setConfig({ ...config, database: db.id as any })}
                      className={`p-6 rounded-xl border-2 flex flex-col items-center gap-3 transition-all relative ${
                        config.database === db.id
                          ? 'border-primary-500 bg-primary-500/10'
                          : 'border-surface-700 hover:border-surface-500'
                      }`}
                    >
                      {db.tag && (
                        <span className="absolute top-2 right-2 text-[10px] px-2 py-0.5 bg-green-500/20 text-green-400 rounded-full border border-green-500/30">
                          {db.tag}
                        </span>
                      )}
                      <Database size={36} className={config.database === db.id ? 'text-primary-400' : 'text-surface-400'} />
                      <span className="font-semibold text-surface-100">{db.name}</span>
                      <span className="text-xs text-surface-400 text-center">{db.desc}</span>
                    </motion.button>
                  ))}
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="space-y-4">
                <h2 className="text-lg font-semibold">Artifact Version</h2>
                <p className="text-sm text-surface-400">Select the FiveM server artifact build</p>
                <div className="space-y-3 mt-4">
                  {[
                    { id: 'experimental', name: 'Latest Build (newest txAdmin)', desc: 'Current FXServer build with the up-to-date txAdmin — best for local servers', icon: Zap, color: 'text-green-400' },
                    { id: 'recommended', name: 'Stable (CFX recommended)', desc: 'Older battle-tested build — txAdmin will be several versions behind', icon: Shield, color: 'text-amber-400' },
                    { id: 'custom', name: 'Custom Version', desc: 'Specify a custom artifact build number', icon: Download, color: 'text-blue-400' },
                  ].map((v) => (
                    <motion.button
                      key={v.id}
                      whileHover={{ scale: 1.01 }}
                      onClick={() => setConfig({ ...config, artifactVersion: v.id })}
                      className={`w-full p-4 rounded-xl border-2 text-left flex items-center gap-4 transition-all ${
                        config.artifactVersion === v.id
                          ? 'border-primary-500 bg-primary-500/10'
                          : 'border-surface-700 hover:border-surface-500'
                      }`}
                    >
                      <v.icon size={22} className={v.color} />
                      <div>
                        <span className="font-semibold text-surface-100">{v.name}</span>
                        <p className="text-xs text-surface-400 mt-0.5">{v.desc}</p>
                      </div>
                    </motion.button>
                  ))}
                </div>
              </div>
            )}

            {step === 3 && (
              <div className="space-y-5">
                <h2 className="text-lg font-semibold">Server Details</h2>
                <p className="text-sm text-surface-400">Give your server a name and choose where to install it</p>
                <div className="space-y-4 mt-4">
                  <div>
                    <label className="block text-sm font-medium text-surface-300 mb-1.5">Server Name</label>
                    <input
                      type="text"
                      className="input-field"
                      placeholder="e.g. My RP Server"
                      value={config.name}
                      onChange={(e) => setConfig({ ...config, name: e.target.value })}
                      autoFocus
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-surface-300 mb-1.5">License Key</label>
                    <input
                      type="text"
                      className="input-field font-mono text-sm"
                      placeholder="cfxk_xxxxxxxxxxxxxxxxxxxx"
                      value={config.licenseKey}
                      onChange={(e) => setConfig({ ...config, licenseKey: e.target.value })}
                    />
                    <p className="text-xs text-surface-500 mt-1.5">
                      Get a free key from <span className="text-primary-400 cursor-pointer" onClick={() => window.electronAPI?.openExternal('https://keymaster.fivem.net')}>keymaster.fivem.net</span>
                    </p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-surface-300 mb-1.5">Installation Directory</label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        className="input-field font-mono text-sm"
                        placeholder="Click Browse to select..."
                        value={config.installPath}
                        onChange={(e) => setConfig({ ...config, installPath: e.target.value })}
                      />
                      <button onClick={selectDirectory} className="btn-secondary flex items-center gap-2 whitespace-nowrap">
                        <FolderOpen size={16} />
                        Browse
                      </button>
                    </div>
                    <p className="text-xs text-surface-500 mt-1.5">This is where your server files will be stored</p>
                  </div>
                </div>
              </div>
            )}

            {step === 4 && (
              <div className="space-y-6">
                <h2 className="text-lg font-semibold">Build Summary</h2>
                <div className="space-y-2.5">
                  <SummaryRow label="Server Name" value={config.name || 'Unnamed'} />
                  <SummaryRow label="Framework" value={FRAMEWORKS.find(f => f.id === config.framework)?.name || config.framework} />
                  <SummaryRow label="Database" value={config.database === 'mariadb' ? 'MariaDB' : 'MySQL'} />
                  <SummaryRow label="Artifacts" value={config.artifactVersion === 'experimental' ? 'Latest Build (newest txAdmin)' : config.artifactVersion === 'recommended' ? 'Stable (CFX recommended)' : 'Custom'} />
                  <SummaryRow label="License Key" value={config.licenseKey ? `${config.licenseKey.substring(0, 12)}...` : 'Not set'} mono />
                  <SummaryRow label="Install Path" value={config.installPath || 'Not set'} mono />
                </div>

                {!building && (
                  <div className="p-3 rounded-lg bg-blue-500/10 border border-blue-500/20">
                    <p className="text-xs text-blue-300">
                      <span className="font-semibold">How it works:</span> We'll download FiveM server artifacts
                      {(config.framework === 'qbcore' || config.framework === 'qbox' || config.framework === 'esx')
                        ? <> and all <span className="font-semibold">{config.framework === 'qbcore' ? 'QBCore' : config.framework === 'qbox' ? 'Qbox' : 'ESX Legacy'}</span> resources from the official recipe.</>
                        : <> and set up the server files.</>
                      }
                      {' '}Then txAdmin will open in your browser so you can create an account and select <span className="font-semibold">"Use Existing Server Data"</span> pointing to your install folder.
                    </p>
                  </div>
                )}

                {building && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    className="space-y-3 pt-2"
                  >
                    <div className="flex justify-between text-sm">
                      <span className="text-surface-300">{buildStep}</span>
                      <span className="text-primary-400 font-medium">{Math.round(buildProgress)}%</span>
                    </div>
                    <div className="w-full h-2.5 bg-surface-800 rounded-full overflow-hidden">
                      <motion.div
                        className="h-full bg-gradient-to-r from-primary-600 to-primary-400 rounded-full"
                        initial={{ width: 0 }}
                        animate={{ width: `${buildProgress}%` }}
                        transition={{ duration: 0.4, ease: 'easeOut' }}
                      />
                    </div>
                  </motion.div>
                )}
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Nav Buttons */}
      <div className="flex justify-between">
        <button
          onClick={step === 0 ? () => navigate(-1) : handleBack}
          disabled={building}
          className="btn-secondary flex items-center gap-2 disabled:opacity-50"
        >
          <ArrowLeft size={16} />
          {step === 0 ? 'Cancel' : 'Back'}
        </button>

        {step < STEPS.length - 1 ? (
          <button
            onClick={handleNext}
            disabled={!canProceed()}
            className="btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Next
            <ArrowRight size={16} />
          </button>
        ) : (
          <button
            onClick={handleBuild}
            disabled={building || !canProceed()}
            className="btn-primary flex items-center gap-2 disabled:opacity-50"
          >
            {building ? <Loader2 size={16} className="animate-spin" /> : <Zap size={16} />}
            {building ? 'Building...' : 'Build Server'}
          </button>
        )}
      </div>
    </motion.div>
  );
}

function SummaryRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between items-center py-2.5 border-b border-surface-800/50">
      <span className="text-sm text-surface-400">{label}</span>
      <span className={`text-sm font-medium text-surface-100 ${mono ? 'font-mono text-xs' : ''}`}>{value}</span>
    </div>
  );
}
