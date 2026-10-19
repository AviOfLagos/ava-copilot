import { Component } from 'react';
import type { ReactNode } from 'react';
import { t } from '@extension/i18n';
import type { PanelApi, SettingsSectionDefinition } from '../registry';
import { sectionSlug } from './pages';

/** One section that failed to draw says so, and the rest of the page stays. */
class SectionBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return <p className="text-destructive px-3 py-2.5 text-[12px]">{t('settings_section_failed')}</p>;
    }
    return this.props.children;
  }
}

export const sectionElementId = (section: Pick<SettingsSectionDefinition, 'id' | 'page'>) =>
  `settings-${section.page}-${sectionSlug(section)}`;

/** A settings section as a titled glass card (or bare, when it brings its own cards). */
export function SectionCard({
  section,
  api,
  anchor,
  showLabel = true,
}: {
  section: SettingsSectionDefinition;
  api: PanelApi;
  anchor?: string;
  // Off when the section is all the page has: the page's title already names it
  showLabel?: boolean;
}) {
  const label = t(section.label);
  const body = (
    <SectionBoundary>
      <section.Component api={api} anchor={anchor} />
    </SectionBoundary>
  );
  return (
    <section
      id={sectionElementId(section)}
      aria-label={label}
      data-settings-section={section.id}
      className="scroll-mt-28 outline-none">
      {showLabel ? <h2 className="label-mono mb-1.5 px-1">{label}</h2> : <h2 className="sr-only">{label}</h2>}
      {section.bare ? body : <div className="glass divide-border/60 divide-y overflow-hidden rounded-2xl">{body}</div>}
    </section>
  );
}
