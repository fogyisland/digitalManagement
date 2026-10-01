import { Layout } from 'antd'
import { Outlet } from 'react-router-dom'
import Sidebar from './Sidebar'
import HeaderBar from './HeaderBar'
import { useAppStore } from '@/stores/appStore'

const { Content } = Layout

export default function MainLayout() {
  const collapsed = useAppStore((s) => s.sidebarCollapsed)

  return (
    <Layout className="app-layout">
      <Layout.Sider
        className="app-sider"
        width={232}
        collapsedWidth={64}
        collapsed={collapsed}
        trigger={null}
      >
        <Sidebar />
      </Layout.Sider>
      <Layout>
        <Layout.Header className="app-header">
          <HeaderBar />
        </Layout.Header>
        <Layout.Content className="app-content fade-in">
          <Outlet />
        </Layout.Content>
      </Layout>
    </Layout>
  )
}
