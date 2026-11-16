/**
 * ComfyUI 节点 — 本平台上的 ComfyUI 安装清单。
 *
 * 一台 ComfyUI 装了 DAM 节点包之后，会带着自己的 API Key 敲
 * `/api/ingest/v1/nodes/register`，把自己登记在这里。平台不发放节点，
 * 也不撤销节点 —— 它只是被节点认领的一行记录，所以这一页是只读的。
 *
 * 每一次登记都会刷新「最后一次开口」，于是「在线」不是一个写死的标记，
 * 而是「多久没说话」算出来的结果：超过 15 分钟没开口就算离线。
 *
 * 页面上只说平台知道的事：名字、版本、最后心跳、状态。平台不知道节点在
 * 跑什么工作流，也不替节点保管它的密钥。
 */

import {
  Button,
  Space,
  Typography,
} from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useApi } from '@/api/hooks';
import {
  PageHeader,
  Panel,
  Pill,
  StateBlock,
  resolveDataStatus,
} from '@/components/ui';
import type { ComfyNode } from '@/types';
import { tokens } from '@/theme/tokens';
import { formatDate, relativeTime } from '@/utils/format';

const { Text } = Typography;

const NODE_BADGE_STYLE: React.CSSProperties = {
  width: 36,
  height: 36,
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: tokens.color.comfyui,
  color: tokens.color.bg,
  fontFamily: tokens.font.mono,
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: '0.05em',
  borderRadius: tokens.radius.sm,
};

const ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: tokens.space[4],
  padding: `${tokens.space[3]}px ${tokens.space[4]}px`,
  background: tokens.color.panel,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.md,
  minHeight: 60,
};

/**
 * One node, one row.
 *
 * The facts are laid out so that the answer to "is it alive?" can be read
 * without reading anything else: the pill on the right says it, and the
 * heartbeat under the name says why.
 */
function NodeRow({ node }: { node: ComfyNode }): JSX.Element {
  const online = node.status === 'online';
  return (
    <div style={ROW_STYLE}>
      <div aria-hidden style={NODE_BADGE_STYLE}>NODE</div>

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <Space size={6} align="center" wrap>
          <Text strong style={{ color: tokens.color.text, fontSize: 14 }}>
            {node.name}
          </Text>
          <span
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 12,
              color: tokens.color.textMuted,
              background: tokens.color.bgAlt,
              border: `1px solid ${tokens.color.border}`,
              padding: '1px 6px',
              borderRadius: tokens.radius.sm,
              maxWidth: 280,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={node.node_key}
          >
            {node.node_key}
          </span>
        </Space>
        <Text style={{ color: tokens.color.textMuted, fontSize: 12 }}>
          {node.last_seen_at
            ? `最后开口 ${relativeTime(node.last_seen_at)}（${formatDate(node.last_seen_at)}）`
            : '从未开口'}
          {node.version ? ` · 节点包 ${node.version}` : ''}
          {node.comfyui_version ? ` · ComfyUI ${node.comfyui_version}` : ''}
          {node.platform ? ` · ${node.platform}` : ''}
        </Text>
      </div>

      <Space size="small" align="center">
        <Pill value={online ? '在线' : '离线'} tone={online ? 'success' : 'neutral'} />
      </Space>
    </div>
  );
}

export default function ComfyNodes(): JSX.Element {
  const nodesState = useApi<ComfyNode[]>('/comfy-nodes');
  const nodes = nodesState.data ?? [];

  /**
   * Exactly one of the four result states is rendered — the error first, so a
   * failed request never leaves the skeleton on screen.
   */
  const listStatus = resolveDataStatus({
    loading: nodesState.loading,
    error: nodesState.error,
    hasData: nodesState.data !== undefined,
    isEmpty: nodes.length === 0,
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space[5] }}>
      <PageHeader
        title="ComfyUI 节点"
        subtitle={
          nodesState.loading || nodesState.error
            ? '正在读取已接入的 ComfyUI 安装'
            : `已接入本租户的 ComfyUI 安装 · 共 ${nodes.length} 台`
        }
        extra={
          <Button
            icon={<ReloadOutlined />}
            loading={nodesState.loading}
            onClick={() => void nodesState.reload()}
          >
            刷新
          </Button>
        }
      />

      <Panel tone="sunken">
        <Text style={{ color: tokens.color.textMuted, fontSize: 12, lineHeight: 1.7 }}>
          节点自己登记：把 DAM 节点包装进 ComfyUI 的 <code>custom_nodes/</code>，
          在「DAM 接入」节点里填上本平台地址和一个带 upload 权限的 API Key，
          节点就会把自己登记到这里。平台不发放节点，也不保存节点的密钥 ——
          这一页只显示节点报上来的名字、版本和心跳。
        </Text>
      </Panel>

      <section>
        {listStatus === 'loading' && (
          <Panel>
            <StateBlock status="loading" rows={4} />
          </Panel>
        )}

        {listStatus === 'error' && (
          <StateBlock
            status="error"
            title="节点列表加载失败"
            error={nodesState.error}
            errorFallback="无法加载 ComfyUI 节点"
            onRetry={() => void nodesState.reload()}
          />
        )}

        {listStatus === 'empty' && (
          <Panel>
            <StateBlock
              status="empty"
              title="还没有 ComfyUI 接入"
              description="节点自己来登记：装好节点包，跑一次「DAM 接入」，它就会出现在这里。"
            />
          </Panel>
        )}

        {listStatus === 'ready' && (
          <Space direction="vertical" size="small" style={{ width: '100%' }}>
            {nodes.map((node) => (
              <NodeRow key={node.id} node={node} />
            ))}
          </Space>
        )}
      </section>
    </div>
  );
}
