import { useEffect, useState } from 'react'
import { Card, Col, Row, Skeleton, Tag } from 'antd'
import {
  AppstoreOutlined,
  PictureOutlined,
  PlayCircleOutlined,
  CloudUploadOutlined,
  HddOutlined,
  TeamOutlined,
  FolderOutlined,
  TagsOutlined,
} from '@ant-design/icons'
import { Line } from '@ant-design/charts'
import { statsApi } from '@/api/stats'
import { useNavigate } from 'react-router-dom'
import type { DashboardData } from '@/types'
import { formatBytes } from '@/utils/format'
import AssetGrid from '@/components/asset/AssetGrid'

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()

  useEffect(() => {
    statsApi.dashboard().then(setData).finally(() => setLoading(false))
  }, [])

  if (loading || !data) {
    return <Skeleton active paragraph={{ rows: 8 }} />
  }

  const { summary, upload_trend, recent_assets } = data

  const stats = [
    {
      label: '总资产数',
      value: summary.total_assets.toLocaleString(),
      extra: `图片 ${summary.image_count} · 视频 ${summary.video_count}`,
      icon: <AppstoreOutlined />,
      bg: 'bg-primary',
    },
    {
      label: '存储占用',
      value: `${summary.storage_used_gb} GB`,
      extra: `${formatBytes(summary.total_size_bytes)}`,
      icon: <HddOutlined />,
      bg: 'bg-blue',
    },
    {
      label: '今日上传',
      value: summary.today_uploads.toLocaleString(),
      extra: `本周 ${summary.week_uploads} · 本月 ${summary.month_uploads}`,
      icon: <CloudUploadOutlined />,
      bg: 'bg-green',
    },
    {
      label: '分类 / 标签',
      value: `${summary.category_count} / ${summary.tag_count}`,
      extra: '已建立的分类与标签',
      icon: <TagsOutlined />,
      bg: 'bg-orange',
    },
    {
      label: '注册用户',
      value: summary.user_count.toLocaleString(),
      extra: '系统使用者',
      icon: <TeamOutlined />,
      bg: 'bg-purple',
    },
    {
      label: '图片 / 视频',
      value: `${summary.image_count} / ${summary.video_count}`,
      extra: '按类型分布',
      icon: <PictureOutlined />,
      bg: 'bg-blue',
    },
  ]

  const chartData = upload_trend.map((d) => ({ date: d.date.slice(5), count: d.count }))

  return (
    <div>
      <div className="page-header">
        <div>
          <h2 className="page-title">仪表盘</h2>
          <div className="page-subtitle">系统整体状况一览</div>
        </div>
      </div>

      {/* Stats grid */}
      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        {stats.map((s, i) => (
          <Col xs={24} sm={12} md={8} lg={8} xl={4} key={i}>
            <div className={`stat-card ${s.bg}`}>
              <div className="stat-label">{s.label}</div>
              <div className="stat-value">{s.value}</div>
              <div className="stat-extra">{s.extra}</div>
              <div className="stat-icon">{s.icon}</div>
            </div>
          </Col>
        ))}
      </Row>

      {/* Chart + Recent */}
      <Row gutter={16} style={{ marginBottom: 24 }}>
        <Col xs={24} lg={14}>
          <Card title="近 7 天上传趋势" bordered={false} style={{ borderRadius: 10 }}>
            <Line
              data={chartData}
              xField="date"
              yField="count"
              smooth
              point={{ size: 4, shape: 'circle' }}
              height={260}
              color="#1677ff"
              area={{ style: { fill: 'l(270) 0:#1677ff 1:#ffffff20' } }}
            />
          </Card>
        </Col>
        <Col xs={24} lg={10}>
          <Card
            title="快速入口"
            bordered={false}
            style={{ borderRadius: 10, height: '100%' }}
          >
            <Row gutter={[12, 12]}>
              {[
                { label: '上传资产', icon: <CloudUploadOutlined />, bg: '#1677ff', to: '/assets/upload' },
                { label: '资产库', icon: <AppstoreOutlined />, bg: '#722ed1', to: '/assets' },
                { label: '分类管理', icon: <FolderOutlined />, bg: '#13c2c2', to: '/categories' },
                { label: 'API Key', icon: <TagsOutlined />, bg: '#fa8c16', to: '/api-keys' },
              ].map((q) => (
                <Col span={12} key={q.to}>
                  <div
                    onClick={() => navigate(q.to)}
                    style={{
                      padding: 20,
                      borderRadius: 10,
                      background: `linear-gradient(135deg, ${q.bg}22 0%, ${q.bg}11 100%)`,
                      border: `1px solid ${q.bg}33`,
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.transform = 'translateY(-2px)')}
                    onMouseLeave={(e) => (e.currentTarget.style.transform = 'translateY(0)')}
                  >
                    <div style={{ fontSize: 24, color: q.bg, marginBottom: 8 }}>{q.icon}</div>
                    <div style={{ fontSize: 14, fontWeight: 500 }}>{q.label}</div>
                  </div>
                </Col>
              ))}
            </Row>
          </Card>
        </Col>
      </Row>

      <Card
        title="最近上传"
        bordered={false}
        style={{ borderRadius: 10 }}
        extra={<a onClick={() => navigate('/assets')}>查看全部 →</a>}
      >
        <AssetGrid assets={recent_assets} />
      </Card>
    </div>
  )
}
