import { create } from 'zustand'
import { getTenantId, setTenantId as persistTenantId, TENANT_CLEARED_EVENT } from '@/api/client'
import { tenantsApi } from '@/api/tenants'
import { describeError } from '@/utils/errors'
import type { Tenant } from '@/types'

interface TenantState {
  /**
   * 当前选中的租户 id。
   *
   * `null` 表示「不限定租户」——只有平台管理员才有这个选项：他们的读取
   * 默认覆盖整个平台，写入则必须先选中一个租户。
   */
  tenantId: string | null
  /** 平台上的租户清单，由 `GET /tenants` 取回——只有平台管理员拿得到。 */
  tenants: Tenant[]
  /** 清单是否正在取。 */
  loading: boolean
  /** 清单取不到时的原因。 */
  error: string | null
  setTenantId: (tenantId: string | null) => void
  loadTenants: () => Promise<void>
}

/**
 * 租户上下文。
 *
 * ## 单一数据源
 *
 * 选中的租户存在 `localStorage` 的 `dam_tenant_id` 下，由
 * `api/client.ts` 拥有——和两个 token 一样的安排。请求拦截器在发出请求前
 * 读它并加上 `X-Tenant` 头，所以这个 store 只负责**写**和**读回**，
 * 不持有第二份副本：两份副本迟早会漂移，而拦截器看不见漂移的那一份。
 *
 * 这里不用 zustand 的 `persist` 中间件，因为持久化已经在
 * `api/client.ts` 里做完了；再叠一层就是两个存储在写同一个意思。
 */
export const useTenantStore = create<TenantState>()((set, get) => ({
  tenantId: getTenantId(),
  tenants: [],
  loading: false,
  error: null,
  setTenantId: (tenantId: string | null) => {
    persistTenantId(tenantId)
    set({ tenantId })
  },
  /**
   * 取回平台上的租户清单。
   *
   * 清单是**平台级**的：它不受当前选中的租户影响，而且它是用来*选*租户
   * 的——所以它不走 `useApi`（那会在每次切换租户时把整张表重取一遍，而
   * 清单本身并不会因此改变）。
   */
  loadTenants: async () => {
    if (get().loading) return
    set({ loading: true })
    try {
      const res = await tenantsApi.list()
      set({ tenants: res.items, error: null })
    } catch (e: unknown) {
      set({ error: describeError(e, '加载租户列表失败') })
    } finally {
      set({ loading: false })
    }
  },
}))

/**
 * 清掉选中的租户。
 *
 * 退出登录、或者登录的账号不是平台管理员时调用：一个普通租户的管理员
 * 不该带着上一个会话的租户选择发请求。
 */
export function clearTenantSelection(): void {
  useTenantStore.getState().setTenantId(null)
}

/**
 * 存储层丢掉了一个指向已不存在租户的选择——请求层自己发现的，它不知道有
 * 这个 store。
 *
 * 这里把内存里的那份也丢掉：存储的那份是 `api/client.ts` 写的，而这一份
 * 是 UI 读的，两份必须一起变。
 */
if (typeof window !== 'undefined') {
  window.addEventListener(TENANT_CLEARED_EVENT, () => {
    useTenantStore.setState({ tenantId: null })
  })
}
