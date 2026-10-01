/**
 * JSON metadata helpers.
 *
 * `metadata_json` is the raw `<Input.TextArea>` payload on the Import page;
 * it must survive parse-failures without blocking submission. The two
 * helpers below let callers (a) try to validate before submit and (b)
 * defensively normalize whatever they read back.
 */

export interface JsonParseResult {
  ok: boolean;
  value: unknown;
  error?: string;
}

export function safeParseJson(input: string): JsonParseResult {
  const trimmed = input.trim();
  if (!trimmed) return { ok: true, value: null };
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return { ok: true, value: parsed };
  } catch (e: unknown) {
    const detail =
      e && typeof e === 'object' && 'message' in e
        ? String((e as { message: unknown }).message)
        : 'JSON 解析失败';
    return { ok: false, value: null, error: detail };
  }
}

/**
 * Surface an axios-style error message that we can hand to AntD's
 * `message.error`. Backend handlers return `{ detail, message, code }`
 * inconsistently across versions, so we walk the shape defensively.
 */
export function describeError(e: unknown, fallback: string): string {
  if (!e || typeof e !== 'object') return fallback;
  const obj = e as Record<string, unknown>;
  const resp = obj.response as Record<string, unknown> | undefined;
  const data = resp?.data as Record<string, unknown> | undefined;
  if (data) {
    const inner =
      (data.response as Record<string, unknown> | undefined)?.message ||
      (data.detail as unknown) ||
      (data.message as unknown);
    if (typeof inner === 'string' && inner.trim()) return inner;
  }
  if (typeof obj.message === 'string' && obj.message.trim()) {
    return obj.message;
  }
  return fallback;
}
