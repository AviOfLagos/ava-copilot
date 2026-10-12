/*
 * A finished run trail, rendered once at build time from the panel's own step component: no JavaScript ships for it.
 * The card is the panel's ChainOfThought shell without its fold toggle, which would do nothing on a static page.
 */
import { ListTree } from 'lucide-react';
import { ChainOfThoughtStep } from '@app/side-panel/components/ai/chain-of-thought';
import { STEP_ICONS } from '../lib/icons';

interface TrailExampleProps {
  runSteps: string;
  steps: { icon: string; label: string }[];
  held: string;
  heldDetail: string;
}

export default function TrailExample({ runSteps, steps, held, heldDetail }: TrailExampleProps) {
  const count = steps.length + 1;
  return (
    <div className="glass w-full rounded-2xl px-3 py-2.5">
      <div className="text-muted-foreground flex w-full items-center gap-2 text-sm">
        <ListTree className="size-4" aria-hidden="true" />
        <span className="label-mono flex-1">{runSteps.replace('{count}', String(count))}</span>
      </div>
      <div className="mt-3">
        {steps.map(step => (
          <ChainOfThoughtStep key={step.label} icon={STEP_ICONS[step.icon]} status="complete" label={step.label} />
        ))}
        <ChainOfThoughtStep status="held" last label={held} description={heldDetail} />
      </div>
    </div>
  );
}
