# DAM for ComfyUI

ComfyUI 节点：把生成的图片直接送进 DAM（数字资产管理平台）。

三个节点都在 `DAM` 分类下：

| 节点 | 作用 | 输出 |
|---|---|---|
| **DAM 上传** | 把一张 `IMAGE` 渲染成 PNG 并上传 | `asset_id`、状态文案 |
| **DAM 登记任务** | 在产物还没生成时先登记一个 job | `job_id`、状态文案 |
| **DAM 查询任务** | 反查某个 job 对应的资产 | `asset_id`、状态文案 |

节点本身**只用 Python 标准库**，不需要装 `requests`、`Pillow`，也不改 ComfyUI 的环境。

---

## 安装

把整个 `comfyui-node/` 目录复制到 ComfyUI 的 `custom_nodes/` 下：

```bash
cp -r comfyui-node ComfyUI/custom_nodes/dam-comfyui
```

重启 ComfyUI，节点面板里就会出现 `DAM` 分类。

> 目录名随意，但不要改名 `dam_node/` —— 那是包名。

---

## 配置

节点需要两项：DAM 的地址，以及一个带 `upload` 权限的 API Key。

### 方式一：环境变量（推荐）

```bash
export DAM_API_URL=http://127.0.0.1:8000
export DAM_API_KEY=dam_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
# 可选：只用于日志展示；数据实际落在哪个租户由 Key 决定
export DAM_TENANT=设计团队
```

### 方式二：配置文件

不设环境变量时，节点读 `comfyui-node/dam_config.json`：

```json
{
  "api_url": "http://127.0.0.1:8000",
  "api_key": "dam_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "tenant": "设计团队"
}
```

环境变量优先于文件 —— 为一次运行导出的 `DAM_API_URL` 不会被几个月前的文件覆盖。

### 关于租户

**租户由 API Key 决定**，节点不接受也不传递"租户"参数：Key 是在哪个租户下创建的，资产就落在哪个租户。`DAM_TENANT` 只是日志里的一个标签。

---

## 用法

### 最小工作流

```
[Load Checkpoint] → [KSampler] → [VAE Decode] → [DAM 上传] → （asset_id 可接到 [DAM 查询任务]）
```

`DAM 上传` 的输入：

| 输入 | 说明 |
|---|---|
| `image` | 上游的 `IMAGE` 张量（必填） |
| `title` | 资产标题；留空时用 job_id |
| `job_id` | 关联生成任务；留空时按标题生成一个 |
| `tags` | 逗号分隔的标签名，例如 `人物,封面` |
| `prompt` | 提示词，可选 |
| `seed` | 种子，可选；`-1` 表示不上报 |

`DAM 上传` 输出两个字符串：`asset_id`（失败时为空）与一句状态文案（成功/失败原因）。状态文案会直接显示在节点上，例如 `已上传到 DAM（1024 KB）` 或 `上传失败：POST /api/ingest/v1/comfyui/xxx answered 403: Missing scope: upload`。

### 工作流示例

```json
{
  "1": {
    "class_type": "DAMUpload",
    "inputs": {
      "image": ["4", 0],
      "title": "封面图",
      "job_id": "job-20261104-a",
      "tags": "人物,封面",
      "prompt": "a quiet harbour at dawn",
      "seed": 12345
    }
  }
}
```

`"4"` 是上游节点（通常是 `VAEDecode`）的 id。把这段接到工作流里，或者直接用 ComfyUI 的界面把 `DAM 上传` 拖出来连线。

---

## 工作原理

`DAM 上传` 把张量转成 PNG，然后调 DAM 的接收接口：

```
POST {DAM_API_URL}/api/ingest/v1/comfyui/{job_id}
X-API-Key: {DAM_API_KEY}
Content-Type: multipart/form-data
```

字段名是 `files`，附带 `title` / `tag_names` / `prompt` / `seed` / `source_tool`。DAM 侧复用内部上传的全部逻辑：去重、缩略图、清单、Webhook 推送，所以节点不需要关心这些。

`DAM 查询任务` 调的是管理端接口 `GET /api/v1/jobs/by-comfyui/{job_id}`，用同一个 Key 以 Bearer 形式鉴权。查不到时返回空 `asset_id` 和一句说明，不会让工作流报错。

---

## 开发

```bash
cd comfyui-node
python -m unittest discover tests
```

测试不依赖 ComfyUI 也不依赖 torch：`IMAGE` 张量用一个带 `.shape` 与 `.tolist()` 的替身，HTTP 用一个进程内的真实服务器，断言的是**实际发出的请求**（路径、头、multipart 字段名、字节内容）。
