import { Component, type ErrorInfo, type ReactNode } from 'react';

import { ConfigError } from '../config/env.ts';
import { Button } from '../ui/Button.tsx';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches render-time errors so a component fault never leaves a blank page.
 * Configuration mistakes (a missing API origin) get their own message, because the
 * fix belongs to whoever deployed the app, not to the person using it.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Unhandled UI error', error, info.componentStack);
  }

  private readonly handleReload = () => {
    window.location.reload();
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const isConfigProblem = error instanceof ConfigError;

    return (
      <div className="flex min-h-dvh items-center justify-center bg-sunken p-6">
        <div role="alert" className="measure rounded-lg border border-line bg-surface p-6 shadow-soft">
          <h1 className="font-display text-xl font-semibold text-ink">{isConfigProblem ? 'QOBO Support is not configured' : 'This page stopped working'}</h1>
          <p className="mt-2 text-[15px] text-muted">
            {isConfigProblem ? error.message : 'Reload to continue. If it keeps happening, contact the QOBO team.'}
          </p>
          {!isConfigProblem && (
            <Button className="mt-5" onClick={this.handleReload}>
              Reload page
            </Button>
          )}
        </div>
      </div>
    );
  }
}
