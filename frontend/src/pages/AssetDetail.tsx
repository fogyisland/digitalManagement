import { useEffect, useState } from 'react'
import {
  Button,
  Descriptions,
  Tag,
  Space,
  Skeleton,
  App,
  Modal,
  Form,
  Input,
  Select,
  Switch,
  Empty,
  Tabs,
} from 'antd'
import {
  ArrowLeftOutlined,
  CopyOutlined,
  DownloadOutlined,
  EditOutlined,
  DeleteOutlined,
  EyeOutlined,
} from '@ant-design/icons'
import { useNavigate, useParams } from 'react-router-dom'
import { assetsApi } from '@/api/assets'
import { categoriesApi } from '@/api/categories'
import { tagsApi } from '@/api/tags'
import { useAuthStore } from '@/stores/authStore'
import type { Asset } from '@/types'
import { formatBytes, formatDate, formatDuration } from '@/utils/format'

export default function AssetDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { message, modal } = App.useApp()
  const canWrite = useAuthStore((s) => s.canWrite())

  const [asset, setAsset] = useState<Asset | null>(null)
  const [loading, setLoading] = useState(true)
  const [editOpen, setEditOpen] = useState(false)
  const [categories, setCategories] = useState<any[]>([])
  const [allTags, setAllTags] = useState<any[]>([])
  const [form] = Form.useForm()

  const load = async () => {
    setLoading(true)
    try {
      const a = await assetsApi.get(Number(id))
      setAsset(a)
      form.setFieldsValue({
        title: a.title,
        description: a.description,
        category_id: a.category_id,
        tag_names: a.tag_names,
        is_public: a.is_public,
      })
    } catch {
      // interceptor handled
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (id) load()
    categoriesApi.tree().then(setCategories).catch(() => {})
    tagsApi.all().then(setAllTags).catch(() => {})
  }, [id])

  if (loading) return <Skeleton active />

  if (!asset) {
    return (
      <Empty description="资产不存在或已被删除">
        <Button onClick={() => navigate('/assets')}>返回资产库</Button>
      </Empty>
    )
  }

  const isVideo = asset.asset_type === 'video'
  const heroUrl = asset.preview_url || asset.original_url

  const onCopy = (text: string, label: string) => {
    navigator.clipboard.writeText(text).then(() => message.success(`${label}已复制`))
  }

  const onDownload = async () => {
    try {
      const r = await assetsApi.getDownloadUrl(asset.id)
      window.open(r.download_url, '_blank')
    } catch {}
  }

  const onDelete = (permanent = false) => {
    modal.confirm({
      title: permanent ? '永久删除？' : '删除资产？',
      content: permanent ? '不可恢复，文件将从磁盘删除' : '可在回收站中恢复',
      okButtonProps: permanent ? { danger: true } : {},
      onOk: async () => {
        await assetsApi.remove(asset.id, permanent)
        message.success('已删除')
        navigate('/assets')
      },
    })
  }

  const onSaveEdit = async () => {
    const v = await form.validateFields()
    const updated = await assetsApi.update(asset.id, v)
    setAsset(updated)
    setEditOpen(false)
    message.success('已保存')
  }

  const flatCategories = (() => {
    const out: { value: number; label: string }[] = []
    const walk = (nodes: any[], prefix = '') => {
      for (const n of nodes) {
        out.push({ value: n.id, label: prefix + n.name })
        if (n.children?.length) walk(n.children, prefix + '— ')
      }
    }
    walk(categories)
    return out
  })()

  return (
    <div>
      <div className="page-header">
        <Space>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/assets')}>返回</Button>
        </Space>
        <Space>
          <Button icon={<DownloadOutlined />} onClick={onDownload}>下载</Button>
          {canWrite && <Button icon={<EditOutlined />} onClick={() => setEditOpen(true)}>编辑</Button>}
          {canWrite && (
            <Button icon={<DeleteOutlined />} danger onClick={() => onDelete(false)}>删除</Button>
          )}
        </Space>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(280px, 1fr)', gap: 16 }}>
        {/* Hero */}
        <div className="detail-hero">
          {isVideo ? (
            <video src={heroUrl || ''} controls poster={asset.thumbnail_url || undefined} style={{ maxWidth: '100%' }} />
          ) : (
            <img src={heroUrl || asset.thumbnail_url || ''} alt={asset.title} />
          )}
        </div>

        {/* Info sidebar */}
        <div className="detail-sidebar">
          <Descriptions column={1} size="small" title="资产信息">
            <Descriptions.Item label="标题">{asset.title}</Descriptions.Item>
            <Descriptions.Item label="编码" >
              <Space>
                <span className="text-mono">{asset.asset_code}</span>
                <Button size="small" type="text" icon={<CopyOutlined />} onClick={() => onCopy(asset.asset_code, '编码')} />
              </Space>
            </Descriptions.Item>
            <Descriptions.Item label="类型">
              <Tag color={isVideo ? 'red' : 'green'}>{isVideo ? '视频' : '图片'}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="格式">{asset.mime_type}</Descriptions.Item>
            <Descriptions.Item label="体积">{formatBytes(asset.file_size)}</Descriptions.Item>
            {asset.width && asset.height && (
              <Descriptions.Item label="尺寸">{asset.width} × {asset.height}</Descriptions.Item>
            )}
            {asset.duration != null && (
              <Descriptions.Item label="时长">{formatDuration(asset.duration)}</Descriptions.Item>
            )}
            <Descriptions.Item label="上传者">{asset.uploader_name || '—'}</Descriptions.Item>
            <Descriptions.Item label="上传时间">{formatDate(asset.created_at)}</Descriptions.Item>
            <Descriptions.Item label="状态">
              <Tag color={asset.status === 'active' ? 'green' : asset.status === 'processing' ? 'blue' : 'red'}>
                {asset.status}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label="来源">
              <Tag>{asset.source || 'upload'}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="公开">
              {asset.is_public ? <Tag color="green">是</Tag> : <Tag>否</Tag>}
            </Descriptions.Item>
            <Descriptions.Item label="浏览 / 下载">
              <Space>
                <span><EyeOutlined /> {asset.view_count}</span>
                <span><DownloadOutlined /> {asset.download_count}</span>
              </Space>
            </Descriptions.Item>
          </Descriptions>

          {asset.tag_names?.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div style={{ marginBottom: 8, fontSize: 13, color: 'rgba(0,0,0,0.65)' }}>标签</div>
              <Space wrap>
                {asset.tag_names.map((t) => (
                  <Tag key={t} color="blue">{t}</Tag>
                ))}
              </Space>
            </div>
          )}

          <div style={{ marginTop: 16 }}>
            <div style={{ marginBottom: 8, fontSize: 13, color: 'rgba(0,0,0,0.65)' }}>文件哈希 (SHA-256)</div>
            <div className="text-mono text-muted" style={{ fontSize: 11, wordBreak: 'break-all' }}>
              {asset.file_hash}
            </div>
          </div>

          {asset.description && (
            <div style={{ marginTop: 16 }}>
              <div style={{ marginBottom: 8, fontSize: 13, color: 'rgba(0,0,0,0.65)' }}>描述</div>
              <div className="text-muted" style={{ fontSize: 13, lineHeight: 1.6 }}>{asset.description}</div>
            </div>
          )}
        </div>
      </div>

      {/* EXIF / Metadata tabs */}
      {asset.exif && (
        <div className="dam-card" style={{ marginTop: 16 }}>
          <Tabs
            defaultActiveKey="exif"
            items={[
              {
                key: 'exif',
                label: 'EXIF 信息',
                children: (
                  <Descriptions column={2} size="small" bordered style={{ padding: 16 }}>
                    {Object.entries(asset.exif).map(([k, v]) => (
                      <Descriptions.Item label={k} key={k}>
                        {typeof v === 'object' ? JSON.stringify(v) : String(v)}
                      </Descriptions.Item>
                    ))}
                  </Descriptions>
                ),
              },
            ]}
          />
        </div>
      )}

      {/* Edit Modal */}
      <Modal
        title="编辑资产"
        open={editOpen}
        onCancel={() => setEditOpen(false)}
        onOk={onSaveEdit}
        width={560}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="title" label="标题" rules={[{ required: true, max: 255 }]}>
            <Input />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item name="category_id" label="分类">
            <Select allowClear options={flatCategories} placeholder="选择分类" />
          </Form.Item>
          <Form.Item name="tag_names" label="标签">
            <Select mode="tags" options={allTags.map((t: any) => ({ value: t.name, label: t.name }))} placeholder="输入后回车" />
          </Form.Item>
          <Form.Item name="is_public" label="公开" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
