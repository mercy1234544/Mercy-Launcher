import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Download, X, RefreshCw, CheckCircle2, Loader2, ArrowUpCircle, AlertTriangle } from 'lucide-react';

type UpdateStatus = 'checking' | 'available' | 'current' | 'downloading' | 'ready' | 'error' | null;

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}

export default function UpdateBanner() {
  const [status, setStatus] = useState<UpdateStatus>(null);
  const [currentVersion, setCurrentVersion] = useState('');
  const [version, setVersion] = useState('');
  const [percent, setPercent] = useState(0);
  const [transferred, setTransferred] = useState<number | undefined>(undefined);
  const [total, setTotal] = useState<number | undefined>(undefined);
  const [bytesPerSecond, setBytesPerSecond] = useState<number | undefined>(undefined);
  const [error, setError] = useState('');
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!window.electronAPI?.appUpdater) return;

    window.electronAPI.appUpdater.getVersion().then(setCurrentVersion).catch(() => {});

    const cleanup = window.electronAPI.appUpdater.onStatus((data) => {
      setStatus(data.status);
      if (data.version) setVersion(data.version);
      if (data.percent !== undefined) setPercent(data.percent);
      setTransferred(data.transferred);
      setTotal(data.total);
      setBytesPerSecond(data.bytesPerSecond);
      if (data.status === 'error') setError(data.error || 'The update failed.');
      // A fresh "available" (or a retried check) should re-surface the banner
      // even if the user dismissed an earlier notice or a previous error.
      if (data.status === 'available' || data.status === 'error') setDismissed(false);
    });

    return cleanup;
  }, []);

  const handleDownload = async () => {
    setStatus('downloading');
    setError('');
    const result = await window.electronAPI.appUpdater.download();
    if (result && result.success === false) {
      setStatus('error');
      setError(result.error || 'The download failed.');
    }
  };

  const handleInstall = () => {
    window.electronAPI.appUpdater.install();
  };

  const handleRetry = async () => {
    setError('');
    setStatus('checking');
    await window.electronAPI.appUpdater.check();
  };

  if (dismissed || !status || status === 'current' || status === 'checking') {
    return null;
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ height: 0, opacity: 0 }}
        animate={{ height: 'auto', opacity: 1 }}
        exit={{ height: 0, opacity: 0 }}
        transition={{ duration: 0.3 }}
        className="overflow-hidden"
      >
        <div className={`flex items-center gap-3 px-4 py-2.5 text-sm ${
          status === 'ready'
            ? 'bg-emerald-500/10 border-b border-emerald-500/20'
            : status === 'error'
            ? 'bg-error-bg border-b border-error/25'
            : 'bg-primary-500/10 border-b border-primary-500/20'
        }`}>
          {status === 'available' && (
            <>
              <ArrowUpCircle size={16} className="text-primary-400 shrink-0" />
              <span className="text-primary-200 flex-1">
                Mercy Launcher update available — <strong>v{currentVersion || '…'}</strong> → <strong>v{version}</strong>
              </span>
              <button
                onClick={handleDownload}
                className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-primary-500/20 text-primary-300 text-xs font-medium hover:bg-primary-500/30 transition-all"
              >
                <Download size={12} />
                Update Now
              </button>
              <button
                onClick={() => setDismissed(true)}
                className="px-2 py-1 rounded-lg text-surface-500 hover:text-surface-300 hover:bg-overlay-6 text-xs transition-all"
              >
                Later
              </button>
            </>
          )}

          {status === 'downloading' && (
            <>
              <Loader2 size={16} className="text-primary-400 shrink-0 animate-spin" />
              <span className="text-primary-200 flex-1">
                Downloading v{version}… {percent}%
                {(transferred !== undefined && total !== undefined) && (
                  <span className="text-primary-400/70"> ({formatBytes(transferred)} / {formatBytes(total)}{bytesPerSecond ? ` · ${formatBytes(bytesPerSecond)}/s` : ''})</span>
                )}
              </span>
              <div className="w-32 h-1.5 rounded-full bg-overlay-6 overflow-hidden">
                <motion.div
                  className="h-full rounded-full bg-primary-400"
                  animate={{ width: `${percent}%` }}
                  transition={{ duration: 0.3 }}
                />
              </div>
            </>
          )}

          {status === 'ready' && (
            <>
              <CheckCircle2 size={16} className="text-emerald-400 shrink-0" />
              <span className="text-emerald-200 flex-1">
                Update ready — Mercy Launcher will restart to finish updating to <strong>v{version}</strong>
              </span>
              <button
                onClick={handleInstall}
                className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-emerald-500/20 text-emerald-300 text-xs font-medium hover:bg-emerald-500/30 transition-all"
              >
                <RefreshCw size={12} />
                Restart & Update
              </button>
              <button
                onClick={() => setDismissed(true)}
                className="px-2 py-1 rounded-lg text-surface-500 hover:text-surface-300 hover:bg-overlay-6 text-xs transition-all"
              >
                Later
              </button>
            </>
          )}

          {status === 'error' && (
            <>
              <AlertTriangle size={16} className="text-error shrink-0" />
              <span className="text-error flex-1">
                Update failed: {error}. Mercy Launcher itself is unaffected — you're still on v{currentVersion || 'the current version'}.
              </span>
              <button
                onClick={handleRetry}
                className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-error/20 text-error text-xs font-medium hover:bg-error/30 transition-all"
              >
                <RefreshCw size={12} />
                Retry
              </button>
              <button
                onClick={() => setDismissed(true)}
                className="p-1 rounded-lg text-surface-500 hover:text-surface-300 hover:bg-overlay-6 transition-all"
              >
                <X size={14} />
              </button>
            </>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
