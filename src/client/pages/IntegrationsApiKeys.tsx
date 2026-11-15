/**
 * API Keys section for Integrations (Task 17).
 *
 * Lists API keys and supports create, edit (name + scopes), activate /
 * deactivate and revoke. The masked key is always visible (the server
 * returns `key_masked`); the raw key surfaces exactly once in the
 * post-create modal.
 *
 * Backend: `GET/POST /api/v1/api-keys`, `PUT /api/v1/api-keys/:id`
 * (name / scopes / expires_at / is_active) and `DELETE /api/v1/api-keys/:id`
 * (deactivates the key but keeps the row for audit).
 *
 * The scope vocabulary is fixed by the backend (`KNOWN_SCOPES` in
 * `backend/src/routes/apikeys.js`) and mirrored by
 * `API_KEY_SCOPES` in `@/api/apikeys` — the UI never invents a scope.
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
  PlusOutlined,
} from '@ant-design/icons';
import { API_KEY_SCOPES, API_KEY_SCOPE_LABELS, apiKeysApi } from '@/api/apikeys';
import ApiKeyRow from '@/components/integrations/ApiKeyRow';
import {
  FormModal,
  Panel,
  StateBlock,
  type StateBlockStatus,
} from '@/components/ui';
import type { ApiKey, ApiKeyCreated, ApiKeyScope } from '@/types';
import { describeError } from '@/utils/errors';
import { tokens } from '@/theme/tokens';

const { Title } = Typography;

/**
 * The scope checkboxes are derived from the backend whitelist so the UI
 * can never offer a scope the API would reject with 400.
 */
const SCOPE_OPTIONS: ReadonlyArray<{ value: ApiKeyScope; label: string }> =
  API_KEY_SCOPES.map((scope) => ({
    value: scope,
    label: `${API_KEY_SCOPE_LABELS[scope]} (${scope})`,
  }));

/** The create and the edit form carry exactly the same fields. */
interface ApiKeyFormValues {
  name: string;
  scopes: ApiKeyScope[];
}

interface IntegrationsApiKeysProps {
  apiKeys: ApiKey[];
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

export default function IntegrationsApiKeys(props: IntegrationsApiKeysProps): JSX.Element {
  const { apiKeys, status, error, onReload, createOpen, onCreateRequest, onCreateClose } = props;
  const { message } = App.useApp();

  const [createdPayload, setCreatedPayload] = useState<ApiKeyCreated | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [editing, setEditing] = useState<ApiKey | null>(null);
  const [editOpen, setEditOpen] = useState<boolean>(false);
  const [createForm] = Form.useForm<ApiKeyFormValues>();
  const [editForm] = Form.useForm<ApiKeyFormValues>();

  /**
   * The page owns the open state, so the form has to be reset whenever the
   * modal is (re)opened — otherwise a half-filled draft from the last
   * attempt leaks into the next one.
   */
  useEffect(() => {
    if (!createOpen) return;
    createForm.resetFields();
    createForm.setFieldValue('scopes', ['read', 'upload']);
  }, [createOpen, createForm]);

  const openEdit = (key: ApiKey): void => {
    setEditing(key);
    editForm.setFieldsValue({
      name: key.name,
      scopes: key.scopes ?? [],
    });
    setEditOpen(true);
  };

  const closeEdit = (): void => {
    setEditOpen(false);
    setEditing(null);
  };

  const onCreateSubmit = async (values: ApiKeyFormValues): Promise<void> => {
    try {
      const payload = await apiKeysApi.create({
        name: values.name.trim(),
        scopes: values.scopes,
      });
      setCreatedPayload(payload);
      onCreateClose();
      void onReload();
    } catch (e: unknown) {
      message.error(describeError(e, '新建 API Key 失败'));
    }
  };

  const onEditSubmit = async (values: ApiKeyFormValues): Promise<void> => {
    if (!editing) return;
    try {
      await apiKeysApi.update(editing.id, {
        name: values.name.trim(),
        scopes: values.scopes,
      });
      message.success('已保存');
      closeEdit();
      await onReload();
    } catch (e: unknown) {
      message.error(describeError(e, '保存 API Key 失败'));
    }
  };

  /**
   * Toggle the key's active state.
   *
   * `PUT /api-keys/:id` accepts `is_active`, so both directions are a
   * real backend operation — deactivating keeps the row (same effect as
   * DELETE) and activating revives a revoked key.
   */
  const onToggleActive = async (key: ApiKey, nextActive: boolean): Promise<void> => {
    setTogglingId(key.id);
    try {
      await apiKeysApi.update(key.id, { is_active: nextActive });
      message.success(nextActive ? '已启用' : '已停用');
      await onReload();
    } catch (e: unknown) {
      message.error(describeError(e, nextActive ? '启用失败' : '停用失败'));
    } finally {
      setTogglingId(null);
    }
  };

  const onRevoke = async (key: ApiKey): Promise<void> => {
    setRevokingId(key.id);
    try {
      await apiKeysApi.revoke(key.id);
      message.success('已撤销');
      await onReload();
    } catch (e: unknown) {
      message.error(describeError(e, '撤销失败'));
    } finally {
      setRevokingId(null);
    }
  };

  const onCopy = async (text: string, label: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      message.success(`${label}已复制到剪贴板`);
    } catch (e: unknown) {
      console.warn('[api-keys] clipboard write failed:', e);
      message.error('剪贴板不可用，请手动复制');
    }
  };

