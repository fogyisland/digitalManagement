# DAM for ComfyUI

ComfyUI 节点：把生成的图片和工作流一起送进 DAM（数字资产管理平台）。

两个节点，在 `DAM` 分类下：

| 节点 | 作用 | 输出 |
|---|---|---|
| **DAM 接入** | 问清楚平台在哪儿，把这台 ComfyUI 登记上去 | `platform_url`、`token`、`node_id`、状态文案 |
| **DAM 推送** | 把一张 `IMAGE` 和它的工作流一起推给平台 | `asset_id`、状态文案 |

两个节点是**接在一起**用的：「DAM 接入」的输出连到「DAM 推送」的输入。换地址、换 Key，只改一个地方。

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

## 第一次配置

需要两项：DAM 的地址，以及一个带 `upload` 权限的 API Key。

### 方式一：环境变量（推荐）

```bash
export DAM_API_URL=https://dam.example.com
export DAM_API_KEY=dam_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### 方式二：配置文件

不设环境变量时，节点读 `comfyui-node/dam_config.json`：

```json
{
  "api_url": "https://dam.example.com",
  "api_key": "dam_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
}
```

环境变量优先于文件 —— 为一次运行导出的 `DAM_API_URL` 不会被几个月前的文件覆盖。

### 也可以直接填在节点里

「DAM 接入」节点有两个输入框：`platform_url` 和 `token`。填了就用填的。

> ⚠️ **别把 Key 填在节点里然后把工作流存成文件** —— 工作流 JSON 是明文，谁拿到文件就拿到了这个 Key。用环境变量或配置文件更安全。

### 关于租户

**租户由 API Key 决定**，节点不接受也不传递"租户"参数：Key 是在哪个租户下创建的，资产就落在哪个租户。

---

## 节点会记住什么

「DAM 接入」第一次跑通之后，会把下面三样写进 `~/.dam-comfyui/state.json`：

- 平台地址
- 使用的 Token
- 这台 ComfyUI 的 `node_key`（平台用它认人，同一台永远是同一个）

之后两个节点的输入框**留空即可**。优先级是：**节点里填的 > 记住的 > 环境变量/配置文件**。

状态文件里有凭据，所以写成只有属主可读（POSIX 下 `0600`）。想换位置就设 `DAM_STATE`。

---

## 用法

### 最小工作流

```
[DAM 接入] ──platform_url──┐
             ──token───────┼──> [DAM 推送] ──> （asset_id）
[Load Checkpoint] → [KSampler] → [VAE Decode] → IMAGE ──┘
```

「DAM 推送」的输入：

| 输入 | 说明 |
|---|---|
| `image` | 上游的 `IMAGE` 张量（必填） |
| `platform_url` | 平台网址；连「DAM 接入」的输出，留空则用记住的 |
| `token` | API Key；连「DAM 接入」的输出，留空则用记住的 |
| `workflow_json` | ComfyUI 的工作流 JSON，可选；必须是合法 JSON |
| `job_id` | 关联生成任务；留空则每次生成一个新的 |
| `title` | 资产标题 |
| `tags` | 逗号分隔的标签名，例如 `人物,封面` |
| `prompt` | 提示词，可选 |
| `seed` | 种子，可选；`-1` 表示不上报 |

「DAM 推送」输出两个字符串：`asset_id`（失败时为空）与一句状态文案（成功/失败原因）。

### 工作流示例

```json
{
  "1": {
    "class_type": "DAMNodeAccess",
    "inputs": {
      "platform_url": "https://dam.example.com",
      "token": "dam_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "node_name": "渲染农场 A"
    }
  },
  "2": {
    "class_type": "DAMPush",
    "inputs": {
      "image": ["4", 0],
      "platform_url": ["1", 0],
      "token": ["1", 1],
      "workflow_json": "{\"1\": {\"class_type\": \"KSampler\"}}",
      "job_id": "job-20261104-a",
      "title": "封面图",
      "tags": "人物,封面",
      "prompt": "a quiet harbour at dawn",
      "seed": 12345
    }
  }
}
```

`["1", 0]` 就是「DAM 接入」的第 0 个输出 —— 这条线就是两个节点之间的接线。

---

## 工作原理

### DAM 接入

```
POST {platform_url}/api/ingest/v1/nodes/register
X-API-Key: {token}
Content-Type: application/json

{"node_key": "...", "name": "渲染农场 A", "version": "2.0.0",
 "comfyui_version": "0.3.40", "platform": "Windows 11 AMD64"}
```

平台按 `(租户, node_key)` 认这一台 —— 同一台 ComfyUI 永远是一行，不会越跑越多。响应里带回**平台自己的访问地址**（平台控制台「设置」里填的那个），节点就用它覆盖输入框里的地址。

登记之后，这台机器就出现在平台的**「ComfyUI 节点」**页里：名字、版本、最后一次开口的时间、在线与否。

### DAM 推送

```
POST {platform_url}/api/ingest/v1/comfyui/{job_id}
X-API-Key: {token}
Content-Type: multipart/form-data
```

字段名是 `files`（PNG），附带 `title` / `tag_names` / `prompt` / `seed` / `source_tool` / `workflow_json`。DAM 侧复用内部上传的全部逻辑：去重、缩略图、清单、Webhook 推送，所以节点不需要关心这些。

### 关于工作流 JSON

`workflow_json` 原样存进资产，在平台的资产详情页可以**下载 JSON**（和图片一起的那份"这是怎么生成的"）。

工作流必须是合法 JSON —— 节点会在推送前检查，不合法就直接拒绝并说明原因，不会推一个半截的资产。

---

## 开发

```bash
cd comfyui-node
python -m unittest discover tests
```

测试不依赖 ComfyUI 也不依赖 torch：`IMAGE` 张量用一个带 `.shape` 与 `.tolist()` 的替身，HTTP 用一个进程内的真实服务器，断言的是**实际发出的请求**（路径、头、multipart 字段名、字节内容）。
