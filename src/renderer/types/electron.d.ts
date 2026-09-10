import type { SmartTuneRequest } from '../../main/shared/handlingMeta';

interface ElectronAPI {
  minimize: () => Promise<void>;
  maximize: () => Promise<void>;
  close: () => Promise<void>;

  settings: {
    get: (key: 'minimizeToTray' | 'autoUpdate' | 'downloadPath') => Promise<any>;
    getAll: () => Promise<{ minimizeToTray: boolean; autoUpdate: boolean; downloadPath: string | null }>;
    set: (key: 'minimizeToTray' | 'autoUpdate' | 'downloadPath', value: any) => Promise<boolean>;
    getLoginItem: () => Promise<boolean>;
    setLoginItem: (enabled: boolean) => Promise<boolean>;
  };

  theme: {
    get: () => Promise<{ activeThemeId: string; customTokens: Record<string, string>; hasCustomTheme: boolean }>;
    setActive: (id: string) => Promise<boolean>;
    setCustom: (tokens: Record<string, string>) => Promise<boolean>;
    reset: () => Promise<boolean>;
    getAvatar: () => Promise<string | null>;
    removeAvatar: () => Promise<boolean>;
    pickAvatar: () => Promise<{ success: boolean; dataUrl?: string; error?: string | null }>;
  };

  openDirectory: () => Promise<string | null>;
  openFile: (filters?: any) => Promise<string | null>;
  openPath: (path: string) => Promise<void>;
  openExternal: (url: string) => Promise<void>;

  server: {
    getAll: () => Promise<any[]>;
    get: (id: string) => Promise<any>;
    create: (config: any) => Promise<any>;
    update: (id: string, data: any) => Promise<any>;
    delete: (id: string) => Promise<boolean>;
    start: (id: string) => Promise<{ success: boolean; error?: string }>;
    stop: (id: string) => Promise<boolean>;
    sendCommand: (id: string, command: string) => Promise<boolean>;
    maintenance: (id: string) => Promise<string[]>;
    import: (serverPath: string, name?: string) => Promise<{
      success: boolean;
      server?: any;
      error?: string;
      detected?: {
        framework: string;
        artifactVersion: string;
        resourceCount: number;
        hasServerCfg: boolean;
        hasFXServer: boolean;
      };
    }>;
    scan: (serverPath: string) => Promise<{
      framework: string;
      artifactVersion: string;
      resourceCount: number;
      hasServerCfg: boolean;
      hasFXServer: boolean;
      serverName: string;
    }>;
  };

  fivemMarketplace: {
    repoDetails: (repoUrl: string) => Promise<GitHubRepoDetails>;
    install: (serverId: string, opts: { repoUrl: string; resourceName: string; category: string; dependencies?: string[]; preferReleaseAsset?: boolean }) => Promise<{ success: boolean; error?: string; content?: FiveMInstalledContent }>;
    listInstalled: (serverId: string) => Promise<(FiveMInstalledContent & { missingOnDisk: boolean })[]>;
    removeResource: (serverId: string, contentId: string) => Promise<{ success: boolean; error?: string }>;
    setResourceEnabled: (serverId: string, contentId: string, enabled: boolean) => Promise<{ success: boolean; error?: string }>;
    openResourceFolder: (serverId: string, contentId: string) => Promise<boolean>;
  };
  onFiveMMarketplaceInstallProgress: (callback: (data: { pct: number; message: string }) => void) => () => void;

