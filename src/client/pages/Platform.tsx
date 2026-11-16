/**
 * Platform — the platform console.
 *
 * One layer above the tenants. It answers two questions and nothing else:
 * how many tenants the platform has and what they are called, and what the
 * account standing here may hand to an AI client.
 *
 * The console has no tenant of its own — a session that came through the
 * platform door is not narrowed to one — so there is no tenant picker here.
 * The tenant registry below is the whole platform, and the header says so.
 */
import { useEffect, useState } from 'react';
import { Button, Tabs, Typography } from 'antd';
import {
  ApartmentOutlined,
  DashboardOutlined,
  ExportOutlined,
  FileTextOutlined,
  GlobalOutlined,
  LineChartOutlined,
  LogoutOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { useTenantStore } from '@/stores/tenantStore';
import { tokens } from '@/theme/tokens';
import Tenants from './Tenants';
import Mcp from './Mcp';
import Overview from './platform/Overview';
import Accounts from './platform/Accounts';
import Audit from './platform/Audit';
import Requests from './platform/Requests';
import Settings from './platform/Settings';

const { Text } = Typography;

export default function Platform(): JSX.Element {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const [tab, setTab] = useState('overview');

  useEffect(() => {
    // The platform layer sits above the tenants. A session that arrived
    // through the platform door must not carry a tenant selection with it,
    // or every request it makes would be narrowed to a single tenant.
    useTenantStore.getState().setTenantId(null);
  }, []);

  const onLogout = (): void => {
    logout();
    navigate('/platform/login', { replace: true });
  };

  return (
    <div style={{ minHeight: '100vh', background: tokens.color.bg, color: tokens.color.text }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.space[4],
          flexWrap: 'wrap',
          padding: `${tokens.space[3]} ${tokens.space[5]}`,
          borderBottom: `1px solid ${tokens.color.border}`,
          background: tokens.color.bgAlt,
        }}
      >
        <div
          aria-hidden
          style={{
            width: 32,
            height: 32,
            borderRadius: tokens.radius.md,
            background: `linear-gradient(135deg, ${tokens.color.accent} 0%, ${tokens.color.comfyui} 100%)`,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: tokens.fontWeight.bold,
            color: tokens.color.bg,
            fontSize: 15,
          }}
        >
          D
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
          <span style={{ fontWeight: tokens.fontWeight.semibold, fontSize: tokens.fontSize.lg }}>
            平台管理
          </span>
          <Text style={{ color: tokens.color.textMuted, fontSize: tokens.fontSize.xs }}>
            当前作用域：全部租户
          </Text>
        </div>

        <div style={{ flex: 1 }} />

        <div style={{ display: 'flex', alignItems: 'center', gap: tokens.space[2] }}>
          <Text style={{ color: tokens.color.textMuted, fontSize: tokens.fontSize.sm }}>
            {user?.display_name || user?.username || '未登录'}
          </Text>
          <Button
            icon={<ExportOutlined />}
            onClick={() => navigate('/')}
            title="进入某个租户的资产库"
          >
            进入资产库
          </Button>
          <Button icon={<LogoutOutlined />} onClick={onLogout}>
            退出
          </Button>
        </div>
      </header>

      <main
        style={{
          padding: tokens.space[5],
          maxWidth: tokens.layout.contentMaxWidth,
          margin: '0 auto',
          width: '100%',
          boxSizing: 'border-box',
        }}
      >
        <Tabs
          activeKey={tab}
          onChange={setTab}
          items={[
            {
              key: 'overview',
              label: (
                <span>
                  <DashboardOutlined style={{ marginRight: 6 }} />
                  总览
                </span>
              ),
              children: <Overview />,
            },
            {
              key: 'tenants',
              label: (
                <span>
                  <ApartmentOutlined style={{ marginRight: 6 }} />
                  租户
                </span>
              ),
              children: <Tenants />,
            },
            {
              key: 'accounts',
              label: (
                <span>
                  <TeamOutlined style={{ marginRight: 6 }} />
                  账号
                </span>
              ),
              children: <Accounts />,
            },
            {
              key: 'audit',
              label: (
                <span>
                  <FileTextOutlined style={{ marginRight: 6 }} />
                  审计
                </span>
              ),
              children: <Audit />,
            },
            {
              key: 'requests',
              label: (
                <span>
                  <LineChartOutlined style={{ marginRight: 6 }} />
                  调用日志
                </span>
              ),
              children: <Requests />,
            },
            {
              key: 'mcp',
              label: 'MCP 令牌',
              children: <Mcp />,
            },
            {
              key: 'settings',
              label: (
                <span>
                  <GlobalOutlined style={{ marginRight: 6 }} />
                  设置
                </span>
              ),
              children: <Settings />,
            },
          ]}
        />
      </main>
    </div>
  );
}
