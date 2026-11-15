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

import { Tabs } from 'antd';
import {
  CloudUploadOutlined,
  LinkOutlined,
  ExperimentOutlined,
} from '@ant-design/icons';
import ImportUploadTab from '@/pages/ImportUploadTab';
import ImportUrlTab from '@/pages/ImportUrlTab';
import ImportComfyUiTab from '@/pages/ImportComfyUiTab';
import { PageHeader, Panel } from '@/components/ui';
import { tokens } from '@/theme/tokens';

type TabKey = 'upload' | 'url' | 'comfyui';

export default function Import(): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space[4] }}>
      <PageHeader
        title="导入"
        subtitle="把外部资产纳入资产库：本地文件、URL 抓取、ComfyUI 任务登记"
      />

      <Panel>
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
      </Panel>
    </div>
  );
}
