import React from 'react';

// Standard "nothing here yet" treatment — used instead of ever inventing fake
// content to fill a blank page. Every empty/coming-soon page in the launcher
// should render through this so they read as one consistent product.
export interface EmptyStateProps {
  icon: React.ComponentType<{ size?: number | string; className?: string }>;
  title: string;
  description?: string;
  badge?: string;
  action?: React.ReactNode;
  size?: 'sm' | 'lg';
}

export default function EmptyState({ icon: Icon, title, description, badge, action, size = 'sm' }: EmptyStateProps) {
  const iconBox = size === 'lg' ? 'w-16 h-16 rounded-2xl mb-5' : 'w-12 h-12 rounded-xl mb-3';
  const iconSize = size === 'lg' ? 28 : 20;
  const titleClass = size === 'lg' ? 'text-2xl font-extrabold text-surface-100' : 'text-sm font-bold text-surface-100';
  return (
    <div className="flex flex-col items-center text-center py-10 px-6">
      <div className={`${iconBox} bg-primary-500/15 border border-primary-500/25 flex items-center justify-center shrink-0`}>
        <Icon size={iconSize} className="text-primary-300" />
      </div>
      {badge && (
        <span className="inline-block text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full bg-overlay-6 text-surface-400 border border-overlay-10 mb-3">
          {badge}
        </span>
      )}
      <p className={titleClass}>{title}</p>
      {description && <p className="text-xs text-surface-500 mt-1.5 max-w-sm leading-relaxed">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
