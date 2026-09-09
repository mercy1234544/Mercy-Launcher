// In-app Admin Panel: search accounts by username and grant/revoke Exclusive
// scripts; owners can also promote/demote admins. Visible only to admins/owners.
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import toast from 'react-hot-toast';
import { Shield, Search, Loader2, Check, Crown, User as UserIcon, ShieldCheck, Lock, KeyRound, LogOut, Copy, ArrowLeft } from 'lucide-react';
import { useAuth } from '../stores/useAuth';
import { useLocalAccess, codeForItem } from '../stores/useLocalAccess';
import { isSupabaseConfigured, Profile, Role } from '../lib/supabase';
import { EXCLUSIVE_ITEMS } from './Marketplace';

const roleBadge: Record<Role, { label: string; cls: string; icon: any }> = {
  owner: { label: 'Owner', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30', icon: Crown },
  admin: { label: 'Admin', cls: 'bg-primary-500/15 text-primary-300 border-primary-500/30', icon: ShieldCheck },
  user:  { label: 'User',  cls: 'bg-overlay-6 text-surface-400 border-overlay-8', icon: UserIcon },
};

export default function AdminPanel() {
  const navigate = useNavigate();
  const { profile, searchUsers, getUserEntitlements, grant, revoke, setRole } = useAuth();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Profile[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<Profile | null>(null);
  const [selEnts, setSelEnts] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const isAdmin = profile?.role === 'admin' || profile?.role === 'owner';
  const isOwner = profile?.role === 'owner';

  const runSearch = async () => {
    setSearching(true);
    try { setResults(await searchUsers(query)); }
    finally { setSearching(false); }
  };

  const pick = async (u: Profile) => {
    setSelected(u);
    setSelEnts(await getUserEntitlements(u.id));
  };

  const toggle = async (scriptId: string) => {
    if (!selected) return;
    setBusy(scriptId);
    const has = selEnts.includes(scriptId);
    const res = has ? await revoke(selected.id, scriptId) : await grant(selected.id, scriptId);
    if (res.error) toast.error(res.error);
    else {
      setSelEnts((e) => has ? e.filter((x) => x !== scriptId) : [...e, scriptId]);
      toast.success(`${has ? 'Revoked' : 'Granted'} ${scriptId} ${has ? 'from' : 'to'} ${selected.username}`);
    }
    setBusy(null);
  };

  const changeRole = async (role: Role) => {
    if (!selected) return;
    setBusy('role');
    const res = await setRole(selected.id, role);
    if (res.error) toast.error(res.error);
    else {
      setSelected({ ...selected, role });
      setResults((rs) => rs.map((r) => r.id === selected.id ? { ...r, role } : r));
      toast.success(`${selected.username} is now ${role}`);
    }
    setBusy(null);
  };

  // ── Gates ──────────────────────────────────────────────────────────────────
  // No database yet → local, code-gated admin mode.
  if (!isSupabaseConfigured()) return <LocalAdmin />;
  if (!profile) {
    return <Gate icon={<Lock size={40} className="text-surface-600" />} title="Log in required"
      text="Log in from the Marketplace to use the Admin Panel." />;
  }
  if (!isAdmin) {
    return <Gate icon={<Shield size={40} className="text-surface-600" />} title="Admins only"
      text="Your account doesn't have admin access." />;
  }

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="p-6 space-y-5 max-w-6xl mx-auto">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate(-1)} className="p-2 rounded-lg text-surface-500 hover:text-surface-100 hover:bg-overlay-6 transition-colors shrink-0"><ArrowLeft size={16} /></button>
        <div>
          <h1 className="text-2xl font-bold text-surface-100 flex items-center gap-2"><Shield size={22} className="text-primary-400" /> Admin Panel</h1>
          <p className="text-sm text-surface-400 mt-1">
            Search an account and grant Exclusive scripts. {isOwner ? 'As owner, you can also promote admins.' : 'Ask the owner to change roles.'}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Search + results */}
        <div className="card">
          <div className="flex gap-2 mb-3">
            <div className="relative flex-1">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-500" />
              <input
                value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runSearch()}
                placeholder="Search username… (blank = newest accounts)"
                className="w-full bg-overlay-3 border border-overlay-6 rounded-xl pl-9 pr-3 py-2 text-sm text-surface-100 placeholder-surface-600 focus:outline-none focus:border-primary-500/40"
              />
            </div>
            <button onClick={runSearch} disabled={searching} className="btn-primary text-xs px-4">
              {searching ? <Loader2 size={13} className="animate-spin" /> : 'Search'}
            </button>
          </div>

          <div className="space-y-1 max-h-[420px] overflow-y-auto">
            {results.length === 0 ? (
              <p className="text-center text-sm text-surface-500 py-10">Search to find accounts</p>
            ) : results.map((u) => {
              const b = roleBadge[u.role];
              return (
                <button key={u.id} onClick={() => pick(u)}
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl border text-left transition-all ${
                    selected?.id === u.id ? 'bg-primary-500/10 border-primary-500/30' : 'border-overlay-4 bg-overlay-2 hover:bg-overlay-4'
                  }`}>
                  <div className="w-8 h-8 rounded-lg bg-overlay-4 flex items-center justify-center shrink-0"><UserIcon size={14} className="text-surface-400" /></div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-surface-100 truncate">{u.username}</p>
                    {u.email && <p className="text-[10px] text-surface-500 truncate">{u.email}</p>}
                  </div>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded border shrink-0 flex items-center gap-1 ${b.cls}`}><b.icon size={9} /> {b.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Selected account */}
        <div className="card">
          {!selected ? (
            <div className="text-center py-16 text-surface-500 text-sm">Select an account to manage its access</div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-xl bg-primary-500/15 border border-primary-500/25 flex items-center justify-center shrink-0"><UserIcon size={19} className="text-primary-300" /></div>
                <div className="min-w-0 flex-1">
                  <p className="font-bold text-surface-100 truncate">{selected.username}</p>
                  <p className="text-[11px] text-surface-500 truncate">{selected.email || 'no email on file'}</p>
                </div>
                <span className={`text-[10px] px-2 py-0.5 rounded border shrink-0 flex items-center gap-1 ${roleBadge[selected.role].cls}`}>
                  {React.createElement(roleBadge[selected.role].icon, { size: 10 })} {roleBadge[selected.role].label}
                </span>
              </div>

              {/* Script access */}
              <div>
                <p className="text-[10px] uppercase tracking-wider text-surface-500 mb-2">Exclusive scripts</p>
                <div className="space-y-1.5">
                  {EXCLUSIVE_ITEMS.map((s) => {
                    const has = selEnts.includes(s.id);
                    return (
                      <div key={s.id} className="flex items-center gap-3 px-3 py-2 rounded-xl border border-overlay-4 bg-overlay-2">
                        <Crown size={13} className="text-amber-400 shrink-0" />
                        <span className="text-sm text-surface-100 flex-1 truncate">{s.name}</span>
                        <button onClick={() => toggle(s.id)} disabled={busy === s.id}
                          className={`text-xs font-semibold px-3 py-1.5 rounded-lg border transition-all ${
                            has ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30 hover:bg-red-500/15 hover:text-red-300 hover:border-red-500/30'
                                : 'bg-overlay-4 text-surface-300 border-overlay-6 hover:bg-primary-600 hover:text-white'
                          }`}>
                          {busy === s.id ? <Loader2 size={12} className="animate-spin" /> : has ? <span className="flex items-center gap-1"><Check size={12} /> Granted</span> : 'Grant'}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Role management (owner only) */}
              {isOwner && (
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-surface-500 mb-2">Role</p>
                  <div className="flex gap-2">
                    {(['user', 'admin', 'owner'] as Role[]).map((r) => (
                      <button key={r} onClick={() => changeRole(r)} disabled={busy === 'role' || selected.role === r}
                        className={`flex-1 text-xs font-semibold py-2 rounded-lg border transition-all capitalize disabled:opacity-100 ${
                          selected.role === r ? roleBadge[r].cls : 'bg-overlay-3 text-surface-300 border-overlay-6 hover:bg-overlay-6'
                        }`}>
                        {r}
                      </button>
                    ))}
                  </div>
                  <p className="text-[10px] text-surface-600 mt-2">Admins grant scripts. Owners can also change roles.</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}

function Gate({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="card flex flex-col items-center text-center py-20">
        <div className="mb-3">{icon}</div>
        <h2 className="text-lg font-bold text-surface-100">{title}</h2>
        <p className="text-sm text-surface-400 mt-1 max-w-sm">{text}</p>
      </div>
    </div>
  );
}

// ── Local (no-database) admin: 4-digit code gate + local Exclusive unlocks ────
function LocalAdmin() {
  const navigate = useNavigate();
  const { hasPin, unlocked, granted, setPin, tryPin, grant, revoke, lock, changePin } = useLocalAccess();
  const [code, setCode] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);

  const onlyDigits = (v: string) => v.replace(/\D/g, '').slice(0, 4);

  const submit = () => {
    setErr(null);
    if (code.length !== 4) return setErr('Enter a 4-digit code.');
    if (!hasPin) {
      if (confirm !== code) return setErr('The two codes don’t match.');
      setPin(code);
      toast.success('Admin code set');
    } else {
      if (!tryPin(code)) { setErr('Wrong code.'); setCode(''); return; }
    }
    setCode(''); setConfirm('');
  };

  // ── Code screen ─────────────────────────────────────────────────────────────
  if (!unlocked) {
    return (
      <div className="p-6 max-w-6xl mx-auto">
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="card max-w-sm mx-auto mt-10 flex flex-col items-center text-center py-10 px-6">
          <div className="w-14 h-14 rounded-2xl bg-primary-500/15 border border-primary-500/25 flex items-center justify-center mb-4"><KeyRound size={24} className="text-primary-300" /></div>
          <h2 className="text-lg font-bold text-surface-100">{hasPin ? 'Enter admin code' : 'Set an admin code'}</h2>
          <p className="text-xs text-surface-400 mt-1 mb-5 max-w-xs">
            {hasPin ? 'Enter your 4-digit code to open the Admin Panel.' : 'Pick a 4-digit code to protect the Admin Panel on this machine.'}
          </p>
          <input
            value={code} onChange={(e) => { setCode(onlyDigits(e.target.value)); setErr(null); }} onKeyDown={(e) => e.key === 'Enter' && (hasPin || confirm) && submit()}
            inputMode="numeric" autoFocus placeholder="••••"
            className="w-40 text-center tracking-[0.5em] text-2xl font-bold bg-overlay-3 border border-overlay-6 rounded-xl py-3 text-surface-100 placeholder-surface-600 focus:outline-none focus:border-primary-500/40"
          />
          {!hasPin && (
            <input
              value={confirm} onChange={(e) => { setConfirm(onlyDigits(e.target.value)); setErr(null); }} onKeyDown={(e) => e.key === 'Enter' && submit()}
              inputMode="numeric" placeholder="confirm"
              className="w-40 mt-2 text-center tracking-[0.4em] text-lg font-bold bg-overlay-3 border border-overlay-6 rounded-xl py-2 text-surface-100 placeholder-surface-600 focus:outline-none focus:border-primary-500/40"
            />
          )}
          {err && <p className="text-xs text-red-400 mt-3">{err}</p>}
          <button onClick={submit} className="btn-primary w-full mt-5 text-sm">{hasPin ? 'Unlock' : 'Set code'}</button>
        </motion.div>
      </div>
    );
  }

  // ── Unlocked: local exclusive grants ────────────────────────────────────────
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="p-6 space-y-5 max-w-3xl mx-auto">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate(-1)} className="p-2 rounded-lg text-surface-500 hover:text-surface-100 hover:bg-overlay-6 transition-colors shrink-0"><ArrowLeft size={16} /></button>
          <div>
            <h1 className="text-2xl font-bold text-surface-100 flex items-center gap-2"><Shield size={22} className="text-primary-400" /> Admin Panel</h1>
            <p className="text-sm text-surface-400 mt-1">Local mode — unlock Exclusive scripts on this machine.</p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={() => setChanging((v) => !v)} className="btn-secondary text-xs py-2">Change code</button>
          <button onClick={lock} className="flex items-center gap-1.5 btn-secondary text-xs py-2"><LogOut size={13} /> Lock</button>
        </div>
      </div>

      {changing && <ChangeCode onDone={() => setChanging(false)} changePin={changePin} />}

      <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-xs text-amber-200 leading-relaxed">
        Give a customer the code for their script and they redeem it in the Marketplace (locked item → “Have a code?”).
        Codes change weekly, so an old shared code stops working — anyone who already redeemed keeps access.
        When the account system is connected, this becomes real one-time codes per person.
      </div>

      <div className="card">
        <p className="text-[10px] uppercase tracking-wider text-surface-500 mb-2">Exclusive scripts &amp; redemption codes</p>
        <div className="space-y-2">
          {EXCLUSIVE_ITEMS.length === 0 ? (
            <p className="text-sm text-surface-500 py-6 text-center">No exclusive scripts in the store.</p>
          ) : EXCLUSIVE_ITEMS.map((s) => {
            const has = granted.includes(s.id);
            const code = codeForItem(s.id);
            return (
              <div key={s.id} className="px-3 py-2.5 rounded-xl border border-overlay-4 bg-overlay-2">
                <div className="flex items-center gap-3">
                  <Crown size={13} className="text-amber-400 shrink-0" />
                  <span className="text-sm font-semibold text-surface-100 flex-1 truncate">{s.name}</span>
                  <button onClick={() => { has ? revoke(s.id) : grant(s.id); toast.success(`${has ? 'Locked' : 'Unlocked'} ${s.name} here`); }}
                    className={`text-[11px] font-semibold px-2.5 py-1 rounded-lg border transition-all ${
                      has ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30 hover:bg-red-500/15 hover:text-red-300 hover:border-red-500/30'
                          : 'bg-overlay-4 text-surface-300 border-overlay-6 hover:bg-primary-600 hover:text-white'
                    }`} title="Unlock on this machine (for testing)">
                    {has ? <span className="flex items-center gap-1"><Check size={11} /> Unlocked here</span> : 'Unlock here'}
                  </button>
                </div>
                <div className="mt-2 flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] uppercase tracking-wider text-surface-500">Code</span>
                  <code className="text-base font-mono font-bold tracking-[0.3em] text-primary-300 bg-[#0d1117] px-3 py-1 rounded-lg border border-overlay-6">{code}</code>
                  <button onClick={() => { navigator.clipboard.writeText(code); toast.success('Code copied'); }}
                    className="flex items-center gap-1 text-[11px] text-surface-400 hover:text-surface-100 px-2 py-1 rounded-lg hover:bg-overlay-6 transition-all">
                    <Copy size={12} /> Copy
                  </button>
                  <span className="text-[10px] text-surface-600">changes weekly</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </motion.div>
  );
}

function ChangeCode({ onDone, changePin }: { onDone: () => void; changePin: (o: string, n: string) => boolean }) {
  const [oldC, setOldC] = useState('');
  const [newC, setNewC] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const d = (v: string) => v.replace(/\D/g, '').slice(0, 4);
  const save = () => {
    if (newC.length !== 4) return setErr('New code must be 4 digits.');
    if (!changePin(oldC, newC)) return setErr('Current code is wrong.');
    toast.success('Code changed');
    onDone();
  };
  return (
    <div className="card flex flex-wrap items-end gap-2">
      <div>
        <label className="text-[10px] uppercase tracking-wider text-surface-500">Current</label>
        <input value={oldC} onChange={(e) => { setOldC(d(e.target.value)); setErr(null); }} inputMode="numeric" placeholder="••••"
          className="block w-24 text-center tracking-widest bg-overlay-3 border border-overlay-6 rounded-lg py-1.5 text-surface-100 placeholder-surface-600 focus:outline-none focus:border-primary-500/40" />
      </div>
      <div>
        <label className="text-[10px] uppercase tracking-wider text-surface-500">New</label>
        <input value={newC} onChange={(e) => { setNewC(d(e.target.value)); setErr(null); }} inputMode="numeric" placeholder="••••"
          className="block w-24 text-center tracking-widest bg-overlay-3 border border-overlay-6 rounded-lg py-1.5 text-surface-100 placeholder-surface-600 focus:outline-none focus:border-primary-500/40" />
      </div>
      <button onClick={save} className="btn-primary text-xs py-2">Save</button>
      <button onClick={onDone} className="btn-secondary text-xs py-2">Cancel</button>
      {err && <p className="text-xs text-red-400 w-full">{err}</p>}
    </div>
  );
}
