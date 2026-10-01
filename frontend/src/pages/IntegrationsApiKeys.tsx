/**
 * API Keys section for Integrations (Task 17).
 *
 * Lists API keys, supports create + revoke. The masked key is always
 * visible (server returns `key_masked`); the raw key surfaces exactly
 * once in the post-create modal.
 *
 * The backend stores scopes as a CSV string (`read,upload`) and the
 * DTO reflects that (`scopes: string`). We split for display only.
 *
 * Backend: GET/POST /api/v1/api-keys, DELETE /api/v1/api-keys/:id
 * (soft-disable, sets is_active=0). No PUT — edit UI is hidden.
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
  KeyOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { apiClient } from '@/api/client';
import type { ApiKey } from '@/types/dto';
import { tokens } from '@/theme/tokens';

const PANEL_STYLE: React.CSSProperties = {
  background: tokens.color.panel,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.lg,
  padding: tokens.space[4],
};

const SCOPE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'read', label: '读取 (read)' },
  { value: 'write', label: '上传 (write)' },
  { value: 'admin', label: '管理 (admin)' },
];

/** Backend stores scopes as CSV; the DTO keeps it as a string. Split
 *  defensively — empty / null → []. */
function parseScopes(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  return raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
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

/** Shape returned by POST /api-keys. Server returns the raw key only
 *  here; subsequent GETs only ever surface the masked prefix. */
interface ApiKeyCreatedPayload {
  id: string;
  name: string;
  key: string;
  key_prefix: string;
  scopes: string;
  warning?: string;
}

interface CreateKeyFormValues {
  name: string;
  scopes: string[];
}

interface IntegrationsApiKeysProps {
  apiKeys: ApiKey[];
  loading: boolean;
  error?: Error;
  onReload: () => Promise<void>;
  createTick?: number;
}

export default function IntegrationsApiKeys(props: IntegrationsApiKeysProps): JSX.Element {
  const { apiKeys, loading, error, onReload, createTick } = props;
  const { message } = App.useApp();

  const [createOpen, setCreateOpen] = useState<boolean>(false);
  const [createdPayload, setCreatedPayload] = useState<ApiKeyCreatedPayload | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [lastHandledTick, setLastHandledTick] = useState<number>(0);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [createForm] = Form.useForm<CreateKeyFormValues>();

  const openCreate = (): void => {
    createForm.resetFields();
    createForm.setFieldValue('scopes', ['read', 'write']);
    setCreateOpen(true);
  };

  const closeCreate = (): void => {
    setCreateOpen(false);
  };

  const onCreateSubmit = async (): Promise<void> => {
    let values: CreateKeyFormValues;
    try {
      values = await createForm.validateFields();
    } catch (e: unknown) {
      void e;
      return;
    }
    setSubmitting(true);
    try {
      const payload = (await apiClient.request<ApiKeyCreatedPayload>({
        url: '/api-keys',
        method: 'POST',
        data: {
          name: values.name.trim(),
          scopes: values.scopes.join(','),
        },
      })).data;
      setCreatedPayload(payload);
      setCreateOpen(false);
      void onReload();
    } catch (e: unknown) {
      message.error(extractErrorMessage(e, '新建 API Key 失败'));
    } finally {
      setSubmitting(false);
    }
  };

  const onToggleActive = async (key: ApiKey, nextActive: boolean): Promise<void> => {
    // Backend has no PATCH/PUT for keys; flipping is_active is the
    // closest thing — we hit the same DELETE endpoint (soft-disable).
    // For re-enable we fall back to a direct DB-side caveat via
    // message: backend currently treats DELETE as irreversible
    // disable. We surface that honestly rather than silently pretending.
    if (nextActive) {
      message.warning('后端暂未提供重新启用接口，请创建新的 API Key');
      return;
    }
    setTogglingId(key.id);
    try {
      await apiClient.request<void>({ url: `/api-keys/${key.id}`, method: 'DELETE' });
      message.success('已停用');
      await onReload();
    } catch (e: unknown) {
      message.error(extractErrorMessage(e, '停用失败'));
    } finally {
      setTogglingId(null);
    }
  };

  const onRevoke = async (key: ApiKey): Promise<void> => {
    setRevokingId(key.id);
    try {
      await apiClient.request<void>({ url: `/api-keys/${key.id}`, method: 'DELETE' });
      message.success('已撤销');
      await onReload();
    } catch (e: unknown) {
      message.error(extractErrorMessage(e, '撤销失败'));
    } finally {
      setRevokingId(null);
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

  // Header "新建 API Key" → open create modal
  useEffect(() => {
    if (createTick === undefined) return;
    if (createTick === lastHandledTick) return;
    setLastHandledTick(createTick);
    openCreate();
  }, [createTick, lastHandledTick]);

  const rows = useMemo(() => apiKeys, [apiKeys]);

  // === Render ===

  const createModal = (
    <Modal
      title="新建 API Key"
      open={createOpen}
      onCancel={closeCreate}
      onOk={() => void onCreateSubmit()}
      okText="创建"
      cancelText="取消"
      confirmLoading={submitting}
      destroyOnClose
      width={520}
    >
      <Form
        form={createForm}
        layout="vertical"
        preserve={false}
        initialValues={{ scopes: ['read', 'write'] }}
      >
        <Form.Item
          name="name"
          label="名称"
          rules={[{ required: true, message: '请输入 API Key 名称' }]}
        >
          <Input placeholder="例如：AI 内容生成系统" autoFocus />
        </Form.Item>
        <Form.Item
          name="scopes"
          label="权限范围"
          rules={[{ required: true, type: 'array', min: 1, message: '至少选择一项权限' }]}
        >
          <Checkbox.Group options={[...SCOPE_OPTIONS]} />
        </Form.Item>
      </Form>
    </Modal>
  );

  const createdModal = createdPayload ? (
    <Modal
      title="API Key 创建成功"
      open
      onCancel={() => setCreatedPayload(null)}
      footer={[
        <Button
          key="copy"
          type="primary"
          icon={<CopyOutlined />}
          onClick={() => void onCopy(createdPayload.key, 'API Key')}
        >
          复制完整 Key
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
        message="请立即保存完整 Key"
        description={createdPayload.warning ?? '出于安全考虑，关闭此弹窗后将无法再次查看完整 Key，只能重新创建。'}
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
          {createdPayload.key}
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
          <span>加载 API Key 失败：{error.message}</span>
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
            description={<span style={{ color: tokens.color.textMuted }}>还没有 API Key</span>}
          >
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              新建 API Key
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space[3] }}>
          {rows.map((k) => {
            const scopes = parseScopes(k.scopes);
            return (
              <div
                key={k.id}
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
                <KeyOutlined style={{ color: tokens.color.accent, fontSize: 16 }} aria-hidden />
                <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: tokens.space[2] }}>
                    <span style={{ color: tokens.color.text, fontWeight: 500 }}>{k.name}</span>
                    <Tooltip title="复制 Key 摘要">
                      <Button
                        size="small"
                        type="text"
                        icon={<CopyOutlined />}
                        onClick={() => void onCopy(k.key_masked, 'Key')}
                        aria-label={`复制 ${k.name} 的 Key 摘要`}
                      />
                    </Tooltip>
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: tokens.space[2],
                      flexWrap: 'wrap',
                    }}
                  >
                    <span
                      style={{
                        fontFamily: tokens.font.mono,
                        fontSize: 12,
                        color: tokens.color.textMuted,
                        background: tokens.color.bgAlt,
                        border: `1px solid ${tokens.color.border}`,
                        padding: '0 6px',
                        borderRadius: tokens.radius.sm,
                      }}
                      title={`prefix: ${k.key_prefix}`}
                    >
                      {k.key_prefix}
                    </span>
                    <span
                      style={{
                        fontFamily: tokens.font.mono,
                        fontSize: 12,
                        color: tokens.color.text,
                      }}
                      title="已脱敏的完整 Key 摘要"
                    >
                      {k.key_masked}
                    </span>
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: tokens.space[2],
                      flexWrap: 'wrap',
                      marginTop: 4,
                    }}
                  >
                    <Space size={4} wrap>
                      {scopes.length === 0 ? (
                        <Tag>无权限</Tag>
                      ) : (
                        scopes.map((s) => (
                          <Tag key={s} color={scopeColor(s)}>
                            {s}
                          </Tag>
                        ))
                      )}
                    </Space>
                    <span style={{ color: tokens.color.textMuted, fontSize: 11 }}>
                      {k.expires_at ? `过期：${k.expires_at}` : '永不过期'}
                    </span>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: tokens.space[2] }}>
                  <Tooltip title={k.is_active ? '点击停用' : '后端暂不支持启用'}>
                    <Switch
                      checked={k.is_active}
                      disabled={togglingId === k.id || (!k.is_active)}
                      onChange={(checked) => void onToggleActive(k, checked)}
                      aria-label={`切换 ${k.name} 的启用状态`}
                    />
                  </Tooltip>
                  <Popconfirm
                    title="确认撤销？"
                    description="撤销后该 Key 将立即失效。"
                    okText="撤销"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => void onRevoke(k)}
                  >
                    <Button
                      size="small"
                      type="text"
                      danger
                      icon={<DeleteOutlined />}
                      loading={revokingId === k.id}
                      aria-label={`撤销 ${k.name}`}
                    />
                  </Popconfirm>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {createModal}
      {createdModal}
    </>
  );
}

function scopeColor(scope: string): string {
  if (scope === 'read') return 'green';
  if (scope === 'write') return 'blue';
  return 'red';
}
