/**
 * Webhook endpoints section for Integrations (Task 17).
 *
 * Backend contract:
 *   GET    /webhooks        → WebhookEndpoint[] (id/name/url/is_active/created_at)
 *   POST   /webhooks        → { id, name, url, secret, warning } (secret only here)
 *   DELETE /webhooks/:id    → 204 (soft-disable: is_active=0)
 *
 * There is no PUT — edit buttons are intentionally absent. Re-enable is
 * also unsupported by the backend; we surface that honestly via the
 * Switch tooltip rather than pretending the toggle works.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  App,
  Alert,
  Button,
  Empty,
  Form,
  Input,
  Modal,
  Skeleton,
  Space,
  Switch,
  Tag,
  Tooltip,
} from 'antd';
import {
  CheckCircleOutlined,
  CopyOutlined,
  LinkOutlined,
} from '@ant-design/icons';
import { apiClient } from '@/api/client';
import type { WebhookEndpoint } from '@/types/dto';
import { tokens } from '@/theme/tokens';

const PANEL_STYLE: React.CSSProperties = {
  background: tokens.color.panel,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.lg,
  padding: tokens.space[4],
};

const EVENT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'asset.created', label: '资产创建 (asset.created)' },
  { value: 'asset.updated', label: '资产更新 (asset.updated)' },
  { value: 'asset.deleted', label: '资产删除 (asset.deleted)' },
];

interface WebhookCreatedPayload {
  id: string;
  name: string;
  url: string;
  secret: string;
  warning?: string;
}

interface CreateWebhookFormValues {
  name: string;
  url: string;
  events: string[];
}

interface IntegrationsWebhooksProps {
  endpoints: WebhookEndpoint[];
  loading: boolean;
  error?: Error;
  onReload: () => Promise<void>;
  createTick?: number;
}

function extractErrorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'response' in err) {
    const response = (err as { response?: { data?: { detail?: string; message?: string } } }).response;
    const data = response?.data;
    if (data?.detail) return String(data.detail);
    if (data?.message) return String(data.message);
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

export default function IntegrationsWebhooks(props: IntegrationsWebhooksProps): JSX.Element {
  const { endpoints, loading, error, onReload, createTick } = props;
  const { message } = App.useApp();

  const [createOpen, setCreateOpen] = useState<boolean>(false);
  const [createdPayload, setCreatedPayload] = useState<WebhookCreatedPayload | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [lastHandledTick, setLastHandledTick] = useState<number>(0);
  const [createForm] = Form.useForm<CreateWebhookFormValues>();

  const openCreate = (): void => {
    createForm.resetFields();
    createForm.setFieldValue('events', ['asset.created', 'asset.updated']);
    setCreateOpen(true);
  };

  const closeCreate = (): void => {
    setCreateOpen(false);
  };

  const onCreateSubmit = async (): Promise<void> => {
    let values: CreateWebhookFormValues;
    try {
      values = await createForm.validateFields();
    } catch (e: unknown) {
      void e;
      return;
    }
    setSubmitting(true);
    try {
      const payload = (await apiClient.request<WebhookCreatedPayload>({
        url: '/webhooks',
        method: 'POST',
        data: {
          name: values.name.trim(),
          url: values.url.trim(),
          events: values.events,
        },
      })).data;
      setCreatedPayload(payload);
      setCreateOpen(false);
      void onReload();
    } catch (e: unknown) {
      message.error(extractErrorMessage(e, '新建 Webhook 失败'));
    } finally {
      setSubmitting(false);
    }
  };

  const onToggleActive = async (ep: WebhookEndpoint, nextActive: boolean): Promise<void> => {
    if (nextActive) {
      message.warning('后端暂未提供重新启用接口，请创建新的 Webhook');
      return;
    }
    setTogglingId(ep.id);
    try {
      await apiClient.request<void>({ url: `/webhooks/${ep.id}`, method: 'DELETE' });
      message.success('已停用 Webhook');
      await onReload();
    } catch (e: unknown) {
      message.error(extractErrorMessage(e, '停用失败'));
    } finally {
      setTogglingId(null);
    }
  };

  const onCopy = async (text: string, label: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      message.success(`${label}已复制到剪贴板`);
    } catch (e: unknown) {
      void e;
      message.error('剪贴板不可用，请手动复制');
    }
  };

  // Header "新建 Webhook" → open create modal
  useEffect(() => {
    if (createTick === undefined) return;
    if (createTick === lastHandledTick) return;
    setLastHandledTick(createTick);
    openCreate();
  }, [createTick, lastHandledTick]);

  const rows = useMemo(() => endpoints, [endpoints]);

  // === Render ===

  const createModal = (
    <Modal
      title="新建 Webhook"
      open={createOpen}
      onCancel={closeCreate}
      onOk={() => void onCreateSubmit()}
      okText="创建"
      cancelText="取消"
      confirmLoading={submitting}
      destroyOnClose
      width={560}
    >
      <Form
        form={createForm}
        layout="vertical"
        preserve={false}
        initialValues={{ events: ['asset.created', 'asset.updated'] }}
      >
        <Form.Item
          name="name"
          label="名称"
          rules={[{ required: true, message: '请输入 Webhook 名称' }]}
        >
          <Input placeholder="例如：生产环境资产同步" />
        </Form.Item>
        <Form.Item
          name="url"
          label="回调 URL"
          rules={[
            { required: true, message: '请输入 URL' },
            {
              pattern: /^https?:\/\//,
              message: 'URL 必须以 http:// 或 https:// 开头',
            },
          ]}
        >
          <Input placeholder="https://example.com/webhooks/dam" autoFocus />
        </Form.Item>
        <Form.Item
          name="events"
          label="订阅事件"
          extra={eventsHint}
        >
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            {EVENT_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: tokens.space[2],
                  color: tokens.color.text,
                }}
              >
                <input type="checkbox" value={opt.value} />
                <span>{opt.label}</span>
              </label>
            ))}
          </Space>
        </Form.Item>
      </Form>
    </Modal>
  );

  const createdModal = createdPayload ? (
    <Modal
      title="Webhook 创建成功"
      open
      onCancel={() => setCreatedPayload(null)}
      footer={[
        <Button
          key="copy"
          type="primary"
          icon={<CopyOutlined />}
          onClick={() => void onCopy(createdPayload.secret, '签名密钥')}
        >
          复制 Secret
        </Button>,
        <Button
          key="close"
          icon={<CheckCircleOutlined />}
          onClick={() => setCreatedPayload(null)}
        >
          我已保存，关闭
        </Button>,
      ]}
      width={560}
    >
      <Alert
        type="warning"
        showIcon
        message="请立即保存签名密钥"
        description={createdPayload.warning ?? '关闭此弹窗后将无法再次查看 Secret。'}
        style={{ marginBottom: tokens.space[3] }}
      />
      <div
        style={{
          padding: tokens.space[3],
          background: tokens.color.bgAlt,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.md,
          wordBreak: 'break-all',
        }}
      >
        <span
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 13,
            color: tokens.color.text,
          }}
        >
          {createdPayload.secret}
        </span>
      </div>
    </Modal>
  ) : null;

  if (error) {
    return (
      <>
        <div
          style={{
            padding: tokens.space[4],
            background: 'rgba(248, 81, 73, 0.08)',
            border: `1px solid ${tokens.color.danger}`,
            borderRadius: tokens.radius.md,
            color: tokens.color.danger,
            display: 'flex',
            alignItems: 'center',
            gap: tokens.space[3],
          }}
        >
          <span>加载 Webhook 失败：{error.message}</span>
          <Button size="small" onClick={() => void onReload()}>
            重试
          </Button>
        </div>
        {createModal}
        {createdModal}
      </>
    );
  }

  if (loading && rows.length === 0) {
    return (
      <>
        <div style={PANEL_STYLE}>
          <Skeleton active paragraph={{ rows: 3 }} />
        </div>
        {createModal}
        {createdModal}
      </>
    );
  }

  if (rows.length === 0) {
    return (
      <>
        <div style={PANEL_STYLE}>
          <Empty
            description={<span style={{ color: tokens.color.textMuted }}>还没有 Webhook 端点</span>}
          >
            <Button type="primary" icon={<LinkOutlined />} onClick={openCreate}>
              新建 Webhook
            </Button>
          </Empty>
        </div>
        {createModal}
        {createdModal}
      </>
    );
  }

  return (
    <>
      <div style={PANEL_STYLE}>
        <div
          style={{
            padding: tokens.space[2],
            fontSize: 12,
            color: tokens.color.textMuted,
            borderRadius: tokens.radius.sm,
            background: 'rgba(245, 165, 36, 0.06)',
            border: `1px dashed ${tokens.color.border}`,
            marginBottom: tokens.space[3],
          }}
        >
          Webhook 仅支持新建与停用；后端未提供编辑接口，重新启用需新建（详见 task-17-report concerns）。
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space[3] }}>
          {rows.map((ep) => (
            <div
              key={ep.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: tokens.space[3],
                padding: tokens.space[3],
                background: tokens.color.panelAlt,
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.md,
              }}
            >
              <LinkOutlined style={{ color: tokens.color.accent, fontSize: 16 }} aria-hidden />
              <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
                <span style={{ color: tokens.color.text, fontWeight: 500 }}>{ep.name}</span>
                <span
                  style={{
                    fontFamily: tokens.font.mono,
                    fontSize: 12,
                    color: tokens.color.textMuted,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={ep.url}
                >
                  {ep.url}
                </span>
                <div style={{ marginTop: 4 }}>
                  <Tag color={ep.is_active ? 'green' : 'default'}>
                    {ep.is_active ? '启用' : '已停用'}
                  </Tag>
                  <span style={{ color: tokens.color.textMuted, fontSize: 11, marginLeft: 6 }}>
                    创建于 {ep.created_at}
                  </span>
                </div>
              </div>
              <Tooltip title={ep.is_active ? '点击停用' : '后端暂不支持启用'}>
                <Switch
                  checked={ep.is_active}
                  disabled={togglingId === ep.id || (!ep.is_active)}
                  onChange={(checked) => void onToggleActive(ep, checked)}
                  aria-label={`切换 ${ep.name} 的启用状态`}
                />
              </Tooltip>
            </div>
          ))}
        </div>
      </div>
      {createModal}
      {createdModal}
    </>
  );
}

const eventsHint = '后端目前不在 secret 之外持久化事件订阅，事件 fan-out 对全部已启用端点生效；此字段用于客户端可读性记录。';
