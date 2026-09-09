import { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu } from 'electron';
import path from 'path';
import fs from 'fs';
import extractZip from 'extract-zip';
import { ServerManager } from './services/ServerManager';
import { FiveMMarketplace } from './services/FiveMMarketplace';
import { ResourceScanner } from './services/ResourceScanner';
import { BackupManager } from './services/BackupManager';
import { HealthScanner } from './services/HealthScanner';
import { GitManager } from './services/GitManager';
import { FileManager } from './services/FileManager';
import { ArtifactDownloader } from './services/ArtifactDownloader';
import { DatabaseManager } from './services/DatabaseManager';
import { AccessManager } from './services/AccessManager';
import { VehicleResourceScanner } from './services/VehicleResourceScanner';
import { VehicleStudio } from './services/VehicleStudio';
import { VehicleStudioAuth } from './services/VehicleStudioAuth';
import { SettingsManager } from './services/SettingsManager';
import { MinecraftManager } from './services/MinecraftManager';
import { MinecraftMarketplace } from './services/MinecraftMarketplace';
import { ThemeManager } from './services/ThemeManager';
import axios from 'axios';
import { autoUpdater } from 'electron-updater';

// On some Windows profiles Chromium's GPU shader disk cache fails to
// initialize ("Unable to move the cache: Access is denied" / "Gpu Cache
// Creation failed") and leaves a stuck, unpainted compositor tile on screen —
// a fixed black rectangle that persists across navigation because it's a
// viewport-space GPU tile, not a real DOM element. Must run before the app is
// ready. Disabling the shader disk cache only costs a slightly slower shader
// (re)compile per launch, never visual correctness.
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let serverManager: ServerManager;
let fiveMMarketplace: FiveMMarketplace;
let resourceScanner: ResourceScanner;
let backupManager: BackupManager;
let healthScanner: HealthScanner;
let gitManager: GitManager;
let fileManager: FileManager;
let artifactDownloader: ArtifactDownloader;
let databaseManager: DatabaseManager;
let accessManager: AccessManager;
let vehicleStudio: VehicleStudio;
let vehicleStudioAuth: VehicleStudioAuth;
let settingsManager: SettingsManager;
let minecraftManager: MinecraftManager;
let minecraftMarketplace: MinecraftMarketplace;
let themeManager: ThemeManager;
const vehicleResourceScanner = new VehicleResourceScanner();

// Tray icon only exists while "Minimize to tray" is enabled — off by default,
// so nothing changes for anyone who doesn't opt in via Settings > General.
function createTray() {
  if (tray) return;
  tray = new Tray(path.join(__dirname, '../../src/assets/icon.ico'));
  tray.setToolTip('Mercy Launcher');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Mercy Launcher', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', () => { mainWindow?.show(); mainWindow?.focus(); });
}

