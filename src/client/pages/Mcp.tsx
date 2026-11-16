/**
 * MCP — this account's AI access.
 *
 * An MCP token is the credential an AI client carries. It speaks for the
 * account that issued it, so it inherits that account's tenant and role: a
 * viewer is offered the reads, an editor the writes as well, an administrator
 * the deletes. The tenant picker at the top of the sidebar works here too — a
 * platform administrator's token reaches every tenant until a request narrows
 * it with `X-Tenant`.
 *
 * The clear token is shown once, here, when it is issued. After that it lives
 * only as a hash in the database, so it cannot be shown again — a lost token
 * is a new token.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  App,
  Button,
  Checkbox,
  Form,
  Input,
  Modal,
  Popconfirm,
  Space,
  Table,
  Typography,
} from 'antd';
import { CopyOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { mcpApi } from '@/api/mcp';
import { useAuthStore } from '@/stores/authStore';
import type { McpScope, McpToken } from '@/types';
import { FormModal, PageHeader, Panel, Pill, StateBlock } from '@/components/ui';
import { tokens } from '@/theme/tokens';
import { formatDate } from '@/utils/format';
import { toError } from '@/utils/errors';

const { Text, Paragraph } = Typography;

interface CreateTokenValues {
  name: string;
  scopes: McpScope[];
}

/**
 * What each role may ask for.
 *
 * The token never carries more than the account can do — the server narrows
 * it — and the interface offers no more either, so the page says the same
 * thing the server will do.
 */
const ROLE_SCOPES: Record<string, McpScope[]> = {
  viewer: ['read'],
  editor: ['read', 'write'],
  admin: ['read', 'write', 'delete'],
  superadmin: ['read', 'write', 'delete'],
};

const SCOPE_LABELS: Record<McpScope, string> = {
  read: '读取（列表 / 详情 / 统计）',
  write: '写入（上传 / 修改）',
  delete: '删除（进回收站 / 彻底删除）',
};

