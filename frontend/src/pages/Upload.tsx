/**
 * Upload — legacy page, deprecated.
 *
 * Task 18: the route `/assets/upload` now redirects to `/import`
 * (handled in router.tsx). This component keeps its default export so
 * any stale imports / external links continue to resolve while the
 * redirect is in place. It also still renders the original uploader in
 * case a programmatic caller (test, embed) reaches for it directly.
 *
 * Visual language: tokens only — no `dam-card-padded`, no `page-header`
 * legacy classes, no all-caps eyebrows. The right-hand helper panel
 * uses mono `code` blocks for endpoints per the system rule.
 */
import { Card, Col, Row, Typography } from 'antd';
import AssetUploader from '@/components/asset/AssetUploader';
import type { Asset } from '@/types';
import { tokens } from '@/theme/tokens';

const { Text, Title } = Typography;

const MONO_CODE_STYLE: React.CSSProperties = {
  fontFamily: tokens.font.mono,
  fontSize: 12,
  color: tokens.color.text,
  background: tokens.color.bgAlt,
  border: `1px solid ${tokens.color.border}`,
  padding: '1px 6px',
  borderRadius: tokens.radius.sm,
};

interface UploadProps {
  onUploaded?: (asset: Asset) => void;
}

export default function Upload(props: UploadProps): JSX.Element {
  const handleUploaded = (asset: Asset): void => {
    if (props.onUploaded) {
      window.setTimeout(() => props.onUploaded?.(asset), 800);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space[5] }}>
      <header>
        <Title
          level={2}
          style={{
            margin: 0,
            color: tokens.color.text,
            fontWeight: 600,
            letterSpacing: '-0.01em',
          }}
        >
          上传资产
        </Title>
        <Text style={{ color: tokens.color.textMuted, fontSize: 13 }}>
          支持单文件、批量上传，自动生成缩略图与元数据
          <span style={{ marginLeft: tokens.space[3], color: tokens.color.accent }}>
            · 此页面已迁移到「导入」
          </span>
        </Text>
      </header>

      <Row gutter={[tokens.space[4], tokens.space[4]]}>
        <Col xs={24} lg={14}>
          <AssetUploader onUploaded={handleUploaded} />
        </Col>
        <Col xs={24} lg={10}>
          <Card
            title={<span style={{ color: tokens.color.text }}>上传提示</span>}
            bordered={false}
            style={{
              background: tokens.color.panel,
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.lg,
              height: '100%',
            }}
            headStyle={{
              color: tokens.color.text,
              borderBottom: `1px solid ${tokens.color.border}`,
            }}
          >
            <Text style={{ color: tokens.color.textMuted, fontSize: 12 }}>支持格式</Text>
            <ul
              style={{
                color: tokens.color.text,
                fontSize: 13,
                lineHeight: 1.8,
                paddingLeft: tokens.space[4],
                marginTop: tokens.space[2],
              }}
            >
              <li>
                <strong>图片</strong>：JPG / PNG / WebP / GIF / BMP / SVG / TIFF
              </li>
              <li>
                <strong>视频</strong>：MP4 / MOV / WebM / MKV / AVI / M4V
              </li>
            </ul>

            <Text style={{ color: tokens.color.textMuted, fontSize: 12 }}>自动处理</Text>
            <ul
              style={{
                color: tokens.color.text,
                fontSize: 13,
                lineHeight: 1.8,
                paddingLeft: tokens.space[4],
                marginTop: tokens.space[2],
              }}
            >
              <li>自动计算 SHA-256 哈希（用于去重）</li>
              <li>自动生成 320×320 缩略图</li>
              <li>自动生成 WebP 预览图</li>
              <li>视频自动截取首帧作为封面</li>
              <li>提取 EXIF 元数据</li>
            </ul>

            <Text style={{ color: tokens.color.textMuted, fontSize: 12 }}>API 投递</Text>
            <div
              style={{
                color: tokens.color.text,
                fontSize: 13,
                lineHeight: 1.6,
                marginTop: tokens.space[2],
              }}
            >
              如需从其他系统自动投递，请使用「API Key」功能获取密钥，
              调用 <span style={MONO_CODE_STYLE}>POST /api/public/v1/delivery/upload</span> 接口。
            </div>
          </Card>
        </Col>
      </Row>
    </div>
  );
}
