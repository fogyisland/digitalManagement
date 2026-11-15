import type { ReactNode } from 'react';
import { tokens } from '@/theme/tokens';

export type PillTone = 'neutral' | 'accent' | 'success' | 'danger' | 'info';

export interface PillProps {
  /** The value to display. */
  value: ReactNode;
  /** Semantic colour of the pill. */
  tone?: PillTone;
  /** Render the value in the mono font (ids, roles, raw enum values). */
  mono?: boolean;
}

const TONE_COLORS: Record<PillTone, { fg: string; bg: string }> = {
  neutral: { fg: tokens.color.textMuted, bg: tokens.color.bgAlt },
  accent: { fg: tokens.color.accent, bg: tokens.color.accentWash },
  success: { fg: tokens.color.success, bg: tokens.color.successSoft },
  danger: { fg: tokens.color.danger, bg: tokens.color.dangerWash },
  info: { fg: tokens.color.text, bg: tokens.color.panelAlt },
};

/**
 * A small status/label chip.
 *
 * Two pages had their own private version of this — `Users.tsx` drew an
 * outlined pill, `Settings.tsx` a filled one — for the same "here is a role"
 * job. One component, one look.
 */
export default function Pill({
  value,
  tone = 'neutral',
  mono = false,
}: PillProps): JSX.Element {
  const colors = TONE_COLORS[tone];
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '1px 10px',
        borderRadius: tokens.radius.sm,
        fontSize: tokens.fontSize.sm,
        fontFamily: mono ? tokens.font.mono : tokens.font.base,
        background: colors.bg,
        color: colors.fg,
        lineHeight: '18px',
      }}
    >
      {value}
    </span>
  );
}
