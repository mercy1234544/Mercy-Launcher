// App-wide access gate. Wraps all routed pages (mounted inside Layout, so the
// Sidebar + window controls stay usable while unauthenticated). Authorization
// is decided by the backend; this only reflects it and drives the login UI.
// This file is a visual layer only — every hook, handler, and error mapping
// below is unchanged from the working authentication flow.
import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import toast from 'react-hot-toast';
import { Loader2, MessageSquare, RefreshCw, ChevronDown, Server, Package, Car, ShieldCheck } from 'lucide-react';
import { useAppAuth } from '../stores/useAppAuth';
import MercyLogo from './MercyLogo';

const FEATURES = [
  { icon: Server, label: 'Server management & console' },
  { icon: Package, label: 'Resource store & installs' },
  { icon: Car, label: 'Vehicle Studio' },
  { icon: ShieldCheck, label: 'Backups, tools & diagnostics' },
];

// The backend returns a bare { error: <code> } on /verify with no human text, so
// the client owns the wording. Codes observed from the live backend: expired,
// invalid, invalid_request; plus the client's own offline/not_configured.
const REDEEM_ERRORS: Record<string, string> = {
  expired: 'This code has expired — generate a new one.',
  invalid: 'That code is invalid or has already been used.',
  invalid_code: 'That code is invalid or has already been used.',
  invalid_request: 'That code is invalid or has already been used.',
  used: 'That code is invalid or has already been used.',
  already_used: 'That code is invalid or has already been used.',
  not_found: 'That code is invalid or has already been used.',
  too_many_attempts: 'Too many attempts — please wait a minute and try again.',
  rate_limited: 'Too many attempts — please wait a minute and try again.',
  offline: "Couldn't reach the verification server — check your connection and try again.",
  server_error: 'The verification server hit a problem — please try again in a moment.',
  not_configured: 'Verification is not configured.',
};

// Ambient glow behind the panel — same visual language as Home's hero cards
// and the sidebar, so login feels like part of the same product.
function AuthBackdrop() {
  return (
    <div className="fixed inset-0 pointer-events-none overflow-hidden">
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[900px] h-[900px] rounded-full bg-primary-600/10 blur-[140px]" />
      <div className="absolute -top-[20%] -right-[10%] w-[50%] h-[50%] rounded-full bg-indigo-600/10 blur-[120px]" />
      <div className="absolute -bottom-[20%] -left-[10%] w-[50%] h-[50%] rounded-full bg-purple-600/10 blur-[120px]" />
    </div>
  );
}

