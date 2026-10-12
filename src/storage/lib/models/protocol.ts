/**
 * Names shared by the Models page and the background. The panel sends these commands over its own port;
 * the settings page, which has none, opens a port by this name.
 */
export const MODELS_PORT_NAME = 'models-settings';

export const MODELS_COMMANDS = {
  refresh: 'models_refresh',
  save: 'models_provider_save',
  check: 'models_provider_check',
  remove: 'models_provider_remove',
} as const;
