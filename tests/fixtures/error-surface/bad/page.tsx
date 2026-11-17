/**
 * 夹具（坏的一面）：后端那句话被原样端到了人眼前。
 *
 * 四种漏法，一个不多一个不少：
 *
 *   1. `message.error(e.message)` —— 直接把错误的话端上去；
 *   2. `message.error(e.response?.data?.detail)` —— 把后端那句英语端上去；
 *   3. 先存进局部变量再端上去 —— 绕得开正则，绕不开语法树；
 *   4. 把它插进模板 —— 错误对象自己会变成一句英语。
 *
 * 这一份必须正好报四条。没有 `bad` 的话，一条再也不报错的规则看起来和一条
 * 正常的规则一模一样。
 */

import { App } from 'antd';

export default function BadPage(): JSX.Element {
  const { message } = App.useApp();

  async function first(): Promise<void> {
    try {
      await doSave();
    } catch (e: unknown) {
      message.error(e.message);
    }
  }

  async function second(): Promise<void> {
    try {
      await doSave();
    } catch (e: unknown) {
      message.error(e.response?.data?.detail);
    }
  }

  async function third(): Promise<void> {
    try {
      await doSave();
    } catch (e: unknown) {
      const detail = e.response?.data?.detail;
      message.error(detail);
    }
  }

  async function fourth(): Promise<void> {
    try {
      await doSave();
    } catch (e: unknown) {
      message.error(`失败：${e}`);
    }
  }

  return <button type="button" onClick={() => void first()}>保存</button>;
}

declare function doSave(): Promise<void>;
