/**
 * Design tokens for the unified DAM site.
 *
 * Single source of truth for color, type, radius, spacing, motion and
 * layout values. Consumed by `antd-theme.ts` (AntD ConfigProvider),
 * `styles/global.css` (CSS custom properties) and the shared UI
 * components under `components/ui/`. Keep numeric values aligned with the
 * brief — changing them here cascades through every consumer.
 *
 * Rules for this file:
 *   - No raw hex/rgba outside this module. If a page needs a tint, add a
 *     named token here instead of inlining a colour.
 *   - Purely additive. Existing keys keep their values so the whole app
 *     moves forward without a coordinated rewrite.
 */

export const tokens = {
  color: {
    bg: '#0d1117',
    bgAlt: '#10131a',
    panel: '#161b22',
    panelAlt: '#1c2230',
    border: '#30363d',
    borderStrong: '#484f58',
    text: '#f0f6fc',
    textMuted: '#8b949e',
    accent: '#f5a524',
    accentHover: '#f7b94a',
    success: '#3fb950',
    danger: '#f85149',
    comfyui: '#f78166',
    jobBadge: '#db61a8',

    // ---- semantic surfaces -------------------------------------------
    /** Panel-level surface. Alias of `panel`, named for intent. */
    surface: '#161b22',
    /** Recessed surface nested inside a panel (inputs, code blocks). */
    surfaceSunken: '#0d1117',
    /** Translucent backdrop that sits on top of media (badges, chips). */
    overlay: 'rgba(13, 17, 23, 0.78)',
    /** Softer backdrop used behind hover gradients. */
    overlaySoft: 'rgba(13, 17, 23, 0.92)',
    /** Blurred chip backdrop used over image previews. */
    overlayChip: 'rgba(13, 17, 23, 0.72)',

    // ---- semantic washes ----------------------------------------------
    /** 12% accent wash — selected nav item, active tab. */
    accentSoft: 'rgba(245, 165, 36, 0.12)',
    /** 6% accent wash — hover on an already-selected surface. */
    accentFaint: 'rgba(245, 165, 36, 0.06)',
    /** 10% danger wash — error panels, destructive pills. */
    dangerSoft: 'rgba(248, 81, 73, 0.10)',
    /** 8% danger wash — inline error banners. */
    dangerFaint: 'rgba(248, 81, 73, 0.08)',
    /** 12% success wash — success pills. */
    successSoft: 'rgba(63, 185, 80, 0.12)',
    /** 14% accent wash — the softer variant used by role badges. */
    accentWash: 'rgba(245, 165, 36, 0.14)',
    /** 14% danger wash — the softer variant used by role badges. */
    dangerWash: 'rgba(248, 81, 73, 0.14)',

    /** Focus ring for keyboard navigation. */
    focusRing: '#f5a524',
  },

  font: {
    base: '"Inter", -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif',
    mono: '"JetBrains Mono", "SF Mono", "Cascadia Mono", Consolas, monospace',
  },

  /** Type scale. `base` is the app's body size. */
  fontSize: {
    xs: 11,
    sm: 12,
    base: 13,
    md: 14,
    lg: 16,
    xl: 20,
    '2xl': 26,
    '3xl': 32,
  },

  fontWeight: {
    regular: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
  },

  radius: {
    sm: 4,
    md: 6,
    lg: 8,
  },

  space: {
    1: 4,
    2: 8,
    3: 12,
    4: 16,
    5: 24,
    6: 32,
  },

  shadow: {
    /** Resting elevation for panels and cards. */
    card: '0 1px 2px rgba(1, 4, 9, 0.40)',
    /** Raised elevation for popovers and hovered cards. */
    raised: '0 8px 24px rgba(1, 4, 9, 0.55)',
  },

  /** Transition durations. Keep them short — this is a dense tool UI. */
  motion: {
    fast: '120ms',
    base: '140ms',
  },

  layout: {
    sidebarWidth: 240,
    topbarHeight: 56,
    /** Upper bound for the content column so text lines stay readable. */
    contentMaxWidth: 1600,
  },
} as const;

export type DesignTokens = typeof tokens;
export type ColorTokens = typeof tokens.color;
export type FontTokens = typeof tokens.font;
export type FontSizeTokens = typeof tokens.fontSize;
export type FontWeightTokens = typeof tokens.fontWeight;
export type RadiusTokens = typeof tokens.radius;
export type SpaceTokens = typeof tokens.space;
export type ShadowTokens = typeof tokens.shadow;
export type MotionTokens = typeof tokens.motion;
export type LayoutTokens = typeof tokens.layout;
