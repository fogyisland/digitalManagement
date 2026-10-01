import { Row, Col, Card, Typography } from 'antd'
import { useNavigate } from 'react-router-dom'
import AssetUploader from '@/components/asset/AssetUploader'

const { Title } = Typography

export default function Upload() {
  const navigate = useNavigate()

  return (
    <div>
      <div className="page-header">
        <div>
          <h2 className="page-title">上传资产</h2>
          <div className="page-subtitle">支持单文件、批量上传，自动生成缩略图与元数据</div>
        </div>
      </div>

      <Row gutter={24}>
        <Col xs={24} lg={14}>
          <AssetUploader
            onUploaded={(asset) => {
              setTimeout(() => navigate(`/assets/${asset.id}`), 800)
            }}
          />
        </Col>
        <Col xs={24} lg={10}>
          <Card title="上传提示" bordered={false} style={{ borderRadius: 10 }}>
            <Title level={5}>支持格式</Title>
            <ul>
              <li><strong>图片</strong>：JPG / PNG / WebP / GIF / BMP / SVG / TIFF</li>
              <li><strong>视频</strong>：MP4 / MOV / WebM / MKV / AVI / M4V</li>
            </ul>

            <Title level={5}>自动处理</Title>
            <ul>
              <li>自动计算 SHA-256 哈希（用于去重）</li>
              <li>自动生成 320×320 缩略图</li>
              <li>自动生成 WebP 预览图</li>
              <li>视频自动截取首帧作为封面</li>
              <li>提取 EXIF 元数据</li>
            </ul>

            <Title level={5}>API 投递</Title>
            <p style={{ color: 'rgba(0,0,0,0.65)' }}>
              如需从其他系统自动投递，请使用「API Key」功能获取密钥，
              调用 <code>POST /api/public/v1/delivery/upload</code> 接口。
            </p>
          </Card>
        </Col>
      </Row>
    </div>
  )
}