export default function AppAccessGate({ children }: { children: React.ReactNode }) {
  const { status, loading, startLogin, redeem, refresh } = useAppAuth();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showCode, setShowCode] = useState(false);

  // Checking access — never flash protected content before we know.
  if (loading || !status) {
    return (
      <div className="h-full flex items-center justify-center relative">
        <AuthBackdrop />
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="relative flex flex-col items-center gap-4">
          <MercyLogo size={48} glow />
          <div className="flex items-center gap-2 text-surface-400 text-sm"><Loader2 size={16} className="animate-spin" /> Checking access…</div>
        </motion.div>
      </div>
    );
  }

  // Verification disabled (dev override) or authorized → the app.
  if (!status.enabled || status.authorized) return <>{children}</>;

  const doRedeem = async () => {
    if (!code.trim()) return;
    setBusy(true); setErr(null);
    const r = await redeem(code.trim());
    setBusy(false);
    if (r.ok) { toast.success(`Verified${r.username ? ` as ${r.username}` : ''} — welcome!`); setCode(''); }
    else setErr(REDEEM_ERRORS[r.error || ''] || r.message || 'Verification failed.');
  };

  const reasonBanner = status.reason === 'revoked' ? 'Your access has been revoked.'
    : status.reason === 'offline' ? "Couldn't reach the verification server — check your connection and try again."
    : (status.reason === 'expired' || status.reason === 'expired_session') ? 'Your session has expired — sign in with Discord again.'
    : (status.reason === 'invalid' || status.reason === 'invalid_session') ? 'Your session is no longer valid — sign in with Discord again.'
    : status.reason === 'inactive_6h' ? "You've been signed out after 6 hours away — sign in again to continue."
    : null;

  return (
    <div className="h-full overflow-y-auto relative flex items-center justify-center p-6">
      <AuthBackdrop />
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: [0.4, 0, 0.2, 1] }}
        className="relative w-full max-w-sm my-8">
        <div className="rounded-3xl border border-overlay-6 bg-surface-900/60 backdrop-blur-xl shadow-2xl p-8 text-center">
          <div className="mx-auto mb-5 flex flex-col items-center gap-3">
            <MercyLogo size={64} glow />
            <div className="leading-none">
              <p className="text-lg font-extrabold text-surface-100 tracking-[0.14em]">MERCY</p>
              <p className="text-[11px] font-bold text-primary-400 tracking-[0.28em] uppercase">Launcher</p>
            </div>
          </div>

          <h1 className="text-lg font-extrabold text-surface-100">Welcome to Mercy Launcher</h1>
          <p className="text-sm text-surface-400 mt-1.5">Sign in with Discord to continue.</p>
          <p className="text-xs text-surface-500 mt-2 leading-relaxed">Mercy Launcher uses Discord to verify access — no separate password to remember.</p>

          <div className="grid grid-cols-2 gap-2 my-6 text-left">
            {FEATURES.map((f) => (
              <div key={f.label} className="flex items-center gap-2 rounded-xl border border-overlay-6 bg-overlay-3 px-2.5 py-2">
                <f.icon size={13} className="text-primary-300 shrink-0" />
                <span className="text-[11px] text-surface-300 leading-tight">{f.label}</span>
              </div>
            ))}
          </div>

          {reasonBanner && <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 text-amber-300 text-xs px-3 py-2 mb-4">{reasonBanner}</div>}

          <button onClick={startLogin}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-bold bg-[#5865F2] text-white hover:bg-[#6875f5] shadow-lg shadow-[#5865F2]/20 hover:shadow-[#5865F2]/30 transition-all">
            <MessageSquare size={16} /> Continue with Discord
          </button>

          <button onClick={() => setShowCode((s) => !s)}
            className="w-full flex items-center justify-center gap-1 text-[11px] text-surface-500 hover:text-surface-300 mt-4 transition-all">
            Already have a code? <ChevronDown size={12} className={`transition-transform ${showCode ? 'rotate-180' : ''}`} />
          </button>

          <AnimatePresence initial={false}>
            {showCode && (
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                <div className="flex gap-2 mt-3">
                  <input
                    value={code}
                    onChange={(e) => { setCode(e.target.value.toUpperCase()); setErr(null); }}
                    onKeyDown={(e) => e.key === 'Enter' && doRedeem()}
                    placeholder="PGMQND54Y2" spellCheck={false}
                    className="flex-1 bg-overlay-3 border border-overlay-6 rounded-lg px-3 py-2 text-sm font-mono tracking-widest text-surface-100 placeholder-surface-600 focus:outline-none focus:border-primary-500/40"
                  />
                  <button onClick={doRedeem} disabled={busy || !code.trim()} className="btn-primary text-xs px-4">{busy ? <Loader2 size={13} className="animate-spin" /> : 'Unlock'}</button>
                </div>
                {err && <p className="text-xs text-red-400 mt-2">{err}</p>}
              </motion.div>
            )}
          </AnimatePresence>

          <button onClick={refresh} className="text-[11px] text-surface-600 hover:text-surface-400 mt-5 flex items-center gap-1.5 mx-auto transition-all"><RefreshCw size={11} /> Check again</button>
        </div>
      </motion.div>
    </div>
  );
}
