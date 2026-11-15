import type { CSSProperties, ReactNode } from 'react';
import { tokens } from '@/theme/tokens';

export interface PanelProps {
  children: ReactNode;
  /**
   * Semantic element to render. `section` by default — a panel usually
   * groups one topic of a page and deserves a landmark.
   */
  as?: 'div' | 'section' | 'article' | 'aside';
  /**
   * Optional heading rendered above the content. Pass a node — the page
   * decides whether it is an icon + label, a count, or a plain string.
   */
  title?: ReactNode;
  /** Drop the default inner padding (for panels that hold their own gutters). */
  flush?: boolean;
  /** Draw the 2px accent rule on the leading edge. */
  accent?: boolean;
  /** Override the surface colour, e.g. a recessed panel. */
  tone?: 'panel' | 'sunken';
  style?: CSSProperties;
  className?: string;
}

/**
 * The standard content surface.
 *
 * Every page in the app used to hand-roll the same four inline style
 * properties (`background: panel`, `border: 1px solid border`,
 * `borderRadius: radius.lg`, `padding: space[4]`). They drifted apart
 * subtly — some pages used `panelAlt`, some forgot the padding — which is
 * why this component exists. Tokens stay the single source of truth; this
 * just applies them consistently.
 */
export default function Panel({
  children,
  as = 'section',
  title,
  flush = false,
  accent = false,
  tone = 'panel',
  style,
  className,
}: PanelProps): JSX.Element {
  const Tag = as;
  return (
    <Tag
      className={className}
      style={{
        background: tone === 'sunken' ? tokens.color.surfaceSunken : tokens.color.panel,
        border: `1px solid ${tokens.color.border}`,
        ...(accent ? { borderLeft: `2px solid ${tokens.color.accent}` } : null),
        borderRadius: tokens.radius.lg,
        ...(flush ? null : { padding: tokens.space[4] }),
        ...style,
      }}
    >
      {title ? (
        <div
          style={{
            marginBottom: tokens.space[3],
            paddingBottom: tokens.space[3],
            borderBottom: `1px solid ${tokens.color.border}`,
            fontSize: tokens.fontSize.md,
            fontWeight: tokens.fontWeight.semibold,
            color: tokens.color.text,
          }}
        >
          {title}
        </div>
      ) : null}
      {children}
    </Tag>
  );
}
