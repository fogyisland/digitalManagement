import { Menu } from 'antd'
import type { MenuProps } from 'antd'
import {
  AppstoreOutlined,
  TagsOutlined,
  FolderOutlined,
  KeyOutlined,
  CloudUploadOutlined,
  DashboardOutlined,
  TeamOutlined,
  SettingOutlined,
} from '@ant-design/icons'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/stores/authStore'
import { useAppStore } from '@/stores/appStore'

export default function Sidebar() {
  const navigate = useNavigate()
  const location = useLocation()
  const collapsed = useAppStore((s) => s.sidebarCollapsed)
  const user = useAuthStore((s) => s.user)

  const items: MenuProps['items'] = [
    { key: '/', icon: <DashboardOutlined />, label: '仪表盘' },
    { key: '/assets', icon: <AppstoreOutlined />, label: '资产库' },
    { key: '/assets/upload', icon: <CloudUploadOutlined />, label: '上传资产' },
    { type: 'divider' },
    { key: '/categories', icon: <FolderOutlined />, label: '分类管理' },
    { key: '/tags', icon: <TagsOutlined />, label: '标签管理' },
    { key: '/api-keys', icon: <KeyOutlined />, label: 'API Key' },
  ]

  if (user?.role === 'admin') {
    items.push({ type: 'divider' })
    items.push({ key: '/users', icon: <TeamOutlined />, label: '用户管理' })
  }

  items.push({ type: 'divider' })
  items.push({ key: '/settings', icon: <SettingOutlined />, label: '设置' })

  // Determine selected key based on current path
  const selectedKey = (() => {
    const p = location.pathname
    if (p === '/') return '/'
    if (p.startsWith('/assets/upload')) return '/assets/upload'
    if (p.startsWith('/assets')) return '/assets'
    if (p.startsWith('/categories')) return '/categories'
    if (p.startsWith('/tags')) return '/tags'
    if (p.startsWith('/api-keys')) return '/api-keys'
    if (p.startsWith('/users')) return '/users'
    if (p.startsWith('/settings')) return '/settings'
    return p
  })()

  return (
    <>
      <div className="logo">
        <div className="logo-icon">D</div>
        {!collapsed && <span>DAM</span>}
      </div>
      <Menu
        theme="dark"
        mode="inline"
        selectedKeys={[selectedKey]}
        items={items}
        onClick={({ key }) => navigate(key)}
        style={{ borderRight: 0, paddingTop: 8 }}
      />
    </>
  )
}
