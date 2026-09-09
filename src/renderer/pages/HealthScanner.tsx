import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import toast from 'react-hot-toast';
import {
  HeartPulse,
  AlertCircle,
  AlertTriangle,
  Info,
  CheckCircle2,
  Loader2,
  Wrench,
  RefreshCw,
  Shield,
  ArrowLeft,
} from 'lucide-react';
import { useAppStore } from '../stores/useAppStore';

interface HealthIssue {
  id: string;
  severity: 'error' | 'warning' | 'info';
  category: string;
  message: string;
  resource?: string;
  file?: string;
  suggestion?: string;
  autoFixable: boolean;
}

interface HealthReport {
  timestamp: string;
  issues: HealthIssue[];
  score: number;
  summary: { errors: number; warnings: number; info: number };
}

const severityConfig = {
  error: { icon: AlertCircle, color: 'text-red-400', bg: 'bg-red-400/10', border: 'border-red-500/30', label: 'Error' },
  warning: { icon: AlertTriangle, color: 'text-amber-400', bg: 'bg-amber-400/10', border: 'border-amber-500/30', label: 'Warning' },
  info: { icon: Info, color: 'text-blue-400', bg: 'bg-blue-400/10', border: 'border-blue-500/30', label: 'Info' },
};

const DEMO_REPORT: HealthReport = {
  timestamp: new Date().toISOString(),
  issues: [
    { id: '1', severity: 'error', category: 'Configuration', message: 'License key has not been set', suggestion: 'Set your FiveM license key from keymaster.fivem.net', autoFixable: false },
    { id: '2', severity: 'warning', category: 'Resources', message: 'esx_mechanicjob uses deprecated __resource.lua', resource: 'esx_mechanicjob', suggestion: 'Migrate to fxmanifest.lua format', autoFixable: false },
    { id: '3', severity: 'warning', category: 'Configuration', message: 'OneSync is not explicitly configured', suggestion: 'Add "set onesync on" to enable OneSync', autoFixable: true },
    { id: '4', severity: 'info', category: 'Resources', message: 'old_resource has no manifest file', resource: 'old_resource', suggestion: 'Add a fxmanifest.lua or remove this resource', autoFixable: false },
    { id: '5', severity: 'warning', category: 'Startup Order', message: 'ox_lib should load before framework resources', suggestion: 'Move ox_lib above es_extended in server.cfg', autoFixable: true },
  ],
  score: 65,
  summary: { errors: 1, warnings: 3, info: 1 },
};

