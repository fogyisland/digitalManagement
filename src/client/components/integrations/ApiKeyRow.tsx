import { Button, Popconfirm, Space, Switch } from 'antd';
import {
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  KeyOutlined,
} from '@ant-design/icons';
import { API_KEY_SCOPE_LABELS } from '@/api/apikeys';
import { Hint, Pill, type PillTone } from '@/components/ui';
import type { ApiKey, ApiKeyScope } from '@/types';
import { formatDate } from '@/utils/format';
import { tokens } from '@/theme/tokens';

export interface ApiKeyRowProps {
  apiKey: ApiKey;
  /** The switch is mid-flight for this key. */
  toggling: boolean;
  /** The revoke is mid-flight for this key. */
  revoking: boolean;
  /** 现在能不能写——平台管理员没选租户时不能写。 */
  canWrite: boolean;
  /** 不能写的时候，怎么才能写。 */
  hint: string | null;
  onEdit: (key: ApiKey) => void;
  onCopy: (text: string, label: string) => void;
  onToggleActive: (key: ApiKey, nextActive: boolean) => void;
  onRevoke: (key: ApiKey) => void;
}

/**
 * Scope → pill tone. `read` / `upload` are the everyday capabilities,
 * `admin` is privileged, everything else stays neutral.
 */
const SCOPE_TONES: Record<string, PillTone> = {
  read: 'accent',
  upload: 'success',
  admin: 'danger',
};

function scopeTone(scope: ApiKeyScope): PillTone {
  return SCOPE_TONES[scope] ?? 'neutral';
}

/**
 * One API key in the integrations list.
 *
 * Lives in its own file so `pages/IntegrationsApiKeys.tsx` stays under the
 * 500-line cap the project keeps every source file under.
 */
export default function ApiKeyRow({
  apiKey,
  toggling,
  revoking,
  canWrite,
  hint,
  onEdit,
  onCopy,
  onToggleActive,
  onRevoke,
}: ApiKeyRowProps): JSX.Element {
  const scopes = Array.isArray(apiKey.scopes) ? apiKey.scopes : [];

  return (
    <div
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
      <KeyOutlined
        style={{ color: tokens.color.accent, fontSize: 16 }}
        aria-hidden
      />
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
          flex: 1,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: tokens.space[2],
          }}
        >
          <span
            style={{
              color: tokens.color.text,
              fontWeight: tokens.fontWeight.medium,
            }}
          >
            {apiKey.name}
          </span>
          <Hint title={canWrite ? '编辑名称与权限' : hint}>
            <Button
              size="small"
              type="text"
              icon={<EditOutlined />}
              disabled={!canWrite}
              onClick={() => onEdit(apiKey)}
              aria-label={`编辑 ${apiKey.name}`}
            />
          </Hint>
          <Hint title="复制 Key 摘要">
            <Button
              size="small"
              type="text"
              icon={<CopyOutlined />}
              onClick={() => onCopy(apiKey.key_masked, 'Key')}
              aria-label={`复制 ${apiKey.name} 的 Key 摘要`}
            />
          </Hint>
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
              fontSize: tokens.fontSize.sm,
              color: tokens.color.textMuted,
              background: tokens.color.bgAlt,
              border: `1px solid ${tokens.color.border}`,
              padding: '0 6px',
              borderRadius: tokens.radius.sm,
            }}
            title={`prefix: ${apiKey.key_prefix}`}
          >
            {apiKey.key_prefix}
          </span>
          <span
            style={{
              fontFamily: tokens.font.mono,
              fontSize: tokens.fontSize.sm,
              color: tokens.color.text,
            }}
            title="已脱敏的完整 Key 摘要"
          >
            {apiKey.key_masked}
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
              <Pill value="无权限" tone="neutral" />
            ) : (
              scopes.map((scope) => (
                <Pill
                  key={scope}
                  value={`${API_KEY_SCOPE_LABELS[scope] ?? scope}(${scope})`}
                  tone={scopeTone(scope)}
                />
              ))
            )}
          </Space>
          <span
            style={{
              color: tokens.color.textMuted,
              fontSize: tokens.fontSize.xs,
            }}
          >
            {apiKey.expires_at ? `过期：${formatDate(apiKey.expires_at)}` : '永不过期'}
          </span>
        </div>
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.space[2],
        }}
      >
        <Hint title={canWrite ? (apiKey.is_active ? '点击停用' : '点击启用') : hint}>
          <Switch
            checked={apiKey.is_active}
            loading={toggling}
            disabled={!canWrite}
            onChange={(checked) => onToggleActive(apiKey, checked)}
            aria-label={`切换 ${apiKey.name} 的启用状态`}
          />
        </Hint>
        {/* 撤销按钮住在 Popconfirm 里面，而 Popconfirm 要一个 DOM 节点挂
            载——所以提示包的是外面那层 span，而不是插在两者中间。 */}
        <Hint title={canWrite ? null : hint}>
          <Popconfirm
            title="确认撤销？"
            description="撤销后该 Key 将立即失效。"
            okText="撤销"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => onRevoke(apiKey)}
          >
            <Button
              size="small"
              type="text"
              danger
              icon={<DeleteOutlined />}
              loading={revoking}
              disabled={!canWrite}
              aria-label={`撤销 ${apiKey.name}`}
            />
          </Popconfirm>
        </Hint>
      </div>
    </div>
  );
}
