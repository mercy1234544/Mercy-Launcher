import React, { useEffect, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Bell, Check, Trash2, ArrowUpCircle, Server, Download, Package, Info } from 'lucide-react';
import { useNotifications } from '../stores/useNotifications';
import { useAppStore } from '../stores/useAppStore';
import type { NotificationCategory } from '../types/notification';

const CATEGORY_ICON: Record<NotificationCategory, React.ComponentType<{ size?: number | string; className?: string }>> = {
  update: ArrowUpCircle,
  server: Server,
  download: Download,
  content: Package,
  system: Info,
};

const CATEGORY_COLOR: Record<NotificationCategory, string> = {
  update: 'text-primary-300 bg-primary-500/15 border-primary-500/20',
  server: 'text-sky-300 bg-sky-500/15 border-sky-500/20',
  download: 'text-blue-300 bg-blue-500/15 border-blue-500/20',
  content: 'text-purple-300 bg-purple-500/15 border-purple-500/20',
  system: 'text-surface-300 bg-overlay-6 border-overlay-10',
};

function timeAgo(iso: string) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// Mounted once in TitleBar. Owns both the bell/panel UI and the real event
// producers — appUpdater lifecycle + server status errors are genuine
// signals already flowing through the app; nothing here is invented.
// Radix Popover replaces the old hand-rolled open-state + outside-click
// listener: it gets focus management, Escape-to-close, and — the reason it
// was worth pulling in — collision-aware positioning, so the panel can never
// render partially off the edge of the window regardless of display size.
export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const notifications = useNotifications((s) => s.notifications);
  const push = useNotifications((s) => s.push);
  const markRead = useNotifications((s) => s.markRead);
  const markAllRead = useNotifications((s) => s.markAllRead);
  const dismiss = useNotifications((s) => s.dismiss);
  const clearAll = useNotifications((s) => s.clearAll);

  const unreadCount = notifications.filter((n) => !n.read).length;

  useEffect(() => {
    const cleanupUpdater = window.electronAPI?.appUpdater?.onStatus((data) => {
      if (data.status === 'available') {
        push({ title: 'Update available', message: `Mercy Launcher v${data.version} is ready to download.`, category: 'update' });
      } else if (data.status === 'ready') {
        push({ title: 'Update ready to install', message: `v${data.version} has downloaded — restart to apply it.`, category: 'update' });
      }
    });
    return () => cleanupUpdater?.();
  }, [push]);

  useEffect(() => {
    const cleanupServer = window.electronAPI?.onServerStatusChange?.((data) => {
      if (data.status !== 'error') return;
      const server = useAppStore.getState().servers.find((s) => s.id === data.serverId);
      push({ title: 'Server error', message: `${server?.name || 'A server'} reported an error.`, category: 'server' });
    });
    return () => cleanupServer?.();
  }, [push]);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          aria-label="Notifications"
          className="relative w-9 h-9 flex items-center justify-center text-surface-500 hover:text-surface-200 hover:bg-overlay-6 rounded-lg transition-colors"
        >
          <Bell size={15} />
          {unreadCount > 0 && (
            <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-primary-400 ring-2 ring-surface-950" />
          )}
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          collisionPadding={12}
          className="z-50 w-80 max-h-[26rem] flex flex-col rounded-2xl border border-overlay-10 bg-surface-900/95 backdrop-blur-xl shadow-2xl overflow-hidden mercy-pop"
          style={{ WebkitAppRegion: 'no-drag' } as any}
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-overlay-6 shrink-0">
            <p className="text-sm font-bold text-surface-100">Notifications</p>
            {notifications.length > 0 && (
              <div className="flex items-center gap-1">
                <button onClick={markAllRead} title="Mark all read" className="p-1.5 rounded-lg text-surface-500 hover:text-primary-300 hover:bg-overlay-6 transition-colors">
                  <Check size={13} />
                </button>
                <button onClick={clearAll} title="Clear all" className="p-1.5 rounded-lg text-surface-500 hover:text-red-400 hover:bg-overlay-6 transition-colors">
                  <Trash2 size={13} />
                </button>
              </div>
            )}
          </div>

          <div className="overflow-y-auto flex-1">
            {notifications.length === 0 ? (
              <div className="flex flex-col items-center text-center py-10 px-6">
                <div className="w-11 h-11 rounded-xl bg-overlay-6 flex items-center justify-center mb-3">
                  <Bell size={18} className="text-surface-500" />
                </div>
                <p className="text-sm font-semibold text-surface-200">You're all caught up</p>
                <p className="text-xs text-surface-500 mt-1">Updates, server activity, and downloads will show up here.</p>
              </div>
            ) : (
              <div className="divide-y divide-overlay-6">
                {notifications.map((n) => {
                  const Icon = CATEGORY_ICON[n.category];
                  return (
                    <button
                      key={n.id}
                      onClick={() => markRead(n.id)}
                      className={`w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-overlay-4 transition-colors group ${!n.read ? 'bg-primary-500/[0.04]' : ''}`}
                    >
                      <div className={`w-8 h-8 rounded-lg border flex items-center justify-center shrink-0 mt-0.5 ${CATEGORY_COLOR[n.category]}`}>
                        <Icon size={13} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          {!n.read && <span className="w-1.5 h-1.5 rounded-full bg-primary-400 shrink-0" />}
                          <p className="text-xs font-semibold text-surface-100 truncate">{n.title}</p>
                        </div>
                        <p className="text-[11px] text-surface-500 mt-0.5 line-clamp-2">{n.message}</p>
                        <p className="text-[10px] text-surface-600 mt-1">{timeAgo(n.timestamp)}</p>
                      </div>
                      <span
                        role="button"
                        onClick={(e) => { e.stopPropagation(); dismiss(n.id); }}
                        className="opacity-0 group-hover:opacity-100 p-1 rounded-md text-surface-600 hover:text-red-400 hover:bg-overlay-6 transition-colors shrink-0"
                      >
                        <Trash2 size={11} />
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
