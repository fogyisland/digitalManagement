import { useMemo } from 'react';
import {
  Avatar,
  Breadcrumb,
  Dropdown,
  Input,
  Layout,
  Menu,
  Space,
  Typography,
  type MenuProps,
} from 'antd';
import {
  AppstoreOutlined,
  ClusterOutlined,
  DashboardOutlined,
  ImportOutlined,
  KeyOutlined,
  LogoutOutlined,
  ProfileOutlined,
  SearchOutlined,
  SettingOutlined,
  TeamOutlined,
  UserOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { tokens } from '@/theme/tokens';

const { Sider, Header, Content } = Layout;
const { Text } = Typography;

const SIDEBAR_WIDTH = 240;
const TOPBAR_HEIGHT = 56;

interface NavEntry {
  key: string;
  path: string;
  label: string;
  icon: React.ReactNode;
}

interface NavGroup {
  key: string;
  label: string;
  entries: NavEntry[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    key: 'create',
    label: '创作',
    entries: [
      { key: 'dashboard', path: '/', label: '仪表盘', icon: <DashboardOutlined /> },
      { key: 'library', path: '/library', label: '资产库', icon: <AppstoreOutlined /> },
      { key: 'import', path: '/import', label: '导入', icon: <ImportOutlined /> },
      { key: 'jobs', path: '/jobs', label: '任务', icon: <VideoCameraOutlined /> },
    ],
  },
  {
    key: 'manage',
    label: '管理',
    entries: [
      { key: 'organize', path: '/organize', label: '分类与标签', icon: <ClusterOutlined /> },
      { key: 'integrations', path: '/integrations', label: '集成', icon: <KeyOutlined /> },
    ],
  },
  {
    key: 'settings',
    label: '设置',
    entries: [
      { key: 'settings', path: '/settings', label: '偏好', icon: <SettingOutlined /> },
    ],
  },
];

/**
 * Match the current pathname against nav entries. Library detail
 * (`/library/:id`) should highlight the Library entry, not fall through.
 */
function matchNavPath(pathname: string): { selectedKey: string; parentKey: string | null } {
  for (const group of NAV_GROUPS) {
    for (const entry of group.entries) {
      if (entry.path === '/' && pathname === '/') {
        return { selectedKey: entry.key, parentKey: group.key };
      }
      if (entry.path !== '/' && (pathname === entry.path || pathname.startsWith(`${entry.path}/`))) {
        return { selectedKey: entry.key, parentKey: group.key };
      }
    }
  }
  return { selectedKey: '', parentKey: null };
}

function buildMenuItems(isAdmin: boolean): MenuProps['items'] {
  const items: NonNullable<MenuProps['items']> = [];
  NAV_GROUPS.forEach((group, index) => {
    if (index > 0) {
      items.push({ type: 'divider' });
    }
    items.push({
      type: 'group',
      key: group.key,
      label: group.label,
      children: group.entries.map((entry) => ({
        key: entry.key,
        icon: entry.icon,
        label: entry.label,
      })),
    });
  });
  if (isAdmin) {
    items.push({ type: 'divider' });
    items.push({
      type: 'group',
      key: 'admin',
      label: '系统',
      children: [
        { key: 'users', icon: <TeamOutlined />, label: '用户管理' },
      ],
    });
  }
  return items;
}

function findEntryByKey(key: string): { path: string; label: string } | null {
  for (const group of NAV_GROUPS) {
    for (const entry of group.entries) {
      if (entry.key === key) return { path: entry.path, label: entry.label };
    }
  }
  if (key === 'users') return { path: '/users', label: '用户管理' };
  return null;
}

function buildBreadcrumbItems(pathname: string, isAdmin: boolean) {
  const trail: { label: string; path: string }[] = [{ label: '首页', path: '/' }];
  if (pathname === '/') return trail.map((item, index) => renderCrumb(item, index, pathname));

  const segments = pathname.split('/').filter(Boolean);
  let accumulated = '';
  segments.forEach((segment) => {
    accumulated += `/${segment}`;
    if (segment === 'library' && pathname.startsWith('/library/')) {
      trail.push({ label: '资产库', path: '/library' });
      return;
    }
    if (pathname.startsWith('/library/')) {
      trail.push({ label: '资产详情', path: pathname });
      return;
    }
    const entry = (() => {
      for (const group of NAV_GROUPS) {
        for (const e of group.entries) {
          if (e.path === accumulated || (e.path !== '/' && accumulated.startsWith(`${e.path}/`))) {
            return { path: e.path, label: e.label };
          }
        }
      }
      if (isAdmin && accumulated === '/users') return { path: '/users', label: '用户管理' };
      return null;
    })();
    if (entry) {
      trail.push(entry);
    } else {
      trail.push({ label: segment, path: accumulated });
    }
  });

  return trail.map((item, index) => renderCrumb(item, index, pathname));
}

function renderCrumb(item: { label: string; path: string }, index: number, current: string) {
  const isLast = current === item.path || (item.path === '/' && current === '/');
  return {
    title: isLast ? (
      <Text style={{ color: tokens.color.text }}>{item.label}</Text>
    ) : (
      <a href={item.path} style={{ color: tokens.color.textMuted }}>{item.label}</a>
    ),
    key: `${index}-${item.path}`,
  };
}

export default function MainLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const isAdmin = user?.role === 'admin';

  const { selectedKey, parentKey } = useMemo(
    () => matchNavPath(location.pathname),
    [location.pathname],
  );

  const menuItems = useMemo(() => buildMenuItems(isAdmin), [isAdmin]);
  const breadcrumbItems = useMemo(
    () => buildBreadcrumbItems(location.pathname, isAdmin),
    [location.pathname, isAdmin],
  );

  const openKeys = parentKey ? [parentKey] : [];

  const onMenuClick: MenuProps['onClick'] = ({ key }) => {
    const entry = findEntryByKey(key);
    if (entry) navigate(entry.path);
  };

  const onLogout = () => {
    logout();
    navigate('/login');
  };

  const userMenuItems: MenuProps['items'] = [
    {
      key: 'identity',
      icon: <UserOutlined />,
      label: user?.display_name || user?.username || '未登录',
      disabled: true,
    },
    { type: 'divider' },
    {
      key: 'settings',
      icon: <SettingOutlined />,
      label: '偏好设置',
      onClick: () => navigate('/settings'),
    },
    {
      key: 'profile',
      icon: <ProfileOutlined />,
      label: '用户管理',
      onClick: () => navigate('/users'),
    },
    { type: 'divider' },
    { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', danger: true, onClick: onLogout },
  ];

  return (
    <Layout style={{ minHeight: '100vh', background: tokens.color.bg }}>
      <Sider
        width={SIDEBAR_WIDTH}
        collapsedWidth={SIDEBAR_WIDTH}
        breakpoint="lg"
        theme="dark"
        style={{
          background: tokens.color.bgAlt,
          borderRight: `1px solid ${tokens.color.border}`,
          overflow: 'hidden',
          height: '100vh',
          position: 'sticky',
          top: 0,
        }}
      >
        <div
          style={{
            height: TOPBAR_HEIGHT,
            display: 'flex',
            alignItems: 'center',
            padding: `0 ${tokens.space[4]}px`,
            borderBottom: `1px solid ${tokens.color.border}`,
            color: tokens.color.text,
          }}
        >
          <div
            aria-hidden
            style={{
              width: 28,
              height: 28,
              borderRadius: tokens.radius.md,
              background: `linear-gradient(135deg, ${tokens.color.accent} 0%, ${tokens.color.comfyui} 100%)`,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 700,
              color: '#0d1117',
              marginRight: tokens.space[3],
            }}
          >
            D
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>DAM</span>
            <span style={{ fontSize: 11, color: tokens.color.textMuted }}>数字资产平台</span>
          </div>
        </div>
        <Menu
          mode="inline"
          theme="dark"
          items={menuItems}
          selectedKeys={selectedKey ? [selectedKey] : []}
          defaultOpenKeys={openKeys}
          openKeys={openKeys}
          onClick={onMenuClick}
          style={{
            background: 'transparent',
            borderInlineEnd: 0,
            paddingTop: tokens.space[2],
          }}
        />
      </Sider>
      <Layout style={{ background: tokens.color.bg }}>
        <Header
          style={{
            height: TOPBAR_HEIGHT,
            lineHeight: `${TOPBAR_HEIGHT}px`,
            padding: `0 ${tokens.space[5]}px`,
            background: tokens.color.panel,
            borderBottom: `1px solid ${tokens.color.border}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            position: 'sticky',
            top: 0,
            zIndex: 10,
          }}
        >
          <Breadcrumb
            items={breadcrumbItems}
            style={{ lineHeight: `${TOPBAR_HEIGHT}px` }}
          />
          <Space size="middle">
            <Input
              placeholder="搜索资产、标签、用户…"
              prefix={<SearchOutlined style={{ color: tokens.color.textMuted }} />}
              allowClear
              style={{
                width: 280,
                background: tokens.color.bgAlt,
                borderColor: tokens.color.border,
              }}
              onPressEnter={(e) => {
                const value = (e.target as HTMLInputElement).value.trim();
                if (value) navigate(`/library?q=${encodeURIComponent(value)}`);
              }}
            />
            <Dropdown menu={{ items: userMenuItems }} placement="bottomRight">
              <Space style={{ cursor: 'pointer' }}>
                <Avatar
                  size="small"
                  src={user?.avatar_url ?? undefined}
                  style={{
                    background: `linear-gradient(135deg, ${tokens.color.accent}, ${tokens.color.comfyui})`,
                    color: '#0d1117',
                    fontWeight: 600,
                  }}
                >
                  {(user?.display_name?.[0] ?? user?.username?.[0] ?? 'U').toUpperCase()}
                </Avatar>
                <span style={{ color: tokens.color.text }}>
                  {user?.display_name || user?.username || '未登录'}
                </span>
              </Space>
            </Dropdown>
          </Space>
        </Header>
        <Content
          className="dam-section-rule"
          style={{
            margin: tokens.space[5],
            padding: tokens.space[5],
            background: tokens.color.panel,
            borderRadius: tokens.radius.lg,
            border: `1px solid ${tokens.color.border}`,
            minHeight: `calc(100vh - ${TOPBAR_HEIGHT}px - ${tokens.space[5] * 2}px)`,
          }}
        >
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
