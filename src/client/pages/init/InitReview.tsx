/**
 * Setup wizard — page three: review, seed and restart.
 *
 * The last page shows exactly what is about to be written — the `.env` the
 * backend renders, secrets masked — and what the seed step will create. The
 * confirm button is the only place that writes the signing key, so an
 * operator can step back without leaving a half-initialized instance.
 *
 * The API key is shown once, on this page, after the seed runs: it is the
 * only time the plaintext exists.
 */
import { useEffect, useState } from 'react';
import { Alert, Button, Card, Descriptions, Space, Spin, Typography } from 'antd';
import { CheckCircleOutlined, SafetyOutlined } from '@ant-design/icons';
import { describeInitError, initApi } from './initApi';
import type { AdminInput, DatabaseInput, SeedResult } from './initApi';

const { Paragraph, Text, Title } = Typography;

interface InitReviewProps {
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

export default function InitReview({
  database,
  admin,
  onBack,
  onFinished,
}: InitReviewProps): JSX.Element {  const [preview, setPreview] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seed, setSeed] = useState<SeedResult | null>(null);
  const [restarting, setRestarting] = useState(false);

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

  const onRestart = async (): Promise<void> => {
    setRestarting(true);
    try {
      await initApi.restart();
    } catch (err) {
      // The process exiting during the request is the expected outcome, so a
      // failure here usually means it already went away — the reload below is
      // the real check either way.
      console.warn('restart request failed:', describeInitError(err));
    }
    // Give the process a moment, then let the app decide where to go.
    window.setTimeout(onFinished, 1500);
  };

  return (
    <div>
      <Title level={3} style={{ marginBottom: 4 }}>
        <SafetyOutlined style={{ marginRight: 8 }} />
        确认并写入
      </Title>
      <Text type="secondary">
        确认下面的内容后写入配置。写入完成会重启服务，之后就能进入系统。
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
          message="配置已写入"
          description={
            <div>
              <Paragraph style={{ marginBottom: 8 }}>
                JWT 密钥已写入 <code>.env</code>。
              </Paragraph>
              {seed.api_key ? (
                <Paragraph style={{ marginBottom: 0 }}>
                  <Text strong>API Key（只显示这一次）：</Text>
                  <br />
                  <Text code copyable>
                    {seed.api_key}
                  </Text>
                </Paragraph>
              ) : (
                <Paragraph style={{ marginBottom: 0 }}>该租户已有 API Key，未生成新的。</Paragraph>
              )}
            </div>
          }
        />
      ) : null}

      <Space style={{ marginTop: 24 }}>
        <Button onClick={onBack} size="large" disabled={loading || restarting}>
          上一步
        </Button>
        {seed === null ? (
          <Button type="primary" size="large" loading={loading} onClick={onConfirm}>
            写入配置并生成密钥
          </Button>
        ) : (
          <Button type="primary" size="large" loading={restarting} onClick={onRestart}>
            重启并进入系统
          </Button>
        )}
      </Space>
    </div>
  );
}