function destroyTray() {
  tray?.destroy();
  tray = null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, '../../src/assets/icon.ico'),
  });

  if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  // Allow opening DevTools in the packaged build (F12 / Ctrl+Shift+I) so the
  // per-mesh texture trace logged to the console is accessible for debugging.
  mainWindow.webContents.on('before-input-event', (_evt, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
      mainWindow!.webContents.toggleDevTools();
    }
  });

  // Any window.open / target="_blank" from the renderer (e.g. "Request Access"
  // Discord links) opens in the system browser — never a child Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Minimize-to-tray is opt-in (Settings > General); when off, closing the
  // window behaves exactly as it always has.
  mainWindow.on('close', (event) => {
    if (settingsManager?.get('minimizeToTray') && !isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function initializeServices() {
  const userDataPath = app.getPath('userData');
  serverManager = new ServerManager(userDataPath);
  fiveMMarketplace = new FiveMMarketplace();
  resourceScanner = new ResourceScanner();
  backupManager = new BackupManager(userDataPath);
  healthScanner = new HealthScanner();
  gitManager = new GitManager();
  fileManager = new FileManager();
  artifactDownloader = new ArtifactDownloader();
  databaseManager = new DatabaseManager();
  accessManager = new AccessManager(userDataPath);
  vehicleStudio = new VehicleStudio(userDataPath);
  vehicleStudioAuth = new VehicleStudioAuth(userDataPath);
  settingsManager = new SettingsManager();
  minecraftManager = new MinecraftManager(userDataPath);
  minecraftMarketplace = new MinecraftMarketplace();
  themeManager = new ThemeManager(userDataPath);
  serverManager.setDatabaseManager(databaseManager);
  healthScanner.setDatabaseManager(databaseManager);
}

// ── Main-process auth guard (Phase B) ────────────────────────────────────────
// Protected IPC channels require a backend-validated session before they run,
// so a bypassed/edited renderer still cannot invoke protected functionality.
// Everything else (window controls, the auth channels themselves, system info,
// dialogs, shell, updater) stays public. Authorization is decided by the
// backend via VehicleStudioAuth.ensureAuthorized() — never trusted from the client.
const PROTECTED_IPC_PREFIXES = [
  'server:', 'resource:', 'health:', 'backup:', 'file:', 'import:',
  'artifact:', 'vehicle:', 'vehicleStudio:', 'livery:', 'git:', 'bridge:',
  'minecraft:', 'fivem:',
];
let ipcGuardInstalled = false;
function installIpcAuthGuard() {
  if (ipcGuardInstalled) return;
  ipcGuardInstalled = true;
  const raw = ipcMain.handle.bind(ipcMain);
  (ipcMain as any).handle = (channel: string, listener: (event: any, ...args: any[]) => any) => {
    if (PROTECTED_IPC_PREFIXES.some((p) => channel.startsWith(p))) {
      return raw(channel, async (event: any, ...args: any[]) => {
        const ok = await vehicleStudioAuth.ensureAuthorized();
        if (!ok) throw new Error('AUTH_REQUIRED'); // deny — renderer is already gated for legit use
        return listener(event, ...args);
      });
    }
    return raw(channel, listener);
  };
}

function registerIpcHandlers() {
  installIpcAuthGuard();

  // Window controls
  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:maximize', () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });
  ipcMain.handle('window:close', () => mainWindow?.close());

  // App settings (main-process-backed: tray, auto-update, download location)
  ipcMain.handle('settings:get', (_, key) => settingsManager.get(key));
  ipcMain.handle('settings:getAll', () => settingsManager.getAll());
  ipcMain.handle('settings:set', (_, key, value) => {
    settingsManager.set(key, value);
    if (key === 'minimizeToTray') { if (value) createTray(); else destroyTray(); }
    if (key === 'autoUpdate') { autoUpdater.autoDownload = value; }
    return true;
  });
  ipcMain.handle('settings:getLoginItem', () => app.getLoginItemSettings().openAtLogin);
  ipcMain.handle('settings:setLoginItem', (_, enabled: boolean) => {
    app.setLoginItemSettings({ openAtLogin: enabled });
    return true;
  });

  // Theme & personalization — persisted outside the packaged app directory
  // (see ThemeManager), so it survives every future update/reinstall.
  ipcMain.handle('theme:get', () => themeManager.get());
  ipcMain.handle('theme:setActive', (_, id: string) => { themeManager.setActiveTheme(id); return true; });
  ipcMain.handle('theme:setCustom', (_, tokens: Record<string, string>) => { themeManager.setCustomTokens(tokens); return true; });
  ipcMain.handle('theme:reset', () => { themeManager.resetToDefault(); return true; });
  ipcMain.handle('theme:getAvatar', () => themeManager.getAvatar());
  ipcMain.handle('theme:removeAvatar', () => themeManager.removeAvatar());
  ipcMain.handle('theme:pickAvatar', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
    });
    if (result.canceled || !result.filePaths[0]) return { success: false, error: null };
    return themeManager.setAvatar(result.filePaths[0]);
  });

  // Dialog
  ipcMain.handle('dialog:openDirectory', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory'],
    });
    return result.filePaths[0] || null;
  });

  ipcMain.handle('dialog:openFile', async (_, filters) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile'],
      filters,
    });
    return result.filePaths[0] || null;
  });

  // Shell
  ipcMain.handle('shell:openPath', (_, path) => shell.openPath(path));
  ipcMain.handle('shell:openExternal', (_, url) => shell.openExternal(url));

  // Server Management
  ipcMain.handle('server:getAll', () => serverManager.getAllServers());
  ipcMain.handle('server:get', (_, id) => serverManager.getServer(id));
  ipcMain.handle('server:create', (_, config) => serverManager.createServer(config));
  ipcMain.handle('server:update', (_, id, data) => serverManager.updateServer(id, data));
  ipcMain.handle('server:delete', (_, id) => serverManager.deleteServer(id));
  ipcMain.handle('server:start', async (_, id) => {
    // Best-effort: make sure the local database is up before the server
    // boots (starts an existing service or our portable MariaDB — no
    // downloads here, the Health Scanner / wizard handle installs)
    try {
      await databaseManager.ensureRunning(false);
    } catch {}
    const result = await serverManager.startServer(id);
    return result;
  });
  ipcMain.handle('server:stop', (_, id) => serverManager.stopServer(id));
  // Write a command to the running FXServer console (restart <res>, stop <res>, …)
  ipcMain.handle('server:command', (_, id: string, command: string) => serverManager.sendCommand(id, command));
  // Apply known config fixes shipped with app updates to an existing server
  ipcMain.handle('server:maintenance', (_, id: string) => serverManager.applyMaintenanceFixes(id));

  // FiveM Marketplace — real GitHub-backed resource installs.
  ipcMain.handle('fivem:marketplace:repoDetails', (_, repoUrl: string) => fiveMMarketplace.getRepoDetails(repoUrl));
  ipcMain.handle('fivem:marketplace:install', (event, serverId: string, opts: any) =>
    fiveMMarketplace.installResource(serverManager, serverId, opts, (pct, message) => event.sender.send('fivem:marketplace:installProgress', { pct, message })));
  ipcMain.handle('fivem:marketplace:listInstalled', (_, serverId: string) => fiveMMarketplace.listInstalled(serverManager, serverId));
  ipcMain.handle('fivem:marketplace:removeResource', (_, serverId: string, contentId: string) => fiveMMarketplace.removeResource(serverManager, serverId, contentId));
  ipcMain.handle('fivem:marketplace:setResourceEnabled', (_, serverId: string, contentId: string, enabled: boolean) => fiveMMarketplace.setResourceEnabled(serverManager, serverId, contentId, enabled));
  ipcMain.handle('fivem:marketplace:openResourceFolder', (_, serverId: string, contentId: string) => {
    const folder = fiveMMarketplace.openResourceFolder(serverManager, serverId, contentId);
    if (folder && fs.existsSync(folder)) { shell.showItemInFolder(folder); return true; }
    return false;
  });

  // Minecraft server management — the second real game backend (see
  // MinecraftManager.ts for why this stays its own service instead of a
  // shared abstraction with FiveM's ServerManager).
  ipcMain.handle('minecraft:getAll', () => minecraftManager.getAllServers());
  ipcMain.handle('minecraft:get', (_, id: string) => minecraftManager.getServer(id));
  ipcMain.handle('minecraft:consoleBuffer', (_, id: string) => minecraftManager.getConsoleBuffer(id));
  ipcMain.handle('minecraft:delete', (_, id: string, deleteFiles: boolean, deleteBackups?: boolean) => minecraftManager.deleteServer(id, deleteFiles, !!deleteBackups));
  ipcMain.handle('minecraft:detectJava', () => minecraftManager.detectJava());
  ipcMain.handle('minecraft:detectAllJava', () => minecraftManager.detectAllJavaRuntimes());
  ipcMain.handle('minecraft:javaRequirement', (_, version: string) => minecraftManager.javaRequirementFor(version));
  ipcMain.handle('minecraft:requiredJavaForVersion', (_, serverType: 'vanilla' | 'paper', version: string) => minecraftManager.getRequiredJavaForVersion(serverType, version));
  ipcMain.handle('minecraft:resolveLaunchJava', (_, id: string) => {
    const server = minecraftManager.getServer(id);
    return server ? minecraftManager.resolveLaunchJava(server) : null;
  });
  ipcMain.handle('minecraft:setJavaPath', (_, id: string, javaPath: string | null) => minecraftManager.setServerJavaPath(id, javaPath));
  ipcMain.handle('minecraft:installJava', (event, major: number) =>
    minecraftManager.downloadAndInstallJava(major, (pct, message) => event.sender.send('minecraft:installJavaProgress', { pct, message })));
  ipcMain.handle('minecraft:connectionInfo', (_, id: string) => minecraftManager.getConnectionInfo(id));
  ipcMain.handle('minecraft:fetchVanillaVersions', () => minecraftManager.fetchVanillaVersions());
  ipcMain.handle('minecraft:fetchPaperVersions', () => minecraftManager.fetchPaperVersions());
  ipcMain.handle('minecraft:create', (event, config) =>
    minecraftManager.createServer(config, (pct, message) => event.sender.send('minecraft:createProgress', { pct, message })));
  ipcMain.handle('minecraft:detectExisting', (_, dirPath: string) => minecraftManager.detectExistingServer(dirPath));
  ipcMain.handle('minecraft:import', (_, dirPath: string, name: string, ramMB: number) => minecraftManager.importServer(dirPath, name, ramMB));
  ipcMain.handle('minecraft:start', (_, id: string) => minecraftManager.startServer(id));
  ipcMain.handle('minecraft:stop', (_, id: string, force?: boolean) => minecraftManager.stopServer(id, !!force));
  ipcMain.handle('minecraft:restart', (_, id: string) => minecraftManager.restartServer(id));
  ipcMain.handle('minecraft:setAutoRestart', (_, id: string, enabled: boolean) => minecraftManager.setAutoRestart(id, enabled));
  ipcMain.handle('minecraft:command', (_, id: string, command: string) => minecraftManager.sendCommand(id, command));
  ipcMain.handle('minecraft:processStats', (_, id: string) => minecraftManager.getProcessStats(id));
  ipcMain.handle('minecraft:players', (_, id: string) => minecraftManager.getPlayers(id));
  ipcMain.handle('minecraft:readProperties', (_, id: string) => minecraftManager.readProperties(id));
  ipcMain.handle('minecraft:writeProperties', (_, id: string, changes: Record<string, string>) => minecraftManager.writeProperties(id, changes));
  ipcMain.handle('minecraft:listFiles', (_, id: string, relPath: string) => minecraftManager.listFiles(id, relPath));
  ipcMain.handle('minecraft:readFile', (_, id: string, relPath: string) => minecraftManager.readServerFile(id, relPath));
  ipcMain.handle('minecraft:writeFile', (_, id: string, relPath: string, content: string) => minecraftManager.writeServerFile(id, relPath, content));
  ipcMain.handle('minecraft:createBackup', (_, id: string) => minecraftManager.createBackup(id));
  ipcMain.handle('minecraft:listBackups', (_, id: string) => minecraftManager.listBackups(id));
  ipcMain.handle('minecraft:restoreBackup', (_, backupId: string) => minecraftManager.restoreBackup(backupId));
  ipcMain.handle('minecraft:deleteBackup', (_, backupId: string) => minecraftManager.deleteBackup(backupId));

  // Marketplace (Modrinth) — mod/plugin/datapack browsing and real install.
  ipcMain.handle('minecraft:marketplace:search', (_, opts) => minecraftMarketplace.search(opts));
  ipcMain.handle('minecraft:marketplace:getProject', (_, projectId: string) => minecraftMarketplace.getProject(projectId));
  ipcMain.handle('minecraft:marketplace:getVersions', (_, projectId: string, opts) => minecraftMarketplace.getVersions(projectId, opts));
  ipcMain.handle('minecraft:marketplace:getVersion', (_, versionId: string) => minecraftMarketplace.getVersion(versionId));
  ipcMain.handle('minecraft:marketplace:install', (event, serverId: string, projectId: string, versionId: string) =>
    minecraftMarketplace.installContent(minecraftManager, serverId, projectId, versionId, (pct, message) => event.sender.send('minecraft:marketplace:installProgress', { pct, message })));
  ipcMain.handle('minecraft:marketplace:listInstalled', (_, serverId: string) => minecraftMarketplace.listInstalled(minecraftManager, serverId));
  ipcMain.handle('minecraft:marketplace:removeContent', (_, serverId: string, contentId: string) => minecraftMarketplace.removeContent(minecraftManager, serverId, contentId));
  ipcMain.handle('minecraft:marketplace:setContentEnabled', (_, serverId: string, contentId: string, enabled: boolean) => minecraftMarketplace.setContentEnabled(minecraftManager, serverId, contentId, enabled));

  // Exclusive access — Discord OAuth verification (auto-grant for members)
  ipcMain.handle('access:login', () => accessManager.login());
  ipcMain.handle('access:status', (_, force?: boolean) => accessManager.status(!!force));
  ipcMain.handle('access:logout', () => accessManager.logout());
  ipcMain.handle('server:import', (_, serverPath: string, name?: string) =>
    serverManager.importExistingServer(serverPath, name));
  ipcMain.handle('server:scan', (_, serverPath: string) =>
    serverManager.scanExistingServer(serverPath));

  // txAdmin — detect and open in browser after server starts
  ipcMain.handle('server:openTxAdmin', async (_, serverPath: string) => {
    // Determine the txAdmin web port: explicit setting > endpoint+10000 > default 40120
    let txPort = 40120;
    const cfgPath = path.join(serverPath, 'server.cfg');
    if (fs.existsSync(cfgPath)) {
      const cfg = fs.readFileSync(cfgPath, 'utf-8');
      // Check for explicit txAdmin port setting
      const txPortMatch = cfg.match(/set\s+txAdminPort\s+["']?(\d+)/);
      if (txPortMatch) {
        txPort = parseInt(txPortMatch[1]);
      } else {
        // Derive from game server endpoint: txAdmin = game port + 10000
        const endpointMatch = cfg.match(/endpoint_add_tcp\s+["'][\d.]+:(\d+)/);
        if (endpointMatch) {
          txPort = parseInt(endpointMatch[1]) + 10000;
        }
      }
    }

    const url = `http://localhost:${txPort}`;
    console.log(`[txAdmin] Opening: ${url}`);
    try {
      await shell.openExternal(url);
    } catch (err: any) {
      console.error(`[txAdmin] Failed to open browser:`, err);
    }
    return { url, port: txPort };
  });

  // Resource Update Checker — scan resources for available updates
  ipcMain.handle('resource:checkUpdates', async (_, serverPath: string) => {
    return checkResourceUpdates(serverPath);
  });

  // Resource Update — update a single resource
  ipcMain.handle('resource:update', async (_, resourcePath: string) => {
    return gitManager.pullUpdates(resourcePath);
  });

  // Vehicle Pack Import — analyze and import vehicle addon packs
  ipcMain.handle('vehicle:analyze', async (_, vehiclePath: string) => {
    return analyzeVehiclePack(vehiclePath);
  });

  ipcMain.handle('vehicle:import', async (_, opts: { sourcePath: string; serverPath: string; resourceName: string }) => {
    return importVehiclePack(opts);
  });

  ipcMain.handle('vehicle:pick', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile', 'openDirectory', 'multiSelections'],
      filters: [{ name: 'Vehicle Pack (folder or ZIP)', extensions: ['zip'] }],
    });
    return result.filePaths || [];
  });

  // ── Vehicle Studio (top-level, server-independent) ──────────────────────────
  ipcMain.handle('vehicleStudio:pickFolder', async () => {
    const r = await dialog.showOpenDialog(mainWindow!, {
      title: 'Select a FiveM vehicle resource folder', properties: ['openDirectory'],
    });
    return r.filePaths?.[0] || null;
  });
  ipcMain.handle('vehicleStudio:pickZip', async () => {
    const r = await dialog.showOpenDialog(mainWindow!, {
      title: 'Select a vehicle ZIP', properties: ['openFile'],
      filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
    });
    return r.filePaths?.[0] || null;
  });
  ipcMain.handle('vehicleStudio:scan', async (_, inputPath: string, copy?: boolean) => {
    try { return { ok: true, data: await vehicleStudio.scan(inputPath, !!copy) }; }
    catch (e: any) { return { ok: false, error: e?.message || 'Scan failed' }; }
  });
  ipcMain.handle('vehicleStudio:readHandling', (_, root: string, handlingId: string) => vehicleStudio.readHandling(root, handlingId));
  ipcMain.handle('vehicleStudio:writeHandling', (_, root: string, handlingId: string, changes: any[]) => vehicleStudio.writeHandling(root, handlingId, changes));
  ipcMain.handle('vehicleStudio:undoHandling', (_, root: string, handlingId: string) => vehicleStudio.undoHandling(root, handlingId));
  ipcMain.handle('vehicleStudio:recommend', (_, type: string) => vehicleStudio.recommendPresets(type));
  ipcMain.handle('vehicleStudio:previewTune', (_, root: string, handlingId: string, profileId: string) => vehicleStudio.previewTune(root, handlingId, profileId));
  ipcMain.handle('vehicleStudio:applyTune', (_, root: string, handlingId: string, profileId: string) => vehicleStudio.applyTune(root, handlingId, profileId));
  ipcMain.handle('vehicleStudio:generateManifest', (_, root: string) => vehicleStudio.generateManifest(root));
  ipcMain.handle('vehicleStudio:exportZip', async (_, root: string, resourceName: string) => {
    const r = await dialog.showSaveDialog(mainWindow!, { title: 'Export vehicle as ZIP', defaultPath: `${resourceName}.zip`, filters: [{ name: 'ZIP', extensions: ['zip'] }] });
    if (!r.filePath) return { ok: false, error: 'cancelled' };
    return vehicleStudio.exportZip(root, r.filePath, resourceName);
  });
  ipcMain.handle('vehicleStudio:exportFolder', async (_, root: string, resourceName: string) => {
    const r = await dialog.showOpenDialog(mainWindow!, { title: 'Choose export destination', properties: ['openDirectory'] });
    if (!r.filePaths?.[0]) return { ok: false, error: 'cancelled' };
    return vehicleStudio.exportFolder(root, r.filePaths[0], resourceName);
  });
  ipcMain.handle('vehicleStudio:install', (_, root: string, serverInstallPath: string, resourceName: string, addEnsure: boolean) =>
    vehicleStudio.installToServer(root, serverInstallPath, resourceName, addEnsure));
  ipcMain.handle('vehicleStudio:diagnoseHandling', (_, root: string, handlingId: string) => vehicleStudio.diagnoseHandling(root, handlingId));
  ipcMain.handle('vehicleStudio:listHandling', (_, root: string) => vehicleStudio.listHandlingEntries(root));
  ipcMain.handle('vehicleStudio:createHandling', (_, root: string, handlingId: string) => vehicleStudio.createHandling(root, handlingId));
  ipcMain.handle('vehicleStudio:cloneHandling', (_, root: string, sourceId: string, newId: string) => vehicleStudio.cloneHandling(root, sourceId, newId));
  ipcMain.handle('vehicleStudio:setVehicleHandlingId', (_, root: string, modelName: string, newHandlingId: string) => vehicleStudio.setVehicleHandlingId(root, modelName, newHandlingId));
  ipcMain.handle('vehicleStudio:registerHandling', (_, root: string) => vehicleStudio.registerHandlingInManifest(root));
  ipcMain.handle('vehicleStudio:categoryPresets', (_, category: string) => vehicleStudio.categoryPresets(category));
  ipcMain.handle('vehicleStudio:previewCategoryPreset', (_, root: string, handlingId: string, category: string, presetId: string) => vehicleStudio.previewCategoryPreset(root, handlingId, category, presetId));
  ipcMain.handle('vehicleStudio:applyCategoryPreset', (_, root: string, handlingId: string, category: string, presetId: string) => vehicleStudio.applyCategoryPreset(root, handlingId, category, presetId));
  ipcMain.handle('vehicleStudio:readMeta', (_, root: string, kind: any, key: string) => vehicleStudio.readMeta(root, kind, key));
  ipcMain.handle('vehicleStudio:writeMeta', (_, root: string, kind: any, key: string, changes: any[]) => vehicleStudio.writeMeta(root, kind, key, changes));
  ipcMain.handle('vehicleStudio:undoMeta', (_, root: string, kind: any, key: string) => vehicleStudio.undoMeta(root, kind, key));
  // Tuning upgrade: original-baseline diff/reset, full-handling presets, smart tune.
  ipcMain.handle('vehicleStudio:handlingDiff', (_, root: string, handlingId: string) => vehicleStudio.handlingDiff(root, handlingId));
  ipcMain.handle('vehicleStudio:resetHandlingFields', (_, root: string, handlingId: string, names: string[]) => vehicleStudio.resetHandlingFields(root, handlingId, names));
  ipcMain.handle('vehicleStudio:revertHandling', (_, root: string, handlingId: string) => vehicleStudio.revertHandling(root, handlingId));
  ipcMain.handle('vehicleStudio:handlingPresets', () => vehicleStudio.handlingPresets());
  ipcMain.handle('vehicleStudio:previewHandlingPreset', (_, root: string, handlingId: string, presetId: string) => vehicleStudio.previewHandlingPreset(root, handlingId, presetId));
  ipcMain.handle('vehicleStudio:applyHandlingPreset', (_, root: string, handlingId: string, presetId: string) => vehicleStudio.applyHandlingPreset(root, handlingId, presetId));
  ipcMain.handle('vehicleStudio:smartTunePreview', (_, root: string, handlingId: string, req: any) => vehicleStudio.smartTunePreview(root, handlingId, req));
  ipcMain.handle('vehicleStudio:smartTuneApply', (_, root: string, handlingId: string, req: any) => vehicleStudio.smartTuneApply(root, handlingId, req));
  ipcMain.handle('vehicleStudio:metaDiff', (_, root: string, kind: any, key: string) => vehicleStudio.metaDiff(root, kind, key));
  ipcMain.handle('vehicleStudio:spawnReport', (_, root: string) => vehicleStudio.spawnReport(root));

  // Vehicle Studio access gate — talks to the auth backend (no secrets here).
  ipcMain.handle('vsAuth:status', () => vehicleStudioAuth.status());
  ipcMain.handle('vsAuth:startLogin', () => vehicleStudioAuth.startLogin());
  ipcMain.handle('vsAuth:redeem', (_, code: string) => vehicleStudioAuth.redeem(code));
  ipcMain.handle('vsAuth:logout', () => vehicleStudioAuth.logout());

  // Livery Editor — folder-first vehicle detection + binary file reads
  ipcMain.handle('livery:pickFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Select a FiveM vehicle resource folder',
      properties: ['openDirectory'],
    });
    return result.filePaths?.[0] || null;
  });

  ipcMain.handle('livery:scanFolder', (_, dir: string) => {
    return vehicleResourceScanner.scan(dir);
  });

  ipcMain.handle('livery:readBinary', (_, filePath: string) => {
    return vehicleResourceScanner.readBinaryBase64(filePath);
  });

  ipcMain.handle('livery:writeFile', async (_, filePath: string, b64: string) => {
    const buf = Buffer.from(b64, 'base64');
    fs.writeFileSync(filePath, buf);
    return true;
  });

  // Node.js zlib decompression — used as primary decompress path in the renderer
  // because Chromium's DecompressionStream can silently fail on some payloads.
  // Returns 'ERR:<message>' on failure so the renderer can log the exact reason.
  ipcMain.handle('livery:inflateRaw', async (_, b64: string) => {
    try {
      const zlib = await import('zlib');
      const compressed = Buffer.from(b64, 'base64');
      return await new Promise<string>((resolve) => {
        zlib.inflateRaw(compressed, (err, result) =>
          resolve(err ? `ERR:${err.message}` : result.toString('base64'))
        );
      });
    } catch (e: any) { return `ERR:${e?.message ?? 'unknown exception'}`; }
  });

  ipcMain.handle('livery:inflate', async (_, b64: string) => {
    try {
      const zlib = await import('zlib');
      const compressed = Buffer.from(b64, 'base64');
      return await new Promise<string>((resolve) => {
        zlib.inflate(compressed, (err, result) =>
          resolve(err ? `ERR:${err.message}` : result.toString('base64'))
        );
      });
    } catch (e: any) { return `ERR:${e?.message ?? 'unknown exception'}`; }
  });

  ipcMain.handle('livery:showSaveDialog', async (_, opts: { defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) => {
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: 'Save texture export',
      defaultPath: opts.defaultPath,
      filters: opts.filters || [{ name: 'PNG Image', extensions: ['png'] }],
    });
    return result.filePath || null;
  });

  // Resource Management
  ipcMain.handle('resource:scan', (_, serverPath) => resourceScanner.scanResources(serverPath));
  ipcMain.handle('resource:getInfo', (_, resourcePath) => resourceScanner.getResourceInfo(resourcePath));
  ipcMain.handle('resource:toggle', (_, serverPath, resourceName, enabled) =>
    resourceScanner.toggleResource(serverPath, resourceName, enabled)
  );
  ipcMain.handle('resource:categorize', (_, resources) => resourceScanner.categorizeResources(resources));

  // Health Scanner
  ipcMain.handle('health:scan', (_, serverPath) => {
    // Find the server by path to get its console logs
    const servers = serverManager.getAllServers();
    const server = servers.find((s: any) => s.installPath === serverPath);
    const logs = server ? serverManager.getConsoleLogs(server.id) : [];
    return healthScanner.scanServer(serverPath, logs);
  });
  ipcMain.handle('health:fix', (_, serverPath, issue) => healthScanner.fixIssue(serverPath, issue, serverManager));

  // Backup Management
  ipcMain.handle('backup:create', (_, serverId, options) => backupManager.createBackup(serverId, options));
  ipcMain.handle('backup:restore', (_, backupId) => backupManager.restoreBackup(backupId));
  ipcMain.handle('backup:list', (_, serverId) => backupManager.listBackups(serverId));
  ipcMain.handle('backup:delete', (_, backupId) => backupManager.deleteBackup(backupId));

  // Git Management
  ipcMain.handle('git:clone', (_, url, dest) => gitManager.cloneRepo(url, dest));
  ipcMain.handle('git:pull', (_, repoPath) => gitManager.pullUpdates(repoPath));
  ipcMain.handle('git:getStatus', (_, repoPath) => gitManager.getStatus(repoPath));

  // File Management
  ipcMain.handle('file:readDir', (_, dirPath) => fileManager.readDirectory(dirPath));
  ipcMain.handle('file:readFile', (_, filePath) => fileManager.readFile(filePath));
  ipcMain.handle('file:writeFile', (_, filePath, content) => fileManager.writeFile(filePath, content));
  ipcMain.handle('file:rename', (_, oldPath, newPath) => fileManager.rename(oldPath, newPath));
  ipcMain.handle('file:createDir', (_, dirPath) => fileManager.createDirectory(dirPath));
  ipcMain.handle('file:delete', (_, targetPath) => fileManager.delete(targetPath));
  ipcMain.handle('file:exists', (_, targetPath) => fileManager.exists(targetPath));

  // Artifact Downloads
  ipcMain.handle('artifact:download', (_, version, dest) => {
    artifactDownloader.removeAllListeners('progress');
    artifactDownloader.on('progress', (progress) => {
      mainWindow?.webContents.send('artifact:progress', progress);
    });
    return artifactDownloader.download(version, dest);
  });
  ipcMain.handle('artifact:getVersions', () => artifactDownloader.getAvailableVersions());

  // Check installed artifact build number by reading FXServer.exe version or cache
  ipcMain.handle('artifact:getInstalled', async (_, serverPath: string) => {
    try {
      // Check for a version marker we save during install
      const markerPath = path.join(serverPath, '.artifact-version');
      if (fs.existsSync(markerPath)) {
        return fs.readFileSync(markerPath, 'utf-8').trim();
      }
      // Fallback: check if FXServer.exe exists at all
      if (fs.existsSync(path.join(serverPath, 'FXServer.exe'))) {
        return 'unknown';
      }
      return null;
    } catch {
      return null;
    }
  });

  // Update artifacts for an existing server (re-download and extract over existing)
  ipcMain.handle('artifact:update', async (_, opts: { serverPath: string; version: string }) => {
    try {
      const result = await artifactDownloader.download(opts.version, opts.serverPath);
      if (result.success) {
        // Save version marker for future update checks
        const versions = await artifactDownloader.getAvailableVersions();
        const picked = versions.find(v =>
          v.version === opts.version ||
          (opts.version === 'recommended' && v.recommended) ||
          (opts.version === 'latest' && !v.recommended)
        );
        const buildNum = picked?.version || opts.version;
        fs.writeFileSync(path.join(opts.serverPath, '.artifact-version'), buildNum, 'utf-8');
      }
      return result;
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Resource Import — drag-and-drop folders/ZIPs with smart conflict detection
  // ═══════════════════════════════════════════════════════════════════════════

  // Pick folders/ZIPs to import via system dialog
  ipcMain.handle('import:pickResources', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile', 'openDirectory', 'multiSelections'],
      filters: [
        { name: 'Resource (folder or ZIP)', extensions: ['zip'] },
      ],
    });
    return result.filePaths || [];
  });

  // Analyze a resource path (folder or ZIP) — figure out what it is
  ipcMain.handle('import:analyze', async (_, resourcePath: string) => {
    return analyzeResource(resourcePath);
  });

  // Import a resource into the server — handles copy, conflict replacement, server.cfg update
  ipcMain.handle('import:install', async (_, opts: {
    sourcePath: string;
    serverPath: string;
    targetFolder: string;
    resourceName: string;
    replaceExisting: string[];
  }) => {
    return importResource(opts);
  });

  // ── Bridge API proxy ──────────────────────────────────────────────────────
  // Routes all bridge HTTP calls through the main process so Chromium CORS
  // restrictions in the renderer never block requests to the Linux bridge.
  ipcMain.handle('bridge:request', async (_, opts: {
    host: string;
    apiKey: string;
    method: string;
    path: string;
    body?: any;
  }) => {
    const { host, apiKey, method, path: urlPath, body } = opts;
    const response = await axios({
      method,
      url: `http://${host}${urlPath}`,
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
      data: body,
      timeout: 10000,
    });
    return response.data;
  });

  // Scan server for installed resources (names only, quick)
  ipcMain.handle('import:scanInstalled', async (_, serverPath: string) => {
    const resourcesDir = path.join(serverPath, 'resources');
    if (!fs.existsSync(resourcesDir)) return [];
    const installed: string[] = [];
    const scanDir = (dir: string, depth: number) => {
      if (depth > 5) return; // safety limit
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const sub = path.join(dir, entry.name);
          if (fs.existsSync(path.join(sub, 'fxmanifest.lua')) || fs.existsSync(path.join(sub, '__resource.lua'))) {
            installed.push(entry.name);
          }
          // Always recurse into bracket folders — they can contain sub-brackets or resources
          if (entry.name.startsWith('[')) {
            scanDir(sub, depth + 1);
          }
        }
      } catch {}
    };
    scanDir(resourcesDir, 0);
    return installed;
  });

  // ── System info (Settings page: CPU / RAM / disk / specs) ──────────────────
  ipcMain.handle('system:info', async () => {
    const os = await import('os');
    // CPU usage: sample cpu times twice and diff the busy fraction.
    const snap = () => os.cpus().map((c) => ({
      idle: c.times.idle,
      total: c.times.user + c.times.nice + c.times.sys + c.times.irq + c.times.idle,
    }));
    const a = snap();
    await new Promise((r) => setTimeout(r, 350));
    const b = snap();
    let idle = 0, total = 0;
    for (let i = 0; i < a.length && i < b.length; i++) {
      idle += b[i].idle - a[i].idle;
      total += b[i].total - a[i].total;
    }
    const cpuUsage = total > 0 ? Math.max(0, Math.min(100, (1 - idle / total) * 100)) : 0;

    // Disk usage for the drive the app's userData lives on (usually C:).
    let disk: { total: number; free: number } | null = null;
    try {
      const root = path.parse(app.getPath('userData')).root; // e.g. "C:\\"
      const sf = (fs as any).statfsSync?.(root);
      if (sf) disk = { total: sf.bsize * sf.blocks, free: sf.bsize * sf.bfree };
    } catch {}

    const cpus = os.cpus();
    return {
      cpuModel: cpus[0]?.model?.trim() || 'Unknown CPU',
      cpuCores: cpus.length,
      cpuUsage,
      totalMem: os.totalmem(),
      freeMem: os.freemem(),
      platform: `${os.platform()} ${os.release()}`,
      hostname: os.hostname(),
      disk,
      appVersion: app.getVersion(),
      electron: process.versions.electron,
    };
  });
}

