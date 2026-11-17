import type { ReactNode } from 'react';
import { Tooltip } from 'antd';

/**
 * 一个「按住了也能解释自己」的提示。
 *
 * ## 为什么需要它
 *
 * 浏览器不给 `disabled` 的表单控件派发鼠标事件——鼠标停在被禁用的
 * `<button>` 上，`mouseenter` 什么也不会发生。而 antd 的 Tooltip 是把鼠标
 * 事件**直接挂在子节点**上的，所以 Tooltip 包着一个禁用按钮时，提示会跟着
 * 按钮一起消失：按钮变灰了，人却不知道为什么。
 *
 * 而「为什么是灰的」恰恰是禁用按钮唯一需要说的事。
 *
 * 于是提示改挂在一层 `<span>` 上：span 本身不禁用，鼠标事件照常触发，提示
 * 就还在。span 是 `inline-block`，按钮的排版不变。
 *
 * ## 用法
 *
 * ```tsx
 * <Hint title={canWrite ? '新增' : hint}>
 *   <Button disabled={!canWrite}>新增</Button>
 * </Hint>
 * ```
 *
 * `title` 传 `null` 表示不显示提示——这时也照样渲染那层 span，免得同一个
 * 位置在「能写」和「不能写」两种状态下长出两套 DOM。
 */
export interface HintProps {
  /** 提示语；`null` 表示不显示。 */
  title: string | null;
  /** 被提示的内容——通常是一个按钮。 */
  children: ReactNode;
}

export default function Hint({ title, children }: HintProps): JSX.Element {
  return (
    <Tooltip title={title ?? undefined}>
      <span style={{ display: 'inline-block' }}>{children}</span>
    </Tooltip>
  );
}
