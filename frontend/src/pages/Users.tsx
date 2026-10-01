import { useEffect, useState } from 'react'
import {
  App,
  Button,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
} from 'antd'
import { DeleteOutlined, EditOutlined, KeyOutlined, PlusOutlined } from '@ant-design/icons'
import { usersApi } from '@/api/users'
import type { User, UserRole, UserStatus } from '@/types'
import { formatDate } from '@/utils/format'

export default function Users() {
  const { message } = App.useApp()
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [editOpen, setEditOpen] = useState(false)
  const [editing, setEditing] = useState<User | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [resetOpen, setResetOpen] = useState<User | null>(null)
  const [createForm] = Form.useForm()
  const [editForm] = Form.useForm()
  const [resetForm] = Form.useForm()

  const load = async () => {
    setLoading(true)
    try {
      const r = await usersApi.list({ keyword: keyword || undefined, page, page_size: 20 })
      setUsers(r.items)
      setTotal(r.total)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [page])

  const onCreate = async () => {
    const v = await createForm.validateFields()
    await usersApi.create(v)
    message.success('已创建')
    setCreateOpen(false)
    createForm.resetFields()
    load()
  }

  const onEdit = (u: User) => {
    setEditing(u)
    editForm.setFieldsValue({
      email: u.email,
      display_name: u.display_name,
      role: u.role,
      status: u.status,
    })
    setEditOpen(true)
  }

  const onSave = async () => {
    if (!editing) return
    const v = await editForm.validateFields()
    await usersApi.update(editing.id, v)
    message.success('已更新')
    setEditOpen(false)
    load()
  }

  const onDelete = async (id: number) => {
    await usersApi.remove(id)
    message.success('已删除')
    load()
  }

  const onReset = async () => {
    if (!resetOpen) return
    const v = await resetForm.validateFields()
    await usersApi.resetPassword(resetOpen.id, v.new_password)
    message.success('密码已重置')
    setResetOpen(null)
    resetForm.resetFields()
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h2 className="page-title">用户管理</h2>
          <div className="page-subtitle">共 {total} 个用户</div>
        </div>
        <Space>
          <Input.Search
            placeholder="搜索用户名/邮箱"
            allowClear
            onSearch={(v) => { setKeyword(v); setPage(1); setTimeout(load, 0) }}
            style={{ width: 240 }}
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            新建用户
          </Button>
        </Space>
      </div>

      <div className="dam-card dam-card-padded">
        <Table
          rowKey="id"
          dataSource={users}
          loading={loading}
          pagination={{
            current: page, total, pageSize: 20, onChange: setPage,
            showSizeChanger: false,
          }}
          locale={{ emptyText: <Empty description="暂无用户" /> }}
          columns={[
            { title: 'ID', dataIndex: 'id', width: 60 },
            { title: '用户名', dataIndex: 'username' },
            { title: '显示名', dataIndex: 'display_name' },
            { title: '邮箱', dataIndex: 'email' },
            {
              title: '角色', dataIndex: 'role', width: 100, render: (r: UserRole) => {
                const color = r === 'admin' ? 'red' : r === 'editor' ? 'blue' : 'default'
                return <Tag color={color}>{r}</Tag>
              },
            },
            {
              title: '状态', dataIndex: 'status', width: 100, render: (s: UserStatus) => (
                <Tag color={s === 'active' ? 'green' : 'red'}>{s}</Tag>
              ),
            },
            { title: '最近登录', dataIndex: 'last_login_at', width: 160, render: (v: string | null) => v ? formatDate(v) : '—' },
            { title: '创建时间', dataIndex: 'created_at', width: 160, render: (v: string) => formatDate(v) },
            {
              title: '操作', width: 160, render: (_: any, u: User) => (
                <Space>
                  <Button size="small" type="text" icon={<EditOutlined />} onClick={() => onEdit(u)} />
                  <Button size="small" type="text" icon={<KeyOutlined />} onClick={() => setResetOpen(u)} title="重置密码" />
                  <Popconfirm title="确认删除？" onConfirm={() => onDelete(u.id)}>
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} disabled={u.is_superuser} />
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </div>

      <Modal title="新建用户" open={createOpen} onCancel={() => setCreateOpen(false)} onOk={onCreate} width={480}>
        <Form form={createForm} layout="vertical" initialValues={{ role: 'viewer' }}>
          <Form.Item name="username" label="用户名" rules={[{ required: true, min: 3, max: 64 }]}>
            <Input />
          </Form.Item>
          <Form.Item name="email" label="邮箱" rules={[{ required: true, type: 'email' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="display_name" label="显示名">
            <Input />
          </Form.Item>
          <Form.Item name="role" label="角色" rules={[{ required: true }]}>
            <Select options={[
              { value: 'admin', label: 'admin · 管理员' },
              { value: 'editor', label: 'editor · 编辑者' },
              { value: 'viewer', label: 'viewer · 查看者' },
            ]} />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true, min: 6 }]}>
            <Input.Password />
          </Form.Item>
        </Form>
      </Modal>

      <Modal title="编辑用户" open={editOpen} onCancel={() => setEditOpen(false)} onOk={onSave} width={480}>
        <Form form={editForm} layout="vertical">
          <Form.Item name="email" label="邮箱" rules={[{ type: 'email' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="display_name" label="显示名">
            <Input />
          </Form.Item>
          <Form.Item name="role" label="角色">
            <Select options={[
              { value: 'admin', label: 'admin · 管理员' },
              { value: 'editor', label: 'editor · 编辑者' },
              { value: 'viewer', label: 'viewer · 查看者' },
            ]} />
          </Form.Item>
          <Form.Item name="status" label="状态">
            <Select options={[
              { value: 'active', label: '启用' },
              { value: 'disabled', label: '禁用' },
              { value: 'locked', label: '锁定' },
            ]} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal title={`重置密码 - ${resetOpen?.username}`} open={!!resetOpen} onCancel={() => setResetOpen(null)} onOk={onReset} width={420}>
        <Form form={resetForm} layout="vertical">
          <Form.Item name="new_password" label="新密码" rules={[{ required: true, min: 6 }]}>
            <Input.Password />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
