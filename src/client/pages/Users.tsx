/**
 * Users — admin-only user management table. The route is already wrapped in
 * `AdminOnly` (router.tsx); if a non-admin reaches the component, we still
 * render a redirect hint as a defensive layer.
 *
 * Visual language:
 *   - shared `PageHeader` / `Panel` / `Pill` components
 *   - tokens.font.mono for ids, usernames, dates
 *   - role/status pills share one look with Settings
 */
import { useCallback, useEffect, useState } from 'react';
import {
  App,
  Button,
  Empty,
  Form,
  Input,
  Popconfirm,
  Select,
  Space,
  Table,
  Typography,
} from 'antd';
import { DeleteOutlined, EditOutlined, KeyOutlined, PlusOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { usersApi } from '@/api/users';
import { useAuthStore } from '@/stores/authStore';
import { useTenantStore } from '@/stores/tenantStore';
import { useTenantWrite } from '@/hooks/useTenantWrite';
import type { PageResponse, User, UserRole, UserStatus } from '@/types';
import { FormModal, Hint, PageHeader, Panel, Pill, StateBlock } from '@/components/ui';
import { tokens } from '@/theme/tokens';
import { formatDate } from '@/utils/format';
import { toError } from '@/utils/errors';

const { Text } = Typography;

interface CreateUserValues {
  username: string;
  email: string;
  display_name?: string;
  role: UserRole;
  password: string;
}

interface EditUserValues {
  email?: string;
  display_name?: string;
  role?: UserRole;
  status?: UserStatus;
}

interface ResetPasswordValues {
  new_password: string;
}

const ROLE_OPTIONS: { value: UserRole; label: string }[] = [
  { value: 'admin', label: 'admin · 管理员' },
  { value: 'editor', label: 'editor · 编辑者' },
  { value: 'viewer', label: 'viewer · 查看者' },
];

/**
 * 后端用户状态只有两态（由 `is_active` 派生）：`active` / `disabled`。
 * `locked` 不在 `backend/src/routes/users.js` 的白名单里，提交会被 400 拒绝。
 */
const STATUS_OPTIONS: { value: UserStatus; label: string }[] = [
  { value: 'active', label: '启用' },
  { value: 'disabled', label: '禁用' },
];

function roleTone(role: UserRole): 'danger' | 'accent' | 'neutral' {
  switch (role) {
    case 'admin':
      return 'danger';
    case 'editor':
      return 'accent';
    default:
      return 'neutral';
  }
}

export default function Users(): JSX.Element {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const currentUser = useAuthStore((s) => s.user);
  /**
   * 当前选中的租户。
   *
   * 它是取数的依赖：同一个 URL 对不同租户答案不同，所以换了租户就得重新
   * 取一次，否则表格里还是上一个租户的人。
   */
  const tenantId = useTenantStore((s) => s.tenantId);

  // 平台管理员没选租户时，新建用户没有落点——后端会拒（`TENANT_REQUIRED`）。
  const { canWrite, hint } = useTenantWrite();

  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | undefined>();
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);

  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState<User | null>(null);

  const [createForm] = Form.useForm<CreateUserValues>();
  const [editForm] = Form.useForm<EditUserValues>();
  const [resetForm] = Form.useForm<ResetPasswordValues>();

  /**
   * The keyword is passed in rather than read from state.
   *
   * The search handler used to call `setKeyword(v)` and then `load()`
   * straight away — but React state updates are asynchronous, so `load`
   * still saw the *previous* keyword. The first search on a page always
   * returned the results for the term before it.
   */
  const load = useCallback(
    async (kw: string): Promise<void> => {
      setLoading(true);
      try {
        const r: PageResponse<User> = await usersApi.list({
          keyword: kw || undefined,
          page,
          page_size: 20,
        });
        setUsers(r.items);
        setTotal(r.total);
        setError(undefined);
      } catch (e: unknown) {
        setError(toError(e, '加载用户列表失败'));
        setUsers([]);
        setTotal(0);
      } finally {
        setLoading(false);
      }
    },
    // `tenantId` is here for the same reason `page` is: the answer depends on
    // it, so a change of tenant has to re-run the query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [page, tenantId],
  );

  useEffect(() => {
    void load(keyword);
  }, [load, keyword]);

  const onCreate = async (values: CreateUserValues): Promise<void> => {
    await usersApi.create(values);
    message.success('已创建');
    setCreateOpen(false);
    createForm.resetFields();
    await load(keyword);
  };

  const onEdit = (u: User): void => {
    setEditing(u);
    editForm.setFieldsValue({
      email: u.email ?? undefined,
      display_name: u.display_name ?? undefined,
      role: u.role,
      status: u.status,
    });
    setEditOpen(true);
  };

  const onSave = async (values: EditUserValues): Promise<void> => {
    if (!editing) return;
    await usersApi.update(editing.id, values);
    message.success('已更新');
    setEditOpen(false);
    await load(keyword);
  };

  const onDelete = async (id: string): Promise<void> => {
    await usersApi.remove(id);
    message.success('已删除');
    await load(keyword);
  };

  const onReset = async (values: ResetPasswordValues): Promise<void> => {
    if (!resetOpen) return;
    await usersApi.resetPassword(resetOpen.id, values.new_password);
    message.success('密码已重置');
    setResetOpen(null);
    resetForm.resetFields();
  };

  // Defensive layer: the router's AdminOnly already redirects non-admins,
  // but if the component renders without the role flag we surface a hint
  // rather than 403 silently.
  if (currentUser && currentUser.role !== 'admin') {
    return (
      <Panel>
        <Text style={{ color: tokens.color.text }}>当前账号没有访问用户管理的权限。</Text>
        <div style={{ marginTop: tokens.space[3] }}>
          <Button onClick={() => navigate('/')}>返回首页</Button>
        </div>
      </Panel>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space[5] }}>
      <PageHeader
        title="用户管理"
        subtitle={`共 ${total.toLocaleString()} 个用户`}
        extra={
          <Space size="small" wrap>
            <Input.Search
              placeholder="搜索用户名 / 邮箱"
              aria-label="搜索用户名或邮箱"
              allowClear
              onSearch={(v) => {
                setKeyword(v.trim());
                setPage(1);
              }}
              style={{ width: 240 }}
            />
            <Hint title={hint}>
              <Button
                type="primary"
                icon={<PlusOutlined />}
                disabled={!canWrite}
                onClick={() => setCreateOpen(true)}
              >
                新建用户
              </Button>
            </Hint>
          </Space>
        }
      />

      <Panel flush>
        {error && !loading ? (
          <StateBlock
            status="error"
            title="用户列表加载失败"
            error={error}
            errorFallback="无法加载用户列表"
            onRetry={() => void load(keyword)}
          />
        ) : (
          <Table<User>
            rowKey="id"
            dataSource={users}
            loading={loading}
            scroll={{ x: 960 }}
            pagination={{
              current: page,
              total,
              pageSize: 20,
              onChange: setPage,
              showSizeChanger: false,
            }}
            locale={{ emptyText: <Empty description="暂无用户" /> }}
            columns={[
              {
                title: 'ID',
                dataIndex: 'id',
                width: 70,
                render: (id: string) => (
                  <span
                    style={{
                      fontFamily: tokens.font.mono,
                      fontSize: tokens.fontSize.sm,
                      color: tokens.color.textMuted,
                    }}
                    title={id}
                  >
                    {id}
                  </span>
                ),
              },
              {
                title: '用户名',
                dataIndex: 'username',
                render: (v: string) => (
                  <span style={{ fontFamily: tokens.font.mono, color: tokens.color.text }}>{v}</span>
                ),
              },
              { title: '显示名', dataIndex: 'display_name', ellipsis: true },
              { title: '邮箱', dataIndex: 'email', ellipsis: true },
              {
                title: '角色',
                dataIndex: 'role',
                width: 110,
                render: (r: UserRole) => <Pill value={r} tone={roleTone(r)} mono />,
              },
              {
                title: '状态',
                dataIndex: 'status',
                width: 100,
                render: (s: UserStatus) => (
                  <Pill
                    value={s}
                    tone={s === 'active' ? 'success' : 'danger'}
                    mono
                  />
                ),
              },
              {
                title: '最近登录',
                dataIndex: 'last_login_at',
                width: 160,
                render: (v: string | null) =>
                  v ? (
                    <span style={{ fontFamily: tokens.font.mono, fontSize: tokens.fontSize.sm, color: tokens.color.text }}>
                      {formatDate(v)}
                    </span>
                  ) : (
                    '—'
                  ),
              },
              {
                title: '创建时间',
                dataIndex: 'created_at',
                width: 160,
                render: (v: string) => (
                  <span style={{ fontFamily: tokens.font.mono, fontSize: tokens.fontSize.sm, color: tokens.color.text }}>
                    {formatDate(v)}
                  </span>
                ),
              },
              {
                title: '操作',
                width: 160,
                render: (_: unknown, u: User) => (
                  <Space size={4}>
                    <Hint title={canWrite ? '编辑' : hint}>
                      <Button
                        size="small"
                        type="text"
                        icon={<EditOutlined />}
                        disabled={!canWrite}
                        aria-label={`编辑 ${u.username}`}
                        onClick={() => onEdit(u)}
                      />
                    </Hint>
                    <Hint title={canWrite ? '重置密码' : hint}>
                      <Button
                        size="small"
                        type="text"
                        icon={<KeyOutlined />}
                        disabled={!canWrite}
                        onClick={() => setResetOpen(u)}
                        aria-label={`重置 ${u.username} 的密码`}
                      />
                    </Hint>
                    {/* 删除按钮住在 Popconfirm 里面，而 Popconfirm 要一个 DOM
                        节点挂载——所以提示包的是外面那层 span，而不是插在两者
                        中间。 */}
                    <Hint
                      title={
                        canWrite
                          ? u.is_superuser
                            ? '平台管理员不能被删除'
                            : '删除'
                          : hint
                      }
                    >
                      <Popconfirm
                        title="确认删除？"
                        okText="删除"
                        cancelText="取消"
                        onConfirm={() => void onDelete(u.id)}
                      >
                        <Button
                          size="small"
                          type="text"
                          danger
                          icon={<DeleteOutlined />}
                          disabled={!canWrite || u.is_superuser}
                          aria-label={`删除 ${u.username}`}
                        />
                      </Popconfirm>
                    </Hint>
                  </Space>
                ),
              },
            ]}
          />
        )}
      </Panel>

      <FormModal<CreateUserValues>
        open={createOpen}
        title="新建用户"
        form={createForm}
        onCancel={() => setCreateOpen(false)}
        onSubmit={onCreate}
        okText="创建"
        width={480}
      >
        <Form<CreateUserValues> form={createForm} layout="vertical" initialValues={{ role: 'viewer' }}>
          <Form.Item name="username" label="用户名" rules={[{ required: true, min: 3, max: 64 }]}>
            <Input />
          </Form.Item>
          <Form.Item name="email" label="邮箱" rules={[{ required: true, type: 'email' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="display_name" label="显示名">
            <Input />
          </Form.Item>
          <Form.Item name="role" label="角色" rules={[{ required: true }]}>
            <Select options={ROLE_OPTIONS} />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true, min: 6 }]}>
            <Input.Password />
          </Form.Item>
        </Form>
      </FormModal>

      <FormModal<EditUserValues>
        open={editOpen}
        title="编辑用户"
        form={editForm}
        onCancel={() => setEditOpen(false)}
        onSubmit={onSave}
        okText="保存"
        width={480}
      >
        <Form<EditUserValues> form={editForm} layout="vertical">
          <Form.Item name="email" label="邮箱" rules={[{ type: 'email' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="display_name" label="显示名">
            <Input />
          </Form.Item>
          <Form.Item name="role" label="角色">
            <Select options={ROLE_OPTIONS} />
          </Form.Item>
          <Form.Item name="status" label="状态">
            <Select options={STATUS_OPTIONS} />
          </Form.Item>
        </Form>
      </FormModal>

      <FormModal<ResetPasswordValues>
        open={!!resetOpen}
        title={resetOpen ? `重置密码 · ${resetOpen.username}` : '重置密码'}
        form={resetForm}
        onCancel={() => setResetOpen(null)}
        onSubmit={onReset}
        okText="重置"
        width={420}
      >
        <Form<ResetPasswordValues> form={resetForm} layout="vertical">
          <Form.Item name="new_password" label="新密码" rules={[{ required: true, min: 6 }]}>
            <Input.Password />
          </Form.Item>
        </Form>
      </FormModal>
    </div>
  );
}
