import { useEffect, useState } from 'react'
import {
  Button,
  Input,
  Select,
  Space,
  Pagination,
  App,
  Dropdown,
  Segmented,
} from 'antd'
import {
  SearchOutlined,
  ReloadOutlined,
  CloudUploadOutlined,
  DeleteOutlined,
  EditOutlined,
  MoreOutlined,
  UndoOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { assetsApi } from '@/api/assets'
import { categoriesApi } from '@/api/categories'
import { tagsApi } from '@/api/tags'
import AssetGrid from '@/components/asset/AssetGrid'
import type { Asset, AssetType, Category, Tag } from '@/types'
import { useAuthStore } from '@/stores/authStore'

/** Which slice of the library the list shows. */
type LibraryView = 'active' | 'trash'

/** One flattened row of the category tree, ready for an antd `Select`. */
interface CategoryOption {
  value: string
  label: string
}

/**
 * Flatten the category tree into a depth-prefixed option list.
 *
 * The backend serves a flat list with a `parent_id` column; the tree is
 * built on the frontend, so the indent marker is ours to choose.
 */
function flattenCategories(nodes: Category[], prefix = ''): CategoryOption[] {
  const out: CategoryOption[] = []
  for (const node of nodes) {
    out.push({ value: String(node.id), label: `${prefix}${node.name}` })
    if (node.children?.length) {
      out.push(...flattenCategories(node.children, `${prefix}— `))
    }
  }
  return out
}

export default function Assets() {
  const navigate = useNavigate()
  const { modal, message } = App.useApp()
  const canWrite = useAuthStore((s) => s.canWrite())

  const [assets, setAssets] = useState<Asset[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(24)

  const [keyword, setKeyword] = useState('')
  const [assetType, setAssetType] = useState<AssetType | undefined>()
  const [categoryId, setCategoryId] = useState<string | undefined>()
  const [tagNames, setTagNames] = useState<string[]>([])
  const [orderBy, setOrderBy] = useState('created_at_desc')
  const [view, setView] = useState<LibraryView>('active')

  const [categories, setCategories] = useState<Category[]>([])
  const [allTags, setAllTags] = useState<Tag[]>([])

  useEffect(() => {
    categoriesApi
      .tree()
      .then((tree) => setCategories(tree))
      .catch((error: unknown) => {
        console.warn('[assets] could not load the category tree:', error)
      })
    tagsApi
      .all()
      .then((tags) => setAllTags(tags))
      .catch((error: unknown) => {
        console.warn('[assets] could not load the tag list:', error)
      })
  }, [])

  const flatCategories = flattenCategories(categories)

  const load = async () => {
    setLoading(true)
    try {
      const resp = await assetsApi.list({
        keyword: keyword || undefined,
        asset_type: assetType,
        category_id: categoryId,
        tag_names: tagNames.length ? tagNames.join(',') : undefined,
        order_by: orderBy,
        // The recycle bin is the *only* place soft-deleted assets show up:
        // `status=deleted` filters them in, while the default view hides
        // them. `include_deleted=true` would mix both views together.
        status: view === 'trash' ? 'deleted' : undefined,
        page,
        page_size: pageSize,
      })
      setAssets(resp.items)
      setTotal(resp.total)
    } catch {
      // The interceptor already surfaced the error.
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [page, pageSize, assetType, categoryId, orderBy, view])

  const onSearch = () => {
    setPage(1)
    load()
  }

  const onReset = () => {
    setKeyword('')
    setAssetType(undefined)
    setCategoryId(undefined)
    setTagNames([])
    setOrderBy('created_at_desc')
    setView('active')
    setPage(1)
    setTimeout(load, 0)
  }

  const onDelete = (asset: Asset, permanent = false) => {
    modal.confirm({
      title: permanent ? '确认永久删除？' : '确认删除资产？',
      content: permanent
        ? '该操作不可恢复，文件将从磁盘删除'
        : '资产会移入回收站，文件仍然保留，可以随时恢复',
      okText: '确认',
      cancelText: '取消',
      okButtonProps: permanent ? { danger: true } : {},
      onOk: async () => {
        await assetsApi.remove(asset.id, permanent)
        message.success(permanent ? '已永久删除' : '已移入回收站')
        load()
      },
    })
  }

  const onRestore = async (asset: Asset) => {
    await assetsApi.restore(asset.id)
    message.success('已恢复')
    load()
  }

  const actionMenu = (asset: Asset) => ({
    items: [
      { key: 'view', label: '查看详情', onClick: () => navigate(`/library/${asset.id}`) },
      canWrite && { key: 'edit', icon: <EditOutlined />, label: '编辑', onClick: () => navigate(`/library/${asset.id}`) },
      asset.status === 'deleted' && { key: 'restore', icon: <UndoOutlined />, label: '恢复', onClick: () => onRestore(asset) },
      canWrite && { type: 'divider' as const },
      canWrite && asset.status !== 'deleted' && { key: 'del', icon: <DeleteOutlined />, label: '删除', danger: true, onClick: () => onDelete(asset, false) },
      canWrite && { key: 'del-perm', icon: <DeleteOutlined />, label: '永久删除', danger: true, onClick: () => onDelete(asset, true) },
    ].filter(Boolean),
  })

  return (
    <div>
      <div className="page-header">
        <div>
          <h2 className="page-title">资产库</h2>
          <div className="page-subtitle">共 {total.toLocaleString()} 个资产</div>
        </div>
        <Space>
          {canWrite && (
            <Button type="primary" icon={<CloudUploadOutlined />} onClick={() => navigate('/import')}>
              上传资产
            </Button>
          )}
        </Space>
      </div>

      {/* Filter bar */}
      <div className="dam-card dam-card-padded" style={{ marginBottom: 16 }}>
        <Space wrap size="middle" style={{ width: '100%' }}>
          <Input
            prefix={<SearchOutlined />}
            placeholder="搜索标题、描述、原始文件名"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onPressEnter={onSearch}
            style={{ width: 280 }}
            allowClear
          />
          <Select
            placeholder="类型"
            value={assetType}
            onChange={setAssetType}
            allowClear
            style={{ width: 120 }}
            options={[
              { value: 'image', label: '图片' },
              { value: 'video', label: '视频' },
            ]}
          />
          <Select
            placeholder="分类"
            value={categoryId}
            onChange={setCategoryId}
            allowClear
            showSearch
            optionFilterProp="label"
            style={{ width: 160 }}
            options={flatCategories}
          />
          <Select
            mode="multiple"
            placeholder="标签"
            value={tagNames}
            onChange={setTagNames}
            style={{ minWidth: 180 }}
            options={allTags.map((tag) => ({ value: tag.name, label: tag.name }))}
            maxTagCount={2}
          />
          <Select
            value={orderBy}
            onChange={setOrderBy}
            style={{ width: 160 }}
            options={[
              { value: 'created_at_desc', label: '最新上传' },
              { value: 'created_at_asc', label: '最早上传' },
              { value: 'size_desc', label: '体积从大到小' },
              { value: 'size_asc', label: '体积从小到大' },
              { value: 'title_asc', label: '标题 A→Z' },
            ]}
          />
          <Button type="primary" icon={<SearchOutlined />} onClick={onSearch}>搜索</Button>
          <Button icon={<ReloadOutlined />} onClick={onReset}>重置</Button>
          <div style={{ flex: 1 }} />
          <Segmented
            value={view}
            onChange={(v) => { setView(v as LibraryView); setPage(1) }}
            options={[
              { value: 'active', label: '活跃' },
              { value: 'trash', label: '回收站' },
            ]}
          />
        </Space>
      </div>

      {/* Grid */}
      <div className="dam-card" style={{ padding: 16 }}>
        <AssetGrid assets={assets} loading={loading} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 24 }}>
          <Pagination
            current={page}
            pageSize={pageSize}
            total={total}
            onChange={(p, ps) => { setPage(p); setPageSize(ps) }}
            showSizeChanger
            showTotal={(t) => `共 ${t} 条`}
            pageSizeOptions={[12, 24, 48, 96]}
          />
        </div>
      </div>
    </div>
  )
}
