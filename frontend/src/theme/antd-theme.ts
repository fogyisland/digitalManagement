import { theme as antdTheme } from 'antd';
import { tokens } from './tokens';

/**
 * AntD ConfigProvider theme for the DAM site.
 *
 * Wired into the dark algorithm because the entire palette is dark.
 * Component-level overrides only target the surfaces we control
 * (Layout, Menu, Button); everything else inherits from `token`.
 */
export const damTheme = {
  algorithm: antdTheme.darkAlgorithm,
  token: {
    colorPrimary: tokens.color.accent,
    colorSuccess: tokens.color.success,
    colorError: tokens.color.danger,
    colorBgBase: tokens.color.bg,
    colorBgContainer: tokens.color.panel,
    colorBgElevated: tokens.color.panelAlt,
    colorBorder: tokens.color.border,
    colorText: tokens.color.text,
    colorTextSecondary: tokens.color.textMuted,
    fontFamily: tokens.font.base,
    borderRadius: tokens.radius.md,
  },
  components: {
    Layout: {
      headerBg: tokens.color.panel,
      siderBg: tokens.color.bg,
      bodyBg: tokens.color.bg,
    },
    Menu: {
      itemBg: 'transparent',
      itemSelectedBg: 'rgba(245, 165, 36, 0.12)',
      itemSelectedColor: tokens.color.accent,
      itemHoverBg: 'rgba(245, 165, 36, 0.06)',
    },
    Button: {
      primaryShadow: 'none',
      defaultBg: tokens.color.panel,
    },
  },
};

export type DamTheme = typeof damTheme;
