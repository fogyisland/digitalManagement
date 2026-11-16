import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Avatar,
  Breadcrumb,
  Button,
  Dropdown,
  Input,
  Layout,
  Menu,
  Space,
  Typography,
  type MenuProps,
} from 'antd';
import {
  ApiOutlined,
  AppstoreOutlined,
  BankOutlined,
  ClusterOutlined,
  DashboardOutlined,
  ImportOutlined,
  KeyOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  ProfileOutlined,
  SearchOutlined,
  SettingOutlined,
  TeamOutlined,
  UserOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import TenantSelect from '@/components/layout/TenantSelect';
import { tokens } from '@/theme/tokens';

const { Sider, Header, Content } = Layout;
const { Text } = Typography;

const SIDEBAR_WIDTH = tokens.layout.sidebarWidth;
const TOPBAR_HEIGHT = tokens.layout.topbarHeight;

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

const ADMIN_ENTRY: NavEntry = {
  key: 'users',
  path: '/users',
  label: '用户管理',
  icon: <TeamOutlined />,
};

/**
 * The tenant list is the platform administrator's: it decides how many
 * tenants there are and what they are called.
 *
 * It lives on the platform layer — one level above the tenants — so the entry
 * leaves the app and opens the platform console. That is the point of the
 * layer: the platform administrator acts *on* the tenants, not inside one.
 */
const TENANT_ENTRY: NavEntry = {
  key: 'tenants',
  path: '/platform',
  label: '租户管理',
  icon: <BankOutlined />,
};

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
  if (pathname === ADMIN_ENTRY.path || pathname.startsWith(`${ADMIN_ENTRY.path}/`)) {
    return { selectedKey: ADMIN_ENTRY.key, parentKey: 'admin' };
  }
  if (pathname === TENANT_ENTRY.path || pathname.startsWith(`${TENANT_ENTRY.path}/`)) {
    return { selectedKey: TENANT_ENTRY.key, parentKey: 'admin' };
  }
  return { selectedKey: '', parentKey: null };
}

function buildMenuItems(isAdmin: boolean, isSuperadmin: boolean): MenuProps['items'] {
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
        { key: ADMIN_ENTRY.key, icon: ADMIN_ENTRY.icon, label: ADMIN_ENTRY.label },
        // Only the platform administrator manages the tenants themselves.
        ...(isSuperadmin
          ? [{ key: TENANT_ENTRY.key, icon: TENANT_ENTRY.icon, label: TENANT_ENTRY.label }]
          : []),
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
  if (key === ADMIN_ENTRY.key) return { path: ADMIN_ENTRY.path, label: ADMIN_ENTRY.label };
  if (key === TENANT_ENTRY.key) return { path: TENANT_ENTRY.path, label: TENANT_ENTRY.label };
  return null;
}

/**
 * Build the breadcrumb trail for a pathname.
 *
 * The previous implementation split the path into segments and tried to map
 * each one back onto a nav entry, which produced raw path segments as
 * labels ("/organize/categories" rendered a crumb literally reading
 * "categories"). This walks the known routes instead and falls back to a
 * readable label for anything unknown.
 */
function buildBreadcrumb(pathname: string): { label: string; path: string }[] {
  const trail: { label: string; path: string }[] = [{ label: '首页', path: '/' }];
  if (pathname === '/') return trail;

  const segments = pathname.split('/').filter(Boolean);
  const root = `/${segments[0]}`;

  // Asset detail is the only nested route: 资产库 / 资产详情.
  if (root === '/library' && segments.length > 1) {
    trail.push({ label: '资产库', path: '/library' });
    trail.push({ label: '资产详情', path: pathname });
    return trail;
  }

  const entry = findEntryByKey(
    NAV_GROUPS.flatMap((g) => g.entries).find((e) => e.path === root)?.key ?? '',
  );
  if (entry) {
    trail.push({ label: entry.label, path: entry.path });
    return trail;
  }
  if (root === ADMIN_ENTRY.path) {
    trail.push({ label: ADMIN_ENTRY.label, path: ADMIN_ENTRY.path });
    return trail;
  }
  if (root === TENANT_ENTRY.path) {
    trail.push({ label: TENANT_ENTRY.label, path: TENANT_ENTRY.path });
    return trail;
  }

  // Unknown route (the 404 catch-all) — say so instead of echoing the path.
  trail.push({ label: '页面不存在', path: pathname });
  return trail;
}

