import { create } from 'zustand';
import { useUiStore } from './useUiStore';
import {
  api,
  ApiError,
  setCsrf,
  syncCsrf,
  getSessionRevision,
  invalidateSessionRequests,
} from '../api';

import type { Workspace, User, Payload, Action } from '../types';

import {
  cacheWorkspace,
  cachedWorkspace,
  clearOfflineWorkspace,
  projectQueue,
  enqueue,
  pendingActions,
  discardPending,
  offlineActions,
  sendDriverAction,
  isConnectionFailure,
  type PendingAction,
} from '../offline';
import { useTracking } from '../tracking';
let refreshSequence = 0;

interface AppState {
  state: Workspace | null;
  loading: boolean;
  bootError: string;
  busy: boolean;
  message: string;
  needsRefresh: boolean;
  refreshReason: 'saved' | 'conflict' | null;

  assignmentAlert: string;
  syncError: string;
  refreshVersion: number;
  sync: () => Promise<void>;
  boot: () => Promise<void>;
  refresh: () => Promise<void>;
  save: (
    work: () => Promise<unknown>,
    message: string,
    onSaved?: () => void,
  ) => Promise<void>;
  logout: () => Promise<void>;
  setMessage: (message: string) => void;
  clearMessage: () => void;
  run: (work: () => Promise<void>) => Promise<void>;
  act: (id: string, version: number, action: Action, data?: Payload) => Promise<void>;
}

async function refreshWorkspace(
  set: (update: Partial<AppState>) => void,
  get: () => AppState,
) {
  const revision = getSessionRevision(),
    sequence = ++refreshSequence;
  try {
    const next = await api<Workspace>('/api/state');
    if (revision !== getSessionRevision() || sequence !== refreshSequence) return;
    if (typeof next.csrf === 'string') syncCsrf(next.csrf);
    const previousOwner = get().state?.user.id;
    if (previousOwner && previousOwner !== next.user.id) {
      const ui = useUiStore.getState();
      ui.setPage('dashboard');
      ui.close();
      ui.syncDeliveryDrafts(next.user.id, [], []);
    }
    const previous = get().state;
    if (previous?.user.id === next.user.id && next.user.role === 'driver') {
      const removed = previous.shipments.filter(
        (s) =>
          s.driverId === next.user.id &&
          !['Delivered', 'Returned', 'Cancelled'].includes(s.status) &&
          !next.shipments.some((n) => n.id === s.id && n.driverId === next.user.id),
      );
      if (removed.length)
        set({
          assignmentAlert: `Your assignment changed for ${removed.map((s) => s.id).join(', ')}. Stop following the previous instructions and review Notifications.`,
        });
    } else if (previous?.user.id !== next.user.id) set({ assignmentAlert: '' });
    cacheWorkspace(next);
    const projected = projectQueue(next);
    set({
      state:
        JSON.stringify(get().state) === JSON.stringify(projected)
          ? get().state
          : projected,
      needsRefresh: false,
      refreshReason: null,
      syncError: '',
      refreshVersion: get().refreshVersion + 1,
    });
    return getSessionRevision();
  } catch (e) {
    if (revision !== getSessionRevision() || sequence !== refreshSequence) return;
    throw e;
  }
}

