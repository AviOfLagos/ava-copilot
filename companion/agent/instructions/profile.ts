import { defineDynamic, defineInstructions } from 'eve/instructions';
import { loadProfile, profileIdOf } from '../lib/avi-brain';

// The profile's own instructions, for this session
export default defineDynamic({
  events: {
    'session.started': async (_event, ctx) => {
      const profile = await loadProfile(profileIdOf(ctx));
      return profile.instructions.trim()
        ? defineInstructions({ content: `# Profile: ${profile.name}\n${profile.instructions}` })
        : null;
    },
  },
});
