/**
 * Users — Task 18.
 *
 * Admin-only user management table. The route is already wrapped in
 * `AdminOnly` (router.tsx); if a non-admin reaches the component, we
 * still render a redirect hint as a defensive layer.
 *
 * Visual language:
 *   - tokens.color.* only — no `dam-card-padded` legacy class
 *   - tokens.font.mono for ids, usernames, dates
 *   - no all-caps eyebrows; muted <Text> serves as labels
 *   - role/status pills use the same tone table as Settings (danger /
 *     accent / muted) for cross-page consistency
 */
import { useEffect, useState } from 'react';
import {
  App,
  Button,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { DeleteOutlined, EditOutlined, KeyOutlined, PlusOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { usersApi } from '@/api/users';
import { useAuthStore } from '@/stores/authStore';
import type { PageResponse, User, UserRole, UserStatus } from '@/types';
import { tokens } from '@/theme/tokens';
import { formatDate } from '@/utils/format';

const { Text, Title } = Typography;

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

function roleColor(role: UserRole): string {
  switch (role) {
    case 'admin':
      return tokens.color.danger;
    case 'editor':
      return tokens.color.accent;
    default:
      return tokens.color.textMuted;
  }
}

function statusColor(status: UserStatus): string {
  return status === 'active' ? tokens.color.success : tokens.color.danger;
}

function MonoPill({ value, tone }: { value: string; tone: string }): React.ReactNode {
  return (
    <span
      style={{
        padding: '2px 10px',
        borderRadius: tokens.radius.sm,
        fontSize: 12,
        fontFamily: tokens.font.mono,
        background: 'rgba(13, 17, 23, 0.72)',
        color: tone,
        border: `1px solid ${tone}`,
      }}
    >
      {value}
    </span>
  );
}

export default function Users(): JSX.Element {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const currentUser = useAuthStore((s) => s.user);

  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
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

  const load = async (): Promise<void> => {
    setLoading(true);
    try {
      const r: PageResponse<User> = await usersApi.list({
        keyword: keyword || undefined,
        page,
        page_size: 20,
      });
      setUsers(r.items);
      setTotal(r.total);
    } catch (e: unknown) {
      // The axios interceptor already redirects on 401; here we only keep
      // the table usable by clearing the stale rows and logging the cause.
      console.warn('[users] load failed:', e);
      setUsers([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  const onCreate = async (): Promise<void> => {
    const v = await createForm.validateFields();
    await usersApi.create(v);
    message.success('已创建');
    setCreateOpen(false);
    createForm.resetFields();
    void load();
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

  const onSave = async (): Promise<void> => {
    if (!editing) return;
    const v = await editForm.validateFields();
    await usersApi.update(editing.id, v);
    message.success('已更新');
    setEditOpen(false);
    void load();
  };

  const onDelete = async (id: string): Promise<void> => {
    await usersApi.remove(id);
    message.success('已删除');
    void load();
  };

  const onReset = async (): Promise<void> => {
    if (!resetOpen) return;
    const v = await resetForm.validateFields();
    await usersApi.resetPassword(resetOpen.id, v.new_password);
    message.success('密码已重置');
    setResetOpen(null);
    resetForm.resetFields();
  };

  // Defensive layer: the router's AdminOnly already redirects non-admins,
  // but if the component renders without the role flag we surface a hint
  // rather than 403 silently.
  if (currentUser && currentUser.role !== 'admin') {
    return (
      <div
        style={{
          padding: tokens.space[5],
          background: tokens.color.panel,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.lg,
        }}
      >
        <Text style={{ color: tokens.color.text }}>当前账号没有访问用户管理的权限。</Text>
        <div style={{ marginTop: tokens.space[3] }}>
          <Button onClick={() => navigate('/')}>返回首页</Button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space[5] }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: tokens.space[4],
        }}
      >
        <div>
          <Title
            level={2}
            style={{
              margin: 0,
              color: tokens.color.text,
              fontWeight: 600,
              letterSpacing: '-0.01em',
            }}
          >
            用户管理
          </Title>
          <Text style={{ color: tokens.color.textMuted, fontSize: 13 }}>
            共 {total.toLocaleString()} 个用户
          </Text>
        </div>
        <Space size="small" wrap>
          <Input.Search
            placeholder="搜索用户名 / 邮箱"
            allowClear
            onSearch={(v) => {
              setKeyword(v);
              setPage(1);
              void load();
            }}
            style={{ width: 240 }}
          />
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setCreateOpen(true)}
          >
            新建用户
          </Button>
        </Space>
      </header>

      <section
        style={{
          background: tokens.color.panel,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.lg,
          padding: tokens.space[4],
        }}
      >
        <Table<User>
          rowKey="id"
          dataSource={users}
          loading={loading}
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
                    fontSize: 12,
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
            { title: '显示名', dataIndex: 'display_name' },
            { title: '邮箱', dataIndex: 'email' },
            {
              title: '角色',
              dataIndex: 'role',
              width: 110,
              render: (r: UserRole) => <MonoPill value={r} tone={roleColor(r)} />,
            },
            {
              title: '状态',
              dataIndex: 'status',
              width: 100,
              render: (s: UserStatus) => <MonoPill value={s} tone={statusColor(s)} />,
            },
            {
              title: '最近登录',
              dataIndex: 'last_login_at',
              width: 160,
              render: (v: string | null) =>
                v ? (
                  <span style={{ fontFamily: tokens.font.mono, fontSize: 12, color: tokens.color.text }}>
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
                <span style={{ fontFamily: tokens.font.mono, fontSize: 12, color: tokens.color.text }}>
                  {formatDate(v)}
                </span>
              ),
            },
            {
              title: '操作',
              width: 160,
              render: (_: unknown, u: User) => (
                <Space size={4}>
                  <Button
                    size="small"
                    type="text"
                    icon={<EditOutlined />}
                    onClick={() => onEdit(u)}
                  />
                  <Button
                    size="small"
                    type="text"
                    icon={<KeyOutlined />}
                    onClick={() => setResetOpen(u)}
                    aria-label={`重置 ${u.username} 的密码`}
                  />
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
                      disabled={u.is_superuser}
                    />
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </section>

      <Modal
        title="新建用户"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => void onCreate()}
        width={480}
        okText="创建"
        cancelText="取消"
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
      </Modal>

      <Modal
        title="编辑用户"
        open={editOpen}
        onCancel={() => setEditOpen(false)}
        onOk={() => void onSave()}
        width={480}
        okText="保存"
        cancelText="取消"
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
      </Modal>

      <Modal
        title={resetOpen ? `重置密码 · ${resetOpen.username}` : '重置密码'}
        open={!!resetOpen}
        onCancel={() => setResetOpen(null)}
        onOk={() => void onReset()}
        width={420}
        okText="重置"
        cancelText="取消"
      >
        <Form<ResetPasswordValues> form={resetForm} layout="vertical">
          <Form.Item name="new_password" label="新密码" rules={[{ required: true, min: 6 }]}>
            <Input.Password />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