// ─── Resource conflict map ───────────────────────────────────────────────────
// Maps resource "types" to known resource names that serve the same purpose.
// When importing a resource that matches a type, any already-installed resource
// from the same type group gets flagged as a conflict for auto-replacement.
const RESOURCE_TYPE_MAP: Record<string, string[]> = {
  police:      ['qb-policejob', 'esx_policejob', 'wasabi_police', 'okokPoliceJob', 'rcore_police', 'linden_outlawalert', 'ps-mdt'],
  ambulance:   ['qb-ambulancejob', 'esx_ambulancejob', 'wasabi_ambulance', 'okokAmbulanceJob', 'cd_ambulance'],
  mechanic:    ['qb-mechanicjob', 'esx_mechanicjob', 'wasabi_mechanic', 'okokMechanicJob'],
  inventory:   ['ox_inventory', 'qb-inventory', 'qs-inventory', 'lj-inventory', 'core_inventory', 'codem-inventory'],
  phone:       ['qb-phone', 'npwd', 'gcphone', 'lb-phone', 'qs-smartphone', 'roadphone', 'high-phone'],
  hud:         ['qb-hud', 'esx_hud', 'wasabi_hud', 'okokHud', 'cd_hud', 'ox_hud', 'ps-hud'],
  housing:     ['qb-houses', 'esx_property', 'wasabi_housing', 'okokHousing', 'ps-housing', 'bcs_housing'],
  clothing:    ['qb-clothing', 'esx_skin', 'fivem-appearance', 'illenium-appearance', 'wasabi_clothing'],
  multichar:   ['qb-multicharacter', 'esx_multicharacter', 'wasabi_multichar', 'cd_multicharacter'],
  garage:      ['qb-garages', 'esx_garage', 'okokGarage', 'cd_garage', 'wasabi_garage', 'jg-mechanic'],
  vehicleshop: ['qb-vehicleshop', 'esx_vehicleshop', 'wasabi_vehicleshop', 'okokVehicleShop'],
  banking:     ['qb-banking', 'esx_banking', 'wasabi_banking', 'okokBanking', 'qb-atm', 'renewed-banking'],
  target:      ['qb-target', 'ox_target', 'qtarget', 'bt-target'],
  admin:       ['qb-adminmenu', 'AdvancesAdmin', 'txAdmin', 'vMenu', 'EasyAdmin', 'Starter_Admin'],
  weather:     ['qb-weathersync', 'AdvancesWeather', 'cd_easytime', 'vSync', 'wasabi_weather'],
  voice:       ['pma-voice', 'saltychat-fivem', 'mumble-voip', 'tokovoip'],
  racing:      ['cw-racingapp', 'qb-racing', 'cd_racing'],
  gangs:       ['qb-gangs', 'wasabi_gangs', 'okokGangs'],
  prison:      ['qb-prison', 'esx_jail', 'wasabi_prison', 'rcore_prison'],
  dispatch:    ['ps-dispatch', 'cd_dispatch', 'qs-dispatch', 'linden_outlawalert', 'okokDispatch'],
  doorlock:    ['qb-doorlock', 'ox_doorlock', 'nui_doorlock'],
  fuel:        ['LegacyFuel', 'ox_fuel', 'cdn-fuel', 'okokGasStation', 'ps-fuel'],
  mlo:         [], // MLOs don't typically conflict — they stack
};

