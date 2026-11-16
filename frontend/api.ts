let csrf: string | null = null;
let sessionRevision = 0;
export function getSessionRevision() {
  return sessionRevision;
}
export function invalidateSessionRequests() {
  sessionRevision++;
}
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
export function setCsrf(value: string | null) {
  csrf = value;
  invalidateSessionRequests();
}
// State refreshes carry the token for the same session as their account data.
export function syncCsrf(value: string) {
  if (value !== csrf) setCsrf(value);
}
export async function api<T>(
  path: string,
  method = 'GET',
  body?: object,
  options: { idempotencyKey?: string } = {},
): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
      ...(method !== 'GET' && csrf ? { 'X-CSRF-Token': csrf } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let value: unknown;
  try {
    value = text.trim() ? JSON.parse(text) : undefined;
  } catch {
    if (response.ok)
      throw new ApiError('The server returned an invalid response.', response.status);
  }
  if (!response.ok) {
    const message =
      value &&
      typeof value === 'object' &&
      'error' in value &&
      typeof value.error === 'string'
        ? value.error
        : `Request failed (HTTP ${response.status}).`;
    throw new ApiError(message, response.status);
  }
  return value as T;
}
