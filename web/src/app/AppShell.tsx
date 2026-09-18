import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';

import { useAuth } from '../auth/AuthProvider.tsx';
import { Button } from '../ui/Button.tsx';
import { Logo } from '../ui/Logo.tsx';
import { ThemeToggle } from '../ui/ThemeToggle.tsx';

function AccountArea() {
  const { status, user, signOut } = useAuth();
  const navigate = useNavigate();
  const [signingOut, setSigningOut] = useState(false);

  if (status === 'loading') return null;

  if (status === 'signed-out') {
    return (
      <Link to="/login" className="flex min-h-11 items-center rounded-md px-3 text-[15px] font-medium text-ink underline underline-offset-2">
        Sign in
      </Link>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <span className="hidden max-w-[22ch] truncate text-[14px] text-muted sm:inline" title={user?.email ?? undefined}>
        {user?.email}
      </span>
      <Button
        variant="secondary"
        className="whitespace-nowrap"
        disabled={signingOut}
        onClick={async () => {
          setSigningOut(true);
          await signOut();
          navigate('/login', { replace: true });
        }}
      >
        {signingOut ? 'Signing out…' : 'Sign out'}
      </Button>
    </div>
  );
}

export interface AppShellProps {
  children: ReactNode;
}

/**
 * App frame: skip link, banner and the main landmark. One hairline separates the
 * header from the content — no card-in-card nesting.
 */
export function AppShell({ children }: AppShellProps) {
  return (
    <div className="flex min-h-dvh flex-col bg-sunken">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-surface focus:px-4 focus:py-2 focus:text-ink focus:shadow-soft"
      >
        Skip to main content
      </a>

      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between gap-4 px-4">
          <Link to="/chat" className="flex min-h-11 items-center rounded-sm" aria-label="QOBO Support home">
            <Logo />
          </Link>
          <div className="flex items-center gap-1 sm:gap-2">
            <ThemeToggle />
            <AccountArea />
          </div>
        </div>
      </header>

      {/* tabIndex -1 lets the skip link actually move focus here: without it the hash
          changes but focus stays on the body, so the link announces nothing. */}
      <main id="main" tabIndex={-1} className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-4">
        {children}
      </main>
    </div>
  );
}