// Keywords in fxmanifest description/name that hint at the resource type
const TYPE_KEYWORDS: Record<string, string[]> = {
  police:      ['police', 'cop', 'law enforcement', 'leo', 'lspd', 'bcso', 'sheriff', 'mdt'],
  ambulance:   ['ambulance', 'ems', 'medic', 'hospital', 'paramedic'],
  mechanic:    ['mechanic', 'repair', 'garage job', 'bennys', 'tuning'],
  inventory:   ['inventory', 'backpack', 'item system'],
  phone:       ['phone', 'smartphone', 'mobile'],
  hud:         ['hud', 'heads up', 'status bar', 'minimap'],
  housing:     ['housing', 'property', 'apartment', 'real estate', 'house'],
  clothing:    ['clothing', 'appearance', 'wardrobe', 'outfit', 'skin'],
  multichar:   ['multicharacter', 'character select', 'multi char'],
  garage:      ['garage', 'parking', 'vehicle storage'],
  vehicleshop: ['vehicle shop', 'dealership', 'car shop', 'pdm'],
  banking:     ['banking', 'bank', 'atm', 'finance'],
  target:      ['target', 'interaction', 'eye'],
  admin:       ['admin', 'staff menu', 'admin menu', 'moderation'],
  weather:     ['weather', 'dynamic weather', 'time sync', 'environment'],
  voice:       ['voice', 'voip', 'proximity chat', 'radio'],
  racing:      ['racing', 'race', 'street race'],
  gangs:       ['gang', 'faction', 'turf'],
  prison:      ['prison', 'jail'],
  dispatch:    ['dispatch', 'alert system', '911'],
  doorlock:    ['door', 'lock', 'doorlock'],
  fuel:        ['fuel', 'gas station', 'petrol'],
  mlo:         ['mlo', 'interior', 'map edit', 'ymap', 'ytyp'],
};

