import { db, peopleStore, workspacePlacement, workspaceStore } from '@extension/storage';
import { addInboxItem, inboxItemId, markDone } from '../inbox/store';
import { services } from '../registry/services';
import { createItemSource } from './items';
import type { PlaceDeps } from './place';
import type { SortDeps } from './sort';

/** The extension's own stores behind the placing functions. Built when used: the services exist only after start-up. */
export function placeDeps(): PlaceDeps {
  return {
    items: createItemSource({
      db,
      kbSetWorkspace: (ids, workspaceId, setBy, unchanged) =>
        services().kb.setWorkspace(ids, workspaceId, setBy, unchanged),
    }),
    placement: workspacePlacement,
    workspaces: {
      list: () => workspaceStore.list(),
      save: workspace => workspaceStore.save(workspace),
      remove: id => workspaceStore.remove(id),
    },
    inbox: {
      add: draft => addInboxItem(draft),
      close: (source, externalId) => markDone(inboxItemId(source, externalId)),
    },
  };
}

export function sortDeps(model: SortDeps['model']): SortDeps {
  return { ...placeDeps(), people: { list: () => peopleStore.list() }, model };
}
