import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Input, Select, Table, Typography } from 'antd';
import { ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { platformApi } from '@/api/platform';
import { tenantsApi } from '@/api/tenants';
import { PageHeader, Panel, Pill, StateBlock } from '@/components/ui';
import { tokens } from '@/theme/tokens';
import { formatDate } from '@/utils/format';
import { toError } from '@/utils/errors';
import type {
  PlatformRequest,
  PlatformTrafficBucket,
  PlatformTrafficReport,
  Tenant,
} from '@/types';

const { Text } = Typography;

/** The windows the traffic report can cover. */
const WINDOWS: { value: number; label: string }[] = [
  { value: 1, label: '最近 1 小时' },
  { value: 24, label: '最近 24 小时' },
  { value: 168, label: '最近 7 天' },
  { value: 720, label: '最近 30 天' },
];

/** The status classes the log can be narrowed to. */
const STATUS_CLASSES: { value: string; label: string }[] = [
  { value: '', label: '全部状态' },
  { value: '2xx', label: '成功 2xx' },
  { value: '4xx', label: '客户端 4xx' },
  { value: '5xx', label: '服务端 5xx' },
];

/**
 * Bytes in the unit a person reads them in.
 */
function bytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

/**
 * How a status reads at a glance.
 */
function statusTone(status: number): 'success' | 'danger' | 'neutral' {
  if (status >= 400) return 'danger';
  if (status >= 200 && status < 300) return 'success';
  return 'neutral';
}

/**
 * One number on the traffic ledger.
 */
function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}): JSX.Element {
  return (
    <div
      style={{
        padding: tokens.space[4],
        borderRadius: tokens.radius.md,
        border: `1px solid ${tokens.color.border}`,
        background: tokens.color.surfaceSunken,
      }}
    >
      <Text
        style={{
          display: 'block',
          color: tokens.color.textMuted,
          fontSize: tokens.fontSize.sm,
          marginBottom: tokens.space[2],
        }}
      >
        {label}
      </Text>
      <div
        style={{
          color: tokens.color.text,
          fontSize: tokens.fontSize['2xl'],
          fontWeight: tokens.fontWeight.bold,
          lineHeight: 1.1,
          fontFamily: tokens.font.mono,
        }}
      >
        {value}
      </div>
      {hint ? (
        <Text
          style={{
            display: 'block',
            marginTop: tokens.space[2],
            color: tokens.color.textMuted,
            fontSize: tokens.fontSize.xs,
          }}
        >
          {hint}
        </Text>
      ) : null}
    </div>
  );
}

/**
 * The traffic over time: what came in and what went out, hour by hour.
 *
 * Two bars per hour — the bytes that arrived and the bytes that left. The
 * scale is the busiest hour in the window, so the shape of the day is what
 * the eye gets; the numbers are in the table below.
 */
function TrafficChart({ buckets }: { buckets: PlatformTrafficBucket[] }): JSX.Element {
  const peak = Math.max(
    1,
    ...buckets.map((bucket) => Math.max(bucket.bytes_in, bucket.bytes_out)),
  );
  const labelEvery = Math.max(1, Math.ceil(buckets.length / 8));

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: 2,
          height: 140,
          paddingBottom: tokens.space[2],
          borderBottom: `1px solid ${tokens.color.border}`,
        }}
      >
        {buckets.map((bucket) => (
          <div
            key={bucket.bucket}
            title={`${bucket.bucket} · 进 ${bytes(bucket.bytes_in)} · 出 ${bytes(
              bucket.bytes_out,
            )} · ${bucket.requests} 次请求`}
            style={{
              flex: 1,
              height: '100%',
              display: 'flex',
              alignItems: 'flex-end',
              gap: 1,
              minWidth: 2,
            }}
          >
            <div
              style={{
                width: '50%',
                height: `${Math.round((bucket.bytes_in / peak) * 100)}%`,
                background: tokens.color.accent,
                borderRadius: `${tokens.radius.sm} ${tokens.radius.sm} 0 0`,
                minHeight: bucket.bytes_in > 0 ? 2 : 0,
              }}
            />
            <div
              style={{
                width: '50%',
                height: `${Math.round((bucket.bytes_out / peak) * 100)}%`,
                background: tokens.color.success,
                borderRadius: `${tokens.radius.sm} ${tokens.radius.sm} 0 0`,
                minHeight: bucket.bytes_out > 0 ? 2 : 0,
              }}
            />
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 2, marginTop: tokens.space[2] }}>
        {buckets.map((bucket, index) => (
          <div
            key={bucket.bucket}
            style={{
              flex: 1,
              minWidth: 2,
              fontSize: tokens.fontSize.xs,
              color: tokens.color.textMuted,
              fontFamily: tokens.font.mono,
              textAlign: 'center',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
            }}
          >
            {index % labelEvery === 0 ? bucket.bucket.slice(11, 16) : ''}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: tokens.space[4], marginTop: tokens.space[3] }}>
        <span style={{ color: tokens.color.textMuted, fontSize: tokens.fontSize.xs }}>
          <span
            style={{
              display: 'inline-block',
              width: 8,
              height: 8,
              borderRadius: 2,
              background: tokens.color.accent,
              marginRight: 6,
            }}
          />
          进来
        </span>
        <span style={{ color: tokens.color.textMuted, fontSize: tokens.fontSize.xs }}>
          <span
            style={{
              display: 'inline-block',
              width: 8,
              height: 8,
              borderRadius: 2,
              background: tokens.color.success,
              marginRight: 6,
            }}
          />
          出去
        </span>
      </div>
    </div>
  );
}

