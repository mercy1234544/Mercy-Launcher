import React from 'react';
import { Download, Inbox } from 'lucide-react';
import { Panel, EmptyState, SectionHeading } from '../components/ui';

// Real, honest empty state — there is no download engine wired up yet (that's
// planned architecture: a shared queue across FiveM/Minecraft/Assetto/BeamNG
// content, once the content-manifest system exists). Per the "never fake
// functionality" rule, this shows "No downloads yet" rather than invented
// progress bars.
const SECTIONS = [
  { label: 'Active', empty: 'Nothing downloading right now.' },
  { label: 'Queued', empty: 'Nothing queued.' },
  { label: 'Completed', empty: 'Nothing completed yet.' },
  { label: 'Failed', empty: 'No failed downloads.' },
];

export default function Downloads() {
  return (
    <div className="p-7 max-w-4xl mx-auto space-y-6">
      <SectionHeading icon={Download} title="Downloads" subtitle="One download manager, shared across every game hub." />

      <Panel padding="sm">
        <EmptyState icon={Inbox} title="No downloads yet" description="Server content packages will download and update here once content publishing is available." />
      </Panel>

      <div className="grid grid-cols-2 gap-4">
        {SECTIONS.map((s) => (
          <Panel key={s.label} padding="sm">
            <p className="text-[10px] uppercase tracking-wider text-surface-500 mb-2 font-semibold">{s.label}</p>
            <p className="text-xs text-surface-600">{s.empty}</p>
          </Panel>
        ))}
      </div>
    </div>
  );
}
