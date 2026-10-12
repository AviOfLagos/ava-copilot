import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { t } from '@extension/i18n';
import { Button } from './ui/button';

/**
 * Keeps one broken screen from blanking the whole panel: it shows what happened and a way to try again.
 * Give it a `key` per place, so moving elsewhere starts it fresh.
 */
export default class RouteBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('A panel screen failed', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-[13.5px] font-medium">{t('route_failed')}</p>
        <p className="text-muted-foreground max-w-[280px] break-words text-[12px]">{this.state.error.message}</p>
        <Button size="sm" variant="glass" onClick={() => this.setState({ error: null })}>
          {t('route_retry')}
        </Button>
      </div>
    );
  }
}
