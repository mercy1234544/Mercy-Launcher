import React, { useState, useCallback, useEffect } from 'react';
import { Routes, Route } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { AnimatePresence } from 'framer-motion';
import { TooltipProvider } from './components/ui/Tooltip';
import Layout from './components/Layout';
import SplashScreen from './components/SplashScreen';
import Home from './pages/Home';
import FiveMHub from './pages/FiveMHub';
import BrowseServers from './pages/BrowseServers';
import MercyServers from './pages/MercyServers';
import ComingSoon from './pages/ComingSoon';
import Library from './pages/Library';
import Downloads from './pages/Downloads';
import ServerWizard from './pages/ServerWizard';
import ResourceManager from './pages/ResourceManager';
import ResourceOrganizer from './pages/ResourceOrganizer';
import StartupManager from './pages/StartupManager';
import HealthScanner from './pages/HealthScanner';
import BackupManager from './pages/BackupManager';
import FileExplorer from './pages/FileExplorer';
import ServerCfgEditor from './pages/ServerCfgEditor';
import Marketplace from './pages/Marketplace';
import ImportResources from './pages/ImportResources';
import ResourceUpdater from './pages/ResourceUpdater';
import VehiclePackManager from './pages/VehiclePackManager';
import ServerConsole from './pages/ServerConsole';
import ServerPanel from './pages/ServerPanel';
import LiveryEditor from './pages/LiveryEditor';
import Settings from './pages/Settings';
import AdminPanel from './pages/AdminPanel';
import VehicleStudio from './pages/VehicleStudio';
import { useAuth } from './stores/useAuth';
import { useAppAuth } from './stores/useAppAuth';

export default function App() {
  const [showSplash, setShowSplash] = useState(true);
  const initAuth = useAuth((s) => s.init);
  const initAppAuth = useAppAuth((s) => s.init);

  // Restore the account session (no-op until Supabase is configured).
  useEffect(() => { initAuth(); }, [initAuth]);
  // Check backend-authorized app access + start periodic revalidation.
  useEffect(() => { initAppAuth(); }, [initAppAuth]);

  const handleSplashComplete = useCallback(() => {
    setShowSplash(false);
  }, []);

  return (
    <TooltipProvider delayDuration={400} skipDelayDuration={200}>
      <Toaster
        position="bottom-right"
        toastOptions={{
          className: 'bg-surface-800 text-surface-100 border border-surface-700',
          duration: 4000,
          style: {
            background: '#1e293b',
            color: '#f1f5f9',
            border: '1px solid #334155',
          },
        }}
      />
      <AnimatePresence>
        {showSplash && <SplashScreen onComplete={handleSplashComplete} />}
      </AnimatePresence>
      {!showSplash && (
        <Layout>
          <AnimatePresence mode="wait">
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/fivem" element={<FiveMHub />} />
              <Route path="/browse-servers" element={<BrowseServers />} />
              <Route path="/mercy-servers/:game" element={<MercyServers />} />
              <Route path="/minecraft" element={<ComingSoon />} />
              <Route path="/assetto-corsa" element={<ComingSoon />} />
              <Route path="/beamng" element={<ComingSoon />} />
              <Route path="/library" element={<Library />} />
              <Route path="/downloads" element={<Downloads />} />
              <Route path="/servers" element={<ServerPanel />} />
              <Route path="/server/:id" element={<ServerPanel />} />
              <Route path="/create" element={<ServerWizard />} />
              <Route path="/resources" element={<ResourceManager />} />
              <Route path="/organizer" element={<ResourceOrganizer />} />
              <Route path="/startup" element={<StartupManager />} />
              <Route path="/health" element={<HealthScanner />} />
              <Route path="/backups" element={<BackupManager />} />
              <Route path="/files" element={<FileExplorer />} />
              <Route path="/editor" element={<ServerCfgEditor />} />
              <Route path="/marketplace" element={<Marketplace />} />
              <Route path="/import" element={<ImportResources />} />
              <Route path="/updater" element={<ResourceUpdater />} />
              <Route path="/vehicles" element={<VehiclePackManager />} />
              <Route path="/console" element={<ServerConsole />} />
              <Route path="/livery" element={<LiveryEditor />} />
              <Route path="/vehicle-studio" element={<VehicleStudio />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/admin" element={<AdminPanel />} />
            </Routes>
          </AnimatePresence>
        </Layout>
      )}
    </TooltipProvider>
  );
}
