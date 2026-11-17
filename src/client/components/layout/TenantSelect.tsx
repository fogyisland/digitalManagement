import { useEffect, useMemo } from 'react';
import { Select, Tooltip } from 'antd';
import { BankOutlined } from '@ant-design/icons';
import { useTenantStore } from '@/stores/tenantStore';
import { tokens } from '@/theme/tokens';

/**
 * 平台管理员的租户选择器。
 *
 * ## 它做什么
 *
 * 平台管理员的账号不属于任何租户，所以它的默认范围是**整个平台**。选中一
 * 个租户之后，接下来的每一次请求都带上 `X-Tenant: <租户 id>`，后端把这次
 * 请求的读和写都收窄到这个租户——选中的那一刻，页面上看到的就是那个租户
 * 的数据。
 *
 * ## 为什么清单不走 `useApi`
 *
 * 租户清单是**平台级**的：它不受当前选中的租户影响，而且它是用来*选*租户
 * 的。如果它跟着 `useApi` 走，每切换一次租户就会把整张清单重取一遍，而
 * 清单本身并不会因此改变。取清单的动作放在 `tenantStore` 里。
 *
 * ## 它为什么在侧边栏里
 *
 * 它在顶部时，头部要同时装下折叠按钮、面包屑、租户选择、搜索框和账号菜单
 * ——在窄窗口里装不下，面包屑会被挤到选择器底下去。侧边栏的宽度是固定的，
 * 放得下，放多久都放得下。
 */

/** 「全部租户」这个选项的值——空串，不是某个租户的 id。 */
const ALL_TENANTS = '';

export default function TenantSelect(): JSX.Element {
  const tenantId = useTenantStore((s) => s.tenantId);
  const tenants = useTenantStore((s) => s.tenants);
  const loading = useTenantStore((s) => s.loading);
  const error = useTenantStore((s) => s.error);
  const setTenantId = useTenantStore((s) => s.setTenantId);
  const loadTenants = useTenantStore((s) => s.loadTenants);

  useEffect(() => {
    void loadTenants();
  }, [loadTenants]);

  const options = useMemo(
    () => [
      { value: ALL_TENANTS, label: '全部租户' },
      ...tenants.map((tenant) => ({ value: tenant.id, label: tenant.name })),
    ],
    [tenants],
  );

  /**
   * 选中的租户可能已经不在列表里了——它被停用，或者这个账号是在别的平台
   * 上选的。列表里找不到就退回「全部租户」，而不是留一个空白的下拉框。
   */
  const selected =
    tenantId && tenants.some((tenant) => tenant.id === tenantId) ? tenantId : ALL_TENANTS;

  const select = (
    <Select
      size="small"
      value={selected}
      options={options}
      loading={loading}
      disabled={Boolean(error)}
      prefix={<BankOutlined style={{ color: tokens.color.textMuted }} />}
      onChange={(value: string) => setTenantId(value === ALL_TENANTS ? null : value)}
      style={{ width: '100%', background: tokens.color.bgAlt }}
      aria-label="选择租户"
    />
  );

  if (error) {
    return (
      <Tooltip title={error}>
        <div>{select}</div>
      </Tooltip>
    );
  }

  /**
   * 平台模式下，把「写入前要先选租户」摆在明处。
   *
   * 这句话以前只是一句 tooltip：要指准那个小箭头才看得见，而看不见的
   * 规则等于没有规则——平台管理员在「全部租户」下点新建，撞上的是一句
   * 英文的拒绝，而不是一条告诉他该怎么做的说明。规则就写在选择器底下，
   * 因为改它的地方也在这里。
   */
  const platformWide = selected === ALL_TENANTS;

  return (
    <div>
      <Tooltip title="不选租户时看到的是整个平台；写入前要先选中一个租户">
        <div>{select}</div>
      </Tooltip>
      {platformWide ? (
        <div
          style={{
            marginTop: tokens.space[1],
            fontSize: tokens.fontSize.xs,
            lineHeight: 1.5,
            color: tokens.color.textMuted,
          }}
        >
          写入前需先选租户
        </div>
      ) : null}
    </div>
  );
}
