import { Button, Empty } from 'antd'
import { useNavigate } from 'react-router-dom'

export default function NotFound() {
  const navigate = useNavigate()
  return (
    <div style={{ minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <Empty
        description={
          <div>
            <div style={{ fontSize: 64, fontWeight: 700, color: 'rgba(0,0,0,0.15)', marginBottom: 12 }}>404</div>
            <div style={{ fontSize: 14, color: 'rgba(0,0,0,0.45)' }}>您访问的页面不存在</div>
          </div>
        }
      >
        <Button type="primary" onClick={() => navigate('/')}>返回首页</Button>
      </Empty>
    </div>
  )
}
