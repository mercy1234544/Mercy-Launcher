// Real, top-level render-crash containment — the direct fix for the
// architectural gap behind the "black screen" reports (see the Minecraft
// panel audit): React has no default recovery from a render-time exception,
// so without this, ANY uncaught error anywhere in the routed page content
// unmounts the entire app, leaving a blank window. This isolates that to
// the one page that actually crashed — the app shell (Sidebar/TitleBar)
// stays intact and the user can navigate away, exactly matching the
// requirement that a Mercy-service failure (or any other bug) must never
// take down local Library/game/server functionality with it.
import React from 'react';
import { AlertTriangle, RotateCcw, Home } from 'lucide-react';

interface Props {
  children: React.ReactNode;
  /** Changing this (e.g. the current route path) resets a previously-caught
   *  error — navigating away from the page that crashed is a real recovery,
   *  not just a dead end. */
  resetKey?: string;
  onNavigateHome?: () => void;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Real, visible logging — this app has no renderer crash-reporting
    // pipeline (a genuine gap noted separately), so the DevTools console is
    // the only place this is currently recoverable; never silently swallowed.
    console.error('[ErrorBoundary] A page crashed and was contained:', error, info.componentStack);
  }

  componentDidUpdate(prevProps: Props) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="p-8 max-w-lg mx-auto flex flex-col items-center text-center gap-4 mt-16">
          <div className="w-14 h-14 rounded-2xl bg-error-bg border border-error/25 flex items-center justify-center">
            <AlertTriangle size={24} className="text-error" />
          </div>
          <div>
            <p className="text-base font-bold text-surface-100">Something went wrong on this page</p>
            <p className="text-sm text-surface-500 mt-1.5">
              This is a real bug, not something you did. Your other games, servers, and settings are unaffected — only this
              one page needs to reload.
            </p>
          </div>
          <div className="flex items-center gap-2 mt-2">
            <button onClick={() => this.setState({ error: null })} className="btn-secondary text-xs py-2 px-4 flex items-center gap-1.5">
              <RotateCcw size={13} /> Try Again
            </button>
            {this.props.onNavigateHome && (
              <button onClick={() => { this.setState({ error: null }); this.props.onNavigateHome!(); }} className="btn-primary text-xs py-2 px-4 flex items-center gap-1.5">
                <Home size={13} /> Go Home
              </button>
            )}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
