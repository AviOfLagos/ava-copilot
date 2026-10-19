import { Download } from 'lucide-react';
import { t } from '@extension/i18n';
import { Button } from '../components/ui/button';
import { ollamaModelRequirement } from './catalog';
import { RequirementCard, useRequirementFlow } from './RequirementCard';

/**
 * "Install" for a recommended local model: pulls it into Ollama with its progress (or, with no server answering,
 * the steps to start Ollama or get it in LM Studio). `onInstalled` runs once the server lists it.
 */
export function OllamaInstall({
  model,
  sizeBytes,
  onInstalled,
}: {
  model: string;
  sizeBytes?: number;
  onInstalled: () => void;
}) {
  const { flow, state } = useRequirementFlow();
  return (
    <div className="mt-1 flex flex-col gap-1" data-ollama-install={model}>
      {state.phase === 'idle' && (
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="glass"
            aria-label={t('requirement_install_named', [model])}
            onClick={async () => void flow.choose(await ollamaModelRequirement(model, { sizeBytes }), onInstalled)}>
            <Download className="size-3.5" aria-hidden />
            {t('requirement_install')}
          </Button>
        </div>
      )}
      <div className="-mx-3">
        <RequirementCard flow={flow} state={state} />
      </div>
    </div>
  );
}
