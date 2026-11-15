import { Button, Typography } from 'antd'
import { useNavigate } from 'react-router-dom'
import { PageHeader, Panel } from '@/components/ui'
import { tokens } from '@/theme/tokens'

const { Text } = Typography

export default function NotFound() {
  const navigate = useNavigate()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space[5] }}>
      <PageHeader
        title="页面不存在"
        subtitle="这个地址没有对应的页面，可能是链接过期或地址输入有误。"
      />
      <Panel accent>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: tokens.space[5],
            flexWrap: 'wrap',
          }}
        >
          <div
            style={{
              fontSize: tokens.fontSize['3xl'],
              fontWeight: tokens.fontWeight.bold,
              color: tokens.color.accent,
              lineHeight: 1,
              letterSpacing: '-0.02em',
            }}
          >
            404
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Text
              style={{
                display: 'block',
                color: tokens.color.text,
                fontSize: tokens.fontSize.lg,
                fontWeight: tokens.fontWeight.semibold,
              }}
            >
              您访问的页面不存在
            </Text>
            <Text style={{ color: tokens.color.textMuted, fontSize: tokens.fontSize.base }}>
              请检查地址是否正确，或返回首页继续使用。
            </Text>
          </div>
          <Button type="primary" onClick={() => navigate('/')}>
            返回首页
          </Button>
        </div>
      </Panel>
    </div>
  )
}
