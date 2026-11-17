import { useEffect } from 'react';
import { useAppStore } from './stores/useAppStore';

export function useWorkspaceSync() {
  const owner = useAppStore((state) => state.state?.user.id);
  useEffect(() => {
    if (!owner) return;
    let active = true,
      running = false;
    const sync = async () => {
      if (
        !active ||
        running ||
        document.visibilityState === 'hidden' ||
        navigator.onLine === false
      )
        return;
      running = true;
      try {
        await useAppStore.getState().sync();
      } finally {
        running = false;
      }
    };
    const interval = window.setInterval(() => void sync(), 10000);
    const wake = () => void sync();
    window.addEventListener('focus', wake);
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', wake);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener('focus', wake);
      window.removeEventListener('online', wake);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [owner]);
}
