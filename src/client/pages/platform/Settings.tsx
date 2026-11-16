import { useCallback, useEffect, useState } from 'react';
import { App, Button, Form, Input, Select, Space, Typography } from 'antd';
import { GlobalOutlined, LinkOutlined, SaveOutlined } from '@ant-design/icons';
import { platformApi } from '@/api/platform';
import { PageHeader, Panel, StateBlock } from '@/components/ui';
import { tokens } from '@/theme/tokens';
import { describeError } from '@/utils/errors';

/**
 * 平台设置 — 实例自己的地址与跨域白名单。
 *
 * 访问域名不是装饰：服务端生成的绝对链接（下载链接、MCP 客户端要填的地址）
 * 都从它来，界面上的「API 基础地址」也是它。以前它是环境变量里的
 * `APP_BASE_URL`，改一次要重启一次；现在是这里的一个字段，保存即生效。
 *
 * 跨域白名单同理。它说的是「谁可以调用这个实例」——默认是没有人，界面和
 * 实例自己同源，不需要跨域。访问域名本身永远在允许之列：界面就是从那里
 * 来的，它当然能调用自己。
 */

const { Text } = Typography;

const LABEL_STYLE = {
  color: tokens.color.textMuted,
  fontSize: tokens.fontSize.sm,
} as const;

export default function Settings(): JSX.Element {
  const [form] = Form.useForm<{ access_domain: string; cors_origins: string[] }>();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<Error | undefined>();
  const { message } = App.useApp();

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const settings = await platformApi.settings();
      form.setFieldsValue({
        access_domain: settings.access_domain,
        cors_origins: settings.cors_origins,
      });
      setError(undefined);
    } catch (e: unknown) {
      setError(new Error(describeError(e, '读取平台设置失败')));
    } finally {
      setLoading(false);
    }
  }, [form]);

  useEffect(() => {
    void load();
  }, [load]);

  const onFinish = async (values: { access_domain: string; cors_origins: string[] }): Promise<void> => {
    setSaving(true);
    try {
      const saved = await platformApi.saveSettings({
        access_domain: (values.access_domain ?? '').trim(),
        cors_origins: values.cors_origins ?? [],
      });
      form.setFieldsValue({
        access_domain: saved.access_domain,
        cors_origins: saved.cors_origins,
      });
      message.success('已保存，立即生效');
    } catch (e: unknown) {
      message.error(describeError(e, '保存平台设置失败'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space[5] }}>
      <PageHeader
        title="设置"
        subtitle="这个实例对外的地址，以及谁可以从浏览器里调用它。改完立即生效，不用重启"
        extra={
          <Button icon={<SaveOutlined />} loading={saving} onClick={() => void form.submit()}>
            保存
          </Button>
        }
      />

      {error && !loading ? (
        <StateBlock
          status="error"
          title="平台设置加载失败"
          error={error}
          errorFallback="无法读取平台设置"
          onRetry={() => void load()}
        />
      ) : (
        <Form form={form} layout="vertical" onFinish={(v) => void onFinish(v)} disabled={loading}>
          <Panel
            title={
              <Space size="small" align="center">
                <GlobalOutlined style={{ color: tokens.color.accent }} />
                <span style={{ color: tokens.color.text }}>访问域名</span>
              </Space>
            }
          >
            <Form.Item
              name="access_domain"
              label={<span style={LABEL_STYLE}>对外地址</span>}
              extra={
                <span style={{ color: tokens.color.textMuted, fontSize: tokens.fontSize.xs }}>
                  这个实例被访问的地址。下载链接、MCP 客户端要填的地址、界面上的「API
                  基础地址」都从它来。留空则按当前请求推导 —— 链接只在发起请求的浏览器里能用
                </span>
              }
            >
              <Input
                prefix={<LinkOutlined style={{ color: tokens.color.textMuted }} />}
                placeholder="https://dam.example.com"
                aria-label="对外地址"
                allowClear
              />
            </Form.Item>
          </Panel>

          <div style={{ height: tokens.space[5] }} />

          <Panel
            title={
              <Space size="small" align="center">
                <LinkOutlined style={{ color: tokens.color.accent }} />
                <span style={{ color: tokens.color.text }}>允许的跨域来源</span>
              </Space>
            }
          >
            <Form.Item
              name="cors_origins"
              label={<span style={LABEL_STYLE}>来源</span>}
              extra={
                <span style={{ color: tokens.color.textMuted, fontSize: tokens.fontSize.xs }}>
                  这些来源的页面可以用浏览器直接调用这个实例的接口。访问域名本身永远在允许之列。
                  留空表示只有同源能调用 —— 这是默认，也是最安全的
                </span>
              }
            >
              <Select
                mode="tags"
                allowClear
                placeholder="输入来源后回车，例如 https://console.example.com"
                aria-label="允许的跨域来源"
                tokenSeparators={[',', '，', ' ']}
                open={false}
                suffixIcon={null}
                style={{ width: '100%' }}
              />
            </Form.Item>
          </Panel>

          <div style={{ height: tokens.space[5] }} />

          <Panel>
            <Text style={{ color: tokens.color.textMuted, fontSize: tokens.fontSize.sm }}>
              这两项以前在环境变量里（APP_BASE_URL / CORS_ORIGINS），改一次要重启一次。
              现在它们在这里，改完立即生效。
            </Text>
          </Panel>
        </Form>
      )}
    </div>
  );
}
