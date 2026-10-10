// Detached Ed25519 signature check for catalog.json. The signature covers the RAW BYTES that were downloaded
// (never a re-serialisation), and is verified against a public key the owner pinned in the launcher — a key
// that arrives in the same download as the catalog would prove nothing.
import * as crypto from 'crypto';

export interface TrustedKey { keyId: string; publicKey: string }
export interface SignatureDoc { alg: 'ed25519'; keyId: string; signedAt: string; catalogSha256: string; signature: string }
export type SignatureCheck =
  | { ok: true; keyId: string; signedAt: string; catalogSha256: string }
  | { ok: false; code: 'no-keys' | 'bad-key' | 'malformed' | 'unknown-key' | 'hash-mismatch' | 'bad-signature'; message: string };

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
export const sha256Hex = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');

/** Accepts a PEM SPKI public key, or a base64 / base64url raw 32-byte Ed25519 key. Returns null when it is neither. */
export function parsePublicKey(text: string): crypto.KeyObject | null {
  const t = (text || '').trim();
  try {
    if (t.includes('BEGIN PUBLIC KEY')) { const k = crypto.createPublicKey(t); return k.asymmetricKeyType === 'ed25519' ? k : null; }
    const raw = Buffer.from(t.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (raw.length !== 32) return null;
    return crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: 'der', type: 'spki' });
  } catch { return null; }
}

export function parseSignatureDoc(text: string): SignatureDoc | null {
  if (typeof text !== 'string' || text.length > 4096) return null;
  try {
    const d = JSON.parse(text);
    if (!d || typeof d !== 'object') return null;
    if (d.alg !== 'ed25519') return null;
    if (typeof d.keyId !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(d.keyId)) return null;
    if (typeof d.signedAt !== 'string' || Number.isNaN(Date.parse(d.signedAt))) return null;
    if (typeof d.catalogSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(d.catalogSha256)) return null;
    if (typeof d.signature !== 'string' || !/^[A-Za-z0-9+/_-]+=*$/.test(d.signature)) return null;
    return d as SignatureDoc;
  } catch { return null; }
}

export function verifyCatalogSignature(catalogBytes: Buffer, signatureText: string, trusted: TrustedKey[]): SignatureCheck {
  if (!trusted.length) return { ok: false, code: 'no-keys', message: 'No signing key is pinned in Mercy Launcher yet, so the catalog cannot be trusted.' };
  const doc = parseSignatureDoc(signatureText);
  if (!doc) return { ok: false, code: 'malformed', message: 'The catalog signature file is malformed.' };
  const entry = trusted.find((k) => k.keyId === doc.keyId);
  if (!entry) return { ok: false, code: 'unknown-key', message: `The catalog is signed with key "${doc.keyId}", which is not one of the keys pinned in Mercy Launcher.` };
  const key = parsePublicKey(entry.publicKey);
  if (!key) return { ok: false, code: 'bad-key', message: `The pinned public key "${entry.keyId}" is not a valid Ed25519 key.` };
  const digest = sha256Hex(catalogBytes);
  if (digest !== doc.catalogSha256) return { ok: false, code: 'hash-mismatch', message: 'The signature does not describe the catalog that was downloaded (the files may be from different publishes).' };
  let valid = false;
  try { valid = crypto.verify(null, catalogBytes, key, Buffer.from(doc.signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64')); } catch { valid = false; }
  if (!valid) return { ok: false, code: 'bad-signature', message: 'The catalog signature is not valid for the pinned key — the catalog may have been tampered with.' };
  return { ok: true, keyId: doc.keyId, signedAt: doc.signedAt, catalogSha256: digest };
}
