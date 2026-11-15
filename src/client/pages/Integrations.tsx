/**
 * Integrations — API Key + Webhook management (Task 17).
 *
 * Single-page workspace merging the legacy ApiKeys + Webhook UIs.
 *
 *   - Top section: API keys (list / create / revoke / copy masked).
 *     POST /api-keys returns the raw key exactly once; the UI surfaces
 *     it inside the post-create modal with copy + acknowledge.
 *   - Bottom section: Webhook endpoints (list / create / edit / toggle).
 *     The backend exposes GET/POST/PUT/DELETE on /webhooks. DELETE is a
 *     soft-disable (is_active=0); PUT can edit the name, the URL and the
 *     event subscription, and can re-enable a disabled endpoint.
 *     POST /webhooks returns the signing secret exactly once.
 *
 * Both sections are pure subcomponents (`IntegrationsApiKeys`,
 * `IntegrationsWebhooks`) so this orchestrator file stays under the 500-line
 * cap and each section is independently readable. Data fetching goes
 * through `useApi`; mutations go through the per-resource API modules
 * (`@/api/apikeys`, `@/api/webhooks`).
 *
 * The create modals live inside the sections (they own the form state), so
 * this page keeps the single source of truth for *which* modal is open and
 * drives it with a controlled flag — a tick counter used to be shared
 * between the two components, which made the contract implicit.
 */

import { useState } from 'react';
import { useApi } from '@/api/hooks';
import { PageHeader, resolveDataStatus } from '@/components/ui';
import type { ApiKey, WebhookEndpoint } from '@/types';
import { tokens } from '@/theme/tokens';
import IntegrationsApiKeys from './IntegrationsApiKeys';
import IntegrationsWebhooks from './IntegrationsWebhooks';

/** Which section owns the "create" modal. */
type CreateKind = 'apikey' | 'webhook';

/**
 * The header shows the row counts — while the request is in flight (or
 * failed) the real number is unknown, so it shows a placeholder instead of
 * a misleading `0`.
 */
function countText(status: 'loading' | 'empty' | 'error' | 'ready', count: number): string {
  return status === 'loading' || status === 'error' ? '…' : String(count);
}

export default function Integrations(): JSX.Element {
  const apiKeysState = useApi<ApiKey[]>('/api-keys');
  const webhooksState = useApi<WebhookEndpoint[]>('/webhooks');

  /**
   * The two sections own their create modals, so the page only decides
   * which one is open and hands the answer down as a controlled flag.
   */
  const [createKind, setCreateKind] = useState<CreateKind | null>(null);

  const apiKeys = apiKeysState.data ?? [];
  const webhooks = webhooksState.data ?? [];

  const apiKeysStatus = resolveDataStatus({
    loading: apiKeysState.loading,
    error: apiKeysState.error,
    hasData: apiKeysState.data !== undefined,
    isEmpty: apiKeys.length === 0,
  });

  const webhooksStatus = resolveDataStatus({
    loading: webhooksState.loading,
    error: webhooksState.error,
    hasData: webhooksState.data !== undefined,
    isEmpty: webhooks.length === 0,
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space[5] }}>
      <PageHeader
        title="集成"
        subtitle={`管理 API Key 与 Webhook 端点 · API Key ${countText(apiKeysStatus, apiKeys.length)} 个 · Webhook ${countText(webhooksStatus, webhooks.length)} 个`}
      />

      {/* === API Keys section === */}
      <IntegrationsApiKeys
        apiKeys={apiKeys}
        status={apiKeysStatus}
        error={apiKeysState.error}
        onReload={() => apiKeysState.reload()}
        createOpen={createKind === 'apikey'}
        onCreateRequest={() => setCreateKind('apikey')}
        onCreateClose={() => setCreateKind(null)}
      />

      {/* === Webhooks section === */}
      <IntegrationsWebhooks
        endpoints={webhooks}
        status={webhooksStatus}
        error={webhooksState.error}
        onReload={() => webhooksState.reload()}
        createOpen={createKind === 'webhook'}
        onCreateRequest={() => setCreateKind('webhook')}
        onCreateClose={() => setCreateKind(null)}
      />
    </div>
  );
}
