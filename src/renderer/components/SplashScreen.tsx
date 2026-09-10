import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface SplashScreenProps {
  onComplete: () => void;
}

type UpdatePhase = 'animating' | 'checking' | 'downloading' | 'installing' | 'ready' | 'done';

export default function SplashScreen({ onComplete }: SplashScreenProps) {
  const [phase, setPhase] = useState<'enter' | 'hold' | 'exit'>('enter');
  const [updatePhase, setUpdatePhase] = useState<UpdatePhase>('animating');
  const [statusText, setStatusText] = useState('');
  const [downloadPercent, setDownloadPercent] = useState(0);
  const [appVersion, setAppVersion] = useState('');
  const [newVersion, setNewVersion] = useState('');
  const cleanupRef = useRef<(() => void) | null>(null);
  const completedRef = useRef(false);

  useEffect(() => {
    const holdTimer = setTimeout(() => setPhase('hold'), 600);

    const checkTimer = setTimeout(() => {
      startUpdateCheck();
    }, 1800);

    return () => {
      clearTimeout(holdTimer);
      clearTimeout(checkTimer);
      if (cleanupRef.current) cleanupRef.current();
    };
  }, []);

  const finishSplash = () => {
    if (completedRef.current) return;
    completedRef.current = true;
    setPhase('exit');
    setTimeout(() => onComplete(), 800);
  };

  const startUpdateCheck = async () => {
    if (window.electronAPI?.appUpdater) {
      try {
        const ver = await window.electronAPI.appUpdater.getVersion();
        setAppVersion(ver);
      } catch {}
    }

    if (!window.electronAPI?.appUpdater) {
      setUpdatePhase('done');
      setStatusText('Ready');
      setTimeout(finishSplash, 600);
      return;
    }

    setUpdatePhase('checking');
    setStatusText('Checking for updates...');

    cleanupRef.current = window.electronAPI.appUpdater.onStatus((data) => {
      switch (data.status) {
        case 'available':
          setUpdatePhase('downloading');
          setNewVersion(data.version || '');
          setStatusText(`Downloading update v${data.version || ''}...`);
          break;

        case 'downloading':
          setUpdatePhase('downloading');
          setDownloadPercent(data.percent || 0);
          setStatusText(`Downloading update... ${Math.round(data.percent || 0)}%`);
          break;

        case 'ready':
          // Installing/restarting is triggered once, centrally, by the main
          // process's own update-downloaded handler — calling install()
          // again from here raced against it (both firing for the same
          // downloaded update) and could leave the install partially
          // applied. This just reflects that status in the UI.
          setUpdatePhase('installing');
          setStatusText(`Update v${data.version || newVersion} ready — restarting...`);
          break;

        case 'current':
          setUpdatePhase('done');
          setStatusText('Up to date');
          setTimeout(finishSplash, 800);
          break;

        case 'error':
          setUpdatePhase('done');
          setStatusText('Ready');
          setTimeout(finishSplash, 800);
          break;
      }
    });

    try {
      await window.electronAPI.appUpdater.check();
    } catch {
      setUpdatePhase('done');
      setStatusText('Ready');
      setTimeout(finishSplash, 800);
    }

    // Safety timeout — if updater never responds, let the user in after 15s
    setTimeout(() => {
      if (!completedRef.current) {
        finishSplash();
      }
    }, 15000);
  };

  return (
    <AnimatePresence>
      <motion.div
        key="splash"
        initial={{ opacity: 1 }}
        animate={{ opacity: phase === 'exit' ? 0 : 1 }}
        transition={{ duration: 0.8, ease: [0.4, 0, 0.2, 1] }}
        className="fixed inset-0 z-[9999] flex items-center justify-center overflow-hidden"
        style={{ background: '#0a0a12' }}
      >
        {/* Animated background gradients */}
        <motion.div
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 0.4, scale: 1.2 }}
          transition={{ duration: 2, ease: 'easeOut' }}
          className="absolute inset-0"
        >
          <div
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full"
            style={{
              background: 'radial-gradient(circle, rgba(99, 102, 241, 0.15) 0%, rgba(99, 102, 241, 0.05) 40%, transparent 70%)',
            }}
          />
          <motion.div
            animate={{ rotate: 360 }}
            transition={{ duration: 20, repeat: Infinity, ease: 'linear' }}
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px]"
          >
            <div
              className="absolute top-0 left-1/4 w-[300px] h-[300px] rounded-full"
              style={{
                background: 'radial-gradient(circle, rgba(168, 85, 247, 0.1) 0%, transparent 70%)',
              }}
            />
            <div
              className="absolute bottom-0 right-1/4 w-[250px] h-[250px] rounded-full"
              style={{
                background: 'radial-gradient(circle, rgba(34, 211, 238, 0.08) 0%, transparent 70%)',
              }}
            />
          </motion.div>
        </motion.div>

        {/* Grid lines */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 0.03 }}
          transition={{ duration: 1.5, delay: 0.3 }}
          className="absolute inset-0"
          style={{
            backgroundImage: `
              linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px),
              linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px)
            `,
            backgroundSize: '60px 60px',
          }}
        />

        {/* Center content */}
        <div className="relative flex flex-col items-center">
          {/* Mercy logo */}
          <motion.div
            initial={{ scale: 0, rotate: -180, opacity: 0 }}
            animate={{ scale: 1, rotate: 0, opacity: 1 }}
            transition={{ duration: 0.8, ease: [0.34, 1.56, 0.64, 1], delay: 0.1 }}
            className="relative mb-8"
          >
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: [0.8, 1.15, 1], opacity: [0, 0.6, 0.3] }}
              transition={{ duration: 1.2, delay: 0.4 }}
              className="absolute inset-[-20px] rounded-full"
              style={{
                background: 'radial-gradient(circle, rgba(99, 102, 241, 0.3) 0%, transparent 70%)',
              }}
            />

            <div className="relative w-20 h-20">
              <svg viewBox="0 0 80 80" className="w-full h-full">
                <defs>
                  <linearGradient id="splash-hex-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#c4b0ff" />
                    <stop offset="50%" stopColor="#9d7bff" />
                    <stop offset="100%" stopColor="#5b3ee0" />
                  </linearGradient>
                  <filter id="splash-glow">
                    <feGaussianBlur stdDeviation="3" result="blur" />
                    <feMerge>
                      <feMergeNode in="blur" />
                      <feMergeNode in="SourceGraphic" />
                    </feMerge>
                  </filter>
                </defs>
                <motion.polygon
                  points="40,4 74,22 74,58 40,76 6,58 6,22"
                  fill="url(#splash-hex-grad)"
                  stroke="rgba(157, 123, 255, 0.5)"
                  strokeWidth="1.5"
                  filter="url(#splash-glow)"
                  initial={{ pathLength: 0 }}
                  animate={{ pathLength: 1 }}
                  transition={{ duration: 0.6, delay: 0.2 }}
                />
                <motion.g
                  initial={{ opacity: 0, y: 5 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4, delay: 0.6 }}
                >
                  <path
                    d="M22 52V27a2.5 2.5 0 0 1 4.5-1.5L38 40.5l11.5-15A2.5 2.5 0 0 1 54 27v25"
                    fill="none" stroke="white" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round"
                  />
                </motion.g>
              </svg>
            </div>
          </motion.div>

          {/* Title */}
          <div className="relative">
            <motion.div
              initial={{ y: 30, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ duration: 0.6, delay: 0.3, ease: [0.4, 0, 0.2, 1] }}
              className="flex items-center justify-center gap-1"
            >
              {'MERCY'.split('').map((char, i) => (
                <motion.span
                  key={i}
                  initial={{ y: 20, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ duration: 0.4, delay: 0.4 + i * 0.06, ease: [0.4, 0, 0.2, 1] }}
                  className="text-4xl font-black tracking-wider"
                  style={{
                    background: 'linear-gradient(135deg, #ede9ff 0%, #dcd0ff 30%, #b09aff 70%, #9d7bff 100%)',
                    WebkitBackgroundClip: 'text',
                    WebkitTextFillColor: 'transparent',
                    textShadow: 'none',
                  }}
                >
                  {char}
                </motion.span>
              ))}
            </motion.div>

            <motion.p
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ duration: 0.5, delay: 0.7, ease: [0.4, 0, 0.2, 1] }}
              className="text-center text-sm font-medium tracking-[0.35em] uppercase mt-2"
              style={{ color: 'rgba(148, 163, 184, 0.8)' }}
            >
              Launcher
            </motion.p>

            <motion.div
              initial={{ scaleX: 0 }}
              animate={{ scaleX: 1 }}
              transition={{ duration: 0.6, delay: 0.9, ease: [0.4, 0, 0.2, 1] }}
              className="mx-auto mt-4 h-px w-32 origin-center"
              style={{
                background: 'linear-gradient(90deg, transparent, rgba(99, 102, 241, 0.5), transparent)',
              }}
            />
          </div>

          {/* Version badge */}
          <motion.div
            initial={{ y: 15, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 0.4, delay: 1.1 }}
            className="mt-5 px-3 py-1 rounded-full border"
            style={{
              background: 'rgba(99, 102, 241, 0.08)',
              borderColor: 'rgba(99, 102, 241, 0.15)',
            }}
          >
            <span className="text-[10px] font-semibold tracking-widest uppercase" style={{ color: 'rgba(129, 140, 248, 0.7)' }}>
              {appVersion ? `v${appVersion}` : 'Beta'}
            </span>
          </motion.div>

          {/* Update status area */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 1.3 }}
            className="flex flex-col items-center gap-3 mt-8 min-h-[60px]"
          >
            {statusText && (
              <motion.p
                key={statusText}
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                className="text-xs font-medium tracking-wide"
                style={{ color: 'rgba(148, 163, 184, 0.7)' }}
              >
                {statusText}
              </motion.p>
            )}

            {updatePhase === 'downloading' && (
              <motion.div
                initial={{ opacity: 0, width: 0 }}
                animate={{ opacity: 1, width: 200 }}
                className="h-1 rounded-full overflow-hidden"
                style={{ background: 'rgba(99, 102, 241, 0.15)' }}
              >
                <motion.div
                  className="h-full rounded-full"
                  style={{ background: 'linear-gradient(90deg, #6366f1, #818cf8)' }}
                  initial={{ width: 0 }}
                  animate={{ width: `${downloadPercent}%` }}
                  transition={{ duration: 0.3 }}
                />
              </motion.div>
            )}

            {(updatePhase === 'animating' || updatePhase === 'checking') && (
              <div className="flex items-center gap-1.5">
                {[0, 1, 2].map((i) => (
                  <motion.div
                    key={i}
                    animate={{
                      scale: [1, 1.4, 1],
                      opacity: [0.3, 1, 0.3],
                    }}
                    transition={{
                      duration: 1,
                      repeat: Infinity,
                      delay: i * 0.15,
                      ease: 'easeInOut',
                    }}
                    className="w-1.5 h-1.5 rounded-full bg-indigo-400"
                  />
                ))}
              </div>
            )}

            {updatePhase === 'installing' && (
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
                className="w-5 h-5 border-2 border-indigo-400/30 border-t-indigo-400 rounded-full"
              />
            )}
          </motion.div>
        </div>

        {/* Corner accents */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 0.15 }}
          transition={{ duration: 1, delay: 0.5 }}
          className="absolute top-8 left-8"
        >
          <div className="w-12 h-px bg-gradient-to-r from-indigo-500 to-transparent" />
          <div className="w-px h-12 bg-gradient-to-b from-indigo-500 to-transparent" />
        </motion.div>
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 0.15 }}
          transition={{ duration: 1, delay: 0.5 }}
          className="absolute bottom-8 right-8"
        >
          <div className="w-12 h-px bg-gradient-to-l from-indigo-500 to-transparent ml-auto" />
          <div className="w-px h-12 bg-gradient-to-t from-indigo-500 to-transparent ml-auto" />
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
