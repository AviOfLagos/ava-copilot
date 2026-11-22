import { growthStore, shiftDay, utcDay } from '@extension/storage';
import type { ProductProfile } from '@extension/storage';
import { PRODUCT_METRICS } from '../../growth/collect';
import type { FactStore } from './facts';

/**
 * Numbers per post (docs/growth-team.md, Part 8): what each post the product's links were made for brought, from
 * the metrics store. Plain code; a post with no read day says "no reading", never 0.
 */

export const POST_DAYS = 14;

export interface PostResult {
  postId: string;
  // Each metric's sum over the days that were read
  numbers: Record<string, number>;
  readDays: number;
}

export async function postResults(
  profile: ProductProfile,
  now: number,
  store: FactStore = growthStore,
): Promise<PostResult[]> {
  const to = utcDay(now);
  const from = shiftDay(to, -(POST_DAYS - 1));
  const posts = new Map<string, PostResult & { days: Set<string> }>();
  for (const metric of PRODUCT_METRICS) {
    const [rows, readings] = await Promise.all([
      store.metrics(profile.workspaceId, metric, from, to),
      store.readings(profile.workspaceId, metric, from, to),
    ]);
    const read = new Set(readings.filter(reading => reading.status === 'ok').map(reading => reading.date));
    for (const row of rows) {
      if (!row.postId || !read.has(row.date)) continue;
      const post = posts.get(row.postId) ?? { postId: row.postId, numbers: {}, readDays: 0, days: new Set<string>() };
      post.numbers[metric] = (post.numbers[metric] ?? 0) + row.value;
      post.days.add(row.date);
      posts.set(row.postId, post);
    }
  }
  return [...posts.values()]
    .map(({ days, ...post }) => ({ ...post, readDays: days.size }))
    .sort((a, b) => (b.numbers.signups ?? 0) - (a.numbers.signups ?? 0) || a.postId.localeCompare(b.postId, 'en'));
}

export function postResultsText(results: readonly PostResult[]): string {
  if (!results.length) {
    return `No reading for any post in the last ${POST_DAYS} days: links made with make_link carry a post id, and their numbers show here once the product reports them.`;
  }
  return [
    `What each post brought over the last ${POST_DAYS} days (read days only):`,
    ...results.map(
      post =>
        `- ${post.postId}: ${Object.entries(post.numbers)
          .map(([metric, value]) => `${value} ${metric}`)
          .join(', ')} (${post.readDays} days read)`,
    ),
  ].join('\n');
}
