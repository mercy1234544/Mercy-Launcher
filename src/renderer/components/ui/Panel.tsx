import React from 'react';

// The one card/panel treatment used everywhere in Mercy Launcher — replaces
// the `rounded-2xl border border-overlay-6 bg-surface-900/40 p-5` pattern that
// used to be copy-pasted with slight drift across every page. `interactive`
// adds the hover lift/border used for clickable panels (nav tiles, list rows);
// static panels (stat cards, settings rows) omit it.
export interface PanelProps extends React.HTMLAttributes<HTMLDivElement> {
  interactive?: boolean;
  padding?: 'sm' | 'md' | 'lg';
  as?: 'div' | 'button';
}

const PADDING = { sm: 'p-3.5', md: 'p-5', lg: 'p-6' };

export default function Panel({ interactive = false, padding = 'md', as = 'div', className = '', children, ...rest }: PanelProps) {
  const base = `rounded-2xl border border-overlay-6 bg-surface-900/40 ${PADDING[padding]}`;
  const hover = interactive
    ? 'transition-all duration-200 hover:bg-overlay-4 hover:border-primary-500/30 hover:-translate-y-0.5 hover:shadow-glow-sm cursor-pointer text-left'
    : '';
  const Comp: any = as;
  return (
    <Comp className={`${base} ${hover} ${className}`} {...rest}>
      {children}
    </Comp>
  );
}
