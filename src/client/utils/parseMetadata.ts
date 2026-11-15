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
 * Error-message extraction now lives in `utils/errors.ts` — it is not a
 * metadata concern, and keeping it here meant every page that needed a
 * failure message grew a private copy instead of importing a helper.
 *
 * Re-exported so existing call sites keep working; new code should import
 * from `@/utils/errors` directly.
 */
export { describeError } from './errors';
