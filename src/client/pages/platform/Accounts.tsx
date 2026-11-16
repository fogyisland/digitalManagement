import { useCallback, useEffect, useMemo, useState } from 'react';
import { App, Button, Form, Input, Select, Space, Table, Typography } from 'antd';
import { EditOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { platformApi } from '@/api/platform';
import { tenantsApi } from '@/api/tenants';
import { FormModal, PageHeader, Panel, Pill, StateBlock } from '@/components/ui';
import { tokens } from '@/theme/tokens';
import { formatDate } from '@/utils/format';
import { toError } from '@/utils/errors';
import type { PlatformAccount, Tenant } from '@/types';

const { Text } = Typography;

/** The role an account may hold, and what it means. */
const ROLE_LABELS: Record<string, string> = {
  superadmin: '平台管理员',
  admin: '租户管理员',
  editor: '编辑',
  viewer: '只读',
};

interface EditValues {
  role: string;
  tenant_id: string;
  status: 'active' | 'disabled';
}

/**
 * The platform's account directory.
 *
 * Every account on the platform, whichever tenant it belongs to. This is
 * where the platform administrator decides what an account may do: which
 * role it holds, which tenant it sits in, and whether it is switched on.
 *
 * A role of `superadmin` is the platform's own — it is granted here, at the
 * layer that owns it, and an account that holds it belongs to no tenant.
 */
export default function Accounts(): JSX.Element {
  const { message } = App.useApp();
  const [accounts, setAccounts] = useState<PlatformAccount[]>([]);
  const [total, setTotal] = useState(0);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | undefined>();
  const [keyword, setKeyword] = useState('');
  const [role, setRole] = useState<string>('');
  const [status, setStatus] = useState<string>('');

  const [editing, setEditing] = useState<PlatformAccount | null>(null);
  const [form] = Form.useForm<EditValues>();

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const response = await platformApi.accounts({ keyword, role, status });
      setAccounts(response.items);
      setTotal(response.total);
      setError(undefined);
    } catch (e: unknown) {
      setError(toError(e, '加载账号列表失败'));
      setAccounts([]);
    } finally {
      setLoading(false);
    }
  }, [keyword, role, status]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void (async () => {
      try {
        const response = await tenantsApi.list();
        setTenants(response.items);
      } catch {
        // The tenant list is only needed for the picker; the directory itself
        // still works without it.
      }
    })();
  }, []);

  const tenantName = useMemo(() => {
    const names = new Map(tenants.map((tenant) => [tenant.id, tenant.name]));
    return (id: string): string => {
      if (id === '*') return '平台（不属于任何租户）';
      return names.get(id) ?? id;
    };
  }, [tenants]);

  const openEdit = (account: PlatformAccount): void => {
    setEditing(account);
    form.setFieldsValue({
      role: account.role,
      tenant_id: account.tenant_id === '*' ? undefined : account.tenant_id,
      status: account.status,
    });
  };

  const submitEdit = async (values: EditValues): Promise<void> => {
    if (!editing) return;
    const changed: { role?: string; tenant_id?: string; status?: string } = { status: values.status };
    if (values.role !== editing.role) changed.role = values.role;
    if (values.role !== 'superadmin' && values.tenant_id !== editing.tenant_id) {
      changed.tenant_id = values.tenant_id;
    }
    await platformApi.updateAccount(editing.id, changed);
    message.success(`已更新 ${editing.username}`);
    setEditing(null);
    await load();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space[5] }}>
      <PageHeader
        title="账号"
        subtitle={`全平台 ${total} 个账号 · 平台管理员在这一层授予，它属于平台，不属于某个租户`}
        extra={
          <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
            刷新
          </Button>
        }
      />

      <Panel flush>
        <div
          style={{
            display: 'flex',
            gap: tokens.space[3],
            flexWrap: 'wrap',
            padding: tokens.space[4],
            borderBottom: `1px solid ${tokens.color.border}`,
          }}
        >
          <Input
            allowClear
            prefix={<SearchOutlined style={{ color: tokens.color.textMuted }} />}
            placeholder="搜索用户名、邮箱或显示名"
            aria-label="搜索账号"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            style={{ width: 280, maxWidth: '100%' }}
          />
          <Select
            allowClear
            placeholder="角色"
            aria-label="按角色筛选"
            value={role || undefined}
            onChange={(value) => setRole(value ?? '')}
            options={Object.entries(ROLE_LABELS).map(([value, label]) => ({ value, label }))}
            style={{ width: 150 }}
          />
          <Select
            allowClear
            placeholder="状态"
            aria-label="按状态筛选"
            value={status || undefined}
            onChange={(value) => setStatus(value ?? '')}
            options={[
              { value: 'active', label: '启用' },
              { value: 'disabled', label: '停用' },
            ]}
            style={{ width: 120 }}
          />
        </div>

        {error && !loading ? (
          <StateBlock
            status="error"
            title="账号列表加载失败"
            error={error}
            errorFallback="无法加载账号列表"
            onRetry={() => void load()}
          />
        ) : (
          <Table<PlatformAccount>
            rowKey="id"
            dataSource={accounts}
            loading={loading}
            scroll={{ x: 900 }}
            locale={{ emptyText: '没有符合条件的账号' }}
            columns={[
              {
                title: '账号',
                dataIndex: 'username',
                render: (value: string, row) => (
                  <span style={{ color: tokens.color.text, fontWeight: tokens.fontWeight.medium }}>
                    {value}
                    {row.display_name ? (
                      <Text
                        style={{
                          marginLeft: tokens.space[2],
                          color: tokens.color.textMuted,
                          fontSize: tokens.fontSize.sm,
                        }}
                      >
                        {row.display_name}
                      </Text>
                    ) : null}
                  </span>
                ),
              },
              {
                title: '租户',
                dataIndex: 'tenant_id',
                render: (value: string) => (
                  <span
                    style={{
                      fontFamily: tokens.font.mono,
                      fontSize: tokens.fontSize.sm,
                      color: tokens.color.textMuted,
                    }}
                  >
                    {tenantName(value)}
                  </span>
                ),
              },
              {
                title: '角色',
                dataIndex: 'role',
                width: 110,
                render: (value: string) => (
                  <Pill
                    value={ROLE_LABELS[value] ?? value}
                    tone={value === 'superadmin' ? 'accent' : 'neutral'}
                  />
                ),
              },
              {
                title: '状态',
                dataIndex: 'status',
                width: 90,
                render: (value: string) => (
                  <Pill
                    value={value === 'active' ? '启用' : '停用'}
                    tone={value === 'active' ? 'success' : 'neutral'}
                  />
                ),
              },
              {
                title: '最近登录',
                dataIndex: 'last_login_at',
                width: 160,
                render: (value: string | null) => (
                  <Text style={{ color: tokens.color.textMuted, fontSize: tokens.fontSize.sm }}>
                    {value ? formatDate(value) : '从未'}
                  </Text>
                ),
              },
              {
                title: '操作',
                key: 'actions',
                width: 90,
                render: (_value, row) => (
                  <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>
                    编辑
                  </Button>
                ),
              },
            ]}
          />
        )}
      </Panel>

      <FormModal<EditValues>
        open={editing !== null}
        title={editing ? `编辑账号 · ${editing.username}` : '编辑账号'}
        form={form}
        onCancel={() => setEditing(null)}
        onSubmit={submitEdit}
      >
        <Form<EditValues> form={form} layout="vertical">
          <Form.Item
            name="role"
            label="角色"
            rules={[{ required: true, message: '请选择角色' }]}
            extra="平台管理员属于平台，不属于任何租户；其它角色需要落在某个租户里"
          >
            <Select
              options={Object.entries(ROLE_LABELS).map(([value, label]) => ({ value, label }))}
            />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(prev, next) => prev.role !== next.role}>
            {({ getFieldValue }) => {
              const isPlatform = getFieldValue('role') === 'superadmin';
              if (isPlatform) return null;
              return (
                <Form.Item
                  name="tenant_id"
                  label="所属租户"
                  rules={[{ required: true, message: '请选择这个账号属于哪个租户' }]}
                >
                  <Select
                    options={tenants.map((tenant) => ({
                      value: tenant.id,
                      label: tenant.name,
                      disabled: tenant.status !== 'active',
                    }))}
                  />
                </Form.Item>
              );
            }}
          </Form.Item>
          <Form.Item name="status" label="状态" rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'active', label: '启用' },
                { value: 'disabled', label: '停用' },
              ]}
            />
          </Form.Item>
          <Space>
            <Text style={{ color: tokens.color.textMuted, fontSize: tokens.fontSize.sm }}>
              改角色或改归属租户会结束这个账号当前的会话——令牌里带着它被签发时的角色。
            </Text>
          </Space>
        </Form>
      </FormModal>
    </div>
  );
}
