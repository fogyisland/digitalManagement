import { useCallback, useEffect, useState } from 'react';
import { Button, Table, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { auditApi } from '@/api/audit';
import { PageHeader, Panel, StateBlock, resolveDataStatus } from '@/components/ui';
import { tokens } from '@/theme/tokens';
import { formatDate } from '@/utils/format';
import { toError } from '@/utils/errors';
import { useAuthStore } from '@/stores/authStore';
import type { AuditEntry } from '@/types';

const { Text } = Typography;

/**
 * 操作日志 — the tenant's own record of what its people changed.
 *
 * The trail follows the scope of the session: an administrator reads the
 * whole tenant's trail, and everybody else reads the actions they made
 * themselves. The page says which one it is showing, so a short trail is not
 * mistaken for a quiet tenant.
 *
 * The platform layer's own actions — a tenant created, an account moved — are
 * recorded one layer up and are read in the platform console.
 */

/** What the actions are called, in the interface's language. */
const ACTION_LABELS: Record<string, string> = {
  'asset.created': '新建资产',
  'asset.updated': '修改资产',
  'asset.deleted': '删除资产',
  'asset.restored': '还原资产',
  'category.created': '新建分类',
  'category.updated': '修改分类',
  'category.deleted': '删除分类',
  'tag.created': '新建标签',
  'tag.updated': '修改标签',
  'tag.deleted': '删除标签',
  'user.created': '新建账号',
  'user.updated': '修改账号',
  'user.deleted': '删除账号',
  'user.password_reset': '重置密码',
  'apikey.created': '新建 API 密钥',
  'apikey.updated': '修改 API 密钥',
  'apikey.deleted': '吊销 API 密钥',
  'webhook.created': '新建 Webhook',
  'webhook.updated': '修改 Webhook',
  'webhook.deleted': '停用 Webhook',
};

/** What the thing that was changed is called. */
const RESOURCE_LABELS: Record<string, string> = {
  asset: '资产',
  category: '分类',
  tag: '标签',
  user: '账号',
  api_key: 'API 密钥',
  webhook: 'Webhook',
};

/**
 * One line of the trail, in words.
 *
 * The entry itself is a machine record; the operator reads a sentence.
 */
function describe(entry: AuditEntry): string {
  let details: Record<string, unknown> = {};
  if (entry.details) {
    try {
      details = JSON.parse(entry.details) as Record<string, unknown>;
    } catch {
      return entry.details;
    }
  }
  const parts: string[] = [];
  if (details.title) parts.push(String(details.title));
  if (details.name) parts.push(String(details.name));
  if (details.username) parts.push(`账号 ${String(details.username)}`);
  if (details.role) parts.push(`角色 ${String(details.role)}`);
  if (details.status) parts.push(`状态 ${String(details.status)}`);
  if (details.count !== undefined) parts.push(`${String(details.count)} 个`);
  if (details.scopes) parts.push(`权限 ${String(details.scopes)}`);
  if (details.job_id) parts.push(`任务 ${String(details.job_id)}`);
  if (details.permanent) parts.push('彻底删除');
  if (parts.length === 0) return entry.details ?? '';
  return parts.join(' · ');
}

export default function Audit(): JSX.Element {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | undefined>();
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.role === 'admin' || user?.role === 'superadmin';

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const response = await auditApi.list(200);
      setEntries(response.items);
      setError(undefined);
    } catch (e: unknown) {
      setError(toError(e, '加载操作日志失败'));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const status = resolveDataStatus({
    loading,
    error,
    hasData: entries.length > 0,
    isEmpty: entries.length === 0,
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space[5] }}>
      <PageHeader
        title="操作日志"
        subtitle={
          isAdmin
            ? '这个租户里有人改过什么。资产、分类、标签、账号、密钥的每一次改动都在这里'
            : '你做过的改动。租户管理员能看到整个租户的流水'
        }
        extra={
          <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
            刷新
          </Button>
        }
      />

      <Panel flush>
        {status === 'error' ? (
          <StateBlock
            status="error"
            title="操作日志加载失败"
            error={error}
            errorFallback="无法加载操作日志"
            onRetry={() => void load()}
          />
        ) : status === 'loading' ? (
          <StateBlock status="loading" rows={6} />
        ) : status === 'empty' ? (
          <StateBlock
            status="empty"
            title="还没有操作记录"
            description="改动资产、分类或账号之后，这里会留下一行"
          />
        ) : (
          <Table<AuditEntry>
            rowKey="id"
            dataSource={entries}
            loading={loading}
            scroll={{ x: 800 }}
            locale={{ emptyText: '还没有操作记录' }}
            columns={[
              {
                title: '时间',
                dataIndex: 'created_at',
                width: 170,
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
                width: 140,
                render: (value: string) => (
                  <span style={{ color: tokens.color.text, fontWeight: tokens.fontWeight.medium }}>
                    {ACTION_LABELS[value] ?? value}
                  </span>
                ),
              },
              {
                title: '对象',
                dataIndex: 'resource_type',
                width: 110,
                render: (value: string) => (
                  <Text style={{ color: tokens.color.textMuted, fontSize: tokens.fontSize.sm }}>
                    {RESOURCE_LABELS[value] ?? value}
                  </Text>
                ),
              },
              {
                title: '谁做的',
                dataIndex: 'username',
                width: 140,
                render: (value: string | null) => (
                  <Text style={{ color: tokens.color.textMuted, fontSize: tokens.fontSize.sm }}>
                    {value ?? '（系统）'}
                  </Text>
                ),
              },
              {
                title: '详情',
                dataIndex: 'details',
                // The sentence can be long. Without a width of its own it sets
                // the width of the table, and the column that says *what*
                // changed is the one that gets pushed out of sight.
                width: 280,
                ellipsis: true,
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