interface AnalysisResult {
  name: string;
  description: string;
  author: string;
  version: string;
  detectedType: string | null;
  suggestedFolder: string;
  isZip: boolean;
  dependencies: string[];
  conflicts: string[]; // known resource names that serve the same purpose
}

async function analyzeResource(resourcePath: string): Promise<AnalysisResult> {
  const isZip = resourcePath.toLowerCase().endsWith('.zip');
  let manifestContent = '';
  let resourceName = path.basename(resourcePath, '.zip');

  if (isZip) {
    // Extract to temp to read manifest
    const os = await import('os');
    const tempDir = path.join(os.tmpdir(), `fivem-builder-analyze-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    try {
      await extractZip(resourcePath, { dir: tempDir });
      // Find manifest inside — could be in root or in a subfolder
      const manifest = findManifest(tempDir);
      if (manifest) {
        manifestContent = fs.readFileSync(manifest, 'utf-8');
        // Resource name is the folder containing the manifest
        const manifestDir = path.dirname(manifest);
        if (manifestDir !== tempDir) {
          resourceName = path.basename(manifestDir);
        }
      }
    } catch {} finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  } else {
    // It's a folder — look for manifest
    const manifestPath = path.join(resourcePath, 'fxmanifest.lua');
    const legacyPath = path.join(resourcePath, '__resource.lua');
    if (fs.existsSync(manifestPath)) {
      manifestContent = fs.readFileSync(manifestPath, 'utf-8');
    } else if (fs.existsSync(legacyPath)) {
      manifestContent = fs.readFileSync(legacyPath, 'utf-8');
    }
    resourceName = path.basename(resourcePath);
  }

  // Parse manifest
  const nameMatch = manifestContent.match(/name\s+['"](.*?)['"]/);
  const descMatch = manifestContent.match(/description\s+['"](.*?)['"]/);
  const authorMatch = manifestContent.match(/author\s+['"](.*?)['"]/);
  const versionMatch = manifestContent.match(/version\s+['"](.*?)['"]/);
  const depMatches = manifestContent.match(/dependenc(?:y|ies)\s*\{([^}]*)\}/s);

  const parsedName = nameMatch?.[1] || resourceName;
  const description = descMatch?.[1] || '';
  const author = authorMatch?.[1] || 'Unknown';
  const version = versionMatch?.[1] || '1.0.0';

  let dependencies: string[] = [];
  if (depMatches) {
    dependencies = depMatches[1].match(/['"]([^'"]+)['"]/g)?.map(d => d.replace(/['"]/g, '')) || [];
  }

  // Detect type from name + description + dependencies
  const searchText = `${parsedName} ${description} ${resourceName}`.toLowerCase();
  let detectedType: string | null = null;

  // First try exact name match against known resources
  for (const [type, names] of Object.entries(RESOURCE_TYPE_MAP)) {
    if (names.some(n => n.toLowerCase() === resourceName.toLowerCase() || n.toLowerCase() === parsedName.toLowerCase())) {
      detectedType = type;
      break;
    }
  }

  // Then try keyword matching
  if (!detectedType) {
    for (const [type, keywords] of Object.entries(TYPE_KEYWORDS)) {
      if (keywords.some(kw => searchText.includes(kw))) {
        detectedType = type;
        break;
      }
    }
  }

  // Determine target folder
  let suggestedFolder = '[custom]';
  if (detectedType === 'mlo') suggestedFolder = '[mlo]';
  else if (detectedType === 'police' || detectedType === 'ambulance' || detectedType === 'mechanic') suggestedFolder = '[jobs]';
  else if (detectedType === 'inventory') suggestedFolder = '[inventory]';
  else if (detectedType === 'phone') suggestedFolder = '[phone]';
  else if (detectedType === 'hud') suggestedFolder = '[hud]';
  else if (detectedType === 'housing') suggestedFolder = '[housing]';
  else if (detectedType === 'clothing' || detectedType === 'multichar') suggestedFolder = '[character]';
  else if (detectedType === 'garage' || detectedType === 'vehicleshop') suggestedFolder = '[vehiclescripts]';
  else if (detectedType === 'banking') suggestedFolder = '[economy]';
  else if (detectedType === 'admin') suggestedFolder = '[admin]';
  else if (detectedType === 'weather') suggestedFolder = '[environment]';
  else if (detectedType === 'voice') suggestedFolder = '[voice]';
  else if (detectedType === 'target') suggestedFolder = '[core]';
  else if (detectedType === 'gangs') suggestedFolder = '[gangs]';
  else if (detectedType === 'prison') suggestedFolder = '[jobs]';
  else if (detectedType === 'racing') suggestedFolder = '[fun]';
  else if (detectedType === 'dispatch') suggestedFolder = '[jobs]';
  else if (detectedType === 'doorlock') suggestedFolder = '[core]';
  else if (detectedType === 'fuel') suggestedFolder = '[standalone]';

  // Get conflict list
  const conflicts = detectedType ? (RESOURCE_TYPE_MAP[detectedType] || []).filter(
    n => n.toLowerCase() !== resourceName.toLowerCase() && n.toLowerCase() !== parsedName.toLowerCase()
  ) : [];

  return {
    name: resourceName,
    description,
    author,
    version,
    detectedType,
    suggestedFolder,
    isZip,
    dependencies,
    conflicts,
  };
}

function findManifest(dir: string): string | null {
  const fxPath = path.join(dir, 'fxmanifest.lua');
  const legPath = path.join(dir, '__resource.lua');
  if (fs.existsSync(fxPath)) return fxPath;
  if (fs.existsSync(legPath)) return legPath;
  // Check deeper (ZIP might have subfolder(s))
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const sub = path.join(dir, entry.name);
      const found = findManifest(sub);
      if (found) return found;
    }
  }
  return null;
}

// Find ALL resource manifests in a directory (for multi-resource ZIPs/packs)
function findAllManifests(dir: string, depth = 0): { name: string; path: string }[] {
  if (depth > 5) return [];
  const results: { name: string; path: string }[] = [];
  const fxPath = path.join(dir, 'fxmanifest.lua');
  const legPath = path.join(dir, '__resource.lua');
  if (fs.existsSync(fxPath) || fs.existsSync(legPath)) {
    results.push({ name: path.basename(dir), path: dir });
    return results; // Don't recurse further into a resource
  }
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        results.push(...findAllManifests(path.join(dir, entry.name), depth + 1));
      }
    }
  } catch {}
  return results;
}

async function importResource(opts: {
  sourcePath: string;
  serverPath: string;
  targetFolder: string;
  resourceName: string;
  replaceExisting: string[];
}): Promise<{ success: boolean; error?: string; replaced: string[] }> {
  try {
    const resourcesDir = path.join(opts.serverPath, 'resources');
    const targetDir = path.join(resourcesDir, opts.targetFolder);
    const destDir = path.join(targetDir, opts.resourceName);

    // Create target folder
    fs.mkdirSync(targetDir, { recursive: true });

    // Remove conflicting resources
    const replaced: string[] = [];
    for (const conflictName of opts.replaceExisting) {
      // Search for the conflict resource in all subfolders of resources/
      const found = findResourceDir(resourcesDir, conflictName);
      if (found) {
        fs.rmSync(found, { recursive: true, force: true });
        replaced.push(conflictName);
        console.log(`Replaced conflicting resource: ${conflictName} at ${found}`);
      }
    }

    // Copy or extract to destination
    const isZip = opts.sourcePath.toLowerCase().endsWith('.zip');
    if (isZip) {
      const os = await import('os');
      const tempDir = path.join(os.tmpdir(), `fivem-builder-import-${Date.now()}`);
      fs.mkdirSync(tempDir, { recursive: true });
      await extractZip(opts.sourcePath, { dir: tempDir });

      // Check if ZIP contains multiple resources (e.g., MLO pack)
      const allResources = findAllManifests(tempDir);

      if (allResources.length > 1) {
        // Multi-resource pack — import each one into the target folder
        for (const res of allResources) {
          const resDest = path.join(targetDir, res.name);
          if (fs.existsSync(resDest)) fs.rmSync(resDest, { recursive: true, force: true });
          copyDirRecursiveSync(res.path, resDest);
        }
        // resourceName for server.cfg is just the first one; all get ensure lines
        const cfgPath = path.join(opts.serverPath, 'server.cfg');
        if (fs.existsSync(cfgPath)) {
          let cfg = fs.readFileSync(cfgPath, 'utf-8');
          for (const res of allResources) {
            if (!cfg.match(new RegExp(`^\\s*ensure\\s+${res.name}\\s*$`, 'm'))) {
              cfg = cfg.trimEnd() + `\nensure ${res.name}\n`;
            }
          }
          fs.writeFileSync(cfgPath, cfg, 'utf-8');
        }
      } else {
        // Single resource — find it and copy
        const manifest = findManifest(tempDir);
        const sourceDir = manifest ? path.dirname(manifest) : tempDir;
        if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true });
        copyDirRecursiveSync(sourceDir, destDir);
      }

      fs.rmSync(tempDir, { recursive: true, force: true });
    } else {
      // It's a folder — check if it's a pack with multiple resources inside
      const allResources = findAllManifests(opts.sourcePath);

      if (allResources.length > 1) {
        // Multi-resource folder — import each one
        for (const res of allResources) {
          const resDest = path.join(targetDir, res.name);
          if (fs.existsSync(resDest)) fs.rmSync(resDest, { recursive: true, force: true });
          copyDirRecursiveSync(res.path, resDest);
        }
        const cfgPath = path.join(opts.serverPath, 'server.cfg');
        if (fs.existsSync(cfgPath)) {
          let cfg = fs.readFileSync(cfgPath, 'utf-8');
          for (const res of allResources) {
            if (!cfg.match(new RegExp(`^\\s*ensure\\s+${res.name}\\s*$`, 'm'))) {
              cfg = cfg.trimEnd() + `\nensure ${res.name}\n`;
            }
          }
          fs.writeFileSync(cfgPath, cfg, 'utf-8');
        }
      } else {
        // Single resource — copy folder
        if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true });
        copyDirRecursiveSync(opts.sourcePath, destDir);
      }
    }

    // Update server.cfg
    const cfgPath = path.join(opts.serverPath, 'server.cfg');
    if (fs.existsSync(cfgPath)) {
      let cfg = fs.readFileSync(cfgPath, 'utf-8');

      // Remove old ensure lines for replaced resources
      for (const old of replaced) {
        cfg = cfg.replace(new RegExp(`^\\s*ensure\\s+${old}\\s*$`, 'gm'), '');
      }

      // Clean up double blank lines from removals
      cfg = cfg.replace(/\n{3,}/g, '\n\n');

      // Add new ensure if not already present
      if (!cfg.match(new RegExp(`^\\s*ensure\\s+${opts.resourceName}\\s*$`, 'm'))) {
        // Try to add after similar resources or at the end
        cfg = cfg.trimEnd() + `\nensure ${opts.resourceName}\n`;
      }

      fs.writeFileSync(cfgPath, cfg, 'utf-8');
    }

    return { success: true, replaced };
  } catch (error: any) {
    return { success: false, error: error.message, replaced: [] };
  }
}

function findResourceDir(resourcesDir: string, name: string): string | null {
  // Search recursively through ALL category folders (supports deep nesting)
  const search = (dir: string, depth: number): string | null => {
    if (depth > 5) return null; // safety limit
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const sub = path.join(dir, entry.name);
        if (entry.name.toLowerCase() === name.toLowerCase()) return sub;
        // Recurse into bracket category folders
        if (entry.name.startsWith('[')) {
          const found = search(sub, depth + 1);
          if (found) return found;
        }
      }
    } catch {}
    return null;
  };
  return search(resourcesDir, 0);
}

function copyDirRecursiveSync(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursiveSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ─── Resource Update Checker ────────────────────────────────────────────────
async function checkResourceUpdates(serverPath: string): Promise<any[]> {
  const resourcesDir = path.join(serverPath, 'resources');
  if (!fs.existsSync(resourcesDir)) return [];

  const results: any[] = [];

  const scanDir = async (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sub = path.join(dir, entry.name);
      const sourceFile = path.join(sub, '.fivem-builder-source');
      const manifestFile = path.join(sub, 'fxmanifest.lua');

      if (fs.existsSync(sourceFile)) {
        const repoUrl = fs.readFileSync(sourceFile, 'utf-8').trim();
        const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
        let latestCommitDate = '';
        let hasUpdate = false;

        if (match) {
          const [, owner, repo] = match;
          try {
            const resp = await axios.get(
              `https://api.github.com/repos/${owner}/${repo.replace(/\.git$/, '')}/commits?per_page=1`,
              { timeout: 8000, headers: { 'User-Agent': 'FiveM-Server-Builder' } }
            );
            if (resp.data && resp.data[0]) {
              latestCommitDate = resp.data[0].commit.committer.date;
              // Check if resource was installed before this commit
              const stats = fs.statSync(sourceFile);
              hasUpdate = new Date(latestCommitDate) > stats.mtime;
            }
          } catch {}
        }

        // Parse manifest for version
        let version = '';
        if (fs.existsSync(manifestFile)) {
          const content = fs.readFileSync(manifestFile, 'utf-8');
          const vMatch = content.match(/version\s+['"](.*?)['"]/);
          if (vMatch) version = vMatch[1];
        }

        // Get relative folder path
        const relPath = path.relative(resourcesDir, sub);

        results.push({
          name: entry.name,
          path: sub,
          repoUrl,
          version,
          folder: relPath.includes(path.sep) ? relPath.split(path.sep)[0] : '',
          hasUpdate,
          latestCommitDate,
          installedDate: fs.statSync(sourceFile).mtime.toISOString(),
        });
      } else if (entry.name.startsWith('[')) {
        // Category folder — recurse into it
        await scanDir(sub);
      }
    }
  };

  await scanDir(resourcesDir);
  return results;
}

