import { theme as antdTheme } from 'antd';
import { tokens } from './tokens';

/**
 * AntD ConfigProvider theme for the DAM site.
 *
 * Wired into the dark algorithm because the entire palette is dark.
 * The `token` block sets the global scale (type, radius, control height,
 * surfaces); the `components` block tunes the surfaces we actually own.
 *
 * Every colour here comes from `tokens.ts` — including the translucent
 * washes, which used to be written as raw `rgba(245, 165, 36, …)` strings
 * spread across the component overrides.
 */
export const damTheme = {
  algorithm: antdTheme.darkAlgorithm,
  token: {
    colorPrimary: tokens.color.accent,
    colorSuccess: tokens.color.success,
    colorError: tokens.color.danger,
    colorInfo: tokens.color.accent,
    colorLink: tokens.color.accent,
    colorLinkHover: tokens.color.accentHover,

    colorBgBase: tokens.color.bg,
    colorBgContainer: tokens.color.panel,
    colorBgElevated: tokens.color.panelAlt,
    colorBgLayout: tokens.color.bg,
    colorBgTextHover: tokens.color.panelAlt,

    colorBorder: tokens.color.border,
    colorBorderSecondary: tokens.color.border,

    colorText: tokens.color.text,
    colorTextSecondary: tokens.color.textMuted,
    colorTextTertiary: tokens.color.textMuted,
    colorTextPlaceholder: tokens.color.textMuted,

    colorFillSecondary: tokens.color.bgAlt,
    colorFillTertiary: tokens.color.bgAlt,

    fontFamily: tokens.font.base,
    fontFamilyCode: tokens.font.mono,
    fontSize: tokens.fontSize.base,
    fontSizeSM: tokens.fontSize.sm,
    fontSizeLG: tokens.fontSize.md,
    fontSizeHeading1: tokens.fontSize['3xl'],
    fontSizeHeading2: tokens.fontSize['2xl'],
    fontSizeHeading3: tokens.fontSize.xl,
    fontSizeHeading4: tokens.fontSize.lg,
    fontWeightStrong: tokens.fontWeight.semibold,

    borderRadius: tokens.radius.md,
    borderRadiusSM: tokens.radius.sm,
    borderRadiusLG: tokens.radius.lg,

    controlHeight: 34,
    controlHeightSM: 26,
    controlHeightLG: 40,

    motionDurationFast: tokens.motion.fast,
    motionDurationMid: tokens.motion.base,
  },
  components: {
    Layout: {
      headerBg: tokens.color.panel,
      siderBg: tokens.color.bgAlt,
      bodyBg: tokens.color.bg,
    },
    Menu: {
      itemBg: 'transparent',
      itemSelectedBg: tokens.color.accentSoft,
      itemSelectedColor: tokens.color.accent,
      itemHoverBg: tokens.color.accentFaint,
      itemHoverColor: tokens.color.text,
      groupTitleColor: tokens.color.textMuted,
      iconSize: 15,
      itemHeight: 38,
      itemMarginInline: tokens.space[2],
    },
    Button: {
      primaryShadow: 'none',
      defaultBg: tokens.color.panelAlt,
      defaultBorderColor: tokens.color.border,
      defaultShadow: 'none',
      dangerShadow: 'none',
      paddingInline: tokens.space[4],
    },
    Card: {
      colorBgContainer: tokens.color.panel,
      headerBg: 'transparent',
      headerFontSize: tokens.fontSize.md,
    },
    Table: {
      headerBg: tokens.color.bgAlt,
      headerColor: tokens.color.textMuted,
      headerSplitColor: 'transparent',
      borderColor: tokens.color.border,
      rowHoverBg: tokens.color.bgAlt,
      cellPaddingBlock: tokens.space[3],
    },
    Modal: {
      contentBg: tokens.color.panel,
      headerBg: 'transparent',
      titleColor: tokens.color.text,
    },
    Drawer: {
      colorBgElevated: tokens.color.panel,
    },
    Tabs: {
      itemSelectedColor: tokens.color.accent,
      itemHoverColor: tokens.color.text,
      inkBarColor: tokens.color.accent,
      titleFontSize: tokens.fontSize.base,
    },
    Segmented: {
      itemSelectedBg: tokens.color.panelAlt,
      trackBg: tokens.color.bgAlt,
    },
    Input: {
      colorBgContainer: tokens.color.bgAlt,
      activeBorderColor: tokens.color.accent,
      hoverBorderColor: tokens.color.borderStrong,
    },
    InputNumber: {
      colorBgContainer: tokens.color.bgAlt,
      activeBorderColor: tokens.color.accent,
    },
    Select: {
      colorBgContainer: tokens.color.bgAlt,
      optionSelectedBg: tokens.color.accentSoft,
    },
    Form: {
      labelColor: tokens.color.textMuted,
      verticalLabelPadding: `0 0 ${tokens.space[1]}px`,
    },
    Empty: {
      colorTextDescription: tokens.color.textMuted,
    },
    Skeleton: {
      colorFillSecondary: tokens.color.panelAlt,
    },
    Popconfirm: {
      colorBgElevated: tokens.color.panelAlt,
    },
    Tooltip: {
      colorBgSpotlight: tokens.color.panelAlt,
    },
    Dropdown: {
      colorBgElevated: tokens.color.panelAlt,
    },
    Statistic: {
      contentFontSize: tokens.fontSize['3xl'],
    },
    Tag: {
      defaultBg: tokens.color.bgAlt,
      defaultColor: tokens.color.text,
    },
  },
};

export type DamTheme = typeof damTheme;
