/**
 * 夹具：提示直接挂在被按住的按钮上。
 *
 * 这是 antd 的 Tooltip 最自然的写法，也是这条规则要抓住的那种——提示挂在
 * 按钮自己身上，而浏览器不给被禁用的控件派发鼠标事件，于是提示消失。
 */

import type { ReactNode } from 'react';
import { Tooltip } from 'antd';

export default function BadHint({ title, children }: { title: string | null; children: ReactNode }): JSX.Element {
  return (
    <Tooltip title={title ?? undefined}>
      {children}
    </Tooltip>
  );
}
