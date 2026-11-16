import { useCallback, useEffect, useState } from 'react';
import { Button, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { platformApi } from '@/api/platform';
import { PageHeader, Panel, StateBlock } from '@/components/ui';
import { tokens } from '@/theme/tokens';
import { toError } from '@/utils/errors';
import type { PlatformStats } from '@/types';

const { Text } = Typography;

/**
 * One number on the platform's ledger.
 */
function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}): JSX.Element {
  return (
    <div
      style={{
        padding: tokens.space[4],
        borderRadius: tokens.radius.md,
        border: `1px solid ${tokens.color.border}`,
        background: tokens.color.surfaceSunken,
      }}
    >
      <Text
        style={{
          display: 'block',
          color: tokens.color.textMuted,
          fontSize: tokens.fontSize.sm,
          marginBottom: tokens.space[2],
        }}
      >
        {label}
      </Text>
      <div
        style={{
          color: tokens.color.text,
          fontSize: tokens.fontSize['3xl'],
          fontWeight: tokens.fontWeight.bold,
          lineHeight: 1.1,
        }}
      >
        {value}
      </div>
      {hint ? (
        <Text
          style={{
            display: 'block',
            marginTop: tokens.space[2],
            color: tokens.color.textMuted,
            fontSize: tokens.fontSize.xs,
          }}
        >
          {hint}
        </Text>
      ) : null}
    </div>
  );
}

/**
 * The platform's overview.
 *
 * One screen that answers "how big is this platform" — the numbers the
 * platform administrator sees before they decide anything about a tenant.
 * Every figure counts across every tenant; none of them is one tenant's.
 */
export default function Overview(): JSX.Element {
  const [stats, setStats] = useState<PlatformStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | undefined>();

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      setStats(await platformApi.stats());
      setError(undefined);
    } catch (e: unknown) {
      setError(toError(e, '加载平台总览失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const gb = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  const mb = (bytes: number): string => `${(bytes / 1024 ** 2).toFixed(1)} MB`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space[5] }}>
      <PageHeader
        title="平台总览"
        subtitle="平台层在所有租户之上：这里的每一个数字都是整个平台的"
        extra={
          <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
            刷新
          </Button>
        }
      />

      {error && !loading ? (
        <StateBlock
          status="error"
          title="平台总览加载失败"
          error={error}
          errorFallback="无法加载平台总览"
          onRetry={() => void load()}
        />
      ) : (
        <>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: tokens.space[3],
            }}
          >
            <Stat
              label="租户"
              value={stats ? String(stats.tenants) : '—'}
              hint={stats ? `${stats.active_tenants} 个还开着` : undefined}
            />
            <Stat
              label="账号"
              value={stats ? String(stats.accounts) : '—'}
              hint={stats ? `其中 ${stats.platform_administrators} 个平台管理员` : undefined}
            />
            <Stat
              label="资产"
              value={stats ? String(stats.assets) : '—'}
              hint={stats ? `回收站里 ${stats.trashed_assets} 个` : undefined}
            />
            <Stat
              label="存储占用"
              value={stats ? gb(stats.storage_bytes) : '—'}
              hint={stats ? `${stats.categories} 个分类 · ${stats.tags} 个标签` : undefined}
            />
          </div>

          <Text
            style={{
              color: tokens.color.textMuted,
              fontSize: tokens.fontSize.sm,
              fontWeight: tokens.fontWeight.medium,
            }}
          >
            最近 24 小时
          </Text>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: tokens.space[3],
            }}
          >
            <Stat
              label="请求"
              value={stats ? String(stats.requests_24h) : '—'}
              hint="整个平台的 API 调用次数"
            />
            <Stat
              label="进来"
              value={stats ? mb(stats.bytes_in_24h) : '—'}
              hint="请求体带进来的字节"
            />
            <Stat
              label="出去"
              value={stats ? mb(stats.bytes_out_24h) : '—'}
              hint="应答带出去的字节"
            />
            <Stat
              label="错误"
              value={stats ? String(stats.errors_24h) : '—'}
              hint="4xx 与 5xx 的调用次数"
            />
          </div>
        </>
      )}

      <Panel title="这一层能做什么">
        <Text style={{ color: tokens.color.textMuted, fontSize: tokens.fontSize.base, lineHeight: 1.8 }}>
          · <strong style={{ color: tokens.color.text }}>租户</strong>：平台上有哪些租户、它们叫什么、是否停用；
          删除租户会连同它里面的资产、账号、分类、标签、密钥和文件一起消失。
          <br />
          · <strong style={{ color: tokens.color.text }}>账号</strong>：平台上所有租户的账号都在这里，
          可以改角色、改归属租户、停用；平台管理员（能进平台门的那种角色）也在这一层授予。
          <br />
          · <strong style={{ color: tokens.color.text }}>审计</strong>：平台层做过的动作留痕。
          <br />
          · <strong style={{ color: tokens.color.text }}>调用日志</strong>：整个平台的进出流量——谁在什么时候
          调了哪个接口、进来多少字节、出去多少字节。
          <br />
          · <strong style={{ color: tokens.color.text }}>MCP 令牌</strong>：这个账户给 AI 客户端的凭证。
        </Text>
      </Panel>
    </div>
  );
}
