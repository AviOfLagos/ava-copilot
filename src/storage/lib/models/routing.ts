import type { RoleTarget } from './settings';

/**
 * Where light work goes. Light work is what a small model does well and the user never watches closely:
 * summaries, titles, classification, routine steps, Inbox summaries, the daily reflection. Heavy work (the browser
 * agent, vision) keeps the model chosen for its role and never comes here.
 */
export type LightTask = 'summary' | 'title' | 'classify' | 'routine' | 'inbox' | 'reflection' | 'graph' | 'draft';

export interface LightRouteInputs {
  preferLocal: boolean;
  cloudAllowed: boolean;
  // When the "start a local model" notice was shown, or null
  noticeAt: number | null;
  // An active local model whose server answers right now, or null
  runningLocal: RoleTarget | null;
}

export type LightRoute =
  | { route: 'local'; target: RoleTarget }
  // The cloud model for the role; `notice` asks the caller to tell the user once that a local model would save cost
  | { route: 'cloud'; notice: boolean; reason: 'preferCloud' | 'allowed' | 'noLocal' };

/** The pure routing decision; see `background/models/light.ts` for the caller. */
export function decideLightRoute(inputs: LightRouteInputs): LightRoute {
  if (!inputs.preferLocal) return { route: 'cloud', notice: false, reason: 'preferCloud' };
  if (inputs.runningLocal) return { route: 'local', target: inputs.runningLocal };
  if (inputs.cloudAllowed) return { route: 'cloud', notice: false, reason: 'allowed' };
  return { route: 'cloud', notice: inputs.noticeAt === null, reason: 'noLocal' };
}
