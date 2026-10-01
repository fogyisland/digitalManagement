import { useEffect, useState } from 'react'
import { App, Button, Empty, Form, Input, Modal, Space, Tree, ColorPicker, Tag } from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined, FolderOutlined } from '@ant-design/icons'
import { categoriesApi } from '@/api/categories'
import { useAuthStore } from '@/stores/authStore'
import type { Category } from '@/types'

export default function Categories() {
  const { message, modal } = App.useApp()
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin')
  const [tree, setTree] = useState<Category[]>([])
  const [editOpen, setEditOpen] = useState(false)
  const [editing, setEditing] = useState<Category | null>(null)
  const [form] = Form.useForm()

  const load = async () => {
    const data = await categoriesApi.tree()
    setTree(data)
  }

  useEffect(() => { load() }, [])

  const onCreate = (parent_id?: number) => {
    setEditing(null)
    form.resetFields()
    if (parent_id) form.setFieldValue('parent_id', parent_id)
    setEditOpen(true)
  }

  const onEdit = (cat: Category) => {
    setEditing(cat)
    form.setFieldsValue({
      name: cat.name,
      description: cat.description,
      icon: cat.icon,
      color: cat.color,
      sort_order: cat.sort_order,
      parent_id: cat.parent_id,
    })
    setEditOpen(true)
  }

  const onDelete = (cat: Category) => {
    modal.confirm({
      title: '确认删除分类？',
      content: `"${cat.name}" 下的资产将变为未分类`,
      okButtonProps: { danger: true },
      onOk: async () => {
        await categoriesApi.remove(cat.id)
        message.success('已删除')
        load()
      },
    })
  }

  const onSave = async () => {
    const v = await form.validateFields()
    if (v.color && typeof v.color !== 'string') {
      v.color = (v.color as any).toHexString?.() || '#1677ff'
    }
    if (editing) {
      await categoriesApi.update(editing.id, v)
      message.success('已更新')
    } else {
      await categoriesApi.create(v)
      message.success('已创建')
    }
    setEditOpen(false)
    load()
  }

  const renderTreeNodes = (nodes: Category[]): any =>
    nodes.map((n) => ({
      key: n.id,
      title: (
        <Space>
          <FolderOutlined style={{ color: n.color || '#1677ff' }} />
          <span>{n.name}</span>
          {n.description && <span className="text-muted" style={{ fontSize: 12 }}>· {n.description}</span>}
          {isAdmin && (
            <Space size={4} style={{ marginLeft: 12 }}>
              <Button size="small" type="text" icon={<PlusOutlined />} onClick={(e) => { e.stopPropagation(); onCreate(n.id) }} title="新建子分类" />
              <Button size="small" type="text" icon={<EditOutlined />} onClick={(e) => { e.stopPropagation(); onEdit(n) }} />
              <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={(e) => { e.stopPropagation(); onDelete(n) }} />
            </Space>
          )}
        </Space>
      ),
      children: n.children?.length ? renderTreeNodes(n.children) : undefined,
    }))

  return (
    <div>
      <div className="page-header">
        <div>
          <h2 className="page-title">分类管理</h2>
          <div className="page-subtitle">树形多级分类，便于资产归档</div>
        </div>
        {isAdmin && (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => onCreate()}>
            新建分类
          </Button>
        )}
      </div>

      <div className="dam-card dam-card-padded">
        {tree.length ? (
          <Tree
            treeData={renderTreeNodes(tree)}
            defaultExpandAll
            showLine={{ showLeafIcon: false }}
            selectable={false}
          />
        ) : (
          <Empty description="暂无分类" />
        )}
      </div>

      <Modal
        title={editing ? '编辑分类' : '新建分类'}
        open={editOpen}
        onCancel={() => setEditOpen(false)}
        onOk={onSave}
        width={520}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="名称" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item name="parent_id" label="父分类">
            <Select
              allowClear
              placeholder="不选则为顶级分类"
              options={(() => {
                const out: any[] = []
                const walk = (nodes: Category[], prefix = '') => {
                  for (const n of nodes) {
                    if (editing && n.id === editing.id) continue
                    out.push({ value: n.id, label: prefix + n.name })
                    if (n.children?.length) walk(n.children, prefix + '— ')
                  }
                }
                walk(tree)
                return out
              })()}
            />
          </Form.Item>
          <Space>
            <Form.Item name="icon" label="图标">
              <Input placeholder="antd icon name" />
            </Form.Item>
            <Form.Item name="color" label="颜色" initialValue="#1677ff">
              <ColorPicker />
            </Form.Item>
            <Form.Item name="sort_order" label="排序" initialValue={0}>
              <Input type="number" style={{ width: 120 }} />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </div>
  )
}
