import { defineDynamic, defineInstructions } from 'eve/instructions';
import { profileFor } from '../lib/profiles';

// (b) Per-session instructions, from the profile the auth step put on the session
export default defineDynamic({
  events: {
    'session.started': (_event, ctx) =>
      defineInstructions({ content: profileFor(ctx.session.auth.initiator?.attributes?.profileId).instructions }),
  },
});