export default function MainLayout(): JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  // A platform administrator is at least an administrator: they may manage
  // every tenant, so they may manage the users of every tenant. Hiding the
  // entry from them would leave the role with an API it cannot reach.
  const isAdmin = user?.role === 'admin' || user?.role === 'superadmin';
  // Only a platform administrator has a tenant to pick: everybody else
  // belongs to exactly one tenant and never chooses.
  const isSuperadmin = user?.role === 'superadmin';

  const [collapsed, setCollapsed] = useState(false);
  // Every group starts open: the sidebar only holds seven entries, and
  // making the user click a group to discover "资产库" is pure friction.
  const [openKeys, setOpenKeys] = useState<string[]>(
    NAV_GROUPS.map((g) => g.key).concat(isAdmin ? ['admin'] : []),
  );

  const { selectedKey, parentKey } = useMemo(
    () => matchNavPath(location.pathname),
    [location.pathname],
  );

  const menuItems = useMemo(() => buildMenuItems(isAdmin, isSuperadmin), [isAdmin, isSuperadmin]);
  const breadcrumbItems = useMemo(
    () => buildBreadcrumb(location.pathname),
    [location.pathname],
  );

  // Keep the group that owns the active entry open, even if the user
  // collapsed every group by hand.
  useEffect(() => {
    if (!parentKey) return;
    setOpenKeys((prev) => (prev.includes(parentKey) ? prev : [...prev, parentKey]));
  }, [parentKey]);

  // A new route starts at the top of the page.
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, [location.pathname]);

  const onMenuClick: MenuProps['onClick'] = ({ key }) => {
    const entry = findEntryByKey(key);
    if (entry) navigate(entry.path);
  };

  const onLogout = () => {
    logout();
    navigate('/login');
  };

  const onSearch = (value: string) => {
    const trimmed = value.trim();
    if (trimmed) navigate(`/library?q=${encodeURIComponent(trimmed)}`);
  };

  const displayName = user?.display_name || user?.username || '未登录';

  const userMenuItems: MenuProps['items'] = [
    {
      key: 'identity',
      icon: <UserOutlined />,
      label: displayName,
      disabled: true,
    },
    { type: 'divider' },
    {
      key: 'settings',
      icon: <SettingOutlined />,
      label: '偏好设置',
      onClick: () => navigate('/settings'),
    },
    // The MCP tokens belong to the account itself, so every account gets the
    // entry — it is the account's own credential to manage.
    {
      key: 'mcp',
      icon: <ApiOutlined />,
      label: 'MCP 接入',
      onClick: () => navigate('/mcp-access'),
    },
    // The user table is admin-only — offering the entry to a regular user
    // sent them to a route that bounced straight back to the dashboard.
    ...(isAdmin
      ? [
          {
            key: 'profile',
            icon: <ProfileOutlined />,
            label: '用户管理',
            onClick: () => navigate('/users'),
          },
        ]
      : []),
    { type: 'divider' },
    { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', danger: true, onClick: onLogout },
  ];

  const toggleCollapsed = useCallback(() => setCollapsed((c) => !c), []);

  return (
    <Layout style={{ minHeight: '100vh', background: tokens.color.bg }}>
      <Sider
        width={SIDEBAR_WIDTH}
        collapsedWidth={0}
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        onBreakpoint={(broken) => setCollapsed(broken)}
        breakpoint="lg"
        theme="dark"
        trigger={null}
        style={{
          background: tokens.color.bgAlt,
          borderRight: `1px solid ${tokens.color.border}`,
          overflow: 'auto',
          height: '100vh',
          position: 'sticky',
          top: 0,
          alignSelf: 'flex-start',
          zIndex: 20,
        }}
      >
        <div
          style={{
            minHeight: TOPBAR_HEIGHT,
            display: 'flex',
            flexDirection: 'column',
            gap: tokens.space[2],
            padding: `${tokens.space[2]}px ${tokens.space[4]}px ${tokens.space[3]}px`,
            borderBottom: `1px solid ${tokens.color.border}`,
            color: tokens.color.text,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', minHeight: 32 }}>
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
                fontWeight: tokens.fontWeight.bold,
                color: tokens.color.bg,
                marginRight: tokens.space[3],
              }}
            >
              D
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
              <span style={{ fontSize: 14, fontWeight: tokens.fontWeight.semibold }}>DAM</span>
              <span style={{ fontSize: 11, color: tokens.color.textMuted }}>数字资产平台</span>
            </div>
          </div>
          {/* The tenant picker lives here, not in the top bar: the bar has to
              hold the breadcrumb, the search and the account menu as well,
              and in a narrow window it cannot hold all of them. The sider's
              width is fixed, so this one always fits. */}
          {isSuperadmin && <TenantSelect />}
        </div>
        <Menu
          mode="inline"
          theme="dark"
          items={menuItems}
          selectedKeys={selectedKey ? [selectedKey] : []}
          openKeys={openKeys}
          onOpenChange={(keys) => setOpenKeys(keys as string[])}
          onClick={onMenuClick}
          style={{
            background: 'transparent',
            borderInlineEnd: 0,
            paddingTop: tokens.space[2],
            paddingBottom: tokens.space[5],
          }}
        />
      </Sider>
      <Layout style={{ background: tokens.color.bg, minWidth: 0 }}>
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
            gap: tokens.space[4],
            position: 'sticky',
            top: 0,
            zIndex: 10,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: tokens.space[3], minWidth: 0 }}>
            <Button
              type="text"
              aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}
              aria-expanded={!collapsed}
              icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={toggleCollapsed}
            />
            <Breadcrumb
              items={breadcrumbItems.map((item, index) => {
                const isLast = index === breadcrumbItems.length - 1;
                return {
                  key: `${index}-${item.path}`,
                  title: isLast ? (
                    <Text style={{ color: tokens.color.text }}>{item.label}</Text>
                  ) : (
                    // A router <Link>, not an <a href>: the old markup
                    // triggered a full document reload on every crumb
                    // click, throwing away the in-memory session state.
                    <Link to={item.path} style={{ color: tokens.color.textMuted }}>
                      {item.label}
                    </Link>
                  ),
                };
              })}
              style={{ lineHeight: `${TOPBAR_HEIGHT}px`, minWidth: 0 }}
            />
          </div>
          <Space size="middle">
            <Input.Search
              placeholder="搜索资产、标签…"
              allowClear
              enterButton={false}
              onSearch={onSearch}
              style={{
                width: 240,
                background: tokens.color.bgAlt,
                borderColor: tokens.color.border,
              }}
            />
            <Dropdown menu={{ items: userMenuItems }} placement="bottomRight">
              <Space style={{ cursor: 'pointer' }}>
                <Avatar
                  size="small"
                  style={{
                    background: `linear-gradient(135deg, ${tokens.color.accent}, ${tokens.color.comfyui})`,
                    color: tokens.color.bg,
                    fontWeight: tokens.fontWeight.semibold,
                  }}
                >
                  {(user?.display_name?.[0] ?? user?.username?.[0] ?? 'U').toUpperCase()}
                </Avatar>
                <span style={{ color: tokens.color.text }}>{displayName}</span>
              </Space>
            </Dropdown>
          </Space>
        </Header>
        <Content
          className="dam-content"
          style={{
            margin: tokens.space[5],
            padding: tokens.space[5],
            background: tokens.color.panel,
            borderRadius: tokens.radius.lg,
            border: `1px solid ${tokens.color.border}`,
            maxWidth: tokens.layout.contentMaxWidth,
            width: '100%',
            marginInline: 'auto',
            minHeight: `calc(100vh - ${TOPBAR_HEIGHT}px - ${tokens.space[5] * 2}px)`,
          }}
        >
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
