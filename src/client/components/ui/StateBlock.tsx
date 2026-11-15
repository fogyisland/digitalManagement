import type { ReactNode } from 'react';
import { Button, Empty, Skeleton } from 'antd';
import { ReloadOutlined, WarningOutlined } from '@ant-design/icons';
import { tokens } from '@/theme/tokens';
import { describeError } from '@/utils/errors';

export type StateBlockStatus = 'loading' | 'empty' | 'error';

/**
 * Resolve which of the four result states a data fetch is in.
 *
 * The order matters, and every page used to spell it out by hand. When a
 * request failed, `loading` stayed `true` (see `api/hooks.ts`), so a page
 * that tested `loading` first rendered a permanent skeleton and never
 * reached its error branch — the error text and the retry button were
 * unreachable code. Testing the error first makes the result independent of
 * that ordering, and keeps "empty" and "error" from rendering together.
 *
 * @param loading    the request is in flight
 * @param error      the failure, if any
 * @param hasData    a successful response is already on screen
 * @param isEmpty    the response carried no rows
 */
export function resolveDataStatus(args: {
  loading: boolean;
  error?: unknown;
  hasData: boolean;
  isEmpty: boolean;
}): 'loading' | 'error' | 'empty' | 'ready' {
  if (args.error) return 'error';
  if (args.loading && !args.hasData) return 'loading';
  if (!args.hasData) return 'empty';
  if (args.isEmpty) return 'empty';
  return 'ready';
}

export interface StateBlockProps {
  status: StateBlockStatus;
  /** Skeleton rows to draw while loading. */
  rows?: number;
  /** Headline for the empty / error state. */
  title?: ReactNode;
  /** Supporting copy under the headline. */
  description?: ReactNode;
  /** The failure to render. Only read when `status === 'error'`. */
  error?: unknown;
  /** Fallback wording when the error carries no usable message. */
  errorFallback?: string;
  /** Shows a retry button that calls this. */
  onRetry?: () => void;
  /** Extra content below the empty state — usually a call to action. */
  action?: ReactNode;
  /** Removes the surface around the block (for inline use). */
  bare?: boolean;
}

/**
 * One place that renders "loading", "nothing here" and "it broke".
 *
 * Before this component the three states were assembled differently on
 * every page, which produced two visible defects:
 *
 *   - the empty state and the error state could render *at the same time*,
 *     so a failed request looked like "no results" with a red banner
 *     underneath it;
 *   - a failed request often left the skeleton on screen, because the
 *     loading flag was never cleared on the error path.
 *
 * A page now picks exactly one status and renders this once.
 */
export default function StateBlock({
  status,
  rows = 4,
  title,
  description,
  error,
  errorFallback = '加载失败',
  onRetry,
  action,
  bare = false,
}: StateBlockProps): JSX.Element {
  if (status === 'loading') {
    return (
      <div style={{ padding: bare ? 0 : tokens.space[4] }}>
        <Skeleton active paragraph={{ rows }} />
      </div>
    );
  }

  if (status === 'error') {
    const message = describeError(error, errorFallback);
    return (
      <div
        role="alert"
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: tokens.space[3],
          padding: tokens.space[4],
          background: tokens.color.dangerFaint,
          border: `1px solid ${tokens.color.danger}`,
          borderRadius: tokens.radius.lg,
        }}
      >
        <WarningOutlined
          aria-hidden
          style={{ color: tokens.color.danger, fontSize: 16, marginTop: 2 }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: tokens.color.text, fontWeight: tokens.fontWeight.medium }}>
            {title ?? '加载失败'}
          </div>
          <div
            style={{
              marginTop: tokens.space[1],
              color: tokens.color.textMuted,
              fontSize: tokens.fontSize.base,
              wordBreak: 'break-word',
            }}
          >
            {message}
          </div>
          {description ? (
            <div
              style={{
                marginTop: tokens.space[1],
                color: tokens.color.textMuted,
                fontSize: tokens.fontSize.sm,
              }}
            >
              {description}
            </div>
          ) : null}
          {onRetry ? (
            <div style={{ marginTop: tokens.space[3] }}>
              <Button size="small" icon={<ReloadOutlined />} onClick={onRetry}>
                重试
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        padding: bare ? 0 : tokens.space[5],
        textAlign: 'center',
      }}
    >
      <Empty
        description={
          <span style={{ color: tokens.color.textMuted, fontSize: tokens.fontSize.base }}>
            {title ?? '暂无数据'}
          </span>
        }
      >
        {description ? (
          <div
            style={{
              marginTop: tokens.space[2],
              color: tokens.color.textMuted,
              fontSize: tokens.fontSize.sm,
            }}
          >
            {description}
          </div>
        ) : null}
        {action ? <div style={{ marginTop: tokens.space[4] }}>{action}</div> : null}
      </Empty>
    </div>
  );
}
