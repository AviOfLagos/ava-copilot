import { useEffect, useMemo, useState } from 'react';
import type { ComponentType } from 'react';
import './Options.css';
import {
  AudioLines,
  BookOpen,
  CircleHelp,
  Cpu,
  Disc,
  Plug,
  Search,
  Settings2,
  ShieldCheck,
  Smile,
  X,
} from 'lucide-react';
import { withErrorBoundary, withSuspense } from '@extension/shared';
import { t } from '@extension/i18n';
import { cn } from '@extension/ui';
import '../side-panel/registers';
import { LiveOrb } from '../side-panel/components/ui/live-orb';
import { useTheme } from '../side-panel/layout/theme';
import { registeredSettingsSections } from '../side-panel/registry';
import type { SettingsPageId, SettingsSectionDefinition } from '../side-panel/registry';
import {
  SETTINGS_PAGES,
  searchWords,
  sectionForAnchor,
  sectionHash,
  sectionMatches,
  settingsHash,
} from '../side-panel/settings/pages';
import { SectionCard, sectionElementId } from '../side-panel/settings/SectionCard';
import VoiceModelsCard from '../side-panel/voice-models/VoiceModelsCard';
import { createSettingsApi } from './settingsApi';
import { useSettingsRoute } from './useSettingsRoute';

/*
 * The full-page Settings: a page per area (General, Models, Voice…) in a left nav, each made of the sections
 * features register (src/side-panel/registry.ts), the same components the side panel used to stack in one list.
 * The address says where you are (`#voice/engines`), so back/forward and deep links work; a search finds a
 * setting by its name or words about it, across every page.
 */

const PAGE_ICONS: Record<SettingsPageId, ComponentType<{ className?: string }>> = {
  general: Settings2,
  models: Cpu,
  voice: AudioLines,
  personalities: Smile,
  memory: BookOpen,
  connections: Plug,
  meetings: Disc,
  privacy: ShieldCheck,
  help: CircleHelp,
};

function sectionTexts(section: SettingsSectionDefinition): string[] {
  const page = SETTINGS_PAGES.find(item => item.id === section.page);
  return [t(section.label), page ? t(page.label) : '', ...(section.keywords ?? [])];
}

