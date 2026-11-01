/**
 * Design tokens for the unified DAM site.
 *
 * Single source of truth for color, type, radius and spacing values.
 * Consumed by `antd-theme.ts` (AntD ConfigProvider) and `styles/global.css`
 * (CSS custom properties). Keep numeric values aligned with the brief —
 * changing them here cascades through both consumers.
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
  },
  font: {
    base: '"Inter", -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif',
    mono: '"JetBrains Mono", "SF Mono", "Cascadia Mono", Consolas, monospace',
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
} as const;

export type DesignTokens = typeof tokens;
export type ColorTokens = typeof tokens.color;
export type FontTokens = typeof tokens.font;
export type RadiusTokens = typeof tokens.radius;
export type SpaceTokens = typeof tokens.space;
