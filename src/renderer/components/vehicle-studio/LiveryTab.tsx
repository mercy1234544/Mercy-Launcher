// Livery Editor, embedded as a first-class Vehicle Studio tab — the exact
// same editor the standalone /livery page uses, just pointed at the
// CURRENT Vehicle Studio workspace (scan.root) instead of making the user
// pick a folder a second time. This is the real fix for "the only way to
// open the Livery Editor is from a specific FiveM server's Tools tab" —
// Vehicle Studio already has a server-independent entry point on the FiveM
// hub page (Import Folder / Open ZIP), so Livery is now reachable from
// there too, at the same level as Handling/Smart Tune.
import React from 'react';
import { LiveryWorkspace } from '../../pages/LiveryEditor';

export function LiveryTab({ root }: { root: string }) {
  // key={root} forces a clean remount (fresh scan, fresh edit state) when
  // the user re-scans or switches to a different imported vehicle —
  // otherwise stale textures/geometry from the previous workspace could
  // linger in LiveryWorkspace's internal refs.
  return (
    <div className="flex-1 min-w-0 overflow-hidden">
      <LiveryWorkspace key={root} initialRoot={root} embedded />
    </div>
  );
}
