/**
 * Error-message helpers shared by the whole client.
 *
 * ## Why this module exists
 *
 * The backend returns `{ detail, message, code }` — and the shapes differ a
 * little between handlers (some nest the payload under `response`, some
 * answer with FastAPI's `detail` array). Every page that needed to show a
 * failure message grew its own private `extractErrorMessage()` copy, which
 * meant the same failure could read three different ways depending on which
 * page raised it. This module is the single place that knows the shapes.
 *
 * ## What is NOT handled here
 *
 * `apiClient`'s response interceptor already signs the user out on a 401 and
 * replays a request once after a token rotation. Nothing in this module
 * should try to re-implement that.
 */

/** The subset of an axios error we care about. */
interface AxiosLikeError {
  response?: {
    status?: number;
    data?: unknown;
  };
  message?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return value as Record<string, unknown>;
}

/**
 * Pull a human-readable message out of whatever the transport threw.
 *
 * Lookup order (first non-empty wins):
 *   1. `response.data.detail`        — FastAPI / our own error middleware
 *   2. `response.data.message`       — our own error middleware
 *   3. `response.data.response.message` — nested shape used by some handlers
 *   4. `response.data` when it is a plain string
 *   5. `err.message`                 — a thrown `Error` or an axios network error
 *   6. `fallback`                    — the caller's own wording
 *
 * @param e       the caught value; anything at all
 * @param fallback wording to use when nothing else is available
 */
export function describeError(e: unknown, fallback: string): string {
  const obj = asRecord(e);
  if (!obj) return fallback;

  const response = asRecord(obj.response);
  const data = asRecord(response?.data);

  if (data) {
    const nested = asRecord(data.response);
    const candidates = [data.detail, data.message, nested?.message];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) return candidate;
    }
    // FastAPI's validation errors put the text in `detail[0].msg`.
    if (Array.isArray(data.detail) && data.detail.length > 0) {
      const first = asRecord(data.detail[0]);
      if (typeof first?.msg === 'string' && first.msg.trim()) return first.msg;
    }
  }

  if (typeof response?.data === 'string' && response.data.trim()) {
    return response.data;
  }

  if (typeof obj.message === 'string' && obj.message.trim()) {
    return obj.message;
  }

  return fallback;
}

/**
 * Normalise an unknown throwable into an `Error`.
 *
 * `useApi` and friends keep the failure in state, and React components want
 * a real `Error` (so `instanceof` checks and the stack still work) — but a
 * rejected axios call is not one. This wraps it.
 */
export function toError(e: unknown, fallback = '未知错误'): Error {
  if (e instanceof Error) return e;
  const message = describeError(e, fallback);
  const error = new Error(message);
  const cause = asRecord(e);
  if (cause?.response) {
    (error as Error & { response?: unknown }).response = cause.response;
  }
  return error;
}
