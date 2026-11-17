/**
 * 夹具：提示挂在一个被按住的按钮上，但触发者不是它。
 *
 * 这是 `Hint.tsx` 的做法——提示挂在一层不禁用的 span 上，span 收得到鼠标
 * 事件，于是按钮变灰时提示还在。
 */

import type { ReactNode } from 'react';
import { Tooltip } from 'antd';

export default function GoodHint({ title, children }: { title: string | null; children: ReactNode }): JSX.Element {
  return (
    <Tooltip title={title ?? undefined}>
      <span style={{ display: 'inline-block' }}>{children}</span>
    </Tooltip>
  );
}
