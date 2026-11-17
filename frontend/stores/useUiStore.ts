import { create } from 'zustand';
import type { EvidenceDraft, Action } from '../types';
import { actionDraftKey } from '../actionDrafts';

interface UiState {
  page: string;
  selected: string | null;
  query: string;
  status: string;
  draftOwner: string | null;
  deliveryDrafts: Record<string, EvidenceDraft>;
  actionDrafts: Record<string, Record<string, string>>;
  setActionDraft: (
    owner: string,
    id: string,
    action: Action,
    name: string,
    value: string,
    scope?: string,
  ) => void;
  clearActionDraft: (owner: string, id: string, action: Action, scope?: string) => void;
  setDeliveryDraft: (owner: string, id: string, draft: EvidenceDraft) => void;
  syncDeliveryDrafts: (
    owner: string | null,
    eligibleIds: string[],
    eligibleActions?: string[],
  ) => void;

  setPage: (page: string) => void;
  select: (id: string | null) => void;
  close: () => void;
  setQuery: (query: string) => void;
  setStatus: (status: string) => void;
  resetFilters: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  page: 'dashboard',
  selected: null,
  query: '',
  status: '',
  draftOwner: null,
  deliveryDrafts: {},
  actionDrafts: {},

  setActionDraft(owner, id, action, name, value, scope) {
    const key = actionDraftKey(id, action, scope);
    set((state) => {
      const existing = state.draftOwner === owner ? state.actionDrafts : {};
      return {
        draftOwner: owner,
        deliveryDrafts: state.draftOwner === owner ? state.deliveryDrafts : {},
        actionDrafts: { ...existing, [key]: { ...existing[key], [name]: value } },
      };
    });
  },
  clearActionDraft(owner, id, action, scope) {
    const key = actionDraftKey(id, action, scope);
    set((state) => {
      if (state.draftOwner !== owner || !state.actionDrafts[key]) return state;
      const remaining = { ...state.actionDrafts };
      delete remaining[key];
      return { actionDrafts: remaining };
    });
  },
  setDeliveryDraft(owner, id, draft) {
    set((state) => ({
      draftOwner: owner,
      actionDrafts: state.draftOwner === owner ? state.actionDrafts : {},
      deliveryDrafts: {
        ...(state.draftOwner === owner ? state.deliveryDrafts : {}),
        [id]: { ...draft },
      },
    }));
  },
  syncDeliveryDrafts(owner, eligibleIds, eligibleActions = []) {
    set((state) => {
      if (owner !== state.draftOwner)
        return { draftOwner: owner, deliveryDrafts: {}, actionDrafts: {} };
      const retained = Object.fromEntries(
        Object.entries(state.deliveryDrafts).filter(([id]) => eligibleIds.includes(id)),
      );
      const retainedActions = Object.fromEntries(
        Object.entries(state.actionDrafts).filter(([key]) =>
          eligibleActions.includes(key),
        ),
      );
      return Object.keys(retained).length === Object.keys(state.deliveryDrafts).length &&
        Object.keys(retainedActions).length === Object.keys(state.actionDrafts).length
        ? state
        : { deliveryDrafts: retained, actionDrafts: retainedActions };
    });
  },
  setPage(page) {
    set({ page, query: '', status: '' });
  },
  select(id) {
    set({ selected: id });
  },
  close() {
    set({ selected: null });
  },
  setQuery(query) {
    set({ query });
  },
  setStatus(status) {
    set({ status });
  },
  resetFilters() {
    set({ query: '', status: '' });
  },
}));
