import Store from 'electron-store';

// Securely remembers the Mercy account's username/password (the same
// Supabase username+password account used for Friends/Presence — see
// src/renderer/stores/useAuth.ts), so the launcher can silently
// re-authenticate after a real Supabase session/refresh-token has actually
// expired, without asking the user to retype their password every time.
//
// The password itself is NEVER written to disk in plaintext. It is
// encrypted with Electron's `safeStorage` — backed by the OS's own
// credential facility (DPAPI on Windows, Keychain on macOS, libsecret on
// Linux) — and only the resulting ciphertext (base64) is persisted, via the
// same electron-store convention every other main-process manager in this
// app already uses (see SettingsManager.ts/PresenceManager.ts). Decryption
// only ever happens in the main process, on demand, and the plaintext
// password is handed to the renderer over IPC only for the single moment a
// real signInWithPassword() call needs it — never persisted anywhere in
// the renderer (no localStorage, no zustand-persisted state).
//
// `safeStorage` is injected (never imported from 'electron' directly) so
// this class stays testable under a plain `node` test process — exactly
// the same reason PresenceManager.ts takes an explicit `userDataPath`
// instead of relying on electron-store's own Electron-app auto-detection.
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(buffer: Buffer): string;
}

interface StoredCredential {
  username: string;
  /** base64-encoded ciphertext from safeStorage.encryptString() — never a
   *  plaintext password. */
  encrypted: string;
}

interface CredentialSchema {
  credential: StoredCredential | null;
}

export class MercyCredentialStore {
  private store: Store<CredentialSchema>;

  constructor(userDataPath: string, private safeStorage: SafeStorageLike) {
    this.store = new Store<CredentialSchema>({
      name: 'mercy-credentials', cwd: userDataPath,
      defaults: { credential: null },
    });
  }

  /** Encrypts and persists the given username/password. Returns false (and
   *  persists nothing) if the OS's secure storage isn't available on this
   *  machine — callers must treat that as "credentials were NOT
   *  remembered", never silently fall back to plaintext. */
  save(username: string, password: string): boolean {
    if (!this.safeStorage.isEncryptionAvailable()) return false;
    const encrypted = this.safeStorage.encryptString(password).toString('base64');
    this.store.set('credential', { username, encrypted });
    return true;
  }

  /** Decrypts and returns the stored credential, or null if none is stored
   *  or the OS's secure storage is unavailable/the ciphertext can no longer
   *  be decrypted (e.g. the OS-level key changed) — never throws. */
  load(): { username: string; password: string } | null {
    const cred = this.store.get('credential');
    if (!cred) return null;
    if (!this.safeStorage.isEncryptionAvailable()) return null;
    try {
      const password = this.safeStorage.decryptString(Buffer.from(cred.encrypted, 'base64'));
      return { username: cred.username, password };
    } catch {
      return null;
    }
  }

  /** Whether a credential is stored — safe to check without ever touching
   *  the OS decryption path (e.g. for UI state like "Connected as: X"). */
  hasStored(): boolean {
    return !!this.store.get('credential');
  }

  /** The stored username only, without decrypting the password — for
   *  display purposes ("Connected as: X") without an unnecessary decrypt. */
  getStoredUsername(): string | null {
    return this.store.get('credential')?.username ?? null;
  }

  clear(): void {
    this.store.set('credential', null);
  }
}
