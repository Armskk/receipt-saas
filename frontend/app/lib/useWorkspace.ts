'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ApiError,
  clearToken,
  getStoredWorkspaceId,
  getToken,
  listWorkspaces,
  setStoredWorkspaceId,
  type Workspace,
} from './api';

// Shared across the dashboard and the summary page: bounces to /login when
// there's no token, loads the workspace list, and remembers which workspace
// is active so switching on one page carries to the other.
export function useWorkspace() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceIdState] = useState('');
  const [error, setError] = useState<string | null>(null);

  const signOut = useCallback(() => {
    clearToken();
    router.replace('/login');
  }, [router]);

  const setWorkspaceId = useCallback((id: string) => {
    setWorkspaceIdState(id);
    setStoredWorkspaceId(id);
  }, []);

  useEffect(() => {
    if (!getToken()) {
      router.replace('/login');
      return;
    }
    listWorkspaces()
      .then((ws) => {
        setWorkspaces(ws);
        const stored = getStoredWorkspaceId();
        const pick =
          (stored && ws.some((w) => w.id === stored) && stored) ||
          ws[0]?.id ||
          '';
        setWorkspaceIdState(pick);
        setReady(true);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) signOut();
        else setError(err instanceof Error ? err.message : 'Failed to load');
      });
  }, [router, signOut]);

  return { ready, workspaces, workspaceId, setWorkspaceId, signOut, error };
}
