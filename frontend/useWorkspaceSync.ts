import { useEffect } from 'react';
import { useAppStore } from './stores/useAppStore';

// Keeps the workspace current. While the live stream is connected the server
// signals each saved change, so the view refreshes at once; polling then only
// runs as a slow safety net. Without a stream, it polls every ten seconds.
const POLL_MS = 10000;
const POLL_WHILE_LIVE_MS = 60000;
const COALESCE_MS = 300;

export function useWorkspaceSync() {
  const owner = useAppStore((state) => state.state?.user.id);
  useEffect(() => {
    if (!owner) return;
    let active = true,
      running = false,
      pending = false,
      live = false,
      lastSync = 0,
      debounce: number | undefined;
    const sync = async (): Promise<void> => {
      if (!active || document.visibilityState === 'hidden' || navigator.onLine === false)
        return;
      if (running) {
        pending = true;
        return;
      }
      running = true;
      lastSync = Date.now();
      try {
        await useAppStore.getState().sync();
      } finally {
        running = false;
      }
      if (pending && active) {
        pending = false;
        void sync();
      }
    };
    const onChange = () => {
      window.clearTimeout(debounce);
      debounce = window.setTimeout(() => void sync(), COALESCE_MS);
    };
    let source: EventSource | null = null;
    if (typeof EventSource !== 'undefined') {
      source = new EventSource('/api/events');
      source.onopen = () => {
        live = true;
      };
      source.addEventListener('changed', onChange);
      source.onerror = () => {
        live = false;
        // A closed stream (for example after sign-out) is not retried automatically.
        if (source?.readyState === EventSource.CLOSED) source.close();
      };
    }
    const interval = window.setInterval(() => {
      if (!live || Date.now() - lastSync >= POLL_WHILE_LIVE_MS) void sync();
    }, POLL_MS);
    const wake = () => void sync();
    window.addEventListener('focus', wake);
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', wake);
    return () => {
      active = false;
      source?.close();
      window.clearTimeout(debounce);
      window.clearInterval(interval);
      window.removeEventListener('focus', wake);
      window.removeEventListener('online', wake);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [owner]);
}
