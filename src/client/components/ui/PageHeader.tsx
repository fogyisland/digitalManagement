import type { ReactNode } from 'react';
import { Typography } from 'antd';
import { tokens } from '@/theme/tokens';

const { Title, Text } = Typography;

export interface PageHeaderProps {
  /** Page name — the only h2 on the page. */
  title: ReactNode;
  /** One line of context under the title (counts, hints, status). */
  subtitle?: ReactNode;
  /** Actions, buttons or filters aligned to the trailing edge. */
  extra?: ReactNode;
}

/**
 * The page masthead.
 *
 * Every page repeated the same `<header>` + `<Title level={2}>` + `<Text>`
 * block, with the title size, weight and letter-spacing copy-pasted. This
 * renders the house style once.
 *
 * The title is an `h2` on purpose: the layout owns the `h1` (it does not
 * have one yet — see `MainLayout`), and heading levels should describe the
 * document outline rather than the component tree.
 */
export default function PageHeader({
  title,
  subtitle,
  extra,
}: PageHeaderProps): JSX.Element {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: tokens.space[4],
      }}
    >
      <div style={{ minWidth: 0 }}>
        <Title
          level={2}
          style={{
            margin: 0,
            color: tokens.color.text,
            fontWeight: tokens.fontWeight.semibold,
            fontSize: tokens.fontSize['2xl'],
            letterSpacing: '-0.01em',
            lineHeight: 1.2,
          }}
        >
          {title}
        </Title>
        {subtitle ? (
          <Text
            style={{
              display: 'block',
              marginTop: tokens.space[1],
              color: tokens.color.textMuted,
              fontSize: tokens.fontSize.base,
            }}
          >
            {subtitle}
          </Text>
        ) : null}
      </div>
      {extra ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: tokens.space[3],
            flexWrap: 'wrap',
          }}
        >
          {extra}
        </div>
      ) : null}
    </header>
  );
}