const Options = () => {
  useTheme();
  const { route, navigate } = useSettingsRoute();
  const api = useMemo(() => createSettingsApi(navigate), [navigate]);
  const [query, setQuery] = useState('');
  const words = searchWords(query);

  // Pages with something on them, in nav order; the nav is what is registered
  const pages = SETTINGS_PAGES.filter(page => registeredSettingsSections(page.id).length > 0);
  const page = pages.find(item => item.id === route.page) ?? pages[0];
  const sections = page ? registeredSettingsSections(page.id) : [];
  const target = sectionForAnchor(sections, route.anchor);
  // An anchor that names no section is the first section's (a tab: #models/local)
  const anchorFor = (section: SettingsSectionDefinition): string | undefined => {
    if (target) return target.id === section.id ? route.anchor?.split('/').slice(1).join('/') || undefined : undefined;
    return section === sections[0] ? (route.anchor ?? undefined) : undefined;
  };
  const results = words.length
    ? registeredSettingsSections().filter(section => sectionMatches(words, sectionTexts(section)))
    : [];

  useEffect(() => {
    document.title = page ? `${t(page.label)} · ${t('options_nav_header')}` : t('options_nav_header');
  }, [page]);

  // Land on the section the address names, once it is drawn; a page alone starts at the top
  useEffect(() => {
    if (words.length) return;
    if (!target) {
      window.scrollTo({ top: 0 });
      return;
    }
    let tries = 0;
    const look = () => {
      const element = document.getElementById(sectionElementId(target));
      if (element) {
        element.scrollIntoView({ block: 'start' });
        if (!element.hasAttribute('tabindex')) element.setAttribute('tabindex', '-1');
        element.focus({ preventScroll: true });
        return;
      }
      if (++tries < 20) window.setTimeout(look, 100);
    };
    window.setTimeout(look, 30);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.page, route.anchor, target?.id, words.length]);

  // Narrow windows: the current page's chip stays in sight
  useEffect(() => {
    document
      .querySelector('[data-page-chip][aria-current="page"]')
      ?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }, [page?.id]);

  const go = (id: SettingsPageId) => {
    setQuery('');
    navigate(settingsHash(id));
  };

  const searchBox = (
    <label className="glass flex h-9 items-center gap-2 rounded-xl px-3">
      <Search className="text-muted-foreground size-4 shrink-0" aria-hidden />
      <input
        type="search"
        value={query}
        onChange={event => setQuery(event.target.value)}
        placeholder={t('settings_search_placeholder')}
        aria-label={t('settings_search_label')}
        className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-[13px] outline-none"
      />
      {query && (
        <button
          type="button"
          onClick={() => setQuery('')}
          aria-label={t('settings_search_clear')}
          className="text-muted-foreground hover:text-foreground">
          <X className="size-3.5" />
        </button>
      )}
    </label>
  );

  const navList = (
    <ul className="space-y-0.5">
      {pages.map(item => {
        const Icon = PAGE_ICONS[item.id];
        const current = !words.length && page?.id === item.id;
        return (
          <li key={item.id}>
            <a
              href={settingsHash(item.id)}
              onClick={event => {
                event.preventDefault();
                go(item.id);
              }}
              aria-current={current ? 'page' : undefined}
              data-settings-page={item.id}
              className={cn(
                'flex items-center gap-2.5 rounded-xl px-3 py-2 text-[13.5px] transition-colors',
                current
                  ? 'border border-[var(--color-border)] bg-[var(--color-accent)] text-[var(--color-foreground)]'
                  : 'border border-transparent text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)]',
              )}>
              <Icon className="size-4 shrink-0" />
              <span className="truncate">{t(item.label)}</span>
            </a>
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className="aura min-h-screen font-sans text-foreground">
      <div className="mx-auto flex w-full max-w-[1160px] gap-6 px-4 md:px-6">
        <nav
          aria-label={t('options_nav_header')}
          className="sticky top-0 hidden max-h-screen w-60 shrink-0 flex-col gap-4 self-start overflow-y-auto py-6 md:flex">
          <div className="flex items-center gap-2.5 px-2">
            <LiveOrb size={28} />
            <span className="text-[15px] font-semibold tracking-tight">{t('options_nav_header')}</span>
          </div>
          {searchBox}
          {navList}
        </nav>

        <main className="min-w-0 flex-1 pb-16 md:max-w-[760px]">
          {/* Narrow windows: the pages as a row of chips above the content */}
          <div className="flex flex-col gap-2 pt-4 md:hidden">
            <div className="flex items-center gap-2 px-1">
              <LiveOrb size={22} />
              <span className="text-[14px] font-semibold tracking-tight">{t('options_nav_header')}</span>
            </div>
            {searchBox}
            <nav aria-label={t('settings_pages_label')} className="-mx-4 overflow-x-auto px-4">
              <ul className="flex gap-1">
                {pages.map(item => (
                  <li key={item.id}>
                    <a
                      href={settingsHash(item.id)}
                      onClick={event => {
                        event.preventDefault();
                        go(item.id);
                      }}
                      aria-current={!words.length && page?.id === item.id ? 'page' : undefined}
                      data-page-chip
                      className={cn(
                        'block whitespace-nowrap rounded-full border px-3 py-1 text-[12.5px]',
                        !words.length && page?.id === item.id
                          ? 'bg-accent text-foreground'
                          : 'text-muted-foreground border-transparent',
                      )}>
                      {t(item.label)}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          </div>

          <header className="sticky top-0 z-10 -mx-4 bg-[var(--color-background)]/80 px-4 pb-3 pt-4 backdrop-blur-md md:-mx-2 md:px-2 md:pt-6">
            <h1 className="text-[22px] font-semibold tracking-[-0.03em]" data-settings-title>
              {words.length ? t('settings_search_results', [query.trim()]) : page ? t(page.label) : ''}
            </h1>
            {!words.length && page && <p className="text-muted-foreground mt-0.5 text-[12.5px]">{t(page.hint)}</p>}
          </header>

          <VoiceModelsCard placement="panel" />

          <div className="mt-2 flex flex-col gap-6">
            {words.length ? (
              results.length ? (
                results.map(section => (
                  <div key={section.id} className="flex flex-col gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        setQuery('');
                        navigate(sectionHash(section));
                      }}
                      className="text-muted-foreground hover:text-foreground self-start px-1 text-[11.5px]">
                      {t(SETTINGS_PAGES.find(item => item.id === section.page)?.label ?? 'options_nav_header')} ›
                    </button>
                    <SectionCard section={section} api={api} />
                  </div>
                ))
              ) : (
                <p className="text-muted-foreground px-1 text-[13px]" role="status">
                  {t('settings_search_none', [query.trim()])}
                </p>
              )
            ) : (
              sections.map(section => (
                <SectionCard
                  key={section.id}
                  section={section}
                  api={api}
                  anchor={anchorFor(section)}
                  showLabel={sections.length > 1}
                />
              ))
            )}
          </div>
        </main>
      </div>
    </div>
  );
};

export default withErrorBoundary(withSuspense(Options, <div>Loading...</div>), <div>Error Occurred</div>);
