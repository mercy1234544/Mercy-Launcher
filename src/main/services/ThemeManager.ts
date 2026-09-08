// Persists the user's theme choice, any custom color overrides, and their
// profile image — in userData (survives app updates/reinstalls, per the
// electron-store convention already established by SettingsManager.ts), never
// inside the packaged app directory that an update replaces wholesale.
import fs from 'fs';
import path from 'path';
import Store from 'electron-store';

export interface ThemeSchema {
  activeThemeId: string;
  /** Sparse — only tokens the user actually changed from the active preset. */
  customTokens: Record<string, string>;
  hasCustomTheme: boolean;
}

const DEFAULTS: ThemeSchema = {
  activeThemeId: 'mercy-default',
  customTokens: {},
  hasCustomTheme: false,
};

const AVATAR_BASENAME = 'avatar';
const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const MAX_AVATAR_BYTES = 8 * 1024 * 1024; // 8MB — plenty for a profile image, not a vector for bloating userData

export class ThemeManager {
  private store: Store<ThemeSchema>;
  private avatarDir: string;

  constructor(userDataPath: string) {
    this.store = new Store<ThemeSchema>({ name: 'mercy-theme', defaults: DEFAULTS });
    this.avatarDir = path.join(userDataPath, 'profile');
    if (!fs.existsSync(this.avatarDir)) fs.mkdirSync(this.avatarDir, { recursive: true });
  }

  get(): ThemeSchema {
    return {
      activeThemeId: this.store.get('activeThemeId'),
      customTokens: this.store.get('customTokens') || {},
      hasCustomTheme: this.store.get('hasCustomTheme'),
    };
  }

  setActiveTheme(id: string) {
    this.store.set('activeThemeId', id);
    this.store.set('hasCustomTheme', false);
    this.store.set('customTokens', {});
  }

  setCustomTokens(tokens: Record<string, string>) {
    this.store.set('customTokens', tokens);
    this.store.set('hasCustomTheme', true);
  }

  resetToDefault() {
    this.store.set(DEFAULTS);
  }

  // ── Profile image ──────────────────────────────────────────────────────
  private currentAvatarPath(): string | null {
    try {
      const files = fs.readdirSync(this.avatarDir).filter((f) => f.startsWith(AVATAR_BASENAME));
      return files.length ? path.join(this.avatarDir, files[0]) : null;
    } catch { return null; }
  }

  /** Copies a user-picked image into userData and returns it as a data: URL for immediate rendering. */
  setAvatar(sourcePath: string): { success: boolean; dataUrl?: string; error?: string } {
    try {
      const ext = path.extname(sourcePath).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(ext)) return { success: false, error: `Unsupported image type: ${ext || 'unknown'}` };
      const stats = fs.statSync(sourcePath);
      if (stats.size > MAX_AVATAR_BYTES) return { success: false, error: 'Image is too large (max 8MB).' };

      // Remove any previous avatar (different extension) before copying the new one.
      const existing = this.currentAvatarPath();
      if (existing) { try { fs.unlinkSync(existing); } catch {} }

      const destPath = path.join(this.avatarDir, `${AVATAR_BASENAME}${ext}`);
      fs.copyFileSync(sourcePath, destPath);
      return { success: true, dataUrl: this.readAvatarAsDataUrl(destPath) };
    } catch (e: any) {
      return { success: false, error: e?.message || 'Could not set profile image.' };
    }
  }

  private readAvatarAsDataUrl(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    const buf = fs.readFileSync(filePath);
    return `data:${mime};base64,${buf.toString('base64')}`;
  }

  /** Returns the current avatar as a data: URL, or null if none/corrupted — callers fall back to the default Mercy image. */
  getAvatar(): string | null {
    const p = this.currentAvatarPath();
    if (!p) return null;
    try { return this.readAvatarAsDataUrl(p); } catch { return null; }
  }

  removeAvatar(): boolean {
    const p = this.currentAvatarPath();
    if (!p) return true;
    try { fs.unlinkSync(p); return true; } catch { return false; }
  }
}
