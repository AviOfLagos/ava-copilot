import type { t } from '@extension/i18n';
import type { ModelRole } from '@extension/storage';

type MessageKey = Parameters<typeof t>[0];

/** Each role's name and what it is for. */
export const ROLE_LABELS: Record<ModelRole, { name: MessageKey; hint: MessageKey }> = {
  fast: { name: 'models_role_fast', hint: 'models_role_fast_hint' },
  smart: { name: 'models_role_smart', hint: 'models_role_smart_hint' },
  vision: { name: 'models_role_vision', hint: 'models_role_vision_hint' },
  local: { name: 'models_role_local', hint: 'models_role_local_hint' },
  embed: { name: 'models_role_embed', hint: 'models_role_embed_hint' },
  transcribe: { name: 'models_role_transcribe', hint: 'models_role_transcribe_hint' },
  realtime: { name: 'models_role_realtime', hint: 'models_role_realtime_hint' },
  tts: { name: 'models_role_tts', hint: 'models_role_tts_hint' },
  search: { name: 'models_role_search', hint: 'models_role_search_hint' },
  image: { name: 'models_role_image', hint: 'models_role_image_hint' },
};
