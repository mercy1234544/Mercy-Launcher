import React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';

// One Tooltip.Provider at the app root (see App.tsx) shares hover-intent
// timing across every tooltip so they feel like one system, not N random
// ones. This component is the styled Mercy Launcher wrapper around Radix's
// unstyled primitive — real focus/hover/escape handling and boundary-aware
// positioning for free, our own look on top.
export interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left';
  delayDuration?: number;
}

export default function Tooltip({ content, children, side = 'bottom', delayDuration = 400 }: TooltipProps) {
  return (
    <TooltipPrimitive.Root delayDuration={delayDuration}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className="z-[60] px-2.5 py-1.5 rounded-lg bg-surface-800 border border-overlay-10 text-[11px] font-medium text-surface-200 shadow-xl mercy-pop"
          style={{ WebkitAppRegion: 'no-drag' } as any}
        >
          {content}
          <TooltipPrimitive.Arrow className="fill-surface-800" width={8} height={4} />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

export const TooltipProvider = TooltipPrimitive.Provider;
