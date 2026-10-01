/**
 * Organize — unified category + tag management (Task 16).
 *
 * Two-column workspace:
 *   - Left:  category tree (CRUD via POST/PUT/DELETE /categories)
 *   - Right: tag card cloud (POST /tags only — backend does not expose
 *            PUT or DELETE for tags, see task-16-report.md "concerns")
 */

import { useState } from 'react';
import { Button, Space, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useApi } from '@/api/hooks';
import type { Category, Tag } from '@/types/dto';
import { tokens } from '@/theme/tokens';
import OrganizeCategories from './OrganizeCategories';
import OrganizeTags from './OrganizeTags';

const { Text: AntText, Title } = Typography;

export default function Organize(): JSX.Element {
  const categoriesState = useApi<Category[]>('/categories');
  const tagsState = useApi<Tag[]>('/tags');

  // Bumping this counter drives OrganizeCategories' "create root"
  // modal open. The categories modal lives inside OrganizeCategories
  // because it owns the parent_id pre-fill from the clicked tree node;
  // the header's "新增根分类" button signals intent via this tick.
  const [createRootTick, setCreateRootTick] = useState<number>(0);

  const categories = categoriesState.data ?? [];
  const tags = tagsState.data ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space[5] }}>
      <header>
        <Title
          level={2}
          style={{ margin: 0, color: tokens.color.text, fontWeight: 600, letterSpacing: '-0.01em' }}
        >
          整理
        </Title>
        <AntText style={{ color: tokens.color.textMuted, fontSize: 13 }}>
          管理分类与标签 · 分类 {categories.length} 个 · 标签 {tags.length} 个
        </AntText>
      </header>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)',
          gap: tokens.space[5],
          alignItems: 'start',
        }}
      >
        {/* === Categories column === */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: tokens.space[3] }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Title level={4} style={{ margin: 0, color: tokens.color.text, fontWeight: 600 }}>
              分类
            </Title>
            <Space size={4}>
              <Button
                type="primary"
                icon={<PlusOutlined />}
                onClick={() => setCreateRootTick((n) => n + 1)}
                aria-label="新增根分类"
              >
                新增根分类
              </Button>
            </Space>
          </div>
          <OrganizeCategories
            categories={categories}
            loading={categoriesState.loading}
            error={categoriesState.error}
            onReload={() => categoriesState.reload()}
            createRootTick={createRootTick}
          />
        </section>

        {/* === Tags column === */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: tokens.space[3] }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Title level={4} style={{ margin: 0, color: tokens.color.text, fontWeight: 600 }}>
              标签
            </Title>
          </div>
          <OrganizeTags
            tags={tags}
            loading={tagsState.loading}
            error={tagsState.error}
            onReload={() => tagsState.reload()}
          />
        </section>
      </div>
    </div>
  );
}
