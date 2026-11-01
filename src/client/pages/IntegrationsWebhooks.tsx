/**
 * Webhook endpoints section for Integrations (Task 17).
 *
 * Backend contract (mirrored by `backend/src/routes/webhooks.js`):
 *   GET    /webhooks        → WebhookEndpoint[] (id/name/url/is_active/events/created_at)
 *   POST   /webhooks        → { id, name, url, secret, events, warning } (secret only here)
 *   PUT    /webhooks/:id    → WebhookEndpoint
 *   DELETE /webhooks/:id    → 204 (soft-disable: is_active=0)
 *
 * Every mutation goes through `@/api/webhooks` — the page never touches
 * `apiClient` directly, so the front↔back contract has exactly one place
 * to drift.
 *
 * `events` is a real subscription, not a note: the backend stores it and
 * only delivers the events an endpoint subscribed to. An **empty list means
 * "every event"**, which is why the create form starts with all events
 * ticked and the row badge says 「全部事件」 for an empty subscription.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  App,
  Alert,
  Button,
  Checkbox,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Skeleton,
  Space,
  Switch,
  Tag,
  Tooltip,
} from 'antd';
import {
  CheckCircleOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  LinkOutlined,
} from '@ant-design/icons';
import { WEBHOOK_EVENTS, WEBHOOK_EVENT_LABELS, webhooksApi } from '@/api/webhooks';
import type { WebhookCreated, WebhookEndpoint, WebhookEvent } from '@/types';
import { tokens } from '@/theme/tokens';

const PANEL_STYLE: React.CSSProperties = {
  background: tokens.color.panel,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.lg,
  padding: tokens.space[4],
};

/**
 * The checkbox list is derived from the backend vocabulary so the UI can
 * never offer an event the API would reject with 400.
 */
const EVENT_OPTIONS: ReadonlyArray<{ value: WebhookEvent; label: string }> = WEBHOOK_EVENTS.map(
  (event) => ({ value: event, label: `${WEBHOOK_EVENT_LABELS[event]} (${event})` }),
);

const EVENTS_HINT = '不勾选任何事件 = 订阅全部事件。';

interface WebhookFormValues {
  name: string;
  url: string;
  events: WebhookEvent[];
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
  const [createdPayload, setCreatedPayload] = useState<WebhookCreated | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [editing, setEditing] = useState<WebhookEndpoint | null>(null);
  const [editOpen, setEditOpen] = useState<boolean>(false);
  const [editSubmitting, setEditSubmitting] = useState<boolean>(false);
  const [lastHandledTick, setLastHandledTick] = useState<number>(0);
  const [createForm] = Form.useForm<WebhookFormValues>();
  const [editForm] = Form.useForm<WebhookFormValues>();

  const openCreate = (): void => {
    createForm.resetFields();
    // Every event ticked by default: an empty subscription means "all
    // events" on the backend, but ticking them makes the intent explicit.
    createForm.setFieldValue('events', [...WEBHOOK_EVENTS]);
    setCreateOpen(true);
  };

  const closeCreate = (): void => {
    setCreateOpen(false);
  };

  const onCreateSubmit = async (): Promise<void> => {
    let values: WebhookFormValues;
    try {
      values = await createForm.validateFields();
    } catch (e: unknown) {
      console.warn('[webhooks] create validation failed:', e);
      return;
    }
    setSubmitting(true);
    try {
      const payload = await webhooksApi.create({
        name: values.name.trim(),
        url: values.url.trim(),
        events: values.events ?? [],
      });
      setCreatedPayload(payload);
      setCreateOpen(false);
      void onReload();
    } catch (e: unknown) {
      message.error(extractErrorMessage(e, '新建 Webhook 失败'));
    } finally {
      setSubmitting(false);
    }
  };

  const openEdit = (ep: WebhookEndpoint): void => {
    setEditing(ep);
    editForm.setFieldsValue({
      name: ep.name,
      url: ep.url,
      events: ep.events ?? [],
    });
    setEditOpen(true);
  };

  const onEditSubmit = async (): Promise<void> => {
    if (!editing) return;
    let values: WebhookFormValues;
    try {
      values = await editForm.validateFields();
    } catch (e: unknown) {
      console.warn('[webhooks] edit validation failed:', e);
      return;
    }
    setEditSubmitting(true);
    try {
      await webhooksApi.update(editing.id, {
        name: values.name.trim(),
        url: values.url.trim(),
        events: values.events ?? [],
      });
      message.success('已保存');
      setEditOpen(false);
      setEditing(null);
      await onReload();
    } catch (e: unknown) {
      message.error(extractErrorMessage(e, '保存 Webhook 失败'));
    } finally {
      setEditSubmitting(false);
    }
  };

