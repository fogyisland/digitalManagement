/**
 * 夹具（好的一面）：报错都经由翻译器到达人眼前。
 *
 * 这一份必须一条问题都不报。它把合法的写法都摆了一遍：
 *
 *   - `describeError(e, …)` 直接用；
 *   - `describeError(e, …)` 放在 antd 的 `{ content }` 配置里；
 *   - `toError(e, …).message`；
 *   - 写死的中文（与后端无关）；
 *   - 用状态码挑一句中文，落到 `describeError` 上；
 *   - `console.warn` 里带着错误——控制台不是给人看的面。
 */

import { App } from 'antd';
import { describeError, toError } from '@/utils/errors';

export default function GoodPage(): JSX.Element {
  const { message } = App.useApp();

  async function save(): Promise<void> {
    try {
      await doSave();
    } catch (e: unknown) {
      message.error(describeError(e, '保存失败'));
    }
  }

  async function saveWithConfig(): Promise<void> {
    try {
      await doSave();
    } catch (e: unknown) {
      message.error({ content: describeError(e, '保存失败'), duration: 600 });
    }
  }

  async function saveAsError(): Promise<void> {
    try {
      await doSave();
    } catch (e: unknown) {
      message.error(toError(e, '保存失败').message);
    }
  }

  async function copy(): Promise<void> {
    try {
      await doCopy();
    } catch (e: unknown) {
      console.warn('[good] clipboard write failed:', e);
      message.error('剪贴板不可用，请手动复制');
    }
  }

  async function signIn(): Promise<void> {
    try {
      await doSignIn();
    } catch (e: unknown) {
      const status = (e as { response?: { status?: number } } | null)?.response?.status;
      message.error(
        status === 403
          ? '这个账号是平台管理员，请用页面底部的「平台管理登录」进入'
          : describeError(e, '登录失败'),
      );
    }
  }

  return <button type="button" onClick={() => void save()}>保存</button>;
}

declare function doSave(): Promise<void>;
declare function doCopy(): Promise<void>;
declare function doSignIn(): Promise<void>;
