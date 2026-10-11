import { ChevronRight } from 'lucide-react';
import { t } from '@extension/i18n';
import { cn } from '@extension/ui';

export interface Crumb {
  label: string;
  // Where the crumb leads; the last one, where you are, leads nowhere
  onClick?: () => void;
}

/** Where you are in the copilot, each step back one click away. */
export default function Breadcrumbs({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav aria-label={t('nav_breadcrumbs')} className="min-w-0 flex-1">
      <ol className="flex min-w-0 items-center gap-0.5 text-[13px]">
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          return (
            <li
              key={`${crumb.label}-${index}`}
              className={cn('flex min-w-0 items-center gap-0.5', last ? 'flex-1' : 'shrink-0')}>
              {index > 0 && <ChevronRight className="text-muted-foreground/70 size-3 shrink-0" aria-hidden="true" />}
              {last || !crumb.onClick ? (
                <span
                  aria-current={last ? 'page' : undefined}
                  className={cn('truncate px-1', last ? 'font-medium tracking-tight' : 'text-muted-foreground')}>
                  {crumb.label}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={crumb.onClick}
                  className="text-muted-foreground hover:bg-accent max-w-[110px] truncate rounded-md px-1 py-0.5 hover:text-foreground">
                  {crumb.label}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
