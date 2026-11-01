/**
 * Import — three-tab ingestion page (Task 14).
 *
 * Tabs:
 *   1. 上传     — ImportUploadTab  (multipart POST /assets/upload)
 *   2. URL 抓取 — ImportUrlTab     (POST /assets/import-url, parked)
 *   3. ComfyUI  — ImportComfyUiTab (GET /jobs/by-comfyui/:id → POST
 *                  /assets/from-comfyui/:id, both parked)
 *
 * Each tab handles its own navigation + error surface; this file is a
 * thin orchestrator so it stays under the 500-line budget and the tabs
 * remain independently testable.
 */

import { Tabs, Typography } from 'antd';
import {
  CloudUploadOutlined,
  LinkOutlined,
  ExperimentOutlined,
} from '@ant-design/icons';
import ImportUploadTab from '@/pages/ImportUploadTab';
import ImportUrlTab from '@/pages/ImportUrlTab';
import ImportComfyUiTab from '@/pages/ImportComfyUiTab';
import { tokens } from '@/theme/tokens';

const { Title, Text } = Typography;

type TabKey = 'upload' | 'url' | 'comfyui';

export default function Import(): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space[4] }}>
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
          导入
        </Title>
        <Text style={{ color: tokens.color.textMuted, fontSize: 13 }}>
          把外部资产纳入资产库：本地文件、URL 抓取、ComfyUI 任务登记
        </Text>
      </header>

      <Tabs
        defaultActiveKey="upload"
        items={[
          {
            key: 'upload' as TabKey,
            label: (
              <span>
                <CloudUploadOutlined style={{ marginRight: tokens.space[2] }} />
                上传
              </span>
            ),
            children: <ImportUploadTab />,
          },
          {
            key: 'url' as TabKey,
            label: (
              <span>
                <LinkOutlined style={{ marginRight: tokens.space[2] }} />
                URL 抓取
              </span>
            ),
            children: <ImportUrlTab />,
          },
          {
            key: 'comfyui' as TabKey,
            label: (
              <span>
                <ExperimentOutlined style={{ marginRight: tokens.space[2] }} />
                ComfyUI 任务登记
              </span>
            ),
            children: <ImportComfyUiTab />,
          },
        ]}
      />
    </div>
  );
}