// ─── Vehicle Pack Analyzer ──────────────────────────────────────────────────
async function analyzeVehiclePack(vehiclePath: string): Promise<any> {
  const isZip = vehiclePath.toLowerCase().endsWith('.zip');
  let scanDir = vehiclePath;
  let tempDir = '';

  if (isZip) {
    const osMod = await import('os');
    tempDir = path.join(osMod.tmpdir(), `fivem-vehicle-analyze-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    await extractZip(vehiclePath, { dir: tempDir });
    // Check if extracted to a subfolder
    const entries = fs.readdirSync(tempDir);
    if (entries.length === 1 && fs.statSync(path.join(tempDir, entries[0])).isDirectory()) {
      scanDir = path.join(tempDir, entries[0]);
    } else {
      scanDir = tempDir;
    }
  }

  const resourceName = path.basename(vehiclePath, '.zip');

  // Look for vehicle files
  const hasManifest = fs.existsSync(path.join(scanDir, 'fxmanifest.lua')) || fs.existsSync(path.join(scanDir, '__resource.lua'));
  const hasStream = fs.existsSync(path.join(scanDir, 'stream'));

  // Scan for vehicle meta files
  const metaFiles: string[] = [];
  const streamFiles: string[] = [];

  const scanForFiles = (dir: string, prefix = '') => {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          scanForFiles(path.join(dir, entry.name), rel);
        } else {
          const lower = entry.name.toLowerCase();
          if (lower.endsWith('.meta') || lower === 'vehicles.meta' || lower === 'handling.meta' || lower === 'carcols.meta' || lower === 'carvariations.meta') {
            metaFiles.push(rel);
          }
          if (lower.endsWith('.yft') || lower.endsWith('.ytd') || lower.endsWith('.ydr')) {
            streamFiles.push(rel);
          }
        }
      }
    } catch {}
  };
  scanForFiles(scanDir);

  // Count vehicles by checking vehicles.meta
  let vehicleCount = 0;
  const vehiclesMeta = path.join(scanDir, 'vehicles.meta');
  const streamVehiclesMeta = path.join(scanDir, 'stream', 'vehicles.meta');
  const dataVehiclesMeta = path.join(scanDir, 'data', 'vehicles.meta');
  for (const mpath of [vehiclesMeta, streamVehiclesMeta, dataVehiclesMeta]) {
    if (fs.existsSync(mpath)) {
      const content = fs.readFileSync(mpath, 'utf-8');
      vehicleCount = (content.match(/<modelName>/gi) || []).length;
      break;
    }
  }

  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  return {
    name: resourceName,
    isZip,
    hasManifest,
    hasStream,
    metaFiles,
    streamFileCount: streamFiles.length,
    vehicleCount: vehicleCount || Math.max(1, Math.floor(streamFiles.filter(f => f.endsWith('.yft')).length / 2)),
    needsManifest: !hasManifest && (metaFiles.length > 0 || streamFiles.length > 0),
  };
}

async function importVehiclePack(opts: { sourcePath: string; serverPath: string; resourceName: string }): Promise<{ success: boolean; error?: string; generatedManifest?: boolean }> {
  try {
    const resourcesDir = path.join(opts.serverPath, 'resources');
    const vehiclesDir = path.join(resourcesDir, '[vehicles]');
    fs.mkdirSync(vehiclesDir, { recursive: true });

    const destDir = path.join(vehiclesDir, opts.resourceName);
    const isZip = opts.sourcePath.toLowerCase().endsWith('.zip');

    if (isZip) {
      const osMod = await import('os');
      const tempDir = path.join(osMod.tmpdir(), `fivem-vehicle-import-${Date.now()}`);
      fs.mkdirSync(tempDir, { recursive: true });
      await extractZip(opts.sourcePath, { dir: tempDir });

      const entries = fs.readdirSync(tempDir);
      const sourceDir = (entries.length === 1 && fs.statSync(path.join(tempDir, entries[0])).isDirectory())
        ? path.join(tempDir, entries[0])
        : tempDir;

      if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true });
      copyDirRecursiveSync(sourceDir, destDir);
      fs.rmSync(tempDir, { recursive: true, force: true });
    } else {
      if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true });
      copyDirRecursiveSync(opts.sourcePath, destDir);
    }

    // Generate fxmanifest.lua if missing
    let generatedManifest = false;
    const manifestPath = path.join(destDir, 'fxmanifest.lua');
    const legacyPath = path.join(destDir, '__resource.lua');
    if (!fs.existsSync(manifestPath) && !fs.existsSync(legacyPath)) {
      // Scan for data files to build manifest
      const dataFiles: string[] = [];
      const scanData = (dir: string, prefix = '') => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            if (entry.name.toLowerCase() !== 'stream') scanData(path.join(dir, entry.name), rel);
          } else if (entry.name.toLowerCase().endsWith('.meta')) {
            dataFiles.push(rel);
          }
        }
      };
      scanData(destDir);

      // Build manifest
      let manifest = `fx_version 'cerulean'\ngame 'gta5'\n\nauthor '${opts.resourceName}'\ndescription 'Vehicle Pack — ${opts.resourceName}'\nversion '1.0.0'\n\n`;

      if (dataFiles.length > 0) {
        manifest += `files {\n`;
        for (const f of dataFiles) {
          manifest += `    '${f}',\n`;
        }
        manifest += `}\n\n`;

        for (const f of dataFiles) {
          const fname = path.basename(f).toLowerCase();
          if (fname === 'vehicles.meta') manifest += `data_file 'VEHICLE_METADATA_FILE' '${f}'\n`;
          else if (fname === 'handling.meta') manifest += `data_file 'HANDLING_FILE' '${f}'\n`;
          else if (fname === 'carcols.meta') manifest += `data_file 'CARCOLS_FILE' '${f}'\n`;
          else if (fname === 'carvariations.meta') manifest += `data_file 'VEHICLE_VARIATION_FILE' '${f}'\n`;
          else if (fname === 'vehiclelayouts.meta') manifest += `data_file 'VEHICLE_LAYOUTS_FILE' '${f}'\n`;
          else if (fname === 'dlctext.meta') manifest += `data_file 'DLC_ITYP_REQUEST' '${f}'\n`;
          else if (fname === 'contentunlocks.meta') manifest += `data_file 'CONTENT_UNLOCKING_META_FILE' '${f}'\n`;
        }
      }

      fs.writeFileSync(manifestPath, manifest, 'utf-8');
      generatedManifest = true;
    }

    // Update server.cfg
    const cfgPath = path.join(opts.serverPath, 'server.cfg');
    if (fs.existsSync(cfgPath)) {
      let cfg = fs.readFileSync(cfgPath, 'utf-8');
      if (!cfg.match(new RegExp(`^\\s*ensure\\s+${opts.resourceName}\\s*$`, 'm'))) {
        cfg = cfg.trimEnd() + `\nensure ${opts.resourceName}\n`;
        fs.writeFileSync(cfgPath, cfg, 'utf-8');
      }
    }

    return { success: true, generatedManifest };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

// ─── Auto Updater Setup ─────────────────────────────────────────────────────
function setupAutoUpdater() {
  autoUpdater.autoDownload = settingsManager.get('autoUpdate');
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.logger = require('electron-log');
  (autoUpdater.logger as any).transports.file.level = 'info';

  // Always register event listeners so the splash screen gets status updates
  // even when running in dev mode (check will error but status flows through)
  autoUpdater.on('checking-for-update', () => {
    console.log('[AutoUpdater] Checking for updates...');
    mainWindow?.webContents.send('updater:status', { status: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    console.log(`[AutoUpdater] Update available: v${info.version}`);
    mainWindow?.webContents.send('updater:status', {
      status: 'available',
      version: info.version,
      releaseNotes: info.releaseNotes,
    });
  });

  autoUpdater.on('update-not-available', (info) => {
    console.log(`[AutoUpdater] Already up to date: v${info.version}`);
    mainWindow?.webContents.send('updater:status', { status: 'current' });
  });

  autoUpdater.on('download-progress', (progress) => {
    console.log(`[AutoUpdater] Downloading: ${Math.round(progress.percent)}%`);
    mainWindow?.webContents.send('updater:status', {
      status: 'downloading',
      percent: Math.round(progress.percent),
      transferred: progress.transferred,
      total: progress.total,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[AutoUpdater] Update downloaded: v${info.version} — installing and restarting...`);
    mainWindow?.webContents.send('updater:status', {
      status: 'ready',
      version: info.version,
    });
    // Auto-restart after a short delay to let the renderer show the status
    setTimeout(() => {
      console.log('[AutoUpdater] Quitting and installing...');
      autoUpdater.quitAndInstall(false, true);
    }, 3000);
  });

  autoUpdater.on('error', (err) => {
    console.error('[AutoUpdater] Error:', err.message);
    mainWindow?.webContents.send('updater:status', {
      status: 'error',
      error: err.message,
    });
  });

  // Background re-check every 15 minutes (only on packaged builds)
  if (app.isPackaged) {
    setInterval(() => {
      autoUpdater.checkForUpdates().catch(() => {});
    }, 15 * 60 * 1000);
  }
}

