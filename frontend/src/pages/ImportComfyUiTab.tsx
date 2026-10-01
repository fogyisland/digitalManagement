/**
 * ImportComfyUiTab — third tab of the Import page.
 *
 * Single `<Input>` accepting a ComfyUI job_id (string). Flow:
 *   1. GET /jobs/by-comfyui/:job_id
 *      - on 200 with payload → asset already exists; show a "前往" link
 *        that navigates to `/library/:id`.
 *      - on 404 → no asset yet, proceed.
 *   2. POST /assets/from-comfyui/:job_id → creates the placeholder row.
 *      - On success, navigate to `/library/:id`.
 *
 * Concerns parked:
 *  - Neither endpoint exists on the backend today; both will 404. We keep
 *    the flow intact so when the routes ship, no UI work is required.
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
import { tokens } from '@/theme/tokens';
import { describeError } from '@/utils/parseMetadata';
import type { Asset } from '@/types/dto';

const { Text, Title } = Typography;

interface FormValues {
  job_id: string;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'exists'; asset: Asset | null }
  | { kind: 'registering' };

export default function ImportComfyUiTab(): JSX.Element {
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  const busy = phase.kind === 'checking' || phase.kind === 'registering';

  const onLookup = async (): Promise<void> => {
    const values = await form.validateFields();
    const jobId = values.job_id.trim();
    if (!jobId) {
      message.warning('请输入 ComfyUI job_id');
      return;
    }
    setPhase({ kind: 'checking' });
    try {
      const existing = await lookupComfyUiJob(jobId);
      if (existing && existing.id) {
        setPhase({ kind: 'exists', asset: existing });
        return;
      }
      setPhase({ kind: 'registering' });
      try {
        const asset = await registerAssetByComfyJob(jobId);
        message.success(`已登记「${asset.title || asset.original_name}」`);
        navigate(`/library/${asset.id}`);
      } catch (inner: unknown) {
        const detail = describeError(inner, '登记 ComfyUI 任务失败');
        message.error(detail);
        // Backend doesn't ship the routes today → fall back to library
        // rather than leave the user staring at a broken tab.
        if (detail.toLowerCase().includes('not found') || detail.includes('404')) {
          setTimeout(() => navigate('/library'), 800);
        }
        setPhase({ kind: 'idle' });
      }
    } catch (e: unknown) {
      // 404 from the lookup endpoint means "no asset yet" — proceed to
      // register. Any other error is surfaced.
      const detail = describeError(e, '反查任务失败');
      const isMissing =
        detail.toLowerCase().includes('not found') || detail.includes('404');
      if (isMissing) {
        setPhase({ kind: 'registering' });
        try {
          const asset = await registerAssetByComfyJob(jobId);
          message.success(`已登记「${asset.title || asset.original_name}」`);
          navigate(`/library/${asset.id}`);
        } catch (inner: unknown) {
          message.error(describeError(inner, '登记 ComfyUI 任务失败'));
          setPhase({ kind: 'idle' });
        }
      } else {
        message.error(detail);
        setPhase({ kind: 'idle' });
      }
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

      <Alert
        type="warning"
        showIcon
        message={
          <Text style={{ fontSize: 12 }}>
            后端尚未提供 <code>/jobs/by-comfyui/:job_id</code> 与 <code>/assets/from-comfyui/:job_id</code>；
            提交会得到 404，UI 会按"无重复"分支处理并提示错误。
          </Text>
        }
        style={{
          background: 'rgba(248, 81, 73, 0.08)',
          border: `1px solid ${tokens.color.danger}`,
        }}
      />

      <section
        style={{
          background: tokens.color.panel,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.lg,
          padding: tokens.space[4],
        }}
      >
        <Form form={form} layout="vertical" requiredMark={false}>
          <Form.Item
            name="job_id"
            label="ComfyUI job_id"
            rules={[
              { required: true, message: '请输入 ComfyUI job_id' },
              { min: 1, message: 'job_id 不能为空' },
            ]}
          >
            <Input
              prefix={<ExperimentOutlined style={{ color: tokens.color.textMuted }} />}
              placeholder="例如 1f2c... (ComfyUI 任务 id)"
              allowClear
              style={{ fontFamily: tokens.font.mono, fontSize: 12 }}
            />
          </Form.Item>

          <Form.Item label=" " colon={false}>
            <Space>
              <Button
                type="primary"
                icon={<RightCircleOutlined />}
                onClick={() => void onLookup()}
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
          </Form.Item>
        </Form>

        {phase.kind === 'exists' && phase.asset && (
          <Alert
            type="info"
            showIcon
            style={{
              background: 'rgba(245, 165, 36, 0.08)',
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
        )}
      </section>
    </div>
  );
}
