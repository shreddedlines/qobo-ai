import { useEffect, useState } from 'react';

import { getApiClient } from '../api/instance.ts';
import { toUserFacingError } from '../api/errors.ts';

type State = { kind: 'checking' } | { kind: 'ok' } | { kind: 'error'; detail: string };

/**
 * Checks the API's public health endpoint, so a misconfigured VITE_API_BASE_URL or a
 * sleeping API is visible before someone types a message rather than after.
 */
export function ApiStatus() {
  const [state, setState] = useState<State>({ kind: 'checking' });

  useEffect(() => {
    const controller = new AbortController();
    getApiClient()
      .health({ signal: controller.signal })
      .then(() => setState({ kind: 'ok' }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ kind: 'error', detail: toUserFacingError(error).detail });
      });
    return () => controller.abort();
  }, []);

  const label =
    state.kind === 'checking' ? 'Checking connection to QOBO…' : state.kind === 'ok' ? 'Connected to QOBO' : `Not connected. ${state.detail}`;

  // Only a problem is worth interrupting for. A working connection is shown, not
  // announced, so a screen reader does not read "Connected to QOBO" on every page load.
  return (
    <p {...(state.kind === 'error' ? { role: 'alert' as const } : {})} className="flex items-center gap-2 text-[13px] text-muted">
      <span
        aria-hidden="true"
        className={`size-1.5 rounded-full ${state.kind === 'ok' ? 'bg-ink' : state.kind === 'error' ? 'bg-danger' : 'bg-line'}`}
      />
      {label}
    </p>
  );
}