export const useAppStore = create<AppState>((set, get) => ({
  state: null,
  loading: true,
  bootError: '',
  busy: false,
  message: '',
  needsRefresh: false,
  refreshReason: null,
  assignmentAlert: '',
  syncError: '',
  refreshVersion: 0,

  async sync() {
    if (
      get().busy ||
      get().needsRefresh ||
      !get().state ||
      pendingActions(get().state!.user.id).length
    )
      return;
    const revision = getSessionRevision();
    try {
      await get().refresh();
    } catch (e) {
      if (revision !== getSessionRevision()) return;
      if (e instanceof ApiError && e.status === 401) {
        useTracking.getState().stop();
        clearOfflineWorkspace();
        setCsrf(null);
        set({
          state: null,
          syncError: '',
          message: 'Your session expired. Log in to continue.',
        });
      } else {
        set({
          syncError:
            'Live updates are unavailable. Displayed instructions may be out of date; refresh before acting.',
        });
      }
    }
  },

  async boot() {
    let revision = getSessionRevision();
    set({ loading: true, bootError: '' });
    if (navigator.onLine === false) {
      const cached = cachedWorkspace();
      if (cached) {
        set({
          state: cached,
          loading: false,
          message:
            'Offline: showing saved driver workspace. Actions will await server confirmation.',
        });
        return;
      }
    }
    try {
      const session = await api<{ user: User | null; csrf: string | null }>(
        '/api/session',
      );
      if (revision !== getSessionRevision()) return;
      setCsrf(session.csrf);
      revision = getSessionRevision();
      if (session.user) {
        const refreshedRevision = await refreshWorkspace(set, get);
        if (refreshedRevision !== undefined) revision = refreshedRevision;
      } else {
        useTracking.getState().stop();
        clearOfflineWorkspace();
        set({ state: null, needsRefresh: false, refreshReason: null });
      }
    } catch (e) {
      if (revision !== getSessionRevision()) return;
      if (isConnectionFailure(e)) {
        const cached = cachedWorkspace();
        if (cached) {
          set({
            state: cached,
            bootError: '',
            message:
              'Connection unavailable. Showing the saved driver workspace; actions await server confirmation.',
          });
          return;
        }
      }
      if (e instanceof ApiError && e.status === 401) {
        setCsrf(null);
        revision = getSessionRevision();
        set({ state: null, bootError: '', needsRefresh: false, refreshReason: null });
      } else {
        set({ bootError: e instanceof Error ? e.message : 'Cannot load workspace.' });
      }
    } finally {
      if (revision === getSessionRevision()) set({ loading: false });
    }
  },

  async refresh() {
    await refreshWorkspace(set, get);
  },

  async save(work, message, onSaved) {
    if (get().needsRefresh) {
      set({ message: 'Refresh the workspace before making another change.' });
      return;
    }
    await get().run(async () => {
      const revision = getSessionRevision();
      await work();
      if (revision !== getSessionRevision()) return;
      set({ needsRefresh: true, refreshReason: 'saved' });
      onSaved?.();
      try {
        await get().refresh();
        if (revision !== getSessionRevision()) return;
        set({ message });
      } catch (e) {
        if (revision !== getSessionRevision()) return;
        if (e instanceof ApiError && e.status === 401) {
          setCsrf(null);
          useTracking.getState().stop();
          clearOfflineWorkspace();
          set({ state: null, needsRefresh: false, refreshReason: null });
        }
        set({
          message: `${message} The latest workspace could not be loaded. Your change was saved; refresh before making another change.`,
        });
      }
    });
  },

  async logout() {
    if (get().busy) return;
    // Invalidate reads immediately, including while the logout POST is pending.
    // Keep the current token so a failed logout can be retried.
    invalidateSessionRequests();
    await get().run(async () => {
      await api('/api/logout', 'POST', {});
      useTracking.getState().stop();
      clearOfflineWorkspace();
      setCsrf(null);
      set({ state: null, needsRefresh: false, refreshReason: null, loading: false });
    });
  },

  setMessage(message) {
    set({ message });
  },

  clearMessage() {
    set({ message: '' });
  },

  async run(work) {
    if (get().busy) return;
    refreshSequence++;
    set({ busy: true, message: '' });
    const revision = getSessionRevision();
    try {
      await work();
    } catch (e) {
      if (revision !== getSessionRevision()) return;
      set({
        message:
          e instanceof Error ? e.message : 'Cannot connect. Your changes were not saved.',
      });
      if (e instanceof ApiError && e.status === 401) {
        setCsrf(null);
        useTracking.getState().stop();
        clearOfflineWorkspace();
        set({ state: null, needsRefresh: false, refreshReason: null });
      }
      if (e instanceof ApiError && e.status === 409) {
        set({ needsRefresh: true, refreshReason: 'conflict' });
        try {
          await get().refresh();
        } catch (refreshError) {
          if (revision !== getSessionRevision()) return;
          if (refreshError instanceof ApiError && refreshError.status === 401) {
            setCsrf(null);
            useTracking.getState().stop();
            clearOfflineWorkspace();
            set({ state: null, needsRefresh: false, refreshReason: null });
          }
          set({
            message: `${e.message} The latest workspace could not be loaded. Refresh before making another change.`,
          });
        }
      }
    } finally {
      set({ busy: false });
    }
  },

  async act(id, version, action, data = {}) {
    if (get().needsRefresh) {
      set({ message: 'Refresh the workspace before making another change.' });
      return;
    }
    const workspace = get().state;
    const owner = workspace?.user.id;
    if (workspace?.user.role === 'driver' && owner && offlineActions.has(action)) {
      const entry: PendingAction = {
        requestKey: crypto.randomUUID(),
        id,
        version,
        action,
        data: action === 'acceptJob' ? { ...data, driverId: owner } : data,
        queuedAt: new Date().toISOString(),
      };
      await get().run(async () => {
        const actionSession = getSessionRevision();
        // Persist before sending: a lost response or page close cannot lose the retry key.
        enqueue(owner, entry);
        if (navigator.onLine && pendingActions(owner).length === 1) {
          try {
            const revision = getSessionRevision();
            await sendDriverAction(entry);
            if (revision !== getSessionRevision()) return;
            discardPending(owner, entry.requestKey);
            useUiStore
              .getState()
              .clearActionDraft(
                owner,
                id,
                action,
                ['respondRequest', 'withdrawRequest'].includes(action) &&
                  typeof data.requestId === 'string'
                  ? data.requestId
                  : undefined,
              );
            try {
              await get().refresh();
              if (revision !== getSessionRevision()) return;
              set({ message: 'Delivery updated.' });
            } catch {
              if (revision === getSessionRevision())
                set({
                  needsRefresh: true,
                  refreshReason: 'saved',
                  message:
                    'Delivery updated. The latest workspace could not be loaded. Your change was saved; refresh before making another change.',
                });
            }
            return;
          } catch (e) {
            if (!isConnectionFailure(e)) {
              if (e instanceof ApiError && e.status < 500)
                discardPending(owner, entry.requestKey);
              throw e;
            }
          }
        }
        if (actionSession !== getSessionRevision()) return;
        set({
          state: projectQueue(workspace),
          message:
            'Saved on this device. Awaiting server confirmation; reconnect to sync.',
        });
      });
      return;
    }
    await get().save(
      () =>
        api(`/api/shipments/${encodeURIComponent(id)}/actions`, 'POST', {
          ...data,
          action,
          version,
        }),
      'Delivery updated.',
      () => {
        if (owner)
          useUiStore
            .getState()
            .clearActionDraft(
              owner,
              id,
              action,
              ['respondRequest', 'withdrawRequest'].includes(action) &&
                typeof data.requestId === 'string'
                ? data.requestId
                : undefined,
            );
      },
    );
  },
}));
