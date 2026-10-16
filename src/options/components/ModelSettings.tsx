/*
 * Models on the full settings page: the same Models page as the panel's (providers, every model with an active
 * switch, roles, local models and light-work routing, spending and usage), so there is one place to choose models.
 * The settings page has no panel port; its commands go over a port of its own (models_ commands only).
 */
import { useMemo } from 'react';
import { t } from '@extension/i18n';
import { ModelsHub } from '../../side-panel/models/ModelsPage';
import { createPortRequest } from '../../side-panel/models/transport';

// Options.tsx passes the same props to every tab; the Models page follows the theme tokens instead
interface ModelSettingsProps {
  isDarkMode?: boolean;
}

export const ModelSettings: React.FC<ModelSettingsProps> = () => {
  const request = useMemo(
    () => createPortRequest({ timeout: t('errors_timeout'), disconnected: t('models_disconnected') }),
    [],
  );
  return (
    <section className="flex min-h-0 flex-col text-left" data-options-models>
      <h2 className="mb-1 px-3 text-xl font-semibold">{t('models_title')}</h2>
      <ModelsHub request={request} wide />
    </section>
  );
};
