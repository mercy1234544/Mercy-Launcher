import React, { useState } from 'react';
import { CheckCircle2, AlertTriangle, XCircle, HelpCircle, Info, ChevronDown, ChevronRight, Wrench, BookOpen, type LucideIcon } from 'lucide-react';
import { groupReport, itemAction, summarizeReport, STATUS_TONE, TONE_CLASSES, type ItemAction } from '../../lib/acMercyView';

const ICON: Record<AcCheckStatus, LucideIcon> = {
  pass: CheckCircle2, info: Info, unknown: HelpCircle, warn: AlertTriangle, fail: XCircle,
};

interface Props {
  report: AcRequirementsReport;
  plan: AcInstallPlan | null;
  /** Fired when the player presses an item's action button. */
  onAction: (action: ItemAction) => void;
}

// Every problem line says what is wrong AND what can be done about it: let the launcher fix it (opens the
// install dialog with that item ticked), hand it a file you downloaded, or — for things the launcher never
// does itself, like Custom Shaders Patch — exactly what you need to do.
export default function AcRequirementsPanel({ report, plan, onAction }: Props) {
  const summary = summarizeReport(report);
  const groups = groupReport(report);
  const [openSteps, setOpenSteps] = useState<string | null>(null);
  const [showOk, setShowOk] = useState<Record<string, boolean>>({});

  return (
    <div className="space-y-3">
      <div className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-xs font-semibold ${TONE_CLASSES[summary.tone].chip}`}>
        <span className={`w-2 h-2 rounded-full ${TONE_CLASSES[summary.tone].dot}`} />
        {summary.headline}
        <span className="ml-auto text-[10px] font-normal opacity-70">checked {new Date(report.checkedAt).toLocaleTimeString()}{report.deep ? '' : ' (quick)'}</span>
      </div>

      {groups.map((g) => {
        const problems = g.items.filter((i) => i.status !== 'pass');
        const oks = g.items.filter((i) => i.status === 'pass');
        const collapse = oks.length > 4 && !showOk[g.id];
        const visible = collapse ? problems : g.items;
        return (
          <div key={g.id} className="rounded-xl border border-overlay-6 bg-surface-950/40 overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-overlay-6">
              <span className={`w-1.5 h-1.5 rounded-full ${TONE_CLASSES[STATUS_TONE[g.worst]].dot}`} />
              <p className="text-xs font-bold text-surface-200">{g.title}</p>
              <p className="ml-auto text-[10px] text-surface-500">
                {g.counts.pass} ok{g.counts.warn ? ` · ${g.counts.warn} suggestion${g.counts.warn === 1 ? '' : 's'}` : ''}{g.counts.fail ? ` · ${g.counts.fail} to fix` : ''}{g.counts.unknown ? ` · ${g.counts.unknown} unknown` : ''}
              </p>
            </div>
            <ul className="divide-y divide-overlay-6">
              {visible.map((item) => {
                const Icon = ICON[item.status];
                const tone = TONE_CLASSES[STATUS_TONE[item.status]];
                const action = itemAction(item, plan);
                const stepsOpen = openSteps === item.id;
                return (
                  <li key={item.id} className="px-3 py-2.5">
                    <div className="flex items-start gap-2.5">
                      <Icon size={15} className={`${tone.text} mt-0.5 shrink-0`} />
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-semibold text-surface-100">{item.label}</p>
                        <p className="text-[11px] text-surface-400 mt-0.5 leading-relaxed break-words">{item.detail}</p>
                      </div>
                      {action.kind === 'auto' || action.kind === 'needs-file' ? (
                        <button onClick={() => onAction(action)} className="btn-primary text-[11px] py-1 px-2.5 shrink-0 flex items-center gap-1"><Wrench size={11} /> {action.label}</button>
                      ) : action.kind === 'manual' || action.kind === 'yours' ? (
                        <button onClick={() => setOpenSteps(stepsOpen ? null : item.id)} className="btn-secondary text-[11px] py-1 px-2.5 shrink-0 flex items-center gap-1">
                          <BookOpen size={11} /> How {stepsOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                        </button>
                      ) : null}
                    </div>
                    {stepsOpen && action.steps && (
                      <ol className="mt-2 ml-6 space-y-1 list-decimal text-[11px] text-surface-300">
                        {action.steps.map((s, i) => <li key={i}>{s}</li>)}
                      </ol>
                    )}
                  </li>
                );
              })}
            </ul>
            {oks.length > 4 && (
              <button onClick={() => setShowOk((s) => ({ ...s, [g.id]: !s[g.id] }))} className="w-full text-[11px] text-surface-500 hover:text-surface-200 py-1.5 border-t border-overlay-6">
                {showOk[g.id] ? 'Hide' : 'Show'} {oks.length} item{oks.length === 1 ? '' : 's'} that passed
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