  minecraft: {
    getAll: () => Promise<MinecraftServer[]>;
    get: (id: string) => Promise<MinecraftServer | undefined>;
    consoleBuffer: (id: string) => Promise<string[]>;
    delete: (id: string, deleteFiles: boolean, deleteBackups?: boolean) => Promise<{ success: boolean; error?: string }>;
    detectJava: () => Promise<{ found: boolean; version: string | null; major: number | null }>;
    detectAllJava: () => Promise<{ path: string; version: string; major: number; source: string }[]>;
    javaRequirement: (version: string) => Promise<number>;
    requiredJavaForVersion: (serverType: 'vanilla' | 'paper', version: string) => Promise<number>;
    resolveLaunchJava: (id: string) => Promise<{ ok: boolean; required: number; javaPath: string | null; major: number | null; error?: string } | null>;
    setJavaPath: (id: string, javaPath: string | null) => Promise<boolean>;
    installJava: (major: number) => Promise<{ success: boolean; javaPath?: string; error?: string }>;
    connectionInfo: (id: string) => Promise<MinecraftConnectionInfo | null>;
    fetchVanillaVersions: () => Promise<{ id: string; type: string; releaseTime: string }[]>;
    fetchPaperVersions: () => Promise<string[]>;
    fetchBedrockVersions: () => Promise<{ stable: { version: string; url: string }; preview: { version: string; url: string } | null }>;
    create: (config: {
      name: string; installPath: string; version: string; serverType: 'vanilla' | 'paper' | 'bedrock';
      ramMB: number; port: number; acceptedEula: boolean; javaPath?: string | null;
      seed?: string; gamemode?: 'survival' | 'creative' | 'adventure' | 'spectator';
      difficulty?: 'peaceful' | 'easy' | 'normal' | 'hard'; hardcore?: boolean;
      onlineMode?: boolean; maxPlayers?: number; motd?: string;
      viewDistance?: number; simulationDistance?: number; pvp?: boolean; whitelist?: boolean;
      allowCheats?: boolean; bedrockChannel?: 'stable' | 'preview';
    }) => Promise<{ success: boolean; server?: MinecraftServer; error?: string }>;
    detectExisting: (dirPath: string) => Promise<{
      valid: boolean; reason?: string; edition?: 'java' | 'bedrock'; jarFile?: string; version?: string; serverType?: 'vanilla' | 'paper' | 'bedrock';
      hasProperties: boolean; hasWorld: boolean; hasEula: boolean; port?: number;
    }>;
    import: (dirPath: string, name: string, ramMB: number) => Promise<{ success: boolean; server?: MinecraftServer; error?: string }>;
    start: (id: string) => Promise<{ success: boolean; error?: string }>;
    stop: (id: string, force?: boolean) => Promise<boolean>;
    restart: (id: string) => Promise<boolean>;
    setAutoRestart: (id: string, enabled: boolean) => Promise<boolean>;
    sendCommand: (id: string, command: string) => Promise<boolean>;
    processStats: (id: string) => Promise<{ pid: number | null; uptimeMs: number | null }>;
    players: (id: string) => Promise<{ name: string; online: boolean; lastSeen: string }[]>;
    readProperties: (id: string) => Promise<{ key: string; value: string; isComment: boolean; raw: string }[]>;
    writeProperties: (id: string, changes: Record<string, string>) => Promise<{ success: boolean; error?: string }>;
    listFiles: (id: string, relPath: string) => Promise<{ name: string; path: string; type: 'file' | 'directory'; size: number; modified: string }[] | null>;
    readFile: (id: string, relPath: string) => Promise<string | null>;
    writeFile: (id: string, relPath: string, content: string) => Promise<boolean>;
    createBackup: (id: string) => Promise<{ success: boolean; backup?: MinecraftBackup; error?: string }>;
    listBackups: (id: string) => Promise<MinecraftBackup[]>;
    restoreBackup: (backupId: string) => Promise<{ success: boolean; error?: string }>;
    deleteBackup: (backupId: string) => Promise<boolean>;
  };

  minecraftMarketplace: {
    search: (opts: { query?: string; projectType?: string; minecraftVersion?: string; loader?: string; limit?: number; offset?: number }) => Promise<{ hits: MarketplaceHit[]; total: number }>;
    getProject: (projectId: string) => Promise<MarketplaceProject>;
    getVersions: (projectId: string, opts?: { minecraftVersion?: string; loader?: string }) => Promise<MarketplaceVersion[]>;
    getVersion: (versionId: string) => Promise<MarketplaceVersion>;
    install: (serverId: string, projectId: string, versionId: string) => Promise<{ success: boolean; error?: string; content?: InstalledContent }>;
    listInstalled: (serverId: string) => Promise<(InstalledContent & { missingOnDisk: boolean })[]>;
    removeContent: (serverId: string, contentId: string) => Promise<{ success: boolean; error?: string }>;
    setContentEnabled: (serverId: string, contentId: string, enabled: boolean) => Promise<{ success: boolean; error?: string }>;
  };

