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
import AllServers from './pages/AllServers';
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
import MinecraftHub from './pages/MinecraftHub';
import MinecraftServerWizard from './pages/MinecraftServerWizard';
import MinecraftServerPanel from './pages/MinecraftServerPanel';
import MinecraftMarketplace from './pages/MinecraftMarketplace';
import Settings from './pages/Settings';
import AdminPanel from './pages/AdminPanel';
import VehicleStudio from './pages/VehicleStudio';
import { useAuth } from './stores/useAuth';
import { useAppAuth } from './stores/useAppAuth';
import { useTheme } from './stores/useTheme';

export default function App() {
  const [showSplash, setShowSplash] = useState(true);
  const initAuth = useAuth((s) => s.init);
  const initAppAuth = useAppAuth((s) => s.init);
  const initTheme = useTheme((s) => s.init);

  // Restore the account session (no-op until Supabase is configured).
  useEffect(() => { initAuth(); }, [initAuth]);
  // Check backend-authorized app access + start periodic revalidation.
  useEffect(() => { initAppAuth(); }, [initAppAuth]);
  // Apply the user's saved theme (or Mercy Default) before first paint settles.
  useEffect(() => { initTheme(); }, [initTheme]);

  const handleSplashComplete = useCallback(() => {
    setShowSplash(false);
  }, []);

  return (
    <TooltipProvider delayDuration={400} skipDelayDuration={200}>
      <Toaster
        position="bottom-right"
        toastOptions={{
          duration: 4000,
          style: {
            background: 'var(--surface-850)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border-color)',
          },
          success: { iconTheme: { primary: 'var(--success)', secondary: 'var(--surface-850)' } },
          error: { iconTheme: { primary: 'var(--error)', secondary: 'var(--surface-850)' } },
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
              <Route path="/my-servers" element={<AllServers />} />
              <Route path="/mercy-servers/:game" element={<MercyServers />} />
              <Route path="/minecraft" element={<MinecraftHub />} />
              <Route path="/minecraft/create" element={<MinecraftServerWizard />} />
              <Route path="/minecraft/server/:id" element={<MinecraftServerPanel />} />
              <Route path="/minecraft/marketplace" element={<MinecraftMarketplace />} />
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