app.whenReady().then(() => {
  initializeServices();
  registerIpcHandlers();
  createWindow();
  if (settingsManager.get('minimizeToTray')) createTray();

  // Apply maintenance fixes shipped with this app version to every registered
  // server — updates land on already-built servers without a reinstall.
  setTimeout(() => {
    try {
      const results = serverManager.applyMaintenanceToAll();
      const total = Object.values(results).reduce((n, f) => n + f.length, 0);
      if (total > 0) console.log(`[Maintenance] Startup pass applied ${total} fix(es) across ${Object.keys(results).length} server(s)`);
    } catch (e) { console.error('[Maintenance] startup pass failed:', e); }
  }, 2000);

  // Auto-update IPC handlers
  ipcMain.handle('updater:check', async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      return result?.updateInfo || null;
    } catch {
      return null;
    }
  });

  ipcMain.handle('updater:download', async () => {
    try {
      await autoUpdater.downloadUpdate();
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('updater:install', () => {
    // Give the IPC response time to reach the renderer before quitting
    setTimeout(() => {
      autoUpdater.quitAndInstall(false, true);
    }, 500);
  });

  ipcMain.handle('updater:getVersion', () => {
    return app.getVersion();
  });

  // Start auto-updater — check immediately on launch, then every 15 min
  setupAutoUpdater();
  if (app.isPackaged) {
    setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 5000);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  try { databaseManager?.shutdown(); } catch {}
});