  onMinecraftConsole: (callback: (data: { serverId: string; line: string }) => void) => () => void;
  onMinecraftStatusChange: (callback: (data: { serverId: string; status: string }) => void) => () => void;
  onMinecraftCreateProgress: (callback: (data: { pct: number; message: string }) => void) => () => void;
  onMinecraftMarketplaceInstallProgress: (callback: (data: { pct: number; message: string }) => void) => () => void;
  onMinecraftInstallJavaProgress: (callback: (data: { pct: number; message: string }) => void) => () => void;

  resource: {
    scan: (serverPath: string) => Promise<any[]>;
    getInfo: (resourcePath: string) => Promise<any>;
    toggle: (serverPath: string, name: string, enabled: boolean) => Promise<boolean>;
    categorize: (resources: any[]) => Promise<Record<string, any[]>>;
  };

  health: {
    scan: (serverPath: string) => Promise<any>;
    fix: (serverPath: string, issue: any) => Promise<boolean>;
  };

  backup: {
    create: (serverId: string, options?: any) => Promise<any>;
    restore: (backupId: string) => Promise<boolean>;
    list: (serverId: string) => Promise<any[]>;
    delete: (backupId: string) => Promise<boolean>;
  };

  git: {
    clone: (url: string, dest: string) => Promise<{ success: boolean; error?: string }>;
    pull: (repoPath: string) => Promise<{ success: boolean; changes?: number; error?: string }>;
    getStatus: (repoPath: string) => Promise<any>;
  };

  file: {
    readDir: (dirPath: string) => Promise<any[]>;
    readFile: (filePath: string) => Promise<{ content: string; encoding: string } | null>;
    writeFile: (filePath: string, content: string) => Promise<boolean>;
    rename: (oldPath: string, newPath: string) => Promise<boolean>;
    createDir: (dirPath: string) => Promise<boolean>;
    delete: (targetPath: string) => Promise<boolean>;
    exists: (targetPath: string) => Promise<boolean>;
  };

  import: {
    pickResources: () => Promise<string[]>;
    analyze: (resourcePath: string) => Promise<{
      name: string;
      description: string;
      author: string;
      version: string;
      detectedType: string | null;
      suggestedFolder: string;
      isZip: boolean;
      dependencies: string[];
      conflicts: string[];
    }>;
    install: (opts: {
      sourcePath: string;
      serverPath: string;
      targetFolder: string;
      resourceName: string;
      replaceExisting: string[];
    }) => Promise<{ success: boolean; error?: string; replaced: string[] }>;
    scanInstalled: (serverPath: string) => Promise<string[]>;
  };

  artifact: {
    download: (version: string, dest: string) => Promise<{ success: boolean; error?: string }>;
    getVersions: () => Promise<any[]>;
    getInstalled: (serverPath: string) => Promise<string | null>;
    update: (opts: { serverPath: string; version: string }) => Promise<{ success: boolean; error?: string }>;
    onProgress: (callback: (progress: any) => void) => void;
  };

  txAdmin: {
    open: (serverPath: string) => Promise<{ url: string; port: number }>;
  };

  updates: {
    check: (serverPath: string) => Promise<{
      name: string;
      path: string;
      repoUrl: string;
      version: string;
      folder: string;
      hasUpdate: boolean;
      latestCommitDate: string;
      installedDate: string;
    }[]>;
    update: (opts: { resourcePath: string; repoUrl: string; serverPath: string }) =>
      Promise<{ success: boolean; error?: string }>;
  };

  vehicle: {
    pick: () => Promise<string[]>;
    analyze: (vehiclePath: string) => Promise<{
      name: string;
      isZip: boolean;
      hasManifest: boolean;
      hasStream: boolean;
      metaFiles: string[];
      streamFileCount: number;
      vehicleCount: number;
      needsManifest: boolean;
    }>;
    import: (opts: { sourcePath: string; serverPath: string; resourceName: string }) =>
      Promise<{ success: boolean; error?: string; generatedManifest?: boolean }>;
  };

