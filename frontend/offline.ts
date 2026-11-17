import { api, ApiError } from './api';
import type { Action, Payload, Workspace, Shipment } from './types';
export interface PendingAction {
  requestKey: string;
  id: string;
  version: number;
  action: Action;
  data: Payload;
  queuedAt: string;
}
const key = (owner: string) => `yyc-offline-actions:${owner}`;
export const offlineActions = new Set<Action>([
  'acceptJob',
  'decline',
  'attachEvidence',
  'arrival',
  'pickup',
  'completeStop',
  'deliver',
  'issue',
  'failDelivery',
  'confirmReturn',
]);
export function pendingActions(owner: string): PendingAction[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(key(owner));
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}
function write(owner: string, entries: PendingAction[]) {
  localStorage.setItem(key(owner), JSON.stringify(entries));
  window.dispatchEvent(new Event('yyc-offline-change'));
}
export function enqueue(owner: string, action: PendingAction) {
  const entries = pendingActions(owner);
  if (entries.length >= 100)
    throw new Error(
      'Offline queue is full. Reconnect and sync before recording more actions.',
    );
  if (!entries.some((entry) => entry.requestKey === action.requestKey))
    write(owner, [...entries, action]);
}
export function discardPending(owner: string, requestKey: string) {
  write(
    owner,
    pendingActions(owner).filter((entry) => entry.requestKey !== requestKey),
  );
}
export function projectAction(s: Shipment, entry: PendingAction): Shipment {
  if (s.id !== entry.id || s.version !== entry.version) return s;
  const next: Shipment = JSON.parse(JSON.stringify(s)),
    time = entry.queuedAt;
  next.version++;
  switch (entry.action) {
    case 'acceptJob':
      if (next.handover) delete next.handover;
      else next.status = 'Assigned';
      next.driverId = String(entry.data.driverId);
      next.offeredTo = null;
      break;
    case 'decline':
      if (next.handover) delete next.handover;
      else next.status = 'Ready to assign';
      next.offeredTo = null;
      break;
    case 'attachEvidence':
      next.evidenceCount = (next.evidenceCount || 0) + 1;
      break;
    case 'arrival':
      next.arrivedAt = time;
      break;
    case 'pickup':
      next.status = 'In transit';
      next.deliveryAttempt = 1;
      next.evidenceCount = 0;
      delete next.arrivedAt;
      break;
    case 'deliver':
      next.status = 'Delivered';
      next.pod = String(entry.data.pod);
      next.recipient = String(entry.data.recipient);
      break;
    case 'completeStop': {
      const stop = next.stops?.find((stop) => stop.id === entry.data.stopId);
      if (stop)
        Object.assign(stop, {
          completedAt: time,
          pod: String(entry.data.pod),
          recipient: String(entry.data.recipient),
        });
      delete next.arrivedAt;
      break;
    }
    case 'issue':
      next.issue = {
        reason: String(entry.data.reason),
        note: String(entry.data.note),
        resolved: false,
      };
      break;
    case 'failDelivery':
      next.status = 'Delivery failed';
      break;
    case 'confirmReturn':
      next.status = 'Returned';
      next.returnPod = String(entry.data.pod);
      next.returnRecipient = String(entry.data.recipient);
      break;
  }
  return next;
}
export function projectQueue(state: Workspace): Workspace {
  let shipments = state.shipments;
  for (const entry of pendingActions(state.user.id))
    shipments = shipments.map((s) => projectAction(s, entry));
  return { ...state, shipments };
}
export function cacheWorkspace(state: Workspace) {
  try {
    // CSRF is always obtained from a live session before syncing.
    localStorage.setItem(
      'yyc-offline-workspace',
      JSON.stringify({ ...state, csrf: '', cachedAt: Date.now() }),
    );
  } catch {
    /* Normal online use remains available when storage is full. */
  }
}
export function cachedWorkspace(): Workspace | null {
  try {
    const state = JSON.parse(localStorage.getItem('yyc-offline-workspace') || 'null');
    return state &&
      state.cachedAt > Date.now() - 24 * 3600000 &&
      state.user.role === 'driver'
      ? projectQueue(state)
      : null;
  } catch {
    return null;
  }
}
export function clearOfflineWorkspace() {
  try {
    if (typeof localStorage !== 'undefined')
      localStorage.removeItem('yyc-offline-workspace');
  } catch {
    /* Storage may be disabled; no usable offline cache exists in that case. */
  }
}
export async function sendDriverAction(entry: PendingAction) {
  if (entry.action === 'attachEvidence')
    return api(`/api/shipments/${encodeURIComponent(entry.id)}/evidence`, 'POST', {
      ...entry.data,
      version: entry.version,
      requestKey: entry.requestKey,
    });
  return api(`/api/shipments/${encodeURIComponent(entry.id)}/actions`, 'POST', {
    ...entry.data,
    action: entry.action,
    version: entry.version,
    requestKey: entry.requestKey,
  });
}
export const isConnectionFailure = (error: unknown) =>
  !(error instanceof ApiError) && error instanceof TypeError;
