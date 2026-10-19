import { t } from '@extension/i18n';
import { CORE_PROFILE, CORE_TOP } from '../layout/Sidebar';
import { registeredPlaces, registeredSettingsSections } from '../registry';
import { sectionHash } from '../settings/pages';

/**
 * Tells the background which places and settings sections this panel has, in the user's language, so Ava's
 * capability list comes from what is registered here (src/background/capabilities). Every settings section is
 * registered (src/side-panel/settings/register.tsx has Settings' own), with where it lives on the full-page
 * Settings, so open_place lands on it there. Sent once at startup, after every register file has run.
 */

export function panelCatalog() {
  const places = [
    ...CORE_TOP,
    ...registeredPlaces('top').map(place => ({ place: place.id, label: place.label, order: place.order })),
    ...CORE_PROFILE,
    ...registeredPlaces('profile').map(place => ({ place: place.id, label: place.label, order: place.order })),
  ].map(place => ({ id: String(place.place), label: t(place.label) }));
  const settingsSections = registeredSettingsSections().map(section => ({
    id: section.id,
    label: t(section.label),
    hash: sectionHash(section),
  }));
  return { places, settingsSections };
}

setTimeout(() => {
  void chrome.runtime.sendMessage({ type: 'capabilities_panel', catalog: panelCatalog() }).catch(() => {});
});
