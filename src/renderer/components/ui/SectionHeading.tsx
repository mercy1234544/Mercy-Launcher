import React from 'react';

// The icon-badge + title + subtitle row used at the top of every page. One
// definition means every page title uses the same size/weight/spacing.
export interface SectionHeadingProps {
  icon: React.ComponentType<{ size?: number | string; className?: string }>;
  iconClass?: string;
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}

export default function SectionHeading({ icon: Icon, iconClass = 'bg-primary-500/15 border-primary-500/25 text-primary-300', title, subtitle, action }: SectionHeadingProps) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-3">
        <div className={`w-11 h-11 rounded-xl border flex items-center justify-center shrink-0 ${iconClass}`}>
          <Icon size={20} />
        </div>
        <div className="min-w-0">
          <h1 className="text-xl font-extrabold text-surface-100 tracking-tight truncate">{title}</h1>
          {subtitle && <p className="text-sm text-surface-400 truncate">{subtitle}</p>}
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