/**
 * The platform's traffic.
 *
 * Two things, asked of the same record: what the instance was asked to do
 * (the counters and the curve), and what it was asked, one call at a time (the
 * log).
 *
 * The record is the request log — one row per API call, with the bytes that
 * came in and went out. It is not the audit trail: that says what a person
 * changed, this says what the instance was asked to do.
 */
export default function Requests(): JSX.Element {
  const [hours, setHours] = useState(24);
  const [tenantId, setTenantId] = useState('');
  const [keyword, setKeyword] = useState('');
  const [statusClass, setStatusClass] = useState('');

  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [report, setReport] = useState<PlatformTrafficReport | null>(null);
  const [rows, setRows] = useState<PlatformRequest[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | undefined>();

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const [traffic, log] = await Promise.all([
        platformApi.traffic({ tenantId: tenantId || undefined, hours }),
        platformApi.requests({
          tenantId: tenantId || undefined,
          keyword: keyword || undefined,
          statusClass: statusClass || undefined,
          hours,
          limit: 100,
        }),
      ]);
      setReport(traffic);
      setRows(log.items);
      setTotal(log.total);
      setError(undefined);
    } catch (e: unknown) {
      setError(toError(e, '加载调用日志失败'));
      setReport(null);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [hours, tenantId, keyword, statusClass]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void (async () => {
      try {
        const response = await tenantsApi.list();
        setTenants(response.items);
      } catch {
        // The tenant list is only needed for the picker; the log itself still
        // works without it.
      }
    })();
  }, []);

  const tenantName = useMemo(() => {
    const names = new Map(tenants.map((tenant) => [tenant.id, tenant.name]));
    return (id: string): string => {
      if (id === '*') return '平台';
      return names.get(id) ?? id;
    };
  }, [tenants]);

  const summary = report?.summary;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space[5] }}>
      <PageHeader
        title="调用日志"
        subtitle={`整个平台的进出流量 · 共 ${total} 次调用`}
        extra={
          <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
            刷新
          </Button>
        }
      />

      <div style={{ display: 'flex', gap: tokens.space[3], flexWrap: 'wrap' }}>
        <Select
          value={hours}
          onChange={setHours}
          style={{ width: 150 }}
          options={WINDOWS}
          aria-label="时间窗口"
        />
        <Select
          value={tenantId}
          onChange={setTenantId}
          style={{ width: 190 }}
          aria-label="租户"
          options={[
            { value: '', label: '全部租户' },
            ...tenants.map((tenant) => ({ value: tenant.id, label: tenant.name })),
          ]}
        />
        <Select
          value={statusClass}
          onChange={setStatusClass}
          style={{ width: 150 }}
          options={STATUS_CLASSES}
          aria-label="状态"
        />
        <Input
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="路径里包含…"
          prefix={<SearchOutlined />}
          allowClear
          style={{ width: 220 }}
          aria-label="按路径搜索"
        />
      </div>

      {error && !loading ? (
        <StateBlock
          status="error"
          title="调用日志加载失败"
          error={error}
          errorFallback="无法加载调用日志"
          onRetry={() => void load()}
        />
      ) : (
        <>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
              gap: tokens.space[3],
            }}
          >
            <Stat
              label="请求"
              value={summary ? String(summary.requests) : '—'}
              hint={summary ? `平均 ${summary.avg_duration_ms} ms` : undefined}
            />
            <Stat
              label="进来"
              value={summary ? bytes(summary.bytes_in) : '—'}
              hint="请求体带进来的字节"
            />
            <Stat
              label="出去"
              value={summary ? bytes(summary.bytes_out) : '—'}
              hint="应答带出去的字节"
            />
            <Stat
              label="错误"
              value={summary ? String(summary.errors) : '—'}
              hint={
                summary
                  ? `错误率 ${(summary.error_rate * 100).toFixed(1)}% · 其中 ${summary.server_errors} 个服务端错误`
                  : undefined
              }
            />
          </div>

          <Panel title="进出流量">
            {report && report.buckets.length > 0 ? (
              <TrafficChart buckets={report.buckets} />
            ) : (
              <Text style={{ color: tokens.color.textMuted }}>这个窗口里还没有调用记录。</Text>
            )}
          </Panel>

          {report && report.routes.length > 0 ? (
            <Panel title="流量最重的接口">
              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space[2] }}>
                {report.routes.map((route) => (
                  <div
                    key={route.route || '(未匹配)'}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: tokens.space[3],
                      fontSize: tokens.fontSize.sm,
                    }}
                  >
                    <span
                      style={{
                        fontFamily: tokens.font.mono,
                        color: tokens.color.text,
                        minWidth: 220,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {route.route || '(未匹配)'}
                    </span>
                    <Text style={{ color: tokens.color.textMuted }}>
                      {route.requests} 次 · 出 {bytes(route.bytes_out)} · 平均 {route.avg_duration_ms} ms
                    </Text>
                  </div>
                ))}
              </div>
            </Panel>
          ) : null}

          <Panel flush>
            <Table<PlatformRequest>
              rowKey="id"
              dataSource={rows}
              loading={loading}
              size="small"
              scroll={{ x: 900 }}
              locale={{ emptyText: '这个窗口里还没有调用记录' }}
              columns={[
                {
                  title: '时间',
                  dataIndex: 'created_at',
                  width: 150,
                  render: (value: string) => (
                    <Text
                      style={{
                        color: tokens.color.textMuted,
                        fontSize: tokens.fontSize.sm,
                        fontFamily: tokens.font.mono,
                      }}
                    >
                      {formatDate(value)}
                    </Text>
                  ),
                },
                {
                  title: '方法',
                  dataIndex: 'method',
                  width: 80,
                  render: (value: string) => (
                    <Pill value={value} tone="info" mono />
                  ),
                },
                {
                  title: '路径',
                  dataIndex: 'path',
                  render: (value: string, row) => (
                    <span
                      title={row.route || value}
                      style={{
                        fontFamily: tokens.font.mono,
                        fontSize: tokens.fontSize.sm,
                        color: tokens.color.text,
                      }}
                    >
                      {value}
                    </span>
                  ),
                },
                {
                  title: '状态',
                  dataIndex: 'status',
                  width: 80,
                  render: (value: number) => <Pill value={value} tone={statusTone(value)} mono />,
                },
                {
                  title: '耗时',
                  dataIndex: 'duration_ms',
                  width: 90,
                  render: (value: number) => (
                    <Text
                      style={{
                        color: tokens.color.textMuted,
                        fontSize: tokens.fontSize.sm,
                        fontFamily: tokens.font.mono,
                      }}
                    >
                      {Math.round(value)} ms
                    </Text>
                  ),
                },
                {
                  title: '租户',
                  dataIndex: 'tenant_id',
                  width: 120,
                  render: (value: string) => (
                    <Text style={{ color: tokens.color.textMuted, fontSize: tokens.fontSize.sm }}>
                      {tenantName(value)}
                    </Text>
                  ),
                },
                {
                  title: '调用人',
                  dataIndex: 'username',
                  width: 120,
                  render: (value: string | null) => (
                    <Text style={{ color: tokens.color.textMuted, fontSize: tokens.fontSize.sm }}>
                      {value ?? '（无凭证）'}
                    </Text>
                  ),
                },
                {
                  title: '进 / 出',
                  width: 150,
                  render: (_value, row) => (
                    <Text
                      style={{
                        color: tokens.color.textMuted,
                        fontSize: tokens.fontSize.sm,
                        fontFamily: tokens.font.mono,
                      }}
                    >
                      {bytes(row.bytes_in)} / {bytes(row.bytes_out)}
                    </Text>
                  ),
                },
              ]}
            />
          </Panel>
        </>
      )}
    </div>
  );
}
