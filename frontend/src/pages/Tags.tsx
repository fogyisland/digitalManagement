import { useEffect, useState } from 'react'
import {
  App,
  Button,
  ColorPicker,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tag as AntTag,
} from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons'
import { tagsApi } from '@/api/tags'
import type { Tag } from '@/types'
import { useAuthStore } from '@/stores/authStore'
import { formatDate } from '@/utils/format'

export default function Tags() {
  const { message } = App.useApp()
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin')
  const [tags, setTags] = useState<Tag[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [page, setPage] = useState(1)
  const [editOpen, setEditOpen] = useState(false)
  const [editing, setEditing] = useState<Tag | null>(null)
  const [form] = Form.useForm()

  const load = async () => {
    setLoading(true)
    try {
      const r = await tagsApi.list({ keyword: keyword || undefined, page, page_size: 50 })
      setTags(r.items)
      setTotal(r.total)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [page])

  const onCreate = () => {
    setEditing(null)
    form.resetFields()
    form.setFieldValue('color', '#1677ff')
    setEditOpen(true)
  }

  const onEdit = (t: Tag) => {
    setEditing(t)
    form.setFieldsValue({
      name: t.name,
      color: t.color,
      description: t.description,
    })
    setEditOpen(true)
  }

  const onDelete = async (id: number) => {
    await tagsApi.remove(id)
    message.success('已删除')
    load()
  }

  const onSave = async () => {
    const v = await form.validateFields()
    if (v.color && typeof v.color !== 'string') {
      v.color = (v.color as any).toHexString?.() || '#1677ff'
    }
    if (editing) {
      await tagsApi.update(editing.id, v)
      message.success('已更新')
    } else {
      await tagsApi.create(v)
      message.success('已创建')
    }
    setEditOpen(false)
    load()
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h2 className="page-title">标签管理</h2>
          <div className="page-subtitle">共 {total} 个标签</div>
        </div>
        <Space>
          <Input.Search
            placeholder="搜索标签"
            allowClear
            onSearch={(v) => { setKeyword(v); setPage(1); setTimeout(load, 0) }}
            style={{ width: 240 }}
          />
          {isAdmin && <Button type="primary" icon={<PlusOutlined />} onClick={onCreate}>新建标签</Button>}
        </Space>
      </div>

      <div className="dam-card dam-card-padded">
        <Table
          rowKey="id"
          dataSource={tags}
          loading={loading}
          pagination={{
            current: page,
            total,
            pageSize: 50,
            onChange: setPage,
            showSizeChanger: false,
          }}
          columns={[
            {
              title: '标签',
              dataIndex: 'name',
              render: (name: string, r: Tag) => (
                <AntTag color={r.color} style={{ fontSize: 13, padding: '2px 10px' }}>{name}</AntTag>
              ),
            },
            { title: '使用次数', dataIndex: 'usage_count', width: 120, sorter: (a: Tag, b: Tag) => a.usage_count - b.usage_count, defaultSortOrder: 'descend' },
            { title: '描述', dataIndex: 'description', ellipsis: true },
            { title: '创建时间', dataIndex: 'created_at', width: 180, render: (v: string) => formatDate(v) },
            {
              title: '操作',
              width: 120,
              render: (_: any, r: Tag) => isAdmin ? (
                <Space>
                  <Button size="small" type="text" icon={<EditOutlined />} onClick={() => onEdit(r)} />
                  <Popconfirm title="确认删除？" onConfirm={() => onDelete(r.id)}>
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                </Space>
              ) : null,
            },
          ]}
        />
      </div>

      <Modal
        title={editing ? '编辑标签' : '新建标签'}
        open={editOpen}
        onCancel={() => setEditOpen(false)}
        onOk={onSave}
        width={480}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="名称" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="color" label="颜色" initialValue="#1677ff">
            <ColorPicker />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
