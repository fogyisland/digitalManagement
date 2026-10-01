import { useEffect, useState } from 'react'
import {
  Alert,
  App,
  Button,
  Checkbox,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import { CopyOutlined, KeyOutlined, PlusOutlined, DeleteOutlined } from '@ant-design/icons'
import { apiKeysApi } from '@/api/apikeys'
import type { ApiKey, ApiKeyCreated } from '@/types'
import { formatDate } from '@/utils/format'

const { Paragraph, Text } = Typography

const SCOPE_OPTIONS = [
  { value: 'assets:read', label: '读取资产 (assets:read)' },
  { value: 'assets:write', label: '上传资产 (assets:write)' },
  { value: 'assets:delete', label: '删除资产 (assets:delete)' },
]

export default function ApiKeys() {
  const { message } = App.useApp()
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [loading, setLoading] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [created, setCreated] = useState<ApiKeyCreated | null>(null)
  const [form] = Form.useForm()

  const load = async () => {
    setLoading(true)
    try {
      const r = await apiKeysApi.list()
      setKeys(r.items)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const onCreate = async () => {
    const v = await form.validateFields()
    const created = await apiKeysApi.create(v)
    setCreated(created)
    setCreateOpen(false)
    form.resetFields()
    form.setFieldValue('scopes', ['assets:read', 'assets:write'])
    load()
  }

  const onRevoke = async (id: number) => {
    await apiKeysApi.revoke(id)
    message.success('已撤销')
    load()
  }

  const onCopy = (text: string, label: string) => {
    navigator.clipboard.writeText(text).then(() => message.success(`${label}已复制到剪贴板`))
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h2 className="page-title">API Key 管理</h2>
          <div className="page-subtitle">为外部系统颁发可控的资产投递凭证</div>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          新建 API Key
        </Button>
      </div>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16, borderRadius: 10 }}
        message="API Key 用法"
        description={
          <div>
            <div>外部系统使用 <Text code>X-API-Key</Text> Header 调用 <Text code>POST /api/public/v1/delivery/upload</Text> 等接口</div>
            <div>完整示例：<Text code>curl -H "X-API-Key: dam_xxx" -F "file=@image.png" -F "title=My Image" http://host/api/public/v1/delivery/upload</Text></div>
          </div>
        }
      />

      <div className="dam-card dam-card-padded">
        <Table
          rowKey="id"
          dataSource={keys}
          loading={loading}
          pagination={false}
          locale={{ emptyText: <Empty description="还没有 API Key" /> }}
          columns={[
            { title: '名称', dataIndex: 'name', render: (v, r: ApiKey) => (
              <Space>
                <KeyOutlined style={{ color: '#1677ff' }} />
                <span>{v}</span>
                {r.description && <span className="text-muted" style={{ fontSize: 12 }}>· {r.description}</span>}
              </Space>
            ) },
            { title: 'Key', dataIndex: 'key_masked', width: 280, render: (v: string) => (
              <Space>
                <Text code className="text-mono" style={{ fontSize: 12 }}>{v}</Text>
                <Button size="small" type="text" icon={<CopyOutlined />} onClick={() => onCopy(v!, 'Key')} />
              </Space>
            ) },
            { title: '权限范围', dataIndex: 'scopes', render: (scopes: string[]) => (
              <Space wrap>
                {scopes.map((s) => (
                  <Tag key={s} color={s === 'assets:read' ? 'green' : s === 'assets:write' ? 'blue' : 'red'}>
                    {s}
                  </Tag>
                ))}
              </Space>
            ) },
            { title: '状态', dataIndex: 'is_active', width: 80, render: (v: boolean) => (
              v ? <Tag color="green">启用</Tag> : <Tag>禁用</Tag>
            ) },
            { title: '最后使用', dataIndex: 'last_used_at', width: 160, render: (v: string | null) => v ? formatDate(v) : '—' },
            { title: '创建时间', dataIndex: 'created_at', width: 160, render: (v: string) => formatDate(v) },
            { title: '操作', width: 80, render: (_: any, r: ApiKey) => (
              <Popconfirm title="确认撤销？" description="撤销后将立即失效" onConfirm={() => onRevoke(r.id)}>
                <Button size="small" type="text" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            ) },
          ]}
        />
      </div>

      {/* Create modal */}
      <Modal
        title="新建 API Key"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={onCreate}
        okText="创建"
        width={520}
      >
        <Form form={form} layout="vertical" initialValues={{ scopes: ['assets:read', 'assets:write'] }}>
          <Form.Item name="name" label="名称" rules={[{ required: true, max: 128 }]}>
            <Input placeholder="例如：AI 内容生成系统" />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={2} placeholder="可选，说明此 Key 的用途" />
          </Form.Item>
          <Form.Item name="scopes" label="权限范围" rules={[{ required: true, type: 'array', min: 1 }]}>
            <Checkbox.Group options={SCOPE_OPTIONS} />
          </Form.Item>
        </Form>
      </Modal>

      {/* Created result */}
      <Modal
        title="API Key 创建成功"
        open={!!created}
        onCancel={() => setCreated(null)}
        footer={[
          <Button key="copy" type="primary" icon={<CopyOutlined />} onClick={() => onCopy(created?.api_key || '', 'API Key')}>
            复制完整 Key
          </Button>,
          <Button key="close" onClick={() => setCreated(null)}>关闭</Button>,
        ]}
      >
        <Alert type="warning" showIcon message="请立即保存完整 Key" description="出于安全考虑，关闭此弹窗后将无法再次查看完整 Key，只能重新创建。" />
        <div style={{ marginTop: 16, padding: 12, background: '#f5f5f5', borderRadius: 6 }}>
          <Paragraph copyable={{ text: created?.api_key }} className="text-mono" style={{ wordBreak: 'break-all', margin: 0 }}>
            {created?.api_key}
          </Paragraph>
        </div>
      </Modal>
    </div>
  )
}
