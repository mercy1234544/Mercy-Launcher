import { contextBridge, ipcRenderer } from 'electron';

const electronAPI = {
  // Window
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  close: () => ipcRenderer.invoke('window:close'),

  // App settings (main-process-backed: tray, auto-update, download location)
  settings: {
    get: (key: string) => ipcRenderer.invoke('settings:get', key),
    getAll: () => ipcRenderer.invoke('settings:getAll'),
    set: (key: string, value: any) => ipcRenderer.invoke('settings:set', key, value),
    getLoginItem: () => ipcRenderer.invoke('settings:getLoginItem'),
    setLoginItem: (enabled: boolean) => ipcRenderer.invoke('settings:setLoginItem', enabled),
  },

  // Theme & personalization
  theme: {
    get: () => ipcRenderer.invoke('theme:get'),
    setActive: (id: string) => ipcRenderer.invoke('theme:setActive', id),
    setCustom: (tokens: Record<string, string>) => ipcRenderer.invoke('theme:setCustom', tokens),
    reset: () => ipcRenderer.invoke('theme:reset'),
    getAvatar: () => ipcRenderer.invoke('theme:getAvatar'),
    removeAvatar: () => ipcRenderer.invoke('theme:removeAvatar'),
    pickAvatar: () => ipcRenderer.invoke('theme:pickAvatar'),
  },

  // Dialog
  openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
  openFile: (filters?: any) => ipcRenderer.invoke('dialog:openFile', filters),

  // Shell
  openPath: (path: string) => ipcRenderer.invoke('shell:openPath', path),
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),

  // Server
  server: {
    getAll: () => ipcRenderer.invoke('server:getAll'),
    get: (id: string) => ipcRenderer.invoke('server:get', id),
    create: (config: any) => ipcRenderer.invoke('server:create', config),
    update: (id: string, data: any) => ipcRenderer.invoke('server:update', id, data),
    delete: (id: string) => ipcRenderer.invoke('server:delete', id),
    start: (id: string) => ipcRenderer.invoke('server:start', id),
    stop: (id: string) => ipcRenderer.invoke('server:stop', id),
    sendCommand: (id: string, command: string): Promise<boolean> => ipcRenderer.invoke('server:command', id, command),
    maintenance: (id: string): Promise<string[]> => ipcRenderer.invoke('server:maintenance', id),
    import: (serverPath: string, name?: string) => ipcRenderer.invoke('server:import', serverPath, name),
    scan: (serverPath: string) => ipcRenderer.invoke('server:scan', serverPath),
  },

  // Minecraft server management
  minecraft: {
    getAll: () => ipcRenderer.invoke('minecraft:getAll'),
    get: (id: string) => ipcRenderer.invoke('minecraft:get', id),
    consoleBuffer: (id: string) => ipcRenderer.invoke('minecraft:consoleBuffer', id),
    delete: (id: string, deleteFiles: boolean, deleteBackups?: boolean) => ipcRenderer.invoke('minecraft:delete', id, deleteFiles, deleteBackups),
    detectJava: () => ipcRenderer.invoke('minecraft:detectJava'),
    detectAllJava: () => ipcRenderer.invoke('minecraft:detectAllJava'),
    javaRequirement: (version: string) => ipcRenderer.invoke('minecraft:javaRequirement', version),
    requiredJavaForVersion: (serverType: 'vanilla' | 'paper', version: string) => ipcRenderer.invoke('minecraft:requiredJavaForVersion', serverType, version),
    resolveLaunchJava: (id: string) => ipcRenderer.invoke('minecraft:resolveLaunchJava', id),
    setJavaPath: (id: string, javaPath: string | null) => ipcRenderer.invoke('minecraft:setJavaPath', id, javaPath),
    installJava: (major: number) => ipcRenderer.invoke('minecraft:installJava', major),
    fetchVanillaVersions: () => ipcRenderer.invoke('minecraft:fetchVanillaVersions'),
    fetchPaperVersions: () => ipcRenderer.invoke('minecraft:fetchPaperVersions'),
    create: (config: any) => ipcRenderer.invoke('minecraft:create', config),
    detectExisting: (dirPath: string) => ipcRenderer.invoke('minecraft:detectExisting', dirPath),
    import: (dirPath: string, name: string, ramMB: number) => ipcRenderer.invoke('minecraft:import', dirPath, name, ramMB),
    start: (id: string) => ipcRenderer.invoke('minecraft:start', id),
    stop: (id: string, force?: boolean) => ipcRenderer.invoke('minecraft:stop', id, force),
    restart: (id: string) => ipcRenderer.invoke('minecraft:restart', id),
    setAutoRestart: (id: string, enabled: boolean) => ipcRenderer.invoke('minecraft:setAutoRestart', id, enabled),
    sendCommand: (id: string, command: string) => ipcRenderer.invoke('minecraft:command', id, command),
    processStats: (id: string) => ipcRenderer.invoke('minecraft:processStats', id),
    players: (id: string) => ipcRenderer.invoke('minecraft:players', id),
    readProperties: (id: string) => ipcRenderer.invoke('minecraft:readProperties', id),
    writeProperties: (id: string, changes: Record<string, string>) => ipcRenderer.invoke('minecraft:writeProperties', id, changes),
    listFiles: (id: string, relPath: string) => ipcRenderer.invoke('minecraft:listFiles', id, relPath),
    readFile: (id: string, relPath: string) => ipcRenderer.invoke('minecraft:readFile', id, relPath),
    writeFile: (id: string, relPath: string, content: string) => ipcRenderer.invoke('minecraft:writeFile', id, relPath, content),
    createBackup: (id: string) => ipcRenderer.invoke('minecraft:createBackup', id),
    listBackups: (id: string) => ipcRenderer.invoke('minecraft:listBackups', id),
    restoreBackup: (backupId: string) => ipcRenderer.invoke('minecraft:restoreBackup', backupId),
    deleteBackup: (backupId: string) => ipcRenderer.invoke('minecraft:deleteBackup', backupId),
  },

  minecraftMarketplace: {
    search: (opts: { query?: string; projectType?: string; minecraftVersion?: string; loader?: string; limit?: number; offset?: number }) =>
      ipcRenderer.invoke('minecraft:marketplace:search', opts),
    getProject: (projectId: string) => ipcRenderer.invoke('minecraft:marketplace:getProject', projectId),
    getVersions: (projectId: string, opts?: { minecraftVersion?: string; loader?: string }) => ipcRenderer.invoke('minecraft:marketplace:getVersions', projectId, opts),
    getVersion: (versionId: string) => ipcRenderer.invoke('minecraft:marketplace:getVersion', versionId),
    install: (serverId: string, projectId: string, versionId: string) => ipcRenderer.invoke('minecraft:marketplace:install', serverId, projectId, versionId),
    listInstalled: (serverId: string) => ipcRenderer.invoke('minecraft:marketplace:listInstalled', serverId),
    removeContent: (serverId: string, contentId: string) => ipcRenderer.invoke('minecraft:marketplace:removeContent', serverId, contentId),
    setContentEnabled: (serverId: string, contentId: string, enabled: boolean) => ipcRenderer.invoke('minecraft:marketplace:setContentEnabled', serverId, contentId, enabled),
  },

  onMinecraftMarketplaceInstallProgress: (callback: (data: { pct: number; message: string }) => void) => {
    const handler = (_: any, data: any) => callback(data);
    ipcRenderer.on('minecraft:marketplace:installProgress', handler);
    return () => { ipcRenderer.removeListener('minecraft:marketplace:installProgress', handler); };
  },
  onMinecraftInstallJavaProgress: (callback: (data: { pct: number; message: string }) => void) => {
    const handler = (_: any, data: any) => callback(data);
    ipcRenderer.on('minecraft:installJavaProgress', handler);
    return () => { ipcRenderer.removeListener('minecraft:installJavaProgress', handler); };
  },

  onMinecraftConsole: (callback: (data: { serverId: string; line: string }) => void) => {
    const handler = (_: any, data: any) => callback(data);
    ipcRenderer.on('minecraft:console', handler);
    return () => { ipcRenderer.removeListener('minecraft:console', handler); };
  },
  onMinecraftStatusChange: (callback: (data: { serverId: string; status: string }) => void) => {
    const handler = (_: any, data: any) => callback(data);
    ipcRenderer.on('minecraft:statusChange', handler);
    return () => { ipcRenderer.removeListener('minecraft:statusChange', handler); };
  },
  onMinecraftCreateProgress: (callback: (data: { pct: number; message: string }) => void) => {
    const handler = (_: any, data: any) => callback(data);
    ipcRenderer.on('minecraft:createProgress', handler);
    return () => { ipcRenderer.removeListener('minecraft:createProgress', handler); };
  },

  // Resources
  resource: {
    scan: (serverPath: string) => ipcRenderer.invoke('resource:scan', serverPath),
    getInfo: (resourcePath: string) => ipcRenderer.invoke('resource:getInfo', resourcePath),
    toggle: (serverPath: string, name: string, enabled: boolean) =>
      ipcRenderer.invoke('resource:toggle', serverPath, name, enabled),
    categorize: (resources: any[]) => ipcRenderer.invoke('resource:categorize', resources),
  },

  // Health
  health: {
    scan: (serverPath: string) => ipcRenderer.invoke('health:scan', serverPath),
    fix: (serverPath: string, issue: any) => ipcRenderer.invoke('health:fix', serverPath, issue),
    onFixProgress: (callback: (data: { message: string }) => void) => {
      const handler = (_: any, data: any) => callback(data);
      ipcRenderer.on('health:fixProgress', handler);
      return () => { ipcRenderer.removeListener('health:fixProgress', handler); };
    },
  },

  // Backup
  backup: {
    create: (serverId: string, options?: any) => ipcRenderer.invoke('backup:create', serverId, options),
    restore: (backupId: string) => ipcRenderer.invoke('backup:restore', backupId),
    list: (serverId: string) => ipcRenderer.invoke('backup:list', serverId),
    delete: (backupId: string) => ipcRenderer.invoke('backup:delete', backupId),
  },

  // Git
  git: {
    clone: (url: string, dest: string) => ipcRenderer.invoke('git:clone', url, dest),
    pull: (repoPath: string) => ipcRenderer.invoke('git:pull', repoPath),
    getStatus: (repoPath: string) => ipcRenderer.invoke('git:getStatus', repoPath),
  },

  // File
  file: {
    readDir: (dirPath: string) => ipcRenderer.invoke('file:readDir', dirPath),
    readFile: (filePath: string) => ipcRenderer.invoke('file:readFile', filePath),
    writeFile: (filePath: string, content: string) => ipcRenderer.invoke('file:writeFile', filePath, content),
    rename: (oldPath: string, newPath: string) => ipcRenderer.invoke('file:rename', oldPath, newPath),
    createDir: (dirPath: string) => ipcRenderer.invoke('file:createDir', dirPath),
    delete: (targetPath: string) => ipcRenderer.invoke('file:delete', targetPath),
    exists: (targetPath: string) => ipcRenderer.invoke('file:exists', targetPath),
  },

  // Artifacts
  artifact: {
    download: (version: string, dest: string) => ipcRenderer.invoke('artifact:download', version, dest),
    getVersions: () => ipcRenderer.invoke('artifact:getVersions'),
    getInstalled: (serverPath: string) => ipcRenderer.invoke('artifact:getInstalled', serverPath),
    update: (opts: { serverPath: string; version: string }) => ipcRenderer.invoke('artifact:update', opts),
    onProgress: (callback: (progress: any) => void) => {
      ipcRenderer.on('artifact:progress', (_, progress) => callback(progress));
    },
  },

  // Resource Import
  import: {
    pickResources: () => ipcRenderer.invoke('import:pickResources'),
    analyze: (resourcePath: string) => ipcRenderer.invoke('import:analyze', resourcePath),
    install: (opts: {
      sourcePath: string;
      serverPath: string;
      targetFolder: string;
      resourceName: string;
      replaceExisting: string[];
    }) => ipcRenderer.invoke('import:install', opts),
    scanInstalled: (serverPath: string) => ipcRenderer.invoke('import:scanInstalled', serverPath),
  },

  // txAdmin
  txAdmin: {
    open: (serverPath: string) => ipcRenderer.invoke('server:openTxAdmin', serverPath),
  },

  // Resource Updates
  updates: {
    check: (serverPath: string) => ipcRenderer.invoke('resource:checkUpdates', serverPath),
    update: (opts: { resourcePath: string; repoUrl: string; serverPath: string }) =>
      ipcRenderer.invoke('resource:update', opts),
  },

  // Vehicle Pack Manager
  vehicle: {
    pick: () => ipcRenderer.invoke('vehicle:pick'),
    analyze: (vehiclePath: string) => ipcRenderer.invoke('vehicle:analyze', vehiclePath),
    import: (opts: { sourcePath: string; serverPath: string; resourceName: string }) =>
      ipcRenderer.invoke('vehicle:import', opts),
  },

  // Livery Editor — folder-first detection, binary reads, and file saves
  livery: {
    pickFolder: (): Promise<string | null> => ipcRenderer.invoke('livery:pickFolder'),
    scanFolder: (dir: string) => ipcRenderer.invoke('livery:scanFolder', dir),
    readBinary: (filePath: string): Promise<string> => ipcRenderer.invoke('livery:readBinary', filePath),
    writeFile: (filePath: string, b64: string): Promise<boolean> => ipcRenderer.invoke('livery:writeFile', filePath, b64),
    showSaveDialog: (opts: { defaultPath?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null> => ipcRenderer.invoke('livery:showSaveDialog', opts),
    inflateRaw: (b64: string): Promise<string | null> => ipcRenderer.invoke('livery:inflateRaw', b64),
    inflate: (b64: string): Promise<string | null> => ipcRenderer.invoke('livery:inflate', b64),
  },

  // Vehicle Studio — top-level vehicle development workspace
  vehicleStudio: {
    pickFolder: () => ipcRenderer.invoke('vehicleStudio:pickFolder'),
    pickZip: () => ipcRenderer.invoke('vehicleStudio:pickZip'),
    scan: (inputPath: string, copy?: boolean) => ipcRenderer.invoke('vehicleStudio:scan', inputPath, copy),
    readHandling: (root: string, handlingId: string) => ipcRenderer.invoke('vehicleStudio:readHandling', root, handlingId),
    writeHandling: (root: string, handlingId: string, changes: any[]) => ipcRenderer.invoke('vehicleStudio:writeHandling', root, handlingId, changes),
    undoHandling: (root: string, handlingId: string) => ipcRenderer.invoke('vehicleStudio:undoHandling', root, handlingId),
    recommend: (type: string) => ipcRenderer.invoke('vehicleStudio:recommend', type),
    previewTune: (root: string, handlingId: string, profileId: string) => ipcRenderer.invoke('vehicleStudio:previewTune', root, handlingId, profileId),
    applyTune: (root: string, handlingId: string, profileId: string) => ipcRenderer.invoke('vehicleStudio:applyTune', root, handlingId, profileId),
    generateManifest: (root: string) => ipcRenderer.invoke('vehicleStudio:generateManifest', root),
    exportZip: (root: string, resourceName: string) => ipcRenderer.invoke('vehicleStudio:exportZip', root, resourceName),
    exportFolder: (root: string, resourceName: string) => ipcRenderer.invoke('vehicleStudio:exportFolder', root, resourceName),
    install: (root: string, serverInstallPath: string, resourceName: string, addEnsure: boolean) => ipcRenderer.invoke('vehicleStudio:install', root, serverInstallPath, resourceName, addEnsure),
    diagnoseHandling: (root: string, handlingId: string) => ipcRenderer.invoke('vehicleStudio:diagnoseHandling', root, handlingId),
    listHandling: (root: string) => ipcRenderer.invoke('vehicleStudio:listHandling', root),
    createHandling: (root: string, handlingId: string) => ipcRenderer.invoke('vehicleStudio:createHandling', root, handlingId),
    cloneHandling: (root: string, sourceId: string, newId: string) => ipcRenderer.invoke('vehicleStudio:cloneHandling', root, sourceId, newId),
    setVehicleHandlingId: (root: string, modelName: string, newHandlingId: string) => ipcRenderer.invoke('vehicleStudio:setVehicleHandlingId', root, modelName, newHandlingId),
    registerHandling: (root: string) => ipcRenderer.invoke('vehicleStudio:registerHandling', root),
    categoryPresets: (category: string) => ipcRenderer.invoke('vehicleStudio:categoryPresets', category),
    previewCategoryPreset: (root: string, handlingId: string, category: string, presetId: string) => ipcRenderer.invoke('vehicleStudio:previewCategoryPreset', root, handlingId, category, presetId),
    applyCategoryPreset: (root: string, handlingId: string, category: string, presetId: string) => ipcRenderer.invoke('vehicleStudio:applyCategoryPreset', root, handlingId, category, presetId),
    readMeta: (root: string, kind: string, key: string) => ipcRenderer.invoke('vehicleStudio:readMeta', root, kind, key),
    writeMeta: (root: string, kind: string, key: string, changes: { tag: string; value: string }[]) => ipcRenderer.invoke('vehicleStudio:writeMeta', root, kind, key, changes),
    undoMeta: (root: string, kind: string, key: string) => ipcRenderer.invoke('vehicleStudio:undoMeta', root, kind, key),
    handlingDiff: (root: string, handlingId: string) => ipcRenderer.invoke('vehicleStudio:handlingDiff', root, handlingId),
    resetHandlingFields: (root: string, handlingId: string, names: string[]) => ipcRenderer.invoke('vehicleStudio:resetHandlingFields', root, handlingId, names),
    revertHandling: (root: string, handlingId: string) => ipcRenderer.invoke('vehicleStudio:revertHandling', root, handlingId),
    handlingPresets: () => ipcRenderer.invoke('vehicleStudio:handlingPresets'),
    previewHandlingPreset: (root: string, handlingId: string, presetId: string) => ipcRenderer.invoke('vehicleStudio:previewHandlingPreset', root, handlingId, presetId),
    applyHandlingPreset: (root: string, handlingId: string, presetId: string) => ipcRenderer.invoke('vehicleStudio:applyHandlingPreset', root, handlingId, presetId),
    smartTunePreview: (root: string, handlingId: string, req: any) => ipcRenderer.invoke('vehicleStudio:smartTunePreview', root, handlingId, req),
    smartTuneApply: (root: string, handlingId: string, req: any) => ipcRenderer.invoke('vehicleStudio:smartTuneApply', root, handlingId, req),
    metaDiff: (root: string, kind: string, key: string) => ipcRenderer.invoke('vehicleStudio:metaDiff', root, kind, key),
    spawnReport: (root: string) => ipcRenderer.invoke('vehicleStudio:spawnReport', root),
  },

  // Vehicle Studio access gate (backend-authorized; no secrets in the client)
  vsAuth: {
    status: () => ipcRenderer.invoke('vsAuth:status'),
    startLogin: () => ipcRenderer.invoke('vsAuth:startLogin'),
    redeem: (code: string) => ipcRenderer.invoke('vsAuth:redeem', code),
    logout: () => ipcRenderer.invoke('vsAuth:logout'),
  },

  // System info (Settings page: CPU / RAM / disk / specs)
  system: {
    getInfo: () => ipcRenderer.invoke('system:info'),
  },

  // Exclusive access — Discord OAuth verification
  access: {
    login: () => ipcRenderer.invoke('access:login'),
    status: (force?: boolean) => ipcRenderer.invoke('access:status', force),
    logout: () => ipcRenderer.invoke('access:logout'),
  },

  // Server console output
  onServerConsole: (callback: (data: { serverId: string; line: string }) => void) => {
    const handler = (_: any, data: any) => callback(data);
    ipcRenderer.on('server:console', handler);
    return () => { ipcRenderer.removeListener('server:console', handler); };
  },

  // Server status change (process exited, errored, etc.)
  onServerStatusChange: (callback: (data: { serverId: string; status: string }) => void) => {
    const handler = (_: any, data: any) => callback(data);
    ipcRenderer.on('server:statusChange', handler);
    return () => { ipcRenderer.removeListener('server:statusChange', handler); };
  },

  // App Updater
  appUpdater: {
    check: () => ipcRenderer.invoke('updater:check'),
    download: () => ipcRenderer.invoke('updater:download'),
    install: () => ipcRenderer.invoke('updater:install'),
    getVersion: () => ipcRenderer.invoke('updater:getVersion'),
    onStatus: (callback: (data: any) => void) => {
      const handler = (_: any, data: any) => callback(data);
      ipcRenderer.on('updater:status', handler);
      return () => { ipcRenderer.removeListener('updater:status', handler); };
    },
  },

  // Bridge API proxy (avoids CORS in renderer)
  bridge: {
    request: (opts: { host: string; apiKey: string; method: string; path: string; body?: any }) =>
      ipcRenderer.invoke('bridge:request', opts),
  },

  // Build progress (server creation)
  onBuildProgress: (callback: (data: { current: number; total: number; resource: string; message: string }) => void) => {
    const handler = (_: any, data: any) => callback(data);
    ipcRenderer.on('server:buildProgress', handler);
    // Return cleanup function
    return () => { ipcRenderer.removeListener('server:buildProgress', handler); };
  },
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);

export type ElectronAPI = typeof electronAPI;
