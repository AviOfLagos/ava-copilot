// What the app's widgets import from @extension/storage, for the site's demos. The pure attachment rules are the
// app's own; the stores read chrome.storage, which a web page does not have, so they answer as if nothing is set.
export * from '@app/storage/lib/threads/attachments';
// The composer's vocabulary chip: pure functions only (the rest of the vocabulary needs the extension's database)
export * from '@app/storage/lib/vocabulary/learn';

export const speechToTextModelStore = {
  getSpeechToTextModel: async () => undefined,
};

export const audioDeviceSettingsStore = {
  get: async () => ({ inputDeviceId: null, outputDeviceId: null }),
  getSettings: async () => ({ inputDeviceId: null, outputDeviceId: null }),
  subscribe: () => () => {},
};
