import { useCallback, useEffect, useState } from 'react';
import { Button, Table, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { platformApi } from '@/api/platform';
import { PageHeader, Panel, StateBlock } from '@/components/ui';
import { tokens } from '@/theme/tokens';
import { formatDate } from '@/utils/format';
import { toError } from '@/utils/errors';
import type { PlatformAuditEntry } from '@/types';

const { Text } = Typography;

/** What the platform layer's actions are called, in the interface's language. */
const ACTION_LABELS: Record<string, string> = {
  'platform.tenant.created': '新建租户',
  'platform.tenant.updated': '修改租户',
  'platform.tenant.deleted': '删除租户',
  'platform.account.updated': '修改账号',
};

/**
 * One line of the audit trail, in words.
 *
 * The entry itself is a machine record; the operator reads a sentence.
 */
function describe(entry: PlatformAuditEntry): string {
  let details: Record<string, unknown> = {};
  if (entry.details) {
    try {
      details = JSON.parse(entry.details) as Record<string, unknown>;
    } catch {
      return entry.details;
    }
  }
  if (entry.action === 'platform.tenant.deleted') {
    const removed = details.removed as Record<string, number> | undefined;
    const count = removed ? Object.values(removed).reduce((sum, n) => sum + n, 0) : 0;
    return `${String(details.name ?? entry.resource_id)} · 一并清掉 ${count} 条记录`;
  }
  if (entry.action === 'platform.tenant.created') {
    return `${String(details.name ?? '')}（${String(details.slug ?? '')}）`;
  }
  if (entry.action === 'platform.tenant.updated') {
    return `${String(details.name ?? '')} · 状态 ${String(details.status ?? '')}`;
  }
  if (entry.action === 'platform.account.updated') {
    return `${String(details.username ?? '')} · ${String(details.role ?? '')} · ${String(details.tenant_id ?? '')}`;
  }
  return entry.details ?? '';
}

/**
 * The platform's audit trail.
 *
 * What the platform layer did, newest first: a tenant created, renamed,
 * suspended or deleted; an account moved. The trail belongs to the platform,
 * so deleting a tenant does not erase the record that it was deleted.
 */
export default function Audit(): JSX.Element {
  const [entries, setEntries] = useState<PlatformAuditEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | undefined>();

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const response = await platformApi.audit(200);
      setEntries(response.items);
      setError(undefined);
    } catch (e: unknown) {
      setError(toError(e, '加载审计日志失败'));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space[5] }}>
      <PageHeader
        title="审计"
        subtitle="平台层做过的动作。它属于平台，所以删掉一个租户不会连它的记录一起删掉"
        extra={
          <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
            刷新
          </Button>
        }
      />

      <Panel flush>
        {error && !loading ? (
          <StateBlock
            status="error"
            title="审计日志加载失败"
            error={error}
            errorFallback="无法加载审计日志"
            onRetry={() => void load()}
          />
        ) : (
          <Table<PlatformAuditEntry>
            rowKey="id"
            dataSource={entries}
            loading={loading}
            scroll={{ x: 800 }}
            locale={{ emptyText: '还没有平台层的动作' }}
            columns={[
              {
                title: '时间',
                dataIndex: 'created_at',
                width: 160,
                render: (value: string) => (
                  <Text
                    style={{
                      color: tokens.color.textMuted,
                      fontSize: tokens.fontSize.sm,
                      fontFamily: tokens.font.mono,
                    }}
                  >
                    {formatDate(value)}
                  </Text>
                ),
              },
              {
                title: '动作',
                dataIndex: 'action',
                width: 130,
                render: (value: string) => (
                  <span style={{ color: tokens.color.text, fontWeight: tokens.fontWeight.medium }}>
                    {ACTION_LABELS[value] ?? value}
                  </span>
                ),
              },
              {
                title: '对象',
                dataIndex: 'resource_type',
                width: 100,
                render: (value: string) => (
                  <Text style={{ color: tokens.color.textMuted, fontSize: tokens.fontSize.sm }}>
                    {value}
                  </Text>
                ),
              },
              {
                title: '谁做的',
                dataIndex: 'username',
                width: 130,
                render: (value: string | null) => (
                  <Text style={{ color: tokens.color.text, fontSize: tokens.fontSize.sm }}>
                    {value ?? '（系统）'}
                  </Text>
                ),
              },
              {
                title: '详情',
                dataIndex: 'details',
                render: (_value, row) => (
                  <Text style={{ color: tokens.color.textMuted, fontSize: tokens.fontSize.sm }}>
                    {describe(row)}
                  </Text>
                ),
              },
            ]}
          />
        )}
      </Panel>
    </div>
  );
}
