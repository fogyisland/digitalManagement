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
 * 后端给出的错误码，和它们该被读成什么。
 *
 * 后端说英语，前端说中文。有些错误码是前端要**分支**的——选中的租户没了
 * 就该把选择丢掉，平台管理员没选租户就不该写入——翻译成一句话反而把分支
 * 的理由抹掉了。所以这些码各自带一句中文：`describeError` 先看码，再看那句
 * 英文。
 *
 * 放在这里而不是每个页面里，是因为这句话该**全站一个说法**：同一个拒绝，
 * 在分类页和资产库页读到两套措辞，人会以为是两回事。
 */
const CODE_MESSAGES: Record<string, string> = {
  TENANT_REQUIRED:
    '写入前要先选中一个租户：平台管理员的写入必须落到某一个租户，请在左上角的租户选择器里选一个。',
  NO_SUCH_TENANT: '选中的租户已经不存在了，请在左上角重新选择一个。',
  TENANT_SUSPENDED: '这个租户已被停用，写入被拒绝。',
};

/**
 * Pull a human-readable message out of whatever the transport threw.
 *
 * Lookup order (first non-empty wins):
 *   0. `response.data.code`          — a refusal the backend named; it has its
 *                                     own wording (see `CODE_MESSAGES`)
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
    // A named refusal carries its own wording. The code is what the caller
    // branches on; the sentence is what a person reads.
    const code = typeof data.code === 'string' ? data.code : '';
    const coded = code ? CODE_MESSAGES[code] : undefined;
    if (coded) return coded;

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
