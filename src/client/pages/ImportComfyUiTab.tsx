/**
 * ImportComfyUiTab — third tab of the Import page.
 *
 * Single `<Input>` accepting a ComfyUI job_id (string). Flow:
 *   1. GET /jobs/by-comfyui/:job_id
 *      - asset already registered → show a "前往" link that navigates
 *        to `/library/:id`.
 *      - 404 → no asset yet, proceed.
 *   2. POST /assets/from-comfyui/:job_id → registers the asset.
 *      - On success, navigate to `/library/:id`.
 *
 * Both routes are served by the backend
 * (`backend/src/routes/jobs.js` and `backend/src/routes/assets.js`).
 * `lookupComfyUiJob` already normalises the "not registered" 404 into
 * `null`, so the flow below only has to handle the happy path and real
 * failures.
 */

import { useState } from 'react';
import {
  App,
  Alert,
  Button,
  Form,
  Input,
  Space,
  Typography,
} from 'antd';
import { ExperimentOutlined, RightCircleOutlined } from '@ant-design/icons';
import { Link, useNavigate } from 'react-router-dom';
import {
  lookupComfyUiJob,
  registerAssetByComfyJob,
} from '@/api/assets';
import { Panel } from '@/components/ui';
import { tokens } from '@/theme/tokens';
import { describeError } from '@/utils/errors';
import type { Asset } from '@/types';

const { Text, Title } = Typography;

interface FormValues {
  job_id: string;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'checking' }
  // The asset is always present in this phase: the lookup only sets it
  // after a successful response that carries an id.
  | { kind: 'exists'; asset: Asset }
  | { kind: 'registering' };

export default function ImportComfyUiTab(): JSX.Element {
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  const busy = phase.kind === 'checking' || phase.kind === 'registering';

  const register = async (jobId: string): Promise<void> => {
    setPhase({ kind: 'registering' });
    try {
      const asset = await registerAssetByComfyJob(jobId);
      message.success(`已登记「${asset.title || asset.original_name}」`);
      navigate(`/library/${asset.id}`);
    } catch (e: unknown) {
      message.error(describeError(e, '登记 ComfyUI 任务失败'));
      setPhase({ kind: 'idle' });
    }
  };

  /**
   * `validateFields()` rejects when the field is empty. It used to sit
   * outside the `try` block, so an empty input produced an unhandled
   * promise rejection instead of the inline field error.
   */
  const onFinish = async (values: FormValues): Promise<void> => {
    const jobId = values.job_id.trim();
    setPhase({ kind: 'checking' });
    try {
      const existing = await lookupComfyUiJob(jobId);
      if (existing && existing.id) {
        setPhase({ kind: 'exists', asset: existing });
        return;
      }
      await register(jobId);
    } catch (e: unknown) {
      message.error(describeError(e, '反查任务失败'));
      setPhase({ kind: 'idle' });
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space[4] }}>
      <Title level={4} style={{ margin: 0, color: tokens.color.text, fontWeight: 600 }}>
        ComfyUI 任务登记
      </Title>
      <Text style={{ color: tokens.color.textMuted, fontSize: 12 }}>
        已知 ComfyUI 任务的 <code style={{ fontFamily: tokens.font.mono }}>job_id</code>，先反查是否已有资产，
        没有就登记一条占位记录。
      </Text>

      <Panel>
        <Form<FormValues>
          form={form}
          layout="vertical"
          onFinish={(v) => void onFinish(v)}
        >
          <Form.Item
            name="job_id"
            label="ComfyUI job_id"
            rules={[
              { required: true, message: '请输入 ComfyUI job_id' },
              {
                validator: (_, value: string | undefined) =>
                  value && value.trim()
                    ? Promise.resolve()
                    : Promise.reject(new Error('job_id 不能为空')),
              },
            ]}
          >
            <Input
              prefix={<ExperimentOutlined style={{ color: tokens.color.textMuted }} />}
              placeholder="例如 1f2c... (ComfyUI 任务 id)"
              allowClear
              style={{ fontFamily: tokens.font.mono, fontSize: 12 }}
            />
          </Form.Item>

          {/* Not wrapped in a `Form.Item` with a blank label — a screen
              reader announced an empty label for this button group. */}
          <Space>
            <Button
              type="primary"
              htmlType="submit"
              icon={<RightCircleOutlined />}
              loading={busy}
            >
              反查并登记
            </Button>
            <Button
              onClick={() => {
                form.resetFields();
                setPhase({ kind: 'idle' });
              }}
              disabled={busy}
            >
              清空
            </Button>
          </Space>
        </Form>

        {phase.kind === 'exists' && (
          <div style={{ marginTop: tokens.space[4] }}>
            <Alert
              type="info"
              showIcon
              style={{
                background: tokens.color.accentSoft,
                border: `1px solid ${tokens.color.accent}`,
              }}
              message={
                <Space size="small" wrap>
                  <Text style={{ color: tokens.color.text }}>
                    该 job_id 已存在资产：
                  </Text>
                  <Text
                    strong
                    style={{ color: tokens.color.text, fontFamily: tokens.font.mono }}
                  >
                    {phase.asset.title || phase.asset.original_name}
                  </Text>
                  <Link
                    to={`/library/${phase.asset.id}`}
                    style={{ color: tokens.color.accent }}
                  >
                    前往 →
                  </Link>
                </Space>
              }
            />
          </div>
        )}
      </Panel>
    </div>
  );
}
