/**
 * ImportUploadTab — first tab of the Import page.
 *
 * Drag-and-drop file picker (image/video) plus a metadata side panel
 * (title, description, prompt, seed, model_name, job_id, source_tool,
 * metadata_json). On submit we POST multipart to `/assets/upload` and
 * navigate to the resulting asset's detail page (or fall back to
 * `/library` when no asset comes back — e.g. a hash collision returns
 * the existing row without a fresh id).
 *
 * Concerns parked:
 *  - The backend handler reads `upload.array('files', 20)`, so we append
 *    the user-selected file under the field name `files` (plural) and
 *    rely on the backend returning `{ items, count }`. We unwrap items
 *    and pick the first one. The brief mentioned `file` (singular) but
 *    that would not match the deployed handler — using `files` is the
 *    only option that round-trips today.
 *  - `metadata_json` is intentionally not blocking: an invalid JSON
 *    surface a warning, but submission continues so a user with a typo
 *    can still ship the asset and patch it later.
 */

import { useCallback, useRef, useState } from 'react';
import {
  App,
  Alert,
  Button,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Typography,
} from 'antd';
import {
  CloudUploadOutlined,
  FileImageOutlined,
  InboxOutlined,
  PlayCircleOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import {
  buildUploadFormData,
  uploadAssetOne,
  type UploadAssetMeta,
} from '@/api/assets';
import { tokens } from '@/theme/tokens';
import { describeError, safeParseJson } from '@/utils/parseMetadata';

const { Text, Title } = Typography;

const SOURCE_TOOL_OPTIONS: { value: string; label: string }[] = [
  { value: 'manual', label: '手动上传' },
  { value: 'comfyui', label: 'ComfyUI' },
  { value: 'admin', label: '管理后台' },
];

interface FormValues {
  title?: string;
  description?: string;
  prompt?: string;
  seed?: number | null;
  model_name?: string;
  job_id?: string;
  source_tool?: string;
  metadata_json?: string;
}

interface PickedFile {
  name: string;
  size: number;
  type: string;
  file: File;
}

function formatKb(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function pickFromDataTransfer(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  for (let i = 0; i < dt.items.length; i++) {
    const item = dt.items[i];
    if (item.kind === 'file') {
      const f = item.getAsFile();
      if (f) out.push(f);
    }
  }
  return out;
}

export default function ImportUploadTab(): JSX.Element {
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [picked, setPicked] = useState<PickedFile | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [dragOver, setDragOver] = useState<boolean>(false);

  const accept = (f: File): boolean => {
    if (!f.type) return true; // allow when browser is unsure
    return f.type.startsWith('image/') || f.type.startsWith('video/');
  };

  const onPick = useCallback((files: File[]) => {
    if (files.length === 0) return;
    // Single-file mode: keep the first accepted one.
    const first = files.find(accept);
    if (!first) {
      message.warning('仅支持 image/* 与 video/* 文件');
      return;
    }
    setPicked({
      name: first.name,
      size: first.size,
      type: first.type,
      file: first,
    });
  }, [message]);

  const onSubmit = async (): Promise<void> => {
    if (!picked) {
      message.warning('请先选择或拖入一个文件');
      return;
    }

    const values = await form.validateFields();
    const meta: UploadAssetMeta = {
      title: values.title,
      description: values.description,
      prompt: values.prompt,
      seed: values.seed ?? null,
      model_name: values.model_name,
      job_id: values.job_id,
      source_tool: values.source_tool ?? 'manual',
      metadata_json: values.metadata_json,
    };

    const parsed = safeParseJson(values.metadata_json ?? '');
    if (!parsed.ok && (values.metadata_json ?? '').trim().length > 0) {
      message.warning(`metadata_json 不是合法 JSON：${parsed.error ?? ''}（仍会提交，数据库会保留原始文本）`);
    }

    const formData = buildUploadFormData([picked.file], meta);
    setSubmitting(true);
    try {
      const asset = await uploadAssetOne(formData);
      if (asset) {
        message.success(`已上传「${asset.title || asset.original_name}」`);
        navigate(`/library/${asset.id}`);
      } else {
        message.success('上传完成');
        navigate('/library');
      }
    } catch (e: unknown) {
      message.error(describeError(e, '上传失败'));
    } finally {
      setSubmitting(false);
    }
  };

  const onReset = (): void => {
    setPicked(null);
    form.resetFields();
    form.setFieldsValue({ source_tool: 'manual' });
    if (inputRef.current) inputRef.current.value = '';
  };

  const firstFileType = picked?.type ?? '';
  const isVideo = firstFileType.startsWith('video/');
  const isImage = firstFileType.startsWith('image/');
  const fileTypeIcon = isVideo ? (
    <PlayCircleOutlined style={{ fontSize: 36, color: tokens.color.textMuted }} />
  ) : isImage ? (
    <FileImageOutlined style={{ fontSize: 36, color: tokens.color.textMuted }} />
  ) : (
    <CloudUploadOutlined style={{ fontSize: 36, color: tokens.color.textMuted }} />
  );

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.4fr) minmax(280px, 1fr)', gap: tokens.space[5] }}>
      {/* Drop zone + file preview */}
      <section
        style={{
          background: tokens.color.panel,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.lg,
          padding: tokens.space[4],
          display: 'flex',
          flexDirection: 'column',
          gap: tokens.space[3],
        }}
      >
        <Title level={4} style={{ margin: 0, color: tokens.color.text, fontWeight: 600 }}>
          上传文件
        </Title>
        <Text style={{ color: tokens.color.textMuted, fontSize: 12 }}>
          支持 image/* 与 video/*，单文件上传；附加字段会一并写入数据库。
        </Text>

        <div
          role="button"
          tabIndex={0}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              inputRef.current?.click();
            }
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            onPick(pickFromDataTransfer(e.dataTransfer));
          }}
          style={{
            background: dragOver ? tokens.color.bgAlt : tokens.color.bg,
            border: `1px dashed ${dragOver ? tokens.color.accent : tokens.color.border}`,
            borderRadius: tokens.radius.md,
            padding: `${tokens.space[6]}px 0`,
            textAlign: 'center',
            cursor: 'pointer',
            transition: 'background 120ms ease, border-color 120ms ease',
            outline: 'none',
          }}
          aria-label="拖拽文件到此处，或点击选择"
        >
          <input
            ref={inputRef}
            type="file"
            accept="image/*,video/*"
            style={{ display: 'none' }}
            onChange={(e) => {
              const list = e.target.files;
              if (!list) return;
              onPick(Array.from(list));
            }}
          />
          {fileTypeIcon}
          <p
            style={{
              margin: `${tokens.space[3]}px 0 ${tokens.space[2]}px`,
              color: tokens.color.text,
              fontSize: 14,
              fontWeight: 500,
            }}
          >
            <InboxOutlined style={{ marginRight: tokens.space[2] }} />
            拖拽文件到此处，或点击选择
          </p>
          <p style={{ color: tokens.color.textMuted, fontSize: 12, margin: 0 }}>
            支持 PNG / JPG / WebP / MP4 / WebM，单文件上限随服务端配置
          </p>
        </div>

        {picked && (
          <Alert
            type="info"
            showIcon
            closable
            onClose={() => setPicked(null)}
            message={
              <Space size="small">
                <Text style={{ color: tokens.color.text, fontWeight: 500 }}>
                  {picked.name}
                </Text>
                <Text style={{ color: tokens.color.textMuted, fontSize: 12 }}>
                  {formatKb(picked.size)} · {picked.type || '未知类型'}
                </Text>
              </Space>
            }
            style={{
              background: tokens.color.bgAlt,
              border: `1px solid ${tokens.color.border}`,
            }}
          />
        )}

        <Space>
          <Button
            type="primary"
            icon={<CloudUploadOutlined />}
            onClick={() => void onSubmit()}
            loading={submitting}
            disabled={!picked}
          >
            上传并提交
          </Button>
          <Button onClick={onReset} disabled={submitting}>
            清空
          </Button>
        </Space>
      </section>

      {/* Metadata side panel */}
      <aside
        style={{
          background: tokens.color.panel,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.lg,
          padding: tokens.space[4],
        }}
      >
        <Form
          form={form}
          layout="vertical"
          initialValues={{ source_tool: 'manual' }}
          requiredMark={false}
        >
          <Form.Item name="title" label="标题">
            <Input placeholder="选填；留空将使用文件名" maxLength={255} allowClear />
          </Form.Item>

          <Form.Item name="description" label="描述">
            <Input.TextArea
              rows={3}
              placeholder="选填；补充上下文以便后续检索"
              maxLength={2000}
              showCount
            />
          </Form.Item>

          <Form.Item name="source_tool" label="来源">
            <Select
              options={SOURCE_TOOL_OPTIONS}
              placeholder="选择来源工具"
            />
          </Form.Item>

          <Form.Item name="prompt" label="Prompt">
            <Input.TextArea
              rows={3}
              placeholder="选填；如果是 AI 生成内容，附上原始 prompt"
              maxLength={4000}
              style={{ fontFamily: tokens.font.mono, fontSize: 12 }}
            />
          </Form.Item>

          <Space size="middle" style={{ width: '100%' }} wrap>
            <Form.Item name="seed" label="Seed" style={{ minWidth: 140 }}>
              <InputNumber
                placeholder="整数值"
                style={{ width: '100%' }}
                min={0}
                step={1}
              />
            </Form.Item>
            <Form.Item name="model_name" label="模型" style={{ flex: 1, minWidth: 180 }}>
              <Input placeholder="例如 sdxl-base-1.0" allowClear />
            </Form.Item>
          </Space>

          <Form.Item name="job_id" label="ComfyUI job_id">
            <Input
              placeholder="选填；如果来自 ComfyUI 任务，填入任务 id"
              allowClear
              style={{ fontFamily: tokens.font.mono, fontSize: 12 }}
            />
          </Form.Item>

          <Form.Item
            name="metadata_json"
            label="metadata_json"
            extra={
              <Text style={{ color: tokens.color.textMuted, fontSize: 12 }}>
                任意 JSON 对象；解析失败不会阻止提交
              </Text>
            }
          >
            <Input.TextArea
              rows={6}
              placeholder='例如 {"steps": 30, "sampler": "euler_a"}'
              style={{ fontFamily: tokens.font.mono, fontSize: 12 }}
              spellCheck={false}
            />
          </Form.Item>
        </Form>
      </aside>
    </div>
  );
}
