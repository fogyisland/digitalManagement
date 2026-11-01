import { Avatar, Badge, Button, Dropdown, Space, Tooltip } from 'antd'
import type { MenuProps } from 'antd'
import {
  BellOutlined,
  FullscreenOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  ReloadOutlined,
  UserOutlined,
  KeyOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/stores/authStore'
import { useAppStore } from '@/stores/appStore'

export default function HeaderBar() {
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  const toggle = useAppStore((s) => s.toggleSidebar)
  const collapsed = useAppStore((s) => s.sidebarCollapsed)

  const onLogout = () => {
    logout()
    navigate('/login')
  }

  const userMenu: MenuProps['items'] = [
    { key: 'profile', icon: <UserOutlined />, label: user?.username, disabled: true },
    { type: 'divider' },
    { key: 'change-password', icon: <KeyOutlined />, label: '修改密码', onClick: () => navigate('/settings') },
    { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', danger: true, onClick: onLogout },
  ]

  const onFullscreen = () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.()
    else document.exitFullscreen?.()
  }

  const onRefresh = () => window.location.reload()

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
      <Space size="middle">
        <Button
          type="text"
          icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
          onClick={toggle}
        />
      </Space>

      <Space size="middle">
        <Tooltip title="刷新页面">
          <Button type="text" icon={<ReloadOutlined />} onClick={onRefresh} />
        </Tooltip>
        <Tooltip title="全屏">
          <Button type="text" icon={<FullscreenOutlined />} onClick={onFullscreen} />
        </Tooltip>
        <Tooltip title="通知">
          <Badge count={0} showZero={false}>
            <Button type="text" icon={<BellOutlined />} />
          </Badge>
        </Tooltip>
        <Dropdown menu={{ items: userMenu }} placement="bottomRight">
          <Space style={{ cursor: 'pointer' }}>
            <Avatar
              size="small"
              style={{ background: 'linear-gradient(135deg, #1677ff, #722ed1)' }}
            >
              {user?.display_name?.[0]?.toUpperCase() || user?.username?.[0]?.toUpperCase()}
            </Avatar>
            <span style={{ color: 'rgba(0,0,0,0.85)' }}>
              {user?.display_name || user?.username}
            </span>
          </Space>
        </Dropdown>
      </Space>
    </div>
  )
}
