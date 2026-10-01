/**
 * Integrations — API Key + Webhook management (Task 17).
 *
 * Single-page workspace merging the legacy ApiKeys + Webhook UIs.
 *
 *   - Top section: API keys (list / create / revoke / copy masked).
 *     POST /api-keys returns the raw key exactly once; the UI surfaces
 *     it inside the post-create modal with copy + acknowledge.
 *   - Bottom section: Webhook endpoints (list / create / disable).
 *     The backend exposes GET/POST/DELETE on /webhooks — no PUT, and
 *     DELETE is a soft-disable (is_active=0). Edit buttons are hidden
 *     because there is no edit endpoint; DELETE only disables.
 *     POST /webhooks returns the signing secret exactly once.
 *
 * Both sections are pure subcomponents (`IntegrationsApiKeys`,
 * `IntegrationsWebhooks`) so this orchestrator file stays under the 500-line
 * cap and each section is independently readable. Data fetching goes
 * through `useApi`; mutations go through the shared `apiClient`.
 */

import { useState } from 'react';
import { Button, Skeleton, Space, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useApi } from '@/api/hooks';
import type { ApiKey, WebhookEndpoint } from '@/types/dto';
import { tokens } from '@/theme/tokens';
import IntegrationsApiKeys from './IntegrationsApiKeys';
import IntegrationsWebhooks from './IntegrationsWebhooks';

const { Text: AntText, Title } = Typography;

export default function Integrations(): JSX.Element {
  const apiKeysState = useApi<ApiKey[]>('/api-keys');
  const webhooksState = useApi<WebhookEndpoint[]>('/webhooks');

  // Per-section "open modal" ticks so the page header can drive both
  // modals from outside (the modals themselves live in the subcomponents
  // because they own the form state).
  const [createKeyTick, setCreateKeyTick] = useState<number>(0);
  const [createWebhookTick, setCreateWebhookTick] = useState<number>(0);

  const apiKeys = apiKeysState.data ?? [];
  const webhooks = webhooksState.data ?? [];

  const anyLoading =
    (apiKeysState.loading && apiKeys.length === 0) ||
    (webhooksState.loading && webhooks.length === 0);
  const anyError = apiKeysState.error ?? webhooksState.error;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space[5] }}>
      <header>
        <Title
          level={2}
          style={{ margin: 0, color: tokens.color.text, fontWeight: 600, letterSpacing: '-0.01em' }}
        >
          集成
        </Title>
        <AntText style={{ color: tokens.color.textMuted, fontSize: 13 }}>
          管理 API Key 与 Webhook 端点 · API Key {apiKeys.length} 个 · Webhook {webhooks.length} 个
        </AntText>
      </header>

      {/* === API Keys section === */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: tokens.space[3] }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <Title level={4} style={{ margin: 0, color: tokens.color.text, fontWeight: 600 }}>
            API Key
          </Title>
          <Space size={4}>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => setCreateKeyTick((n) => n + 1)}
              aria-label="新建 API Key"
            >
              新建 API Key
            </Button>
          </Space>
        </div>
        <IntegrationsApiKeys
          apiKeys={apiKeys}
          loading={apiKeysState.loading}
          error={apiKeysState.error}
          onReload={() => apiKeysState.reload()}
          createTick={createKeyTick}
        />
      </section>

      {/* === Webhooks section === */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: tokens.space[3] }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <Title level={4} style={{ margin: 0, color: tokens.color.text, fontWeight: 600 }}>
            Webhook
          </Title>
          <Space size={4}>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => setCreateWebhookTick((n) => n + 1)}
              aria-label="新建 Webhook"
            >
              新建 Webhook
            </Button>
          </Space>
        </div>
        <IntegrationsWebhooks
          endpoints={webhooks}
          loading={webhooksState.loading}
          error={webhooksState.error}
          onReload={() => webhooksState.reload()}
          createTick={createWebhookTick}
        />
      </section>

      {/* Combined first-load skeleton — only when we have zero data on
          both sides and the user is waiting for the very first paint. */}
      {anyLoading && !anyError ? (
        <Skeleton
          active
          paragraph={{ rows: 4 }}
          style={{ marginTop: tokens.space[3] }}
          aria-label="正在加载集成数据"
        />
      ) : null}
    </div>
  );
}