  /**
   * Toggle the endpoint's active state.
   *
   * `PUT /webhooks/:id` accepts `is_active`, so both directions are a real
   * backend operation: `DELETE` only soft-disables, while `PUT` with
   * `is_active: true` brings the endpoint back into the fan-out.
   */
  const onToggleActive = async (ep: WebhookEndpoint, nextActive: boolean): Promise<void> => {
    setTogglingId(ep.id);
    try {
      await webhooksApi.update(ep.id, { is_active: nextActive });
      message.success(nextActive ? '已启用' : '已停用');
      await onReload();
    } catch (e: unknown) {
      message.error(extractErrorMessage(e, nextActive ? '启用失败' : '停用失败'));
    } finally {
      setTogglingId(null);
    }
  };

  const onRemove = async (ep: WebhookEndpoint): Promise<void> => {
    setRemovingId(ep.id);
    try {
      await webhooksApi.remove(ep.id);
      message.success('已停用 Webhook');
      await onReload();
    } catch (e: unknown) {
      message.error(extractErrorMessage(e, '停用失败'));
    } finally {
      setRemovingId(null);
    }
  };

  const onCopy = async (text: string, label: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      message.success(`${label}已复制到剪贴板`);
    } catch (e: unknown) {
      console.warn('[webhooks] clipboard write failed:', e);
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
        initialValues={{ events: [...WEBHOOK_EVENTS] }}
      >
        <Form.Item
          name="name"
          label="名称"
          rules={[{ required: true, message: '请输入 Webhook 名称' }]}
        >
          <Input placeholder="例如：生产环境资产同步" autoFocus />
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
          <Input placeholder="https://example.com/webhooks/dam" />
        </Form.Item>
        <Form.Item name="events" label="订阅事件" extra={EVENTS_HINT}>
          <Checkbox.Group options={[...EVENT_OPTIONS]} />
        </Form.Item>
      </Form>
    </Modal>
  );

  const editModal = (
    <Modal
      title="编辑 Webhook"
      open={editOpen}
      onCancel={() => {
        setEditOpen(false);
        setEditing(null);
      }}
      onOk={() => void onEditSubmit()}
      okText="保存"
      cancelText="取消"
      confirmLoading={editSubmitting}
      destroyOnClose
      width={560}
    >
      <Form form={editForm} layout="vertical" preserve={false}>
        <Form.Item
          name="name"
          label="名称"
          rules={[{ required: true, message: '请输入 Webhook 名称' }]}
        >
          <Input autoFocus />
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
          <Input />
        </Form.Item>
        <Form.Item name="events" label="订阅事件" extra={EVENTS_HINT}>
          <Checkbox.Group options={[...EVENT_OPTIONS]} />
        </Form.Item>
        <Form.Item label=" " colon={false}>
          <span style={{ color: tokens.color.textMuted, fontSize: 12 }}>
            签名密钥不可更改；如需更换，请新建一个 Webhook。
          </span>
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
        {editModal}
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
        {editModal}
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
        {editModal}
        {createdModal}
      </>
    );
  }

  return (
    <>
      <div style={PANEL_STYLE}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space[3] }}>
          {rows.map((ep) => {
            const events = Array.isArray(ep.events) ? ep.events : [];
            return (
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
                  <div style={{ display: 'flex', alignItems: 'center', gap: tokens.space[2] }}>
                    <span style={{ color: tokens.color.text, fontWeight: 500 }}>{ep.name}</span>
                    <Tooltip title="编辑名称、URL 与订阅事件">
                      <Button
                        size="small"
                        type="text"
                        icon={<EditOutlined />}
                        onClick={() => openEdit(ep)}
                        aria-label={`编辑 ${ep.name}`}
                      />
                    </Tooltip>
                  </div>
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
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: tokens.space[2],
                      flexWrap: 'wrap',
                      marginTop: 4,
                    }}
                  >
                    <Tag color={ep.is_active ? 'green' : 'default'}>
                      {ep.is_active ? '启用' : '已停用'}
                    </Tag>
                    {events.length === 0 ? (
                      <Tag color="blue">全部事件</Tag>
                    ) : (
                      events.map((event) => (
                        <Tag key={event}>{event}</Tag>
                      ))
                    )}
                    <span style={{ color: tokens.color.textMuted, fontSize: 11 }}>
                      创建于 {ep.created_at}
                    </span>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: tokens.space[2] }}>
                  <Tooltip title={ep.is_active ? '点击停用' : '点击启用'}>
                    <Switch
                      checked={ep.is_active}
                      loading={togglingId === ep.id}
                      onChange={(checked) => void onToggleActive(ep, checked)}
                      aria-label={`切换 ${ep.name} 的启用状态`}
                    />
                  </Tooltip>
                  <Popconfirm
                    title="确认停用？"
                    description="停用后该端点将不再收到事件，历史记录会保留。"
                    okText="停用"
                    cancelText="取消"
                    onConfirm={() => void onRemove(ep)}
                  >
                    <Button
                      size="small"
                      type="text"
                      danger
                      icon={<DeleteOutlined />}
                      loading={removingId === ep.id}
                      aria-label={`停用 ${ep.name}`}
                    />
                  </Popconfirm>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {createModal}
      {editModal}
      {createdModal}
    </>
  );
}