export default function HealthScanner() {
  const navigate = useNavigate();
  const { activeServerId, servers, logAction } = useAppStore();
  const [report, setReport] = useState<HealthReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [fixing, setFixing] = useState<string | null>(null);
  const [fixingAll, setFixingAll] = useState(false);
  const [fixProgress, setFixProgress] = useState('');

  const activeServer = servers.find(s => s.id === activeServerId);

  // Live progress from long-running fixes (e.g. downloading MariaDB)
  React.useEffect(() => {
    const api = (window as any).electronAPI;
    if (!api?.health?.onFixProgress) return;
    const cleanup = api.health.onFixProgress((data: { message: string }) => {
      setFixProgress(data.message);
    });
    return cleanup;
  }, []);

  // A fix call can return the new { success, error } object or a legacy boolean
  const fixResultOk = (result: any): { ok: boolean; error?: string } => {
    if (result === true) return { ok: true };
    if (result && typeof result === 'object') return { ok: !!result.success, error: result.error };
    return { ok: false, error: 'Fix did not apply' };
  };

  const runScan = async () => {
    if (!activeServer) return;
    setLoading(true);
    try {
      let result: HealthReport;
      if (window.electronAPI) {
        result = await window.electronAPI.health.scan(activeServer.installPath);
      } else {
        await new Promise(r => setTimeout(r, 1500));
        result = DEMO_REPORT;
      }
      setReport(result);
      logAction('Health Scan', `Score: ${result.score}/100 â€” ${result.issues.length} issues`, result.score > 70 ? 'success' : 'warning');
      if (result.issues.length === 0) toast.success('No issues found!');
    } catch {
      toast.error('Scan failed');
    } finally {
      setLoading(false);
    }
  };

  const fixAll = async () => {
    if (!activeServer || !report) return;
    const fixable = report.issues.filter(i => i.autoFixable);
    if (fixable.length === 0) { toast('No auto-fixable issues'); return; }

    setFixingAll(true);
    let fixed = 0;
    const failures: string[] = [];
    for (const issue of fixable) {
      setFixing(issue.id);
      setFixProgress('');
      try {
        if (window.electronAPI) {
          const result = await window.electronAPI.health.fix(activeServer.installPath, issue);
          const { ok, error } = fixResultOk(result);
          if (ok) fixed++;
          else failures.push(`${issue.message}: ${error}`);
        }
      } catch (err: any) {
        failures.push(`${issue.message}: ${err?.message || 'error'}`);
      }
    }
    setFixing(null);
    setFixingAll(false);
    setFixProgress('');

    // Re-scan to get fresh results
    setLoading(true);
    try {
      const result = await window.electronAPI.health.scan(activeServer.installPath);
      setReport(result);
      logAction('Fix All', `Fixed ${fixed}/${fixable.length} issues, re-scanned`, failures.length ? 'warning' : 'success');
    } catch {
      setReport(prev => prev ? { ...prev, issues: prev.issues.filter(i => !i.autoFixable) } : null);
    }
    setLoading(false);

    if (fixed > 0) toast.success(`Fixed ${fixed} issue${fixed !== 1 ? 's' : ''}`);
    for (const f of failures.slice(0, 3)) toast.error(f, { duration: 8000 });
    if (failures.length > 3) toast.error(`...and ${failures.length - 3} more fixes failed`, { duration: 8000 });
  };

  const fixIssue = async (issue: HealthIssue) => {
    if (!activeServer) return;
    setFixing(issue.id);
    setFixProgress('');
    try {
      let ok = true;
      let error: string | undefined;
      if (window.electronAPI) {
        const result = await window.electronAPI.health.fix(activeServer.installPath, issue);
        ({ ok, error } = fixResultOk(result));
      } else {
        await new Promise(r => setTimeout(r, 600));
      }

      if (!ok) {
        toast.error(error || 'Could not fix this issue', { duration: 8000 });
        logAction('Fix Failed', `${issue.message} — ${error}`, 'error');
        return;
      }

      setReport(prev => prev ? {
        ...prev,
        issues: prev.issues.filter(i => i.id !== issue.id),
        score: Math.min(100, prev.score + 10),
        summary: {
          ...prev.summary,
          [issue.severity + 's']: Math.max(0, (prev.summary as any)[issue.severity + 's'] - 1),
        },
      } : null);
      toast.success(`Fixed: ${issue.message}`);
      logAction('Issue Fixed', issue.message, 'success');
    } catch (err: any) {
      toast.error(err?.message || 'Could not fix this issue');
    } finally {
      setFixing(null);
      setFixProgress('');
    }
  };

  if (!activeServer) {
    return (
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center justify-center h-full">
        <HeartPulse size={48} className="text-surface-600 mb-4" />
        <p className="text-surface-400 mb-1">No server selected</p>
        <p className="text-xs text-surface-500">Select a server to run health diagnostics</p>
      </motion.div>
    );
  }

  const scoreColor = (score: number) =>
    score >= 80 ? 'text-green-500' : score >= 50 ? 'text-amber-500' : 'text-red-500';

  const scoreStrokeColor = (score: number) =>
    score >= 80 ? 'stroke-green-500' : score >= 50 ? 'stroke-amber-500' : 'stroke-red-500';

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate(-1)} className="p-2 rounded-lg text-surface-500 hover:text-surface-100 hover:bg-overlay-6 transition-colors shrink-0"><ArrowLeft size={16} /></button>
          <div>
            <h1 className="text-2xl font-bold text-surface-100">Health Scanner</h1>
            <p className="text-sm text-surface-400 mt-1">Diagnose issues with {activeServer.name}</p>
          </div>
        </div>
        <button onClick={runScan} disabled={loading} className="btn-primary flex items-center gap-2">
          {loading ? <Loader2 size={16} className="animate-spin" /> : <HeartPulse size={16} />}
          {loading ? 'Scanning...' : 'Run Scan'}
        </button>
      </div>

      {/* Live progress while a fix runs (e.g. downloading MariaDB) */}
      {(fixing || fixingAll) && fixProgress && (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-primary-600/10 border border-primary-500/30 text-sm text-primary-300">
          <Loader2 size={14} className="animate-spin shrink-0" />
          <span>{fixProgress}</span>
        </div>
      )}
      <div className="hidden">
      </div>

      {!report && !loading && (
        <div className="glass-panel flex flex-col items-center py-16">
          <Shield size={48} className="text-surface-600 mb-4" />
          <p className="text-surface-300 font-medium mb-1">Ready to scan</p>
          <p className="text-xs text-surface-500">Click "Run Scan" to check your server for issues</p>
        </div>
      )}

      {loading && (
        <div className="glass-panel flex flex-col items-center py-16">
          <Loader2 size={40} className="animate-spin text-primary-500 mb-4" />
          <p className="text-surface-300">Analyzing server configuration...</p>
          <p className="text-xs text-surface-500 mt-1">Checking resources, dependencies, and startup order</p>
        </div>
      )}

      {report && !loading && (
        <>
          {/* Score Card */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="glass-panel p-6"
          >
            <div className="flex items-center gap-8">
              <div className="relative w-28 h-28 shrink-0">
                <svg className="w-28 h-28 -rotate-90" viewBox="0 0 100 100">
                  <circle cx="50" cy="50" r="42" fill="none" stroke="currentColor" strokeWidth="6" className="text-surface-800" />
                  <circle
                    cx="50" cy="50" r="42" fill="none" strokeWidth="6"
                    strokeDasharray={`${report.score * 2.64} 264`}
                    strokeLinecap="round"
                    className={scoreStrokeColor(report.score)}
                  />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className={`text-3xl font-bold ${scoreColor(report.score)}`}>{report.score}</span>
                  <span className="text-[10px] text-surface-400">/ 100</span>
                </div>
              </div>

              <div className="flex-1">
                <h3 className="text-lg font-semibold text-surface-100 mb-3">
                  {report.score >= 80 ? 'Looking Good!' : report.score >= 50 ? 'Needs Attention' : 'Critical Issues Found'}
                </h3>
                <div className="grid grid-cols-3 gap-4">
                  <div className="text-center p-3 bg-red-500/10 rounded-xl border border-red-500/20">
                    <p className="text-xl font-bold text-red-400">{report.summary.errors}</p>
                    <p className="text-[10px] text-red-300/70 mt-0.5">Errors</p>
                  </div>
                  <div className="text-center p-3 bg-amber-500/10 rounded-xl border border-amber-500/20">
                    <p className="text-xl font-bold text-amber-400">{report.summary.warnings}</p>
                    <p className="text-[10px] text-amber-300/70 mt-0.5">Warnings</p>
                  </div>
                  <div className="text-center p-3 bg-blue-500/10 rounded-xl border border-blue-500/20">
                    <p className="text-xl font-bold text-blue-400">{report.summary.info}</p>
                    <p className="text-[10px] text-blue-300/70 mt-0.5">Info</p>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>

          {/* Fix All + Re-scan bar */}
          {report.issues.length > 0 && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-surface-400">{report.issues.length} issue{report.issues.length !== 1 ? 's' : ''} found</p>
              <div className="flex items-center gap-2">
                {report.issues.some(i => i.autoFixable) && (
                  <button
                    onClick={fixAll}
                    disabled={fixingAll}
                    className="flex items-center gap-1.5 px-4 py-2 text-sm bg-green-600/20 text-green-400 border border-green-500/30 rounded-lg hover:bg-green-600/30 transition-all font-medium disabled:opacity-50"
                  >
                    {fixingAll ? <Loader2 size={14} className="animate-spin" /> : <Wrench size={14} />}
                    Fix All ({report.issues.filter(i => i.autoFixable).length})
                  </button>
                )}
                <button onClick={runScan} className="flex items-center gap-1.5 px-3 py-2 text-sm btn-secondary">
                  <RefreshCw size={14} /> Re-scan
                </button>
              </div>
            </div>
          )}

          {/* Issues List */}
          <div className="space-y-2">
            {report.issues.length === 0 ? (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="card flex items-center gap-3 py-8 justify-center"
              >
                <CheckCircle2 size={28} className="text-green-400" />
                <span className="text-green-300 font-semibold text-lg">All checks passed!</span>
              </motion.div>
            ) : (
              report.issues.map((issue, i) => {
                const cfg = severityConfig[issue.severity];
                const Icon = cfg.icon;
                return (
                  <motion.div
                    key={issue.id}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.05 }}
                    className={`card border ${cfg.border} flex items-start gap-3`}
                  >
                    <div className={`w-8 h-8 rounded-lg ${cfg.bg} flex items-center justify-center shrink-0`}>
                      <Icon size={16} className={cfg.color} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-surface-100">{issue.message}</p>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-xs text-surface-500">{issue.category}</span>
                        {issue.resource && <span className="text-xs text-surface-500">Â· {issue.resource}</span>}
                      </div>
                      {issue.suggestion && (
                        <p className="text-xs text-surface-400 mt-1.5 flex items-start gap-1">
                          <Wrench size={10} className="shrink-0 mt-0.5" />
                          {issue.suggestion}
                        </p>
                      )}
                    </div>
                    {issue.autoFixable && (
                      <button
                        onClick={() => fixIssue(issue)}
                        disabled={fixing === issue.id}
                        className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-xs bg-primary-600/20 text-primary-400 rounded-lg hover:bg-primary-600/30 transition-all font-medium disabled:opacity-50"
                      >
                        {fixing === issue.id ? <Loader2 size={12} className="animate-spin" /> : <Wrench size={12} />}
                        Auto Fix
                      </button>
                    )}
                  </motion.div>
                );
              })
            )}
          </div>
        </>
      )}
    </motion.div>
  );
}
