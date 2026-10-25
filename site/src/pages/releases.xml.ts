import type { APIRoute } from 'astro';
import { RELEASE } from '../content/release-notes';
import { INSTALL_COMMAND, PRODUCT, SITE_URL, VERSION } from '../content/site';

/**
 * The release feed: one item per release, for anyone who wants to hear about a new version outside the extension
 * (a feed reader, Slack's RSS app, an email-from-RSS service of their own choosing). Same source as version.json,
 * which is what the extension itself checks.
 */

const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const GET: APIRoute = () => {
  const date = new Date(`${RELEASE.released}T12:00:00Z`).toUTCString();
  const notes = RELEASE.notes.map(note => `<li>${escape(note)}</li>`).join('');
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escape(PRODUCT)} releases</title>
    <link>${SITE_URL}/</link>
    <atom:link href="${SITE_URL}/releases.xml" rel="self" type="application/rss+xml" />
    <description>New versions of ${escape(PRODUCT)}, the AI browser copilot that waits for your click.</description>
    <language>en</language>
    <lastBuildDate>${date}</lastBuildDate>
    <item>
      <title>${escape(PRODUCT)} ${escape(VERSION)}</title>
      <link>${SITE_URL}/install#update</link>
      <guid isPermaLink="false">${escape(PRODUCT)}-${escape(VERSION)}-${RELEASE.released}</guid>
      <pubDate>${date}</pubDate>
      <description>${escape(`<ul>${notes}</ul><p>Update: <code>${escape(INSTALL_COMMAND)}</code>, then reload the extension.</p>`)}</description>
    </item>
  </channel>
</rss>
`;
  return new Response(body, {
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
  });
};
