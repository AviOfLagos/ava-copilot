import type { APIRoute } from 'astro';
import { INSTALL_COMMAND, PRODUCT, SITE_URL, home, install, llms, privacy } from '../content/site';

// A plain-text summary for language models (llmstxt.org), from the same content model as the pages
export const GET: APIRoute = () => {
  const text = [
    `# ${PRODUCT}`,
    '',
    `> ${llms.summary}`,
    '',
    ...llms.facts.map(fact => `- ${fact}`),
    '',
    '## Install',
    '',
    `macOS and Linux: \`${INSTALL_COMMAND}\`, then load the unpacked folder in Brave, Chrome or Edge (Developer mode → Load unpacked). Windows: install by hand.`,
    '',
    '## Pages',
    '',
    `- [${PRODUCT}](${SITE_URL}/): ${home.description}`,
    `- [Install](${SITE_URL}/install): ${install.description}`,
    `- [Privacy](${SITE_URL}/privacy): ${privacy.description}`,
    '',
  ].join('\n');
  return new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
