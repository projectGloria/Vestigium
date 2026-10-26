import { useCallback, useEffect, useState, useTransition } from 'react';
import type { Bridge, Result } from '../shared/ipc.js';
import type { AppState } from '../shared/types.js';

declare global {
  interface Window { vestigium: Bridge }
}

export const bridge = (): Bridge => window.vestigium;

// The renderer holds no copy of app data beyond the latest AppState snapshot pushed by main.
// `act` runs one bridge call inside a transition, so `pending` is true until main has answered.
export function useAppState() {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState('');
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    const off = bridge().onState(setState);
    void bridge().getState().then(result => {
      if (result.ok) setState(result.state);
    });
    return off;
  }, []);

  const act = useCallback((call: () => Promise<Result>) => {
    startTransition(async () => {
      let result: Result;
      try {
        result = await call();
      } catch {
        result = { ok: false, error: 'The application could not complete this request.' };
      }
      // Updates after an await are outside the original transition scope; wrap them again (React 19 caveat).
      startTransition(() => {
        if (result.ok) {
          setState(result.state);
          setError('');
        } else {
          setError(result.error);
        }
      });
    });
  }, []);

  return { state, error, pending, act };
}

export type Act = ReturnType<typeof useAppState>['act'];