  livery: {
    pickFolder: () => Promise<string | null>;
    scanFolder: (dir: string) => Promise<{
      root: string;
      vehicles: {
        name: string; yft: string | null; hiYft: string | null; ytds: string[]; dir: string;
      }[];
      meta: { handling: string[]; carvariations: string[]; vehiclelayouts: string[]; vehicles: string[] };
    }>;
    readBinary: (filePath: string) => Promise<string>;
    writeFile: (filePath: string, b64: string) => Promise<boolean>;
    showSaveDialog: (opts: { defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>;
    inflateRaw: (b64: string) => Promise<string | null>;
    inflate: (b64: string) => Promise<string | null>;
  };

  access: {
    login: () => Promise<{
      configured: boolean; loggedIn: boolean; inGuild: boolean; hasAccess: boolean;
      username?: string; discordId?: string; reason?: string;
    }>;
    status: (force?: boolean) => Promise<{
      configured: boolean; loggedIn: boolean; inGuild: boolean; hasAccess: boolean;
      username?: string; discordId?: string; reason?: string;
    }>;
    logout: () => Promise<void>;
  };

  vehicleStudio: {
    pickFolder: () => Promise<string | null>;
    pickZip: () => Promise<string | null>;
    scan: (inputPath: string, copy?: boolean) => Promise<{ ok: boolean; error?: string; data?: VSScan }>;
    readHandling: (root: string, handlingId: string) => Promise<{ ok: boolean; error?: string; filePath?: string; fields?: VSHandlingField[]; original?: Record<string, string> }>;
    writeHandling: (root: string, handlingId: string, changes: VSHandlingChange[]) => Promise<{ ok: boolean; error?: string; backup?: string; applied?: number }>;
    undoHandling: (root: string, handlingId: string) => Promise<{ ok: boolean; error?: string }>;
    recommend: (type: string) => Promise<{ recommended: string; alternatives: string[]; profiles: { id: string; name: string; desc: string }[] }>;
    previewTune: (root: string, handlingId: string, profileId: string) => Promise<{ ok: boolean; error?: string; name?: string; changes?: { name: string; from: string; to: string }[] }>;
    applyTune: (root: string, handlingId: string, profileId: string) => Promise<{ ok: boolean; error?: string; backup?: string; applied?: number }>;
    generateManifest: (root: string) => Promise<{ ok: boolean; error?: string; path?: string }>;
    exportZip: (root: string, resourceName: string) => Promise<{ ok: boolean; error?: string; path?: string }>;
    exportFolder: (root: string, resourceName: string) => Promise<{ ok: boolean; error?: string; dest?: string }>;
    install: (root: string, serverInstallPath: string, resourceName: string, addEnsure: boolean) => Promise<{ ok: boolean; error?: string; dest?: string }>;
    diagnoseHandling: (root: string, handlingId: string) => Promise<VSHandlingDiag>;
    listHandling: (root: string) => Promise<{ name: string; file: string }[]>;
    createHandling: (root: string, handlingId: string) => Promise<{ ok: boolean; error?: string; file?: string }>;
    cloneHandling: (root: string, sourceId: string, newId: string) => Promise<{ ok: boolean; error?: string }>;
    setVehicleHandlingId: (root: string, modelName: string, newHandlingId: string) => Promise<{ ok: boolean; error?: string }>;
    registerHandling: (root: string) => Promise<{ ok: boolean; error?: string }>;
    categoryPresets: (category: string) => Promise<{ id: string; name: string }[]>;
    previewCategoryPreset: (root: string, handlingId: string, category: string, presetId: string) => Promise<{ ok: boolean; error?: string; name?: string; changes?: { name: string; from: string; to: string }[] }>;
    applyCategoryPreset: (root: string, handlingId: string, category: string, presetId: string) => Promise<{ ok: boolean; error?: string; backup?: string; applied?: number }>;
    readMeta: (root: string, kind: 'vehicles' | 'carvariations' | 'carcols', key: string) => Promise<{ ok: boolean; error?: string; file?: string; fields?: VSMetaField[]; summary?: Record<string, any> }>;
    writeMeta: (root: string, kind: 'vehicles' | 'carvariations' | 'carcols', key: string, changes: { tag: string; value: string }[]) => Promise<{ ok: boolean; error?: string; backup?: string; applied?: number }>;
    undoMeta: (root: string, kind: 'vehicles' | 'carvariations' | 'carcols', key: string) => Promise<{ ok: boolean; error?: string }>;
    handlingDiff: (root: string, handlingId: string) => Promise<{ ok: boolean; error?: string; changes?: { name: string; original: string; current: string }[] }>;
    resetHandlingFields: (root: string, handlingId: string, names: string[]) => Promise<{ ok: boolean; error?: string; applied?: number; backup?: string }>;
    revertHandling: (root: string, handlingId: string) => Promise<{ ok: boolean; error?: string; applied?: number; backup?: string }>;
    handlingPresets: () => Promise<{ id: string; name: string; desc: string; special?: string }[]>;
    previewHandlingPreset: (root: string, handlingId: string, presetId: string) => Promise<{ ok: boolean; error?: string; name?: string; changes?: { name: string; from: string; to: string }[]; warnings?: string[] }>;
    applyHandlingPreset: (root: string, handlingId: string, presetId: string) => Promise<{ ok: boolean; error?: string; backup?: string; applied?: number }>;
    smartTunePreview: (root: string, handlingId: string, req: SmartTuneRequest) => Promise<{ ok: boolean; error?: string; changes?: { name: string; from: string; to: string }[]; warnings?: string[] }>;
    smartTuneApply: (root: string, handlingId: string, req: SmartTuneRequest) => Promise<{ ok: boolean; error?: string; backup?: string; applied?: number }>;
    metaDiff: (root: string, kind: 'vehicles' | 'carvariations' | 'carcols', key: string) => Promise<{ ok: boolean; error?: string; changes?: { tag: string; friendly: string; original: string; current: string }[] }>;
    spawnReport: (root: string) => Promise<{ ok: boolean; vehicles: { modelName: string; spawnCode: string; hasModel: boolean; level: 'ok' | 'warn' | 'error'; issues: string[]; suggestion?: string }[]; modelFiles: string[] }>;
  };

  vsAuth: {
    status: () => Promise<{ enabled: boolean; authorized: boolean; username?: string; reason?: string; stale?: boolean; expiresAt?: number; entitlements?: string[] }>;
    startLogin: () => Promise<{ ok: boolean; error?: string }>;
    redeem: (code: string) => Promise<{ ok: boolean; username?: string; error?: string; message?: string }>;
    logout: () => Promise<void>;
  };

  system: {
    getInfo: () => Promise<{
      cpuModel: string;
      cpuCores: number;
      cpuUsage: number;
      totalMem: number;
      freeMem: number;
      platform: string;
      hostname: string;
      disk: { total: number; free: number } | null;
      appVersion: string;
      electron: string;
    }>;
  };

  appUpdater: {
    check: () => Promise<any>;
    download: () => Promise<{ success: boolean; error?: string }>;
    install: () => Promise<void>;
    getVersion: () => Promise<string>;
    onStatus: (callback: (data: {
      status: 'available' | 'current' | 'downloading' | 'ready' | 'error';
      version?: string;
      percent?: number;
      error?: string;
    }) => void) => () => void;
  };

  onServerConsole: (callback: (data: { serverId: string; line: string }) => void) => () => void;
  onServerStatusChange: (callback: (data: { serverId: string; status: string }) => void) => () => void;

  onBuildProgress: (callback: (data: { current: number; total: number; resource: string; message: string }) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }

  // ── Minecraft types (mirror src/main/services/MinecraftManager.ts) ─────────
  interface MinecraftServer {
    id: string;
    name: string;
    installPath: string;
    version: string;
    serverType: 'vanilla' | 'paper' | 'bedrock';
    edition: 'java' | 'bedrock';
    jarFile: string;
    ramMB: number;
    port: number;
    status: 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
    pid: number | null;
    startedAt: string | null;
    autoRestart: boolean;
    lastBackup: string | null;
    createdAt: string;
    updatedAt: string;
    requiredJavaMajor: number | null;
    javaPath: string | null;
    lastError: string | null;
    installedContent: InstalledContent[];
  }
  interface MinecraftBackup {
    id: string;
    serverId: string;
    name: string;
    path: string;
    size: number;
    createdAt: string;
  }
  interface MinecraftConnectionInfo {
    serverId: string;
    serverName: string;
    serverType: 'vanilla' | 'paper' | 'bedrock';
    version: string;
    edition: 'java' | 'bedrock';
    status: 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
    port: number;
    lanAddress: string | null;
    portListening: boolean | null;
    bedrock: { possible: boolean; detectedPlugin: string | null; note: string };
    raknet: { checked: boolean; reachable: boolean | null; note: string } | null;
  }
  interface GitHubRepoDetails {
    owner: string;
    repo: string;
    description: string | null;
    stars: number;
    license: { name: string; spdxId: string | null } | null;
    pushedAt: string;
    defaultBranch: string;
    ownerAvatarUrl: string;
    htmlUrl: string;
    openIssues: number;
    latestReleaseAsset: { name: string; url: string; tag: string } | null;
  }
  interface FiveMInstalledContent {
    id: string;
    source: 'github';
    repo: string;
    resourceName: string;
    category: string;
    relPath: string;
    version: string | null;
    sha: string | null;
    enabled: boolean;
    installedAt: string;
    dependencies: string[];
  }
  interface InstalledContent {
    id: string;
    kind: 'plugin' | 'datapack';
    source: 'modrinth';
    projectId: string;
    projectName: string;
    versionId: string;
    versionNumber: string;
    fileName: string;
    relPath: string;
    sha1: string;
    size: number;
    enabled: boolean;
    installedAt: string;
    dependencies: { projectId: string; projectName: string; dependencyType: string }[];
  }
  interface MarketplaceHit {
    projectId: string; slug: string; title: string; description: string; author: string;
    projectType: string; categories: string[]; loaders: string[]; gameVersions: string[];
    downloads: number; iconUrl: string | null; license: string | null;
  }
  interface MarketplaceVersion {
    id: string; versionNumber: string; name: string; gameVersions: string[]; loaders: string[];
    datePublished: string;
    files: { url: string; filename: string; primary: boolean; size: number; sha1: string | null }[];
    dependencies: { projectId: string | null; versionId: string | null; dependencyType: string }[];
  }
  interface MarketplaceProject {
    projectId: string; slug: string; title: string; description: string; body: string; author: string;
    projectType: string; categories: string[];
    license: { id: string; name: string; url: string | null } | null;
    sourceUrl: string | null; websiteUrl: string | null; iconUrl: string | null; downloads: number;
    gameVersions: string[]; loaders: string[];
  }

  // ── Vehicle Studio types (mirror src/main/services/VehicleStudio.ts) ────────
  interface VSVehicle {
    modelName: string;
    handlingId: string | null;
    txdName: string | null;
    vehicleClass: string | null;
    type: string;
    typeConfidence: 'High' | 'Medium' | 'Low';
    gameName: string | null;
    makeName: string | null;
    hasModel: boolean;
    hasHandling: boolean;
  }
  interface VSDiagnostic {
    id: string;
    severity: 'error' | 'warning' | 'info';
    category: 'Resource' | 'Manifest' | 'Vehicle' | 'Handling' | 'Metadata' | 'Files';
    file: string;
    line?: number;
    vehicle?: string;
    problem: string;
    detail: string;
    why?: string;
    fix?: string;
    autoFixable: boolean;
    fixKind?: 'generate-manifest' | 'register-handling';
    handlingRef?: string;
  }
  interface VSHandlingDiag {
    handlingId: string;
    handlingFileExists: boolean;
    registeredInManifest: boolean | null;
    exactMatch: { name: string; file: string } | null;
    fuzzy: { name: string; file: string; similarity: number }[];
    allNames: { name: string; file: string }[];
  }
  interface VSHandlingField {
    name: string;
    kind: 'scalar' | 'int' | 'vector' | 'text';
    value?: string;
    x?: string; y?: string; z?: string;
    editable: boolean;
  }
  interface VSHandlingChange { name: string; axis?: 'x' | 'y' | 'z'; value: string; }
  interface VSMetaField { tag: string; friendly: string; kind: 'tag' | 'attr'; value: string; editable: boolean; }
  interface VSScan {
    root: string;
    workspacePath: string;
    name: string;
    isZip: boolean;
    manifest: { exists: boolean; type: 'fxmanifest' | '__resource' | 'none'; path: string | null };
    counts: { yft: number; ytd: number; meta: number; vehicles: number };
    metaFiles: { handling: string[]; vehicles: string[]; carvariations: string[]; carcols: string[]; vehiclelayouts: string[] };
    vehicles: VSVehicle[];
    diagnostics: VSDiagnostic[];
    summary: { errors: number; warnings: number; info: number };
  }
}

export {};
