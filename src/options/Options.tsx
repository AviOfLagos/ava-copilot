import { useState } from 'react';
import './Options.css';
import { withErrorBoundary, withSuspense } from '@extension/shared';
import { t } from '@extension/i18n';
import { FiSettings, FiCpu, FiShield, FiHelpCircle, FiBookmark } from 'react-icons/fi';
import { GeneralSettings } from './components/GeneralSettings';
import { ModelSettings } from './components/ModelSettings';
import { FirewallSettings } from './components/FirewallSettings';
import { LiveOrb } from '../side-panel/components/ui/live-orb';
import { useTheme } from '../side-panel/layout/theme';
import { SkillsSettings } from './components/SkillsSettings';

type TabTypes = 'general' | 'models' | 'skills' | 'firewall' | 'help';

const TABS: { id: TabTypes; icon: React.ComponentType<{ className?: string }>; label: string }[] = [
  { id: 'general', icon: FiSettings, label: t('options_tabs_general') },
  { id: 'models', icon: FiCpu, label: t('options_tabs_models') },
  { id: 'skills', icon: FiBookmark, label: t('options_tabs_skills') },
  { id: 'firewall', icon: FiShield, label: t('options_tabs_firewall') },
  { id: 'help', icon: FiHelpCircle, label: t('options_tabs_help') },
];

const Options = () => {
  const [activeTab, setActiveTab] = useState<TabTypes>('models');
  // The look follows the panel's choice; the page always renders its dark variant, whose colours the
  // page's Tailwind config maps to the theme (dark or light)
  useTheme();
  const isDarkMode = true;

  const handleTabClick = (tabId: TabTypes) => {
    if (tabId === 'help') {
      window.open('https://nanobrowser.ai/docs', '_blank');
    } else {
      setActiveTab(tabId);
    }
  };

  const renderTabContent = () => {
    switch (activeTab) {
      case 'general':
        return <GeneralSettings isDarkMode={isDarkMode} />;
      case 'models':
        return <ModelSettings isDarkMode={isDarkMode} />;
      case 'skills':
        return <SkillsSettings isDarkMode={isDarkMode} />;
      case 'firewall':
        return <FirewallSettings isDarkMode={isDarkMode} />;
      default:
        return null;
    }
  };

  return (
    <div className="aura flex min-h-screen min-w-[768px] font-sans text-foreground">
      <nav aria-label={t('options_nav_header')} className="glass m-3 w-56 shrink-0 self-start rounded-2xl p-3">
        <div className="mb-5 flex items-center gap-2.5 px-2 pt-1">
          <LiveOrb size={28} />
          <h1 className="text-[15px] font-semibold tracking-tight">{t('options_nav_header')}</h1>
        </div>
        <ul className="space-y-1">
          {TABS.map(item => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => handleTabClick(item.id)}
                aria-current={activeTab === item.id ? 'page' : undefined}
                className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13.5px] transition-colors ${
                  activeTab === item.id
                    ? 'border border-[var(--color-border)] bg-[var(--color-accent)] text-[var(--color-foreground)]'
                    : 'text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)]'
                }`}>
                <item.icon className="size-4" />
                <span>{item.label}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <main className="min-w-0 flex-1 p-8 pl-5">
        <div className="mx-auto min-w-[512px] max-w-screen-lg">{renderTabContent()}</div>
      </main>
    </div>
  );
};

export default withErrorBoundary(withSuspense(Options, <div>Loading...</div>), <div>Error Occurred</div>);
