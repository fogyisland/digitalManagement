import { useRef, useState, useEffect } from 'react'
import { Button, Input, Select, Space, message } from 'antd'
import { CloudUploadOutlined, InboxOutlined } from '@ant-design/icons'
import { assetsApi } from '@/api/assets'
import type { Asset } from '@/types'
import { categoriesApi } from '@/api/categories'
import { tagsApi } from '@/api/tags'

interface Props {
  onUploaded?: (asset: Asset) => void
}

export default function AssetUploader({ onUploaded }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [categoryId, setCategoryId] = useState<number | undefined>()
  const [tagInput, setTagInput] = useState('')
  const [progress, setProgress] = useState(0)
  const [uploading, setUploading] = useState(false)
  const [categories, setCategories] = useState<any[]>([])
  const [allTags, setAllTags] = useState<string[]>([])

  useEffect(() => {
    categoriesApi.tree().then((tags: Array<{ id?: number; name: string }>) => setCategories(tags)).catch(() => {})
    tagsApi.all().then((tags: Array<{ name: string }>) => setAllTags(tags.map((t: { name: string }) => t.name))).catch(() => {})
  }, [])

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

  const onPick = (f: File) => {
    setFile(f)
    if (!title) setTitle(f.name.replace(/\.[^.]+$/, ''))
  }

  const onUpload = async () => {
    if (!file) {
      message.warning('请先选择文件')
      return
    }
    setUploading(true)
    setProgress(0)
    try {
      const asset = await assetsApi.upload(file, {
        title: title || undefined,
        description: description || undefined,
        category_id: categoryId,
        tag_names: tagInput || undefined,
        onProgress: (e) => {
          if (e.total) setProgress(Math.round((e.loaded / e.total) * 100))
        },
      })
      message.success(`上传成功: ${asset.title}`)
      setFile(null)
      setTitle('')
      setDescription('')
      setTagInput('')
      setProgress(0)
      onUploaded?.(asset)
    } catch {
      // interceptor already showed error
    } finally {
      setUploading(false)
    }
  }

  return (
    <div>
      <div
        className="upload-zone"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('is-drag-over') }}
        onDragLeave={(e) => e.currentTarget.classList.remove('is-drag-over')}
        onDrop={(e) => {
          e.preventDefault()
          e.currentTarget.classList.remove('is-drag-over')
          const f = e.dataTransfer.files?.[0]
          if (f) onPick(f)
        }}
      >
        <CloudUploadOutlined className="upload-icon" />
        <div style={{ fontSize: 16, fontWeight: 500, marginBottom: 4 }}>
          {file ? file.name : '点击或拖拽文件到此处上传'}
        </div>
        <div className="text-muted" style={{ fontSize: 12 }}>
          支持图片（JPG / PNG / WebP / GIF / SVG）和视频（MP4 / MOV / WebM）
        </div>
        {file && (
          <div className="text-muted" style={{ fontSize: 12, marginTop: 8 }}>
            {(file.size / 1024 / 1024).toFixed(2)} MB
          </div>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/*,video/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) onPick(f)
          }}
        />
      </div>

      <div className="dam-card dam-card-padded" style={{ marginTop: 16 }}>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <div>
            <label style={{ display: 'block', marginBottom: 6, fontSize: 13 }}>资产标题</label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="留空将使用文件名" />
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: 6, fontSize: 13 }}>描述</label>
            <Input.TextArea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={{ display: 'block', marginBottom: 6, fontSize: 13 }}>分类</label>
              <Select
                value={categoryId}
                onChange={setCategoryId}
                options={flatCategories}
                placeholder="选择分类"
                allowClear
                style={{ width: '100%' }}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ display: 'block', marginBottom: 6, fontSize: 13 }}>标签</label>
              <Select
                mode="tags"
                value={tagInput ? tagInput.split(',').filter(Boolean) : []}
                onChange={(v) => setTagInput(v.join(','))}
                options={allTags.map((t) => ({ value: t, label: t }))}
                placeholder="输入后回车"
                style={{ width: '100%' }}
              />
            </div>
          </div>
          <Button
            type="primary"
            icon={<InboxOutlined />}
            loading={uploading}
            onClick={onUpload}
            block
            size="large"
          >
            {uploading ? `上传中... ${progress}%` : '开始上传'}
          </Button>
          {uploading && progress > 0 && (
            <div style={{
              height: 6, background: '#f0f0f0', borderRadius: 3, overflow: 'hidden',
            }}>
              <div style={{
                width: `${progress}%`,
                height: '100%',
                background: 'linear-gradient(90deg, #1677ff, #722ed1)',
                transition: 'width 0.2s',
              }} />
            </div>
          )}
        </Space>
      </div>
    </div>
  )
}
