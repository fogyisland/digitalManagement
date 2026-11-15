import { useMemo } from 'react';
import { Button, Space } from 'antd';
import { CopyOutlined } from '@ant-design/icons';
import { Panel, Pill } from '@/components/ui';
import type { Asset } from '@/types';
import { tokens } from '@/theme/tokens';
import { formatBytes, formatDate } from '@/utils/format';
import { statusColor, statusLabel, statusTone } from '@/utils/assetStatus';

export interface AssetSidebarProps {
  asset: Asset;
  /** Readable category name — the asset row only carries `category_id`. */
  categoryName: string | null;
  onCopy: (text: string, label: string) => Promise<void>;
}

interface MetadataJson {
  [key: string]: unknown;
}

/**
 * Backend stores ComfyUI's structured payload in `metadata_json` as a
 * JSON-encoded TEXT column. Returns null on absent / empty / invalid
 * input so the caller can render a "no metadata" hint instead of a
 * raw blob.
 */
function parseMetadata(raw: string | null | undefined): MetadataJson | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as MetadataJson;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The right-hand column of the asset detail page.
 *
 * It lives in its own file because the page was over the repo's 500-line
 * cap, and because everything in here — the facts list, the description,
 * the category/tag chips and the ComfyUI metadata block — is a read-only
 * view of one asset: no state of its own beyond the parsed metadata.
 */