  // === Render ===

  const createModal = (
    <FormModal
      open={createOpen}
      title="新建 API Key"
      form={createForm}
      onCancel={onCreateClose}
      onSubmit={onCreateSubmit}
      onValidationError={(e: unknown) => console.warn('[api-keys] create validation failed:', e)}
      okText="创建"
      width={520}
    >
      <Form
        form={createForm}
        layout="vertical"
        preserve={false}
        initialValues={{ scopes: ['read', 'upload'] }}
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
    </FormModal>
  );

  const editModal = (
    <FormModal
      open={editOpen}
      title="编辑 API Key"
      form={editForm}
      onCancel={closeEdit}
      onSubmit={onEditSubmit}
      onValidationError={(e: unknown) => console.warn('[api-keys] edit validation failed:', e)}
      okText="保存"
      width={520}
    >
      <Form form={editForm} layout="vertical" preserve={false}>
        <Form.Item
          name="name"
          label="名称"
          rules={[{ required: true, message: '请输入 API Key 名称' }]}
        >
          <Input autoFocus />
        </Form.Item>
        <Form.Item
          name="scopes"
          label="权限范围"
          rules={[{ required: true, type: 'array', min: 1, message: '至少选择一项权限' }]}
        >
          <Checkbox.Group options={[...SCOPE_OPTIONS]} />
        </Form.Item>
        <TextMuted>修改权限范围会立即影响该 Key 的调用；密钥本身不可更改。</TextMuted>
      </Form>
    </FormModal>
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
      {/* Read-only input: the plain key must not be autofilled, spell-checked
          or picked up as a form field by the browser. */}
      <Input
        readOnly
        spellCheck={false}
        autoComplete="off"
        aria-label="完整 API Key，仅在此处显示一次"
        value={createdPayload.key}
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
              API Key
            </Title>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={onCreateRequest}
              aria-label="新建 API Key"
            >
              新建 API Key
            </Button>
          </div>

          {status === 'loading' && <StateBlock status="loading" rows={3} />}

          {status === 'error' && (
            <StateBlock
              status="error"
              title="加载 API Key 失败"
              error={error}
              errorFallback="无法加载 API Key 列表"
              onRetry={() => void onReload()}
            />
          )}

          {status === 'empty' && (
            <StateBlock
              status="empty"
              title="还没有 API Key"
              description="创建一个 API Key，让外部系统可以访问资产。"
              action={
                <Button
                  type="primary"
                  icon={<PlusOutlined />}
                  onClick={onCreateRequest}
                  aria-label="新建 API Key"
                >
                  新建 API Key
                </Button>
              }
            />
          )}

          {status === 'ready' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space[3] }}>
              {apiKeys.map((k) => (
                <ApiKeyRow
                  key={k.id}
                  apiKey={k}
                  toggling={togglingId === k.id}
                  revoking={revokingId === k.id}
                  onEdit={openEdit}
                  onCopy={(text, label) => void onCopy(text, label)}
                  onToggleActive={(key, next) => void onToggleActive(key, next)}
                  onRevoke={(key) => void onRevoke(key)}
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

/** A muted inline note; kept local so the file has no extra imports. */
function TextMuted({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <span style={{ color: tokens.color.textMuted, fontSize: tokens.fontSize.sm }}>{children}</span>
  );
}