export default function Mcp(): JSX.Element {
  const { message } = App.useApp();
  const currentUser = useAuthStore((s) => s.user);

  const [tokens_, setTokens] = useState<McpToken[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | undefined>();
  const [createOpen, setCreateOpen] = useState(false);
  const [issued, setIssued] = useState<{ token: string; name: string } | null>(null);
  const [createForm] = Form.useForm<CreateTokenValues>();

  const allowed = useMemo<McpScope[]>(
    () => ROLE_SCOPES[currentUser?.role ?? 'viewer'] ?? ROLE_SCOPES.viewer,
    [currentUser?.role],
  );

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const response = await mcpApi.list();
      setTokens(response.items);
      setError(undefined);
    } catch (e: unknown) {
      setError(toError(e, '加载 MCP 令牌失败'));
      setTokens([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onCreate = async (values: CreateTokenValues): Promise<void> => {
    const created = await mcpApi.create({ name: values.name, scopes: values.scopes });
    setCreateOpen(false);
    createForm.resetFields();
    await load();
    // The clear token is in this one answer and nowhere else.
    setIssued({ token: created.token, name: created.name });
  };

  const onRevoke = async (id: string): Promise<void> => {
    await mcpApi.remove(id);
    message.success('令牌已吊销');
    await load();
  };

  /**
   * The client configuration an MCP client needs.
   *
   * The URL is the instance the browser is talking to, so the snippet works
   * without being edited.
   *
   * `/mcp` is the protocol's own endpoint — the path an MCP client is
   * configured with. It is not this page's path: the page is at `/mcp-access`,
   * because the server answers everything under `/mcp` with the MCP transport.
   */
  const config = useMemo(() => {
    if (!issued) return '';
    const url = `${window.location.origin}/mcp`;
    return JSON.stringify(
      {
        mcpServers: {
          'digital-management': {
            url,
            headers: { Authorization: `Bearer ${issued.token}` },
          },
        },
      },
      null,
      2,
    );
  }, [issued]);

  const copy = async (text: string, what: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      message.success(`${what}已复制`);
    } catch (error) {
      message.warning('浏览器拒绝了剪贴板访问，请手动选中复制');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space[5] }}>
      <PageHeader
        title="MCP 接入"
        subtitle="让 AI 客户端用这个账户的身份读写资产库"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            新建令牌
          </Button>
        }
      />

      <Panel title="它是怎么工作的">
        <Paragraph style={{ color: tokens.color.textMuted, marginBottom: tokens.space[2] }}>
          令牌是这个账户的另一种身份：它继承账户的租户与角色，所以它能做的事不会超过你在界面里能做的事。
          把它填进 MCP 客户端（Claude Desktop、Claude Code、Cursor 等），客户端就能列出、检索并按权限修改资产库。
        </Paragraph>
        <Paragraph style={{ color: tokens.color.textMuted, marginBottom: 0 }}>
          明文令牌只在签发时出现一次。之后数据库里只剩它的哈希——丢了就重建一个，旧的那个吊销掉即可。
        </Paragraph>
      </Panel>

      <Panel flush>
        {error && !loading ? (
          <StateBlock
            status="error"
            title="MCP 令牌加载失败"
            error={error}
            errorFallback="无法加载 MCP 令牌"
            onRetry={() => void load()}
          />
        ) : (
          <Table<McpToken>
            rowKey="id"
            dataSource={tokens_}
            loading={loading}
            scroll={{ x: 760 }}
            locale={{ emptyText: '还没有令牌' }}
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
                title: '令牌',
                dataIndex: 'token_masked',
                width: 260,
                render: (value: string) => (
                  <span style={{ fontFamily: tokens.font.mono, fontSize: tokens.fontSize.sm, color: tokens.color.textMuted }}>
                    {value}
                  </span>
                ),
              },
              {
                title: '权限',
                dataIndex: 'scopes',
                width: 220,
                render: (scopes: McpScope[]) => (
                  <Space size={4} wrap>
                    {scopes.map((scope) => (
                      <Pill key={scope} value={scope} tone="accent" mono />
                    ))}
                  </Space>
                ),
              },
              {
                title: '状态',
                dataIndex: 'is_active',
                width: 90,
                render: (active: boolean) => (
                  <Pill value={active ? 'active' : 'revoked'} tone={active ? 'success' : 'danger'} mono />
                ),
              },
              {
                title: '最近使用',
                dataIndex: 'last_used_at',
                width: 160,
                render: (value: string | null) =>
                  value ? (
                    <span style={{ fontFamily: tokens.font.mono, fontSize: tokens.fontSize.sm, color: tokens.color.text }}>
                      {formatDate(value)}
                    </span>
                  ) : (
                    '—'
                  ),
              },
              {
                title: '操作',
                width: 90,
                render: (_: unknown, token: McpToken) => (
                  <Popconfirm
                    title="吊销这个令牌？"
                    description="使用它的客户端会立刻失去访问权限。"
                    okText="吊销"
                    cancelText="取消"
                    onConfirm={() => void onRevoke(token.id)}
                    disabled={!token.is_active}
                  >
                    <Button
                      size="small"
                      type="text"
                      danger
                      icon={<DeleteOutlined />}
                      disabled={!token.is_active}
                      aria-label={`吊销令牌 ${token.name}`}
                    />
                  </Popconfirm>
                ),
              },
            ]}
          />
        )}
      </Panel>

      <FormModal<CreateTokenValues>
        open={createOpen}
        title="新建 MCP 令牌"
        form={createForm}
        onCancel={() => setCreateOpen(false)}
        onSubmit={onCreate}
        okText="创建"
        width={520}
      >
        <Form<CreateTokenValues>
          form={createForm}
          layout="vertical"
          initialValues={{ name: '', scopes: allowed }}
        >
          <Form.Item name="name" label="名称" rules={[{ required: true, max: 191 }]}>
            <Input placeholder="例如：Claude Desktop" />
          </Form.Item>
          <Form.Item
            name="scopes"
            label="权限"
            extra={`当前账户（${currentUser?.role ?? 'viewer'}）最多能拿到这些。`}
          >
            <Checkbox.Group options={allowed.map((scope) => ({ value: scope, label: SCOPE_LABELS[scope] }))} />
          </Form.Item>
        </Form>
      </FormModal>

      <Modal
        title="令牌已创建 —— 复制下来"
        open={Boolean(issued)}
        okText="我已保存"
        cancelButtonProps={{ style: { display: 'none' } }}
        onOk={() => {
          setIssued(null);
        }}
        width={640}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space[3] }}>
          <Text style={{ color: tokens.color.text }}>「{issued?.name}」的令牌：</Text>
          <Input
            aria-label="MCP 令牌"
            readOnly
            value={issued?.token ?? ''}
            addonAfter={
              <Button
                size="small"
                type="text"
                icon={<CopyOutlined />}
                aria-label="复制令牌"
                onClick={() => void copy(issued?.token ?? '', '令牌')}
              />
            }
            style={{ fontFamily: tokens.font.mono }}
          />
          <Text style={{ color: tokens.color.text }}>客户端配置：</Text>
          <Input.TextArea
            aria-label="MCP 客户端配置"
            readOnly
            autoSize={{ minRows: 6, maxRows: 14 }}
            value={config}
            style={{ fontFamily: tokens.font.mono, fontSize: tokens.fontSize.sm }}
          />
          <Button
            icon={<CopyOutlined />}
            onClick={() => void copy(config, '配置')}
            style={{ alignSelf: 'flex-start' }}
          >
            复制配置
          </Button>
          <Text style={{ color: tokens.color.danger, fontSize: tokens.fontSize.sm }}>
            这个明文只出现这一次。关掉这个窗口之后，只能重建令牌。
          </Text>
        </div>
      </Modal>
    </div>
  );
}
