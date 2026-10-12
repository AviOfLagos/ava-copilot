/*
 * A run you can watch and stop, rendered once at build time from the panel's own parts (the run trail's step, the
 * panel's button) and played by src/scripts/widgets.ts: steps fill one by one, it hands the page back for your
 * sign-in ("Your turn", as the panel's card says it) until you press Continue, then fills the form and stops at the
 * amber diamond. Stop ends it at any step. Without JavaScript it shows the whole run, waiting at Submit.
 */
import { AlertTriangle, ListTree, LogIn, RotateCcw, Square } from 'lucide-react';
import { ChainOfThoughtStep } from '@app/side-panel/components/ai/chain-of-thought';
import { Button } from '@app/side-panel/components/ui/button';
import type { home } from '../content/site';
import { STEP_ICONS } from '../lib/icons';

type TrailCopy = (typeof home)['steps']['trail'];

export default function TrailRun({ copy }: { copy: TrailCopy }) {
  const [first, ...rest] = copy.steps;
  const total = copy.steps.length + 2;
  return (
    <div className="tr" data-trail-run data-state="held">
      <div className="tr-panel aura">
        <div className="tr-ask">
          <p>{copy.prompt}</p>
        </div>
        <div className="glass tr-trail w-full rounded-2xl px-3 py-2.5">
          <div className="text-muted-foreground flex w-full items-center gap-2 text-sm">
            <ListTree className="size-4" aria-hidden="true" />
            <span className="label-mono flex-1" data-count data-template={copy.runSteps}>
              {copy.runSteps.replace('{count}', String(total))}
            </span>
          </div>
          <div className="tr-steps mt-3">
            <ChainOfThoughtStep
              data-step=""
              data-on=""
              data-counts=""
              icon={STEP_ICONS[first.icon]}
              label={first.label}
            />
            <ChainOfThoughtStep data-signed-in="" data-on="" data-counts="" icon={LogIn} label={copy.handback.done} />
            {rest.map(step => (
              <ChainOfThoughtStep
                key={step.label}
                data-step=""
                data-on=""
                data-counts=""
                icon={STEP_ICONS[step.icon]}
                label={step.label}
              />
            ))}
            <ChainOfThoughtStep
              data-held=""
              data-on=""
              data-counts=""
              data-say={copy.heldNote}
              status="held"
              last
              label={copy.held}
              description={copy.heldDetail}
            />
            <ChainOfThoughtStep
              data-stopped=""
              data-say={copy.stoppedNote}
              status="failed"
              icon={AlertTriangle}
              last
              label={copy.stopped}
            />
            <div className="tr-working" data-working="">
              <span className="tr-working__dot" aria-hidden="true" />
              <span className="mo-lab-t text-[12.5px]">{copy.working}</span>
            </div>
          </div>
        </div>

        {/* The panel's "Your turn" card: the page needs you, so it waits */}
        <div className="tr-handback" data-handback="" data-say={copy.handback.status}>
          <div
            role="group"
            aria-labelledby="tr-handback-title"
            className="border-hold/45 from-hold/10 to-hold/[0.03] rounded-[18px] border bg-gradient-to-b p-3.5 text-[13px] shadow-[0_0_0_4px_rgb(var(--hold-rgb)/0.06),0_12px_30px_rgba(0,0,0,0.25)]">
            <div className="flex items-start justify-between gap-3">
              <p id="tr-handback-title" className="text-[14px] font-semibold leading-snug">
                {copy.handback.title}
              </p>
              <span className="text-muted-foreground mt-0.5 shrink-0 font-mono text-[10.5px]">
                {copy.handback.host}
              </span>
            </div>
            <p className="text-muted-foreground mt-1">{copy.handback.body}</p>
            <div className="mt-3 flex gap-2">
              <Button variant="glass" size="lg" className="flex-1" data-stop="">
                {copy.stop}
              </Button>
              <Button variant="default" size="lg" className="flex-[1.4]" data-continue="">
                {copy.handback.action}
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div className="tr-controls">
        <Button variant="glass" size="sm" className="tr-stop" data-stop="">
          <Square className="size-3 fill-current" aria-hidden="true" />
          {copy.stop}
        </Button>
        <Button variant="outline" size="sm" className="tr-replay" data-replay="">
          <RotateCcw className="size-3.5" aria-hidden="true" />
          {copy.replay}
        </Button>
        <p className="tr-status" role="status" aria-live="polite" data-status-text="">
          {copy.heldNote}
        </p>
      </div>
      <p className="tr-hint">{copy.hint}</p>
    </div>
  );
}
