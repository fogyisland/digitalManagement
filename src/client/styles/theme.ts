import { theme } from 'antd'

export const lightTheme = {
  algorithm: theme.defaultAlgorithm,
  token: {
    colorPrimary: '#1677ff',
    colorSuccess: '#52c41a',
    colorWarning: '#faad14',
    colorError: '#ff4d4f',
    borderRadius: 8,
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
    fontSize: 14,
    colorBgLayout: '#f5f7fb',
    colorBgContainer: '#ffffff',
    boxShadow: '0 4px 16px rgba(15, 23, 42, 0.06)',
    boxShadowSecondary: '0 1px 2px rgba(0, 0, 0, 0.04)',
  },
  components: {
    Layout: {
      headerBg: 'rgba(255, 255, 255, 0.85)',
      headerHeight: 60,
      bodyBg: '#f5f7fb',
      siderBg: '#0f1a3a',
    },
    Menu: {
      darkItemBg: 'transparent',
      darkSubMenuItemBg: 'transparent',
      darkItemSelectedBg: 'rgba(22, 119, 255, 0.15)',
    },
    Card: {
      borderRadiusLG: 10,
    },
    Button: {
      primaryShadow: '0 2px 8px rgba(22, 119, 255, 0.25)',
    },
    Tag: {
      borderRadiusSM: 4,
    },
  },
}
