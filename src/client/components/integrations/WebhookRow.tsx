import { Button, Popconfirm, Space, Switch } from 'antd';
import { DeleteOutlined, EditOutlined, LinkOutlined } from '@ant-design/icons';
import { WEBHOOK_EVENT_LABELS } from '@/api/webhooks';
import { Hint, Pill } from '@/components/ui';
import type { WebhookEndpoint } from '@/types';
import { formatDate } from '@/utils/format';
import { tokens } from '@/theme/tokens';

export interface WebhookRowProps {
  endpoint: WebhookEndpoint;
  /** The switch is mid-flight for this endpoint. */
  toggling: boolean;
  /** The removal is mid-flight for this endpoint. */
  removing: boolean;
  /** 现在能不能写——平台管理员没选租户时不能写。 */
  canWrite: boolean;
  /** 不能写的时候，怎么才能写。 */
  hint: string | null;
  onEdit: (endpoint: WebhookEndpoint) => void;
  onToggleActive: (endpoint: WebhookEndpoint, nextActive: boolean) => void;
  onRemove: (endpoint: WebhookEndpoint) => void;
}

/**
 * One webhook endpoint in the integrations list.
 *
 * Lives in its own file so `pages/IntegrationsWebhooks.tsx` stays under the
 * 500-line cap the project keeps every source file under.
 */
export default function WebhookRow({
  endpoint,
  toggling,
  removing,
  canWrite,
  hint,
  onEdit,
  onToggleActive,
  onRemove,
}: WebhookRowProps): JSX.Element {
  const events = Array.isArray(endpoint.events) ? endpoint.events : [];

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
      <LinkOutlined
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
            {endpoint.name}
          </span>
          <Hint title={canWrite ? '编辑名称、URL 与订阅事件' : hint}>
            <Button
              size="small"
              type="text"
              icon={<EditOutlined />}
              disabled={!canWrite}
              onClick={() => onEdit(endpoint)}
              aria-label={`编辑 ${endpoint.name}`}
            />
          </Hint>
        </div>
        <span
          style={{
            fontFamily: tokens.font.mono,
            fontSize: tokens.fontSize.sm,
            color: tokens.color.textMuted,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={endpoint.url}
        >
          {endpoint.url}
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
          <Space size={4} wrap>
            <Pill
              value={endpoint.is_active ? '启用' : '已停用'}
              tone={endpoint.is_active ? 'success' : 'neutral'}
            />
            {events.length === 0 ? (
              <Pill value="全部事件" tone="accent" />
            ) : (
              events.map((event) => (
                <Pill
                  key={event}
                  value={`${WEBHOOK_EVENT_LABELS[event] ?? event}(${event})`}
                  tone="neutral"
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
            创建于 {formatDate(endpoint.created_at)}
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
        <Hint title={canWrite ? (endpoint.is_active ? '点击停用' : '点击启用') : hint}>
          <Switch
            checked={endpoint.is_active}
            loading={toggling}
            disabled={!canWrite}
            onChange={(checked) => onToggleActive(endpoint, checked)}
            aria-label={`切换 ${endpoint.name} 的启用状态`}
          />
        </Hint>
        {/* 停用按钮住在 Popconfirm 里面，而 Popconfirm 要一个 DOM 节点挂
            载——所以提示包的是外面那层 span，而不是插在两者中间。 */}
        <Hint title={canWrite ? null : hint}>
          <Popconfirm
            title="确认停用？"
            description="停用后该端点将不再收到事件，历史记录会保留。"
            okText="停用"
            cancelText="取消"
            onConfirm={() => onRemove(endpoint)}
          >
            <Button
              size="small"
              type="text"
              danger
              icon={<DeleteOutlined />}
              loading={removing}
              disabled={!canWrite}
              aria-label={`停用 ${endpoint.name}`}
            />
          </Popconfirm>
        </Hint>
      </div>
    </div>
  );
}
