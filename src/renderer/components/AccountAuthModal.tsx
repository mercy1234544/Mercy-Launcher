// Username + password sign in / sign up for the store. Email is optional (kept
// for account recovery/contact). Shown only when Supabase is configured.
import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import toast from 'react-hot-toast';
import { Loader2, Lock, User, Mail, X } from 'lucide-react';
import { useAuth } from '../stores/useAuth';

interface AccountAuthModalProps {
  open: boolean;
  onClose: () => void;
  /** Overrides the "Log in" heading shown in login mode only — every caller
   *  shares the exact same underlying Mercy username/password account
   *  system (signIn/signUp below); this is copy only, never a second auth
   *  implementation. Signup's heading ("Create account") is unaffected —
   *  every caller creates the same one Mercy account, so there's nothing
   *  context-specific to say there. */
  loginTitle?: string;
  /** Overrides the login-mode description only, for the same reason as
   *  loginTitle. Defaults to the original Marketplace/Exclusive Scripts
   *  copy so every existing caller keeps its exact current wording unless
   *  it opts in. */
  loginDescription?: string;
}

export default function AccountAuthModal({
  open, onClose,
  loginTitle = 'Log in',
  loginDescription = 'Log in to access your Exclusive scripts.',
}: AccountAuthModalProps) {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => { setError(null); setPassword(''); };

  const submit = async () => {
    setError(null);
    const u = username.trim();
    if (!u) return setError('Enter a username.');
    if (password.length < 6) return setError('Password must be at least 6 characters.');
    setBusy(true);
    const res = mode === 'login'
      ? await signIn(u, password)
      : await signUp(u, password, email || undefined);
    setBusy(false);
    if (res.error) { setError(res.error); return; }
    toast.success(mode === 'login' ? `Welcome back, ${u}!` : `Account created — welcome, ${u}!`);
    setUsername(''); setPassword(''); setEmail('');
    onClose();
  };

  const onKey = (e: React.KeyboardEvent) => { if (e.key === 'Enter') submit(); };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.92, y: 16 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.92, y: 16 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            onClick={(e) => e.stopPropagation()}
            className="glass-panel p-6 max-w-sm w-full mx-4"
          >
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-lg font-bold text-surface-100">{mode === 'login' ? loginTitle : 'Create account'}</h3>
              <button onClick={onClose} className="p-1.5 rounded-lg text-surface-500 hover:text-surface-100 hover:bg-overlay-6 transition-all"><X size={16} /></button>
            </div>
            <p className="text-xs text-surface-400 mb-4">
              {mode === 'login' ? loginDescription : 'Pick a username and password. Email is optional (for recovery).'}
            </p>

            <div className="space-y-2.5">
              <div className="relative">
                <User size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-500" />
                <input
                  value={username} onChange={(e) => { setUsername(e.target.value); reset(); }} onKeyDown={onKey}
                  placeholder="Username" autoFocus spellCheck={false}
                  className="w-full bg-overlay-3 border border-overlay-6 rounded-xl pl-9 pr-3 py-2.5 text-sm text-surface-100 placeholder-surface-600 focus:outline-none focus:border-primary-500/40"
                />
              </div>
              <div className="relative">
                <Lock size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-500" />
                <input
                  type="password" value={password} onChange={(e) => { setPassword(e.target.value); reset(); }} onKeyDown={onKey}
                  placeholder="Password"
                  className="w-full bg-overlay-3 border border-overlay-6 rounded-xl pl-9 pr-3 py-2.5 text-sm text-surface-100 placeholder-surface-600 focus:outline-none focus:border-primary-500/40"
                />
              </div>
              {mode === 'signup' && (
                <div className="relative">
                  <Mail size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-500" />
                  <input
                    type="email" value={email} onChange={(e) => { setEmail(e.target.value); reset(); }} onKeyDown={onKey}
                    placeholder="Email (optional — for recovery)"
                    className="w-full bg-overlay-3 border border-overlay-6 rounded-xl pl-9 pr-3 py-2.5 text-sm text-surface-100 placeholder-surface-600 focus:outline-none focus:border-primary-500/40"
                  />
                </div>
              )}
            </div>

            {error && <p className="text-xs text-red-400 mt-2.5">{error}</p>}

            <button
              onClick={submit} disabled={busy}
              className="w-full mt-4 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-bold bg-primary-600 text-white hover:bg-primary-500 transition-all disabled:opacity-60"
            >
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Lock size={15} />}
              {mode === 'login' ? 'Log in' : 'Create account'}
            </button>

            <button
              onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); reset(); }}
              className="w-full mt-3 text-xs text-surface-400 hover:text-surface-200 transition-colors"
            >
              {mode === 'login' ? "Don't have an account? Sign up" : 'Already have an account? Log in'}
            </button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
