/**
 * Tenants — the platform administrator's tenant list.
 *
 * The tenant is the boundary every row of the library belongs to. A tenant
 * administrator manages the contents of their own tenant; this page is the
 * other half: how many tenants there are, what they are called, whether they
 * are open, and — when a tenant is emptied out and gone for good — how to
 * remove it.
 *
 * Visual language:
 *   - the shared `PageHeader` / `Panel` / `Pill` / `FormModal` components
 *   - tokens.font.mono for ids, slugs and dates
 *   - the same table shape as the user management page
 *
 * ## The two ways to close a tenant
 *
 * Suspending is the switch: the tenant's accounts are locked out at once and
 * its rows stay. Removing is the other one — the tenant and everything inside
 * it go, and nothing comes back. So removing asks the operator to type the
 * tenant's id first: a mis-click must not take a library with it.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  App,
  Button,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Typography,
} from 'antd';
import {
  DeleteOutlined,
  EditOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { tenantsApi } from '@/api/tenants';
import { useAuthStore } from '@/stores/authStore';
import type { Tenant, TenantInput } from '@/types';
import { FormModal, PageHeader, Panel, Pill, StateBlock } from '@/components/ui';
import { tokens } from '@/theme/tokens';
import { formatDate } from '@/utils/format';
import { toError } from '@/utils/errors';

const { Text } = Typography;

interface CreateTenantValues {
  name: string;
  slug?: string;
  id?: string;
}

interface EditTenantValues {
  name?: string;
  slug?: string;
  status?: 'active' | 'suspended';
}

const STATUS_OPTIONS: { value: 'active' | 'suspended'; label: string }[] = [
  { value: 'active', label: '启用' },
  { value: 'suspended', label: '停用' },
];

export default function Tenants(): JSX.Element {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const currentUser = useAuthStore((s) => s.user);

  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | undefined>();

  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<Tenant | null>(null);
  const [removing, setRemoving] = useState<Tenant | null>(null);
  const [removeInput, setRemoveInput] = useState('');

  const [createForm] = Form.useForm<CreateTenantValues>();
  const [editForm] = Form.useForm<EditTenantValues>();

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const response = await tenantsApi.list();
      setTenants(response.items);
      setError(undefined);
    } catch (e: unknown) {
      setError(toError(e, '加载租户列表失败'));
      setTenants([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onCreate = async (values: CreateTenantValues): Promise<void> => {
    const created = await tenantsApi.create(values as TenantInput);
    message.success(`租户「${created.name}」已创建`);
    setCreateOpen(false);
    createForm.resetFields();
    await load();
  };

  const onEdit = (tenant: Tenant): void => {
    setEditing(tenant);
    editForm.setFieldsValue({
      name: tenant.name,
      slug: tenant.slug,
      status: tenant.status === 'suspended' ? 'suspended' : 'active',
    });
    setEditOpen(true);
  };

  const onSave = async (values: EditTenantValues): Promise<void> => {
    if (!editing) return;
    await tenantsApi.update(editing.id, values);
    message.success('已更新');
    setEditOpen(false);
    await load();
  };

  const onToggleStatus = async (tenant: Tenant): Promise<void> => {
    const next = tenant.status === 'suspended' ? 'active' : 'suspended';
    await tenantsApi.update(tenant.id, { status: next });
    message.success(next === 'suspended' ? '租户已停用，账号即刻无法登录' : '租户已启用');
    await load();
  };

  const onRemove = async (): Promise<void> => {
    if (!removing) return;
    if (removeInput.trim() !== removing.id) {
      message.error('请输入租户 id 以确认删除');
      return;
    }
    await tenantsApi.remove(removing.id);
    message.success(`租户「${removing.name}」及其中的内容已删除`);
    setRemoving(null);
    setRemoveInput('');
    await load();
  };

  // Defensive layer: the router already sends a non-superadmin away, but a
  // component that renders without the role says so instead of failing quietly.
  if (currentUser && currentUser.role !== 'superadmin') {
    return (
      <Panel>
        <Text style={{ color: tokens.color.text }}>当前账号没有管理租户的权限。</Text>
        <div style={{ marginTop: tokens.space[3] }}>
          <Button onClick={() => navigate('/')}>返回首页</Button>
        </div>
      </Panel>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space[5] }}>
      <PageHeader
        title="租户管理"
        subtitle={`共 ${tenants.length} 个租户 · 租户里的内容由租户管理员自己管理`}
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            新建租户
          </Button>
        }
      />

      <Panel flush>
        {error && !loading ? (
          <StateBlock
            status="error"
            title="租户列表加载失败"
            error={error}
            errorFallback="无法加载租户列表"
            onRetry={() => void load()}
          />
        ) : (
          <Table<Tenant>
            rowKey="id"
            dataSource={tenants}
            loading={loading}
            scroll={{ x: 900 }}
            locale={{ emptyText: '还没有租户' }}
            columns={[
              {
                title: '名称',
                dataIndex: 'name',
                render: (value: string) => (
                  <span style={{ color: tokens.color.text, fontWeight: tokens.fontWeight.medium }}>
                    {value}
                  </span>
                ),
              },
              {
                title: 'id',
                dataIndex: 'id',
                width: 170,
                render: (value: string) => (
                  <span
                    style={{ fontFamily: tokens.font.mono, fontSize: tokens.fontSize.sm, color: tokens.color.textMuted }}
                    title={value}
                  >
                    {value}
                  </span>
                ),
              },
              {
                title: 'slug',
                dataIndex: 'slug',
                width: 140,
                render: (value: string) => (
                  <span style={{ fontFamily: tokens.font.mono, fontSize: tokens.fontSize.sm }}>
                    {value}
                  </span>
                ),
              },
              {
                title: '状态',
                dataIndex: 'status',
                width: 90,
                render: (value: string) => (
                  <Pill value={value === 'suspended' ? 'suspended' : 'active'} tone={value === 'suspended' ? 'danger' : 'success'} mono />
                ),
              },
              {
                title: '资产 / 账号',
                width: 110,
                render: (_: unknown, tenant: Tenant) => (
                  <span style={{ fontFamily: tokens.font.mono, fontSize: tokens.fontSize.sm }}>
                    {tenant.asset_count} / {tenant.user_count}
                  </span>
                ),
              },
              {
                title: '创建时间',
                dataIndex: 'created_at',
                width: 160,
                render: (value: string) => (
                  <span style={{ fontFamily: tokens.font.mono, fontSize: tokens.fontSize.sm, color: tokens.color.text }}>
                    {formatDate(value)}
                  </span>
                ),
              },
              {
                title: '操作',
                width: 180,
                render: (_: unknown, tenant: Tenant) => (
                  <Space size={4}>
                    <Button
                      size="small"
                      type="text"
                      icon={<EditOutlined />}
                      aria-label={`编辑租户 ${tenant.name}`}
                      onClick={() => onEdit(tenant)}
                    />
                    <Popconfirm
                      title={tenant.status === 'suspended' ? '启用这个租户？' : '停用这个租户？'}
                      description={
                        tenant.status === 'suspended'
                          ? '启用后该租户的账号可以重新登录。'
                          : '停用后该租户的所有账号立即无法登录，数据保留。'
                      }
                      okText={tenant.status === 'suspended' ? '启用' : '停用'}
                      cancelText="取消"
                      onConfirm={() => void onToggleStatus(tenant)}
                    >
                      <Button
                        size="small"
                        type="text"
                        icon={tenant.status === 'suspended' ? <PlayCircleOutlined /> : <PauseCircleOutlined />}
                        aria-label={tenant.status === 'suspended' ? `启用租户 ${tenant.name}` : `停用租户 ${tenant.name}`}
                      />
                    </Popconfirm>
                    <Button
                      size="small"
                      type="text"
                      danger
                      icon={<DeleteOutlined />}
                      aria-label={`删除租户 ${tenant.name}`}
                      onClick={() => {
                        setRemoving(tenant);
                        setRemoveInput('');
                      }}
                    />
                  </Space>
                ),
              },
            ]}
          />
        )}
      </Panel>

      <FormModal<CreateTenantValues>
        open={createOpen}
        title="新建租户"
        form={createForm}
        onCancel={() => setCreateOpen(false)}
        onSubmit={onCreate}
        okText="创建"
        width={480}
      >
        <Form<CreateTenantValues> form={createForm} layout="vertical">
          <Form.Item name="name" label="名称" rules={[{ required: true, max: 191 }]}>
            <Input placeholder="例如：Acme Corp" />
          </Form.Item>
          <Form.Item
            name="slug"
            label="slug"
            extra="请求头 X-Tenant 可以用 id、slug 或名称来指认租户；slug 只能是字母、数字、点和横线。"
          >
            <Input placeholder="留空则由名称生成" />
          </Form.Item>
          <Form.Item
            name="id"
            label="id"
            extra="留空则跟随 slug。id 必须能在 HTTP 头里传输，所以只能用 ASCII 字母、数字、点、横线和下划线。"
          >
            <Input placeholder="留空则自动生成" />
          </Form.Item>
        </Form>
      </FormModal>

      <FormModal<EditTenantValues>
        open={editOpen}
        title={editing ? `编辑租户 · ${editing.name}` : '编辑租户'}
        form={editForm}
        onCancel={() => setEditOpen(false)}
        onSubmit={onSave}
        okText="保存"
        width={480}
      >
        <Form<EditTenantValues> form={editForm} layout="vertical">
          <Form.Item name="name" label="名称" rules={[{ max: 191 }]}>
            <Input />
          </Form.Item>
          <Form.Item name="slug" label="slug" rules={[{ pattern: /^[A-Za-z0-9][A-Za-z0-9._-]*$/, message: '只能用字母、数字、点和横线' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="status" label="状态">
            <Select options={STATUS_OPTIONS} />
          </Form.Item>
        </Form>
      </FormModal>

      <Modal
        title="删除租户"
        open={Boolean(removing)}
        okText="永久删除"
        cancelText="取消"
        okButtonProps={{ danger: true, disabled: removeInput.trim() !== (removing?.id ?? '') }}
        onCancel={() => {
          setRemoving(null);
          setRemoveInput('');
        }}
        onOk={() => void onRemove()}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space[3] }}>
          <Text style={{ color: tokens.color.text }}>
            租户「{removing?.name}」里的 {removing?.asset_count} 个资产、{removing?.user_count}
            个账号以及它们的分类、标签、密钥和文件会一起消失，无法恢复。
          </Text>
          <Text style={{ color: tokens.color.textMuted, fontSize: tokens.fontSize.sm }}>
            如果只是想先让这个租户用不了，请改用「停用」——数据会留着，随时可以启用。
          </Text>
          <Input
            aria-label="输入租户 id 以确认"
            placeholder={`输入 ${removing?.id ?? ''} 以确认`}
            value={removeInput}
            onChange={(event) => setRemoveInput(event.target.value)}
          />
        </div>
      </Modal>
    </div>
  );
}
