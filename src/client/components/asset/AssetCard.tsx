import { Tag } from 'antd'
import { PlayCircleOutlined, PictureOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import type { Asset } from '@/types'
import { formatBytes, formatDuration } from '@/utils/format'

interface Props {
  asset: Asset
}

export default function AssetCard({ asset }: Props) {
  const navigate = useNavigate()

  const isVideo = asset.asset_type === 'video'

  return (
    <div className="asset-card" onClick={() => navigate(`/assets/${asset.id}`)}>
      <div className="asset-thumb">
        {asset.thumbnail_url ? (
          <img src={asset.thumbnail_url} alt={asset.title} loading="lazy" />
        ) : isVideo ? (
          <div className="flex-center" style={{ height: '100%' }}>
            <PlayCircleOutlined style={{ fontSize: 48, color: '#1677ff' }} />
          </div>
        ) : (
          <div className="flex-center" style={{ height: '100%' }}>
            <PictureOutlined style={{ fontSize: 48, color: '#52c41a' }} />
          </div>
        )}
        <span className={`asset-badge ${asset.asset_type}`}>
          {isVideo ? '视频' : '图片'}
        </span>
        {isVideo && asset.duration != null && (
          <span className="asset-duration">{formatDuration(asset.duration)}</span>
        )}
      </div>
      <div className="asset-info">
        <h4 className="asset-title" title={asset.title}>{asset.title}</h4>
        <div className="asset-meta">
          <span>{asset.width && asset.height ? `${asset.width}×${asset.height}` : '—'}</span>
          <span>{formatBytes(asset.file_size)}</span>
        </div>
        {asset.tag_names && asset.tag_names.length > 0 && (
          <div className="asset-tags">
            {asset.tag_names.slice(0, 3).map((t) => (
              <Tag key={t} bordered={false} style={{ fontSize: 11, padding: '0 6px' }}>{t}</Tag>
            ))}
            {asset.tag_names.length > 3 && (
              <span style={{ fontSize: 11, color: 'rgba(0,0,0,0.45)' }}>+{asset.tag_names.length - 3}</span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