export default function AssetSidebar({
  asset,
  categoryName,
  onCopy,
}: AssetSidebarProps): JSX.Element {
  const metadata: MetadataJson | null = useMemo(
    () => parseMetadata(asset.metadata_json),
    [asset.metadata_json],
  );

  const metaPairs: { key: string; label: string; value: string }[] = [];
  if (asset.prompt) metaPairs.push({ key: 'prompt', label: 'prompt', value: asset.prompt });
  if (asset.seed != null) metaPairs.push({ key: 'seed', label: 'seed', value: String(asset.seed) });
  if (asset.model_name) metaPairs.push({ key: 'model', label: 'model_name', value: asset.model_name });
  if (asset.job_id) metaPairs.push({ key: 'job', label: 'job_id', value: asset.job_id });
  if (asset.source_tool) metaPairs.push({ key: 'tool', label: 'source_tool', value: asset.source_tool });

  const tags: string[] = asset.tag_names ?? [];

  return (
    <aside style={{ display: 'flex', flexDirection: 'column', gap: tokens.space[4] }}>
      {/* Status / facts — the page's one memorable beat uses the accent
          rule on the leading edge. */}
      <Panel as="section" accent>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: tokens.space[3],
            marginBottom: tokens.space[3],
          }}
        >
          <span
            style={{
              display: 'inline-block',
              width: 8,
              height: 8,
              borderRadius: 4,
              background: statusColor(asset.status),
            }}
            aria-hidden
          />
          <Pill value={statusLabel(asset.status)} tone={statusTone(asset.status)} />
          <span style={{ color: tokens.color.textMuted, fontSize: tokens.fontSize.sm }}>
            · {formatDate(asset.created_at)}
          </span>
        </div>

        <dl
          style={{
            margin: 0,
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            columnGap: tokens.space[3],
            rowGap: tokens.space[2],
            fontSize: tokens.fontSize.base,
          }}
        >
          <dt style={{ color: tokens.color.textMuted }}>格式</dt>
          <dd style={{ margin: 0, color: tokens.color.text }}>
            {asset.mime_type || '—'}
          </dd>
          <dt style={{ color: tokens.color.textMuted }}>体积</dt>
          <dd style={{ margin: 0, color: tokens.color.text }}>
            {formatBytes(asset.file_size)}
          </dd>
          {asset.width != null && asset.height != null && (
            <>
              <dt style={{ color: tokens.color.textMuted }}>尺寸</dt>
              <dd style={{ margin: 0, color: tokens.color.text }}>
                {asset.width} × {asset.height}
              </dd>
            </>
          )}
          {asset.duration != null && asset.duration > 0 && (
            <>
              <dt style={{ color: tokens.color.textMuted }}>时长</dt>
              <dd style={{ margin: 0, color: tokens.color.text }}>
                {asset.duration.toFixed(2)}s
              </dd>
            </>
          )}
          <dt style={{ color: tokens.color.textMuted }}>来源</dt>
          <dd style={{ margin: 0, color: tokens.color.text }}>
            {asset.source_tool || asset.source || '—'}
          </dd>
        </dl>
      </Panel>

      {/* Description */}
      {asset.description && (
        <Panel as="section">
          <div
            style={{
              color: tokens.color.textMuted,
              fontSize: tokens.fontSize.sm,
              marginBottom: tokens.space[2],
            }}
          >
            描述
          </div>
          <div
            style={{
              color: tokens.color.text,
              fontSize: tokens.fontSize.base,
              lineHeight: 1.6,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {asset.description}
          </div>
        </Panel>
      )}

      {/* Category + tag chips */}
      {(categoryName || tags.length > 0) && (
        <Panel as="section">
          <div
            style={{
              color: tokens.color.textMuted,
              fontSize: tokens.fontSize.sm,
              marginBottom: tokens.space[3],
            }}
          >
            分类与标签
          </div>
          <Space size={tokens.space[2]} wrap>
            {categoryName && <Pill value={categoryName} tone="accent" />}
            {tags.map((tag) => (
              <Pill key={tag} value={tag} />
            ))}
          </Space>
        </Panel>
      )}

      {/* Metadata block — mono font, ComfyUI-shaped fields */}
      {(metaPairs.length > 0 || metadata) && (
        <Panel as="section">
          <div
            style={{
              color: tokens.color.textMuted,
              fontSize: tokens.fontSize.sm,
              marginBottom: tokens.space[3],
            }}
          >
            生成参数
          </div>
          {metaPairs.length > 0 && (
            <dl
              style={{
                margin: 0,
                display: 'grid',
                gridTemplateColumns: 'auto 1fr',
                columnGap: tokens.space[3],
                rowGap: tokens.space[2],
                fontFamily: tokens.font.mono,
                fontSize: tokens.fontSize.sm,
              }}
            >
              {metaPairs.map((p) => (
                <Pair
                  key={p.key}
                  label={p.label}
                  value={p.value}
                  copyable={p.key !== 'seed'}
                  onCopy={onCopy}
                />
              ))}
            </dl>
          )}
          {metadata && (
            <pre
              style={{
                margin: metaPairs.length > 0 ? `${tokens.space[3]}px 0 0 0` : 0,
                padding: tokens.space[3],
                background: tokens.color.bgAlt,
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.sm,
                color: tokens.color.text,
                fontFamily: tokens.font.mono,
                fontSize: tokens.fontSize.sm,
                lineHeight: 1.5,
                overflowX: 'auto',
                maxHeight: 240,
                whiteSpace: 'pre',
              }}
            >
              {JSON.stringify(metadata, null, 2)}
            </pre>
          )}
        </Panel>
      )}
    </aside>
  );
}

interface PairProps {
  label: string;
  value: string;
  copyable: boolean;
  onCopy: (text: string, label: string) => Promise<void>;
}

function Pair({ label, value, copyable, onCopy }: PairProps): JSX.Element {
  return (
    <>
      <dt style={{ color: tokens.color.textMuted }}>{label}</dt>
      <dd
        style={{
          margin: 0,
          color: tokens.color.text,
          display: 'flex',
          alignItems: 'center',
          gap: tokens.space[2],
          minWidth: 0,
        }}
      >
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
          }}
          title={value}
        >
          {value}
        </span>
        {copyable && (
          <Button
            size="small"
            type="text"
            icon={<CopyOutlined />}
            onClick={() => void onCopy(value, label)}
            aria-label={`复制 ${label}`}
          />
        )}
      </dd>
    </>
  );
}
