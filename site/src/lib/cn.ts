import { clsx } from 'clsx';
import type { ClassValue } from 'clsx';

/**
 * The app's `cn` (src/ui/lib/utils.ts) without tailwind-merge, which would add about 8 KB gzipped to the hero.
 * The widgets the site uses never receive conflicting classes from the site, and the one conflict inside them
 * (HoldButton's armed background, bg-hold/30 over bg-hold/15) is settled the same way by Tailwind's own order.
 */
export const cn = (...inputs: ClassValue[]) => clsx(inputs);
