import { Button, Input, Select, Space } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import type { AssetType, Category } from '@/types';
import { Panel } from '@/components/ui';
import { tokens } from '@/theme/tokens';

const ASSET_TYPE_FILTERS: { value: AssetType; label: string }[] = [
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
  { value: 'other', label: '其他' },
];

// `/api/v1/assets/source-tools` does not exist in this milestone; the
// reasonable hardcoded set covers every value `processUpload` writes.
const SOURCE_TOOL_OPTIONS = [
  { value: 'comfyui', label: 'ComfyUI' },
  { value: 'manual', label: '手动上传' },
  { value: 'admin', label: '管理后台' },
];

export interface LibraryFiltersState {
  keywordInput: string;
  assetType: AssetType | undefined;
  categoryId: string | undefined;
  sourceTool: string | undefined;
}

export interface LibraryFiltersHandlers {
  onKeywordInputChange: (v: string) => void;
  onSearch: (v: string) => void;
  onAssetTypeChange: (v: AssetType | undefined) => void;
  onCategoryIdChange: (v: string | undefined) => void;
  onSourceToolChange: (v: string | undefined) => void;
  onReset: () => void;
}

export interface LibraryFiltersProps {
  state: LibraryFiltersState;
  handlers: LibraryFiltersHandlers;
  categories: Category[];
  categoriesLoading: boolean;
}

/**
 * Pure presentational filter surface for the Library page. The parent owns
 * all state and URL-syncing; this component just renders the inputs and
 * forwards user intent via the handlers object.
 */
export default function LibraryFilters({
  state,
  handlers,
  categories,
  categoriesLoading,
}: LibraryFiltersProps): JSX.Element {
  return (
    <Panel>
      <Space
        size={[tokens.space[3], tokens.space[3]]}
        wrap
        style={{ width: '100%' }}
      >
        <Input.Search
          allowClear
          aria-label="按标题、文件名、描述搜索资产"
          placeholder="按标题、文件名、描述搜索"
          value={state.keywordInput}
          onChange={(e) => handlers.onKeywordInputChange(e.target.value)}
          onSearch={(v) => handlers.onSearch(v)}
          enterButton={<SearchOutlined />}
          style={{ width: 280 }}
        />
        <Select
          placeholder="类型"
          aria-label="按资产类型筛选"
          allowClear
          value={state.assetType}
          onChange={(v: AssetType | undefined) => handlers.onAssetTypeChange(v)}
          style={{ width: 130 }}
          options={ASSET_TYPE_FILTERS}
        />
        <Select
          placeholder="分类"
          aria-label="按分类筛选"
          allowClear
          showSearch
          value={state.categoryId}
          onChange={(v: string | undefined) => handlers.onCategoryIdChange(v)}
          optionFilterProp="label"
          style={{ width: 180 }}
          loading={categoriesLoading}
          options={categories.map((c) => ({ value: c.id, label: c.name }))}
        />
        <Select
          placeholder="来源"
          aria-label="按来源工具筛选"
          allowClear
          value={state.sourceTool}
          onChange={(v: string | undefined) => handlers.onSourceToolChange(v)}
          style={{ width: 150 }}
          options={SOURCE_TOOL_OPTIONS}
        />
        <Button onClick={handlers.onReset}>重置</Button>
      </Space>
    </Panel>
  );
}
