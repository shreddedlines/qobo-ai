import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';

import { useAuth } from './AuthProvider.tsx';
import { guardDecision } from './guards.ts';

interface GuardProps {
  children: ReactNode;
}

/** Shown only while the stored session is being read; deliberately quiet. */
function SessionLoading() {
  return (
    <div className="flex flex-1 items-center justify-center py-16" aria-busy="true">
      <p className="text-[15px] text-muted" role="status">
        Loading your account…
      </p>
    </div>
  );
}

/** Wraps routes that need a session: /chat and /chat/:conversationId. */
export function RequireAuth({ children }: GuardProps) {
  const { status } = useAuth();
  const location = useLocation();
  const decision = guardDecision({ status, requiresAuth: true, currentPath: `${location.pathname}${location.search}` });

  if (decision.action === 'wait') return <SessionLoading />;
  if (decision.action === 'redirect') return <Navigate to={decision.to} replace state={{ from: decision.from }} />;
  return children;
}

/** Wraps /login and /signup: a signed-in person is sent to where they were going. */
export function RedirectIfSignedIn({ children }: GuardProps) {
  const { status } = useAuth();
  const location = useLocation();
  const intendedPath = (location.state as { from?: string } | null)?.from;
  const decision = guardDecision({ status, requiresAuth: false, currentPath: location.pathname, intendedPath });

  if (decision.action === 'wait') return <SessionLoading />;
  if (decision.action === 'redirect') return <Navigate to={decision.to} replace />;
  return children;
}
