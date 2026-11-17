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
 *
 * The create modal belongs to this section (it owns the form state), but
 * the page owns *whether* it is open: the page passes a controlled
 * `createOpen` flag and this section asks for it through `onCreateRequest`,
 * so no tick counter has to be shared between the two components.
 */

import { useEffect, useState } from 'react';
import {
  App,
  Alert,
  Button,
  Checkbox,
  Form,
  Input,
  Modal,
  Space,
  Typography,
} from 'antd';
import {
  CheckCircleOutlined,
  CopyOutlined,
  LinkOutlined,
} from '@ant-design/icons';
import { WEBHOOK_EVENTS, WEBHOOK_EVENT_LABELS, webhooksApi } from '@/api/webhooks';
import WebhookRow from '@/components/integrations/WebhookRow';
import { useTenantWrite } from '@/hooks/useTenantWrite';
import {
  FormModal,
  Hint,
  Panel,
  StateBlock,
  type StateBlockStatus,
} from '@/components/ui';
import type { WebhookCreated, WebhookEndpoint, WebhookEvent } from '@/types';
import { describeError } from '@/utils/errors';
import { tokens } from '@/theme/tokens';

const { Title } = Typography;

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
  /** Result state resolved by the page — see `resolveDataStatus`. */
  status: StateBlockStatus | 'ready';
  error?: Error;
  onReload: () => Promise<void>;
  /** Controlled open state of the create modal. */
  createOpen: boolean;
  /** Asks the page to open the create modal. */
  onCreateRequest: () => void;
  /** The page closed the create modal. */
  onCreateClose: () => void;
}

export default function IntegrationsWebhooks(props: IntegrationsWebhooksProps): JSX.Element {
  const {
    endpoints,
    status,
    error,
    onReload,
    createOpen,
    onCreateRequest,
    onCreateClose,
  } = props;
  const { message } = App.useApp();

  // 平台管理员没选租户时，Webhook 没有落点——后端会拒（`TENANT_REQUIRED`）。
  const { canWrite, hint } = useTenantWrite();

  const [createdPayload, setCreatedPayload] = useState<WebhookCreated | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [editing, setEditing] = useState<WebhookEndpoint | null>(null);
  const [editOpen, setEditOpen] = useState<boolean>(false);
  const [createForm] = Form.useForm<WebhookFormValues>();
  const [editForm] = Form.useForm<WebhookFormValues>();

  /**
   * The page owns the open state, so the form has to be reset whenever the
   * modal is (re)opened — otherwise a half-filled draft from the last
   * attempt leaks into the next one.
   */
  useEffect(() => {
    if (!createOpen) return;
    createForm.resetFields();
    // Every event ticked by default: an empty subscription means "all
    // events" on the backend, but ticking them makes the intent explicit.
    createForm.setFieldValue('events', [...WEBHOOK_EVENTS]);
  }, [createOpen, createForm]);

  const openEdit = (ep: WebhookEndpoint): void => {
    setEditing(ep);
    editForm.setFieldsValue({
      name: ep.name,
      url: ep.url,
      events: ep.events ?? [],
    });
    setEditOpen(true);
  };

  const closeEdit = (): void => {
    setEditOpen(false);
    setEditing(null);
  };

  const onCreateSubmit = async (values: WebhookFormValues): Promise<void> => {
    try {
      const payload = await webhooksApi.create({
        name: values.name.trim(),
        url: values.url.trim(),
        events: values.events ?? [],
      });
      setCreatedPayload(payload);
      onCreateClose();
      void onReload();
    } catch (e: unknown) {
      message.error(describeError(e, '新建 Webhook 失败'));
    }
  };

  const onEditSubmit = async (values: WebhookFormValues): Promise<void> => {
    if (!editing) return;
    try {
      await webhooksApi.update(editing.id, {
        name: values.name.trim(),
        url: values.url.trim(),
        events: values.events ?? [],
      });
      message.success('已保存');
      closeEdit();
      await onReload();
    } catch (e: unknown) {
      message.error(describeError(e, '保存 Webhook 失败'));
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
      message.error(describeError(e, nextActive ? '启用失败' : '停用失败'));
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
      message.error(describeError(e, '停用失败'));
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

  // === Render ===

  const createModal = (
    <FormModal
      open={createOpen}
      title="新建 Webhook"
      form={createForm}
      onCancel={onCreateClose}
      onSubmit={onCreateSubmit}
      onValidationError={(e: unknown) => console.warn('[webhooks] create validation failed:', e)}
      okText="创建"
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
    </FormModal>
  );

  const editModal = (
    <FormModal
      open={editOpen}
      title="编辑 Webhook"
      form={editForm}
      onCancel={closeEdit}
      onSubmit={onEditSubmit}
      onValidationError={(e: unknown) => console.warn('[webhooks] edit validation failed:', e)}
      okText="保存"
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
        <span style={{ color: tokens.color.textMuted, fontSize: tokens.fontSize.sm }}>
          签名密钥不可更改；如需更换，请新建一个 Webhook。
        </span>
      </Form>
    </FormModal>
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
      {/* Read-only input: the secret must not be autofilled, spell-checked
          or picked up as a form field by the browser. */}
      <Input
        readOnly
        spellCheck={false}
        autoComplete="off"
        aria-label="签名密钥，仅在此处显示一次"
        value={createdPayload.secret}
        style={{
          fontFamily: tokens.font.mono,
          fontSize: tokens.fontSize.base,
          color: tokens.color.text,
          background: tokens.color.bgAlt,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.md,
          padding: tokens.space[3],
        }}
      />
    </Modal>
  ) : null;

  return (
    <>
      <Panel>
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space[3] }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <Title
              level={4}
              style={{
                margin: 0,
                color: tokens.color.text,
                fontWeight: tokens.fontWeight.semibold,
              }}
            >
              Webhook
            </Title>
            <Hint title={hint}>
              <Button
                type="primary"
                icon={<LinkOutlined />}
                disabled={!canWrite}
                onClick={onCreateRequest}
                aria-label="新建 Webhook"
              >
                新建 Webhook
              </Button>
            </Hint>
          </div>

          {status === 'loading' && <StateBlock status="loading" rows={3} />}

          {status === 'error' && (
            <StateBlock
              status="error"
              title="加载 Webhook 失败"
              error={error}
              errorFallback="无法加载 Webhook 列表"
              onRetry={() => void onReload()}
            />
          )}

          {status === 'empty' && (
            <StateBlock
              status="empty"
              title="还没有 Webhook 端点"
              description="新建一个端点，资产变更时即可推送事件。"
              action={
                <Hint title={hint}>
                  <Button
                    type="primary"
                    icon={<LinkOutlined />}
                    disabled={!canWrite}
                    onClick={onCreateRequest}
                    aria-label="新建 Webhook"
                  >
                    新建 Webhook
                  </Button>
                </Hint>
              }
            />
          )}

          {status === 'ready' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space[3] }}>
              {endpoints.map((ep) => (
                <WebhookRow
                  key={ep.id}
                  endpoint={ep}
                  toggling={togglingId === ep.id}
                  removing={removingId === ep.id}
                  canWrite={canWrite}
                  hint={hint}
                  onEdit={openEdit}
                  onToggleActive={(endpoint, next) => void onToggleActive(endpoint, next)}
                  onRemove={(endpoint) => void onRemove(endpoint)}
                />
              ))}
            </div>
          )}
        </div>
      </Panel>
      {createModal}
      {editModal}
      {createdModal}
    </>
  );
}
