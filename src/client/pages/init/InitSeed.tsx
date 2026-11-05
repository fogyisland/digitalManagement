/**
 * Setup wizard — page three: the seed data.
 *
 * The last page shows exactly what is about to be written — the `.env` the
 * backend renders, secrets masked — and what the seed step creates: the
 * starter categories and tags, and nothing else. The confirm button is the
 * only place that writes the signing key, so an operator can step back
 * without leaving a half-initialized instance.
 *
 * Nothing here restarts the process: the backend hot-reloads the moment the
 * seed succeeds, and the operator walks straight into the application.
 *
 * No API key is created here either. Keys exist per external system, are
 * issued on the 集成 page, and are revoked when that system stops using one.
 */
import { useEffect, useState } from 'react';
import { Alert, Button, Card, Descriptions, Space, Spin, Tag, Typography } from 'antd';
import { CheckCircleOutlined, SafetyOutlined } from '@ant-design/icons';
import { describeInitError, initApi } from './initApi';
import type { AdminInput, DatabaseInput, SeedResult } from './initApi';

const { Paragraph, Text, Title } = Typography;

/**
 * What the seed step creates on the first boot.
 *
 * The list is fixed, so it lives here rather than on a route of its own: an
 * operator confirming the last page should see it, not fetch it.
 */
const SEEDED_CATEGORIES = ['产品图', '营销素材', 'AI 生成', '视频'];
const SEEDED_TAGS = ['封面', '海报', '人物', '风景', '抽象', '品牌', 'SVG', '动效'];

interface InitSeedProps {
  /**
   * The database values this session collected, or `null` when the wizard was
   * resumed onto this page — the step ran before the reload, and the values
   * only lived in the previous page's form.
   */
  database: DatabaseInput | null;
  /** The administrator values this session collected, or `null` when resumed. */
  admin: AdminInput | null;
  /** Go back to the administrator page. */
  onBack: () => void;
  /** The instance is configured; reload into the app. */
  onFinished: () => void;
}

export default function InitSeed({
  database,
  admin,
  onBack,
  onFinished,
}: InitSeedProps): JSX.Element {
  const [preview, setPreview] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seed, setSeed] = useState<SeedResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    initApi
      .envPreview()
      .then((response) => {
        if (!cancelled) setPreview(response.content);
      })
      .catch((err: unknown) => {
        if (!cancelled) setPreviewError(describeInitError(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onConfirm = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const result = await initApi.runSeed();
      setSeed(result);
    } catch (err) {
      setError(describeInitError(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <Title level={3} style={{ marginBottom: 4 }}>
        <SafetyOutlined style={{ marginRight: 8 }} />
        确认并写入
      </Title>
      <Text type="secondary">
        确认下面的内容后写入配置。写入完成立即生效，服务不会重启，之后就能进入系统。
      </Text>

      <Card size="small" title="将要创建的记录" style={{ marginTop: 16 }}>
        <Descriptions column={1} size="small">
          <Descriptions.Item label="数据库">
            {database
              ? `${database.user}@${database.host}:${database.port}/${database.database}`
              : <Text type="secondary">上一步已完成（本次会话未重新填写）</Text>}
          </Descriptions.Item>
          <Descriptions.Item label="租户">
            {admin ? admin.tenantName : <Text type="secondary">上一步已完成</Text>}
          </Descriptions.Item>
          <Descriptions.Item label="管理员">
            {admin ? (
              <>
                {admin.username}
                {admin.email ? `（${admin.email}）` : ''}
              </>
            ) : (
              <Text type="secondary">上一步已完成</Text>
            )}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      <Card size="small" title="将要生成的种子数据" style={{ marginTop: 16 }}>
        <Descriptions column={1} size="small">
          <Descriptions.Item label="分类">
            <Space size={[4, 4]} wrap>
              {SEEDED_CATEGORIES.map((name) => (
                <Tag key={name}>{name}</Tag>
              ))}
            </Space>
          </Descriptions.Item>
          <Descriptions.Item label="标签">
            <Space size={[4, 4]} wrap>
              {SEEDED_TAGS.map((name) => (
                <Tag key={name}>{name}</Tag>
              ))}
            </Space>
          </Descriptions.Item>
        </Descriptions>
        <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
          这一步不会创建 API Key。API Key 进入系统后在「集成」页申请，按外部系统各自一份，不再使用时撤销。
        </Paragraph>
      </Card>

      <Card size="small" title=".env 内容（敏感值已掩码）" style={{ marginTop: 16 }}>
        {preview === null && previewError === null ? <Spin /> : null}
        {previewError ? <Alert type="warning" showIcon message={previewError} /> : null}
        {preview !== null ? (
          <Paragraph>
            <pre
              style={{
                margin: 0,
                padding: 12,
                borderRadius: 6,
                background: 'rgba(0, 0, 0, 0.25)',
                fontSize: 12,
                lineHeight: 1.6,
                overflowX: 'auto',
                maxHeight: 260,
              }}
            >
              {preview}
            </pre>
          </Paragraph>
        ) : null}
      </Card>

      {error ? (
        <Alert
          type="error"
          showIcon
          style={{ marginTop: 16 }}
          message="写入失败"
          description={error}
        />
      ) : null}

      {seed ? (
        <Alert
          type="success"
          showIcon
          icon={<CheckCircleOutlined />}
          style={{ marginTop: 16 }}
          message="配置已写入，系统已就绪"
          description={
            <div>
              <Paragraph style={{ marginBottom: 8 }}>
                JWT 密钥已写入 <code>.env</code>，服务已热加载完成，不需要重启。
              </Paragraph>
              <Paragraph style={{ marginBottom: 0 }}>
                需要 API Key 时，进入系统后在「集成」页申请。
              </Paragraph>
            </div>
          }
        />
      ) : null}

      <Space style={{ marginTop: 24 }}>
        <Button onClick={onBack} size="large" disabled={loading}>
          上一步
        </Button>
        {seed === null ? (
          <Button type="primary" size="large" loading={loading} onClick={onConfirm}>
            写入配置并生成种子数据
          </Button>
        ) : (
          <Button type="primary" size="large" onClick={onFinished}>
            完成并进入系统
          </Button>
        )}
      </Space>
    </div>
  );
}
