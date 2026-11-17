/**
 * 写入之前，先问一句「现在能写吗」。
 *
 * 平台管理员的账号不属于任何租户：不选租户时，他看到的是**整个平台**，而
 * 写入必须落到**某一个租户**——一行数据总得有个主人。后端会拒这种写入
 * （`TENANT_REQUIRED`），所以前端也得知道这件事：与其把一个注定失败的
 * 按钮摆在那儿，不如把它按住，并告诉人怎么才能写。
 *
 * 规则只有一条：**平台管理员 + 没选租户 = 不能写**。别的账号都有自己
 * 那个租户，写入的落点就是它，不需要多问一句。
 *
 * 租户是谁、选中没选中，都在两个 store 里；这个 hook 只是把这两件事
 * 读成一个「能写 / 不能写」的回答。
 */

import { useAuthStore } from '@/stores/authStore';
import { useTenantStore } from '@/stores/tenantStore';

/** 不能写的时候，告诉人怎么办。 */
export const TENANT_WRITE_HINT = '先在左上角选中一个租户，再写入。';

export interface TenantWriteState {
  /** 现在能不能写。 */
  canWrite: boolean;
  /** 不能写的时候，为什么、怎么办；能写的时候是 null。 */
  hint: string | null;
}

/**
 * 判定本身——不依赖 React，所以能被护栏直接验。
 *
 * 规则只有一条：**平台管理员 + 没选租户 = 不能写**。别的账号都有自己
 * 那个租户，写入的落点就是它，不需要多问一句。
 *
 * @param isSuperadmin 当前账号是不是平台管理员
 * @param tenantId 当前选中的租户；null 表示没选
 * @returns 能不能写，以及不能写时的说法
 */
export function tenantWriteState(
  isSuperadmin: boolean,
  tenantId: string | null,
): TenantWriteState {
  const canWrite = !(isSuperadmin && !tenantId);
  return { canWrite, hint: canWrite ? null : TENANT_WRITE_HINT };
}

/**
 * @returns 能不能写，以及不能写时的说法
 */
export function useTenantWrite(): TenantWriteState {
  const isSuperadmin = useAuthStore((s) => s.user?.role === 'superadmin');
  const tenantId = useTenantStore((s) => s.tenantId);
  return tenantWriteState(isSuperadmin, tenantId);
}
