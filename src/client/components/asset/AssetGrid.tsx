import { Empty, Spin } from 'antd'
import AssetCard from './AssetCard'
import type { Asset } from '@/types'

interface Props {
  assets: Asset[]
  loading?: boolean
}

export default function AssetGrid({ assets, loading }: Props) {
  if (loading) {
    return (
      <div className="flex-center" style={{ padding: 60 }}>
        <Spin size="large" tip="加载中..." />
      </div>
    )
  }

  if (!assets.length) {
    return (
      <Empty
        description="暂无资产"
        style={{ padding: 60 }}
      />
    )
  }

  return (
    <div className="asset-grid">
      {assets.map((a) => <AssetCard key={a.id} asset={a} />)}
    </div>
  )
}
