/* ============================================
   API Contract Types — 前后端唯一契约源
   ============================================

   本文件严格镜像 `backend/src/lib/dto.js` 中各 `toXxx()` 序列化函数的输出
   形状。`frontend/tests/contract.test.js` 会在 CI 中校验前后端是否漂移。

   规则：
   1. 所有实体主键都是**字符串**（后端用 nanoid 生成 TEXT 主键），不是数字。
   2. 字段名与后端 JSON 完全一致（snake_case），不做前端重命名。
   3. 词表（status / role / asset_type / scopes）必须与后端白名单完全一致。
   4. 不允许出现后端 DTO 中不存在的字段（那会让前端读到 undefined）。

   后端 DTO 字段数校验：toAsset 31 键 / toUser 9 / toApiKey 9 / toTag 6 /
   toCategory 7 / toWebhook 6 / toPage 5。
   ============================================ */

/* --------------------------------------------------------------------------
   资源类型与状态词表
   -------------------------------------------------------------------------- */

/** `detectAssetType()` 依据 MIME 推导：image | video | other。 */
export type AssetType = 'image' | 'video' | 'other'

/** `ASSET_STATUSES` 白名单。`deleted` 表示已软删除（进回收站）。 */
export type AssetStatus = 'ready' | 'processing' | 'failed' | 'deleted'

/** 用户角色白名单。 */
export type UserRole = 'admin' | 'editor' | 'viewer' | 'superadmin'

/** 用户状态：后端由 `is_active` 派生，只有 active / disabled 两态。 */
export type UserStatus = 'active' | 'disabled'

/** API Key 权限白名单（`KNOWN_SCOPES`）。`*` 表示全权限。 */
export type ApiKeyScope = 'read' | 'upload' | 'delete' | 'write' | '*'

/**
 * Webhook 事件词表（`WEBHOOK_EVENTS`，后端 `backend/src/lib/webhook.js`）。
 *
 * 订阅列表为空表示「订阅全部事件」——这是后端的语义，前端不再自己发明。
 */
export type WebhookEvent =
  | 'asset.created'
  | 'asset.updated'
  | 'asset.deleted'
  | 'asset.restored'
  | 'asset.metadata_updated'
  | 'tenant.created'
  | 'tenant.updated'

/* --------------------------------------------------------------------------
   Asset — 镜像 toAsset()
   -------------------------------------------------------------------------- */

export interface Asset {
  id: string
  title: string
  description: string | null
  /** 落盘文件名（`<id>.<ext>`）。 */
  filename: string
  /** 用户上传时的原始文件名。 */
  original_name: string
  mime_type: string
  file_size: number
  file_hash: string
  asset_type: AssetType
  category_id: string | null
  width: number | null
  height: number | null
  duration: number | null
  /** 相对 STORAGE_DIR 的存储路径，如 `originals/abc.png`。 */
  storage_path: string
  thumbnail_path: string | null
  /** 浏览器可访问的缩略图地址 `/storage/...`，无缩略图时为 null。 */
  thumbnail_url: string | null
  /** 预览地址：优先缩略图，缺省回落到原图。 */
  preview_url: string | null
  /** 原图地址 `/storage/...`。 */
  original_url: string | null
  status: AssetStatus
  /** 软删除时间；非回收站资产为 null。 */
  deleted_at: string | null
  /** 上传者用户 id。 */
  uploaded_by: string | null
  source: string
  source_tool: string | null
  prompt: string | null
  seed: number | null
  model_name: string | null
  job_id: string | null
  /** 原始元数据的 JSON 字符串（未解析）。 */
  metadata_json: string | null
  /** 资产绑定的标签名数组。 */
  tag_names: string[]
  created_at: string
  updated_at: string
}

/** `PUT /assets/:id` 可接受的字段白名单（后端只认这五个）。 */
export interface AssetUpdatePayload {
  title?: string
  description?: string | null
  category_id?: string | null
  tag_names?: string[]
  status?: Exclude<AssetStatus, 'deleted'>
}

/** `GET /assets/:id/manifest` 的响应形状。 */
export interface AssetManifest {
  id: string
  title: string
  asset_type: AssetType
  source_tool: string | null
  job_id: string | null
  prompt: string | null
  seed: number | null
  model_name: string | null
  metadata: Record<string, unknown> | null
  original_path: string
  thumbnail_path: string | null
  public_url: string
  created_at: string
}

/** `POST /assets/:id/download` 的响应形状。 */
export interface AssetDownloadTicket {
  download_url: string
  filename: string
  size: number
  mime_type: string
}

/** `POST /assets/upload` 的响应形状。 */
export interface AssetUploadResult {
  items: Asset[]
  count: number
}

/** `GET /assets` 的查询参数（后端 query 词表）。 */
export interface AssetListParams {
  /** 前端叫 keyword，后端参数名是 `q`，见 `assetsApi.list`。 */
  keyword?: string
  asset_type?: AssetType
  category_id?: string
  tag_names?: string
  uploader_id?: string
  status?: AssetStatus
  include_deleted?: boolean
  order_by?: string
  page?: number
  page_size?: number
}

/* --------------------------------------------------------------------------
   User — 镜像 toUser()
   -------------------------------------------------------------------------- */

export interface User {
  id: string
  username: string
  email: string | null
  display_name: string | null
  role: UserRole
  status: UserStatus
  is_superuser: boolean
  /** 用户所属租户；平台超管的租户为 `*`。 */
  tenant_id: string | null
  last_login_at: string | null
  created_at: string
}

/** `POST /users` 的请求体。 */
export interface UserCreatePayload {
  username: string
  email?: string | null
  password: string
  display_name?: string | null
  role: UserRole
}

/** `PUT /users/:id` 的请求体。 */
export interface UserUpdatePayload {
  email?: string | null
  display_name?: string | null
  role?: UserRole
  status?: UserStatus
  password?: string
}

/** `GET /users` 的查询参数。 */
export interface UserListParams {
  keyword?: string
  role?: UserRole
  status?: UserStatus
  page?: number
  page_size?: number
}

/* --------------------------------------------------------------------------
   Tenant — 镜像 toTenant()
   -------------------------------------------------------------------------- */

/**
 * 一个租户。
 *
 * 平台管理员用它决定「当前在哪个租户里行事」：选中之后，请求带上
 * `X-Tenant: <id>`，后端把这次请求的读写都收窄到这个租户。
 */
export interface Tenant {
  id: string
  name: string
  slug: string
  status: string
  created_at: string
  /** 租户里有多少资产 —— 停用或删除之前，平台管理员先看这个。 */
  asset_count: number
  /** 租户里有多少账号。 */
  user_count: number
}

/** `GET /tenants` 的响应。 */
export interface TenantListResponse {
  items: Tenant[]
}

/** 新建 / 修改租户时提交的东西。 */
export interface TenantInput {
  name: string
  slug?: string
  id?: string
  status?: 'active' | 'suspended'
}

/**
 * 登录页能看到的租户。
 *
 * 这是**公开**目录：还没有会话的人也要能选一个租户登录，所以它只有 id、
 * 名称和状态——租户里的资产、账号、计数，在登录之前不关别人的事。
 */
export interface TenantDirectoryEntry {
  id: string
  name: string
  status: string
}

/** `GET /auth/tenants` 的响应。 */
export interface TenantDirectoryResponse {
  items: TenantDirectoryEntry[]
}

/* --------------------------------------------------------------------------
   Platform — 平台层：在所有租户之上的那一层
   -------------------------------------------------------------------------- */

/** 平台的总账：跨租户算出来的一次。 */
export interface PlatformStats {
  /** 租户总数。 */
  tenants: number
  /** 其中还开着的租户数。 */
  active_tenants: number
  /** 全平台的账号数。 */
  accounts: number
  /** 能进平台门的账号数。 */
  platform_administrators: number
  /** 全平台的资产数（不含回收站）。 */
  assets: number
  /** 回收站里的资产数。 */
  trashed_assets: number
  /** 全平台占用的存储字节数。 */
  storage_bytes: number
  categories: number
  tags: number
  /** 最近 24 小时的请求数。 */
  requests_24h: number
  /** 最近 24 小时进来的字节数。 */
  bytes_in_24h: number
  /** 最近 24 小时出去的字节数。 */
  bytes_out_24h: number
  /** 最近 24 小时里出错（4xx / 5xx）的请求数。 */
  errors_24h: number
}

/** 平台层看到的账号——跨租户。 */
export interface PlatformAccount {
  id: string
  username: string
  email: string | null
  display_name: string | null
  role: UserRole
  status: UserStatus
  /** 账号所属的租户；平台超管是 `*`。 */
  tenant_id: string
  last_login_at: string | null
  created_at: string
}

/** `GET /platform/accounts` 的响应。 */
export interface PlatformAccountListResponse {
  items: PlatformAccount[]
  total: number
}

/** 平台层做过的一件事。 */
export interface PlatformAuditEntry {
  id: string
  tenant_id: string
  user_id: string | null
  /** 做事的人的用户名。 */
  username: string | null
  action: string
  resource_type: string
  resource_id: string | null
  /** JSON 文本，形状随 action 而定。 */
  details: string | null
  ip_address: string | null
  created_at: string
}

/** `GET /platform/audit` 的响应。 */
export interface PlatformAuditListResponse {
  items: PlatformAuditEntry[]
}

/** 租户里有人改过的一件事。 */
export interface AuditEntry {
  id: string
  /** 这件事属于哪个租户；平台层自己的动作记在 `*`。 */
  tenant_id: string
  user_id: string | null
  /** 做事的人的用户名。 */
  username: string | null
  /** 动作名，比如 `asset.created`。 */
  action: string
  resource_type: string
  resource_id: string | null
  /** JSON 文本，形状随 action 而定。 */
  details: string | null
  ip_address: string | null
  created_at: string
}

/** `GET /audit` 的响应。 */
export interface AuditListResponse {
  items: AuditEntry[]
}

/** 一次 API 调用——流量日志里的一行。 */
export interface PlatformRequest {
  id: string
  /** 这次调用说的是哪个租户；没有租户的调用记在 `*`。 */
  tenant_id: string
  user_id: string | null
  /** 调用人的用户名；没有凭证的调用是 `null`。 */
  username: string | null
  method: string
  /** 实际请求的路径。 */
  path: string
  /** 命中的路由样式，比如 `/assets/:id`。 */
  route: string
  status: number
  duration_ms: number
  bytes_in: number
  bytes_out: number
  ip_address: string | null
  created_at: string
}

/** `GET /platform/requests` 的响应。 */
export interface PlatformRequestListResponse {
  items: PlatformRequest[]
  total: number
}

/** 一个时间窗里的流量总数。 */
export interface PlatformTrafficSummary {
  /** 这个窗口有多长（小时）。 */
  window_hours: number
  requests: number
  bytes_in: number
  bytes_out: number
  errors: number
  server_errors: number
  /** 出错的请求占比，0–1。 */
  error_rate: number
  avg_duration_ms: number
}

/** 流量曲线上的一个桶（一个小时）。 */
export interface PlatformTrafficBucket {
  /** 桶的起点，形如 `2026-11-16 04:00:00`。 */
  bucket: string
  requests: number
  bytes_in: number
  bytes_out: number
  errors: number
}

/** 流量最重的几个路由。 */
export interface PlatformTrafficRoute {
  route: string
  requests: number
  bytes_out: number
  avg_duration_ms: number
}

/** `GET /platform/traffic` 的响应。 */
export interface PlatformTrafficReport {
  summary: PlatformTrafficSummary
  buckets: PlatformTrafficBucket[]
  routes: PlatformTrafficRoute[]
}

/* --------------------------------------------------------------------------
   MCP — 每个账户的 AI 接入凭证
   -------------------------------------------------------------------------- */

/** MCP 令牌能做的事。角色决定上限，令牌只能更少。 */
export type McpScope = 'read' | 'write' | 'delete'

/**
 * 一个 MCP 令牌。
 *
 * 令牌属于一个账户，代表那个账户说话：它的租户和角色就是账户的租户和
 * 角色。清单里只有前缀 —— 明文只在签发的那一次出现。
 */
export interface McpToken {
  id: string
  name: string
  token_prefix: string
  token_masked: string
  scopes: McpScope[]
  is_active: boolean
  last_used_at: string | null
  created_at: string
  user_id: string | null
  tenant_id: string | null
}

/** 签发时的那一次回答：带着明文令牌。 */
export interface McpTokenCreated extends McpToken {
  token: string
  warning: string
}

/** `GET /mcp/tokens` 的响应。 */
export interface McpTokenListResponse {
  items: McpToken[]
}

/* --------------------------------------------------------------------------
   Auth — 镜像 issueTokenPair()
   -------------------------------------------------------------------------- */

export interface TokenPair {
  access_token: string
  refresh_token: string
  token_type: string
  expires_in: number
}

/** `POST /auth/login` 的响应 = TokenPair + 当前用户。 */
export interface LoginResponse extends TokenPair {
  user: User
}

/* --------------------------------------------------------------------------
   Tag — 镜像 toTag()
   -------------------------------------------------------------------------- */

export interface Tag {
  id: string
  name: string
  slug: string
  color: string | null
  usage_count: number
  created_at: string
}

/** `PUT /tags/:id` 只接受 name 与 color。 */
export interface TagUpdatePayload {
  name?: string
  color?: string | null
}

/* --------------------------------------------------------------------------
   Category — 镜像 toCategory()
   -------------------------------------------------------------------------- */

export interface Category {
  id: string
  name: string
  slug: string
  parent_id: string | null
  description: string | null
  sort_order: number
  created_at: string
  /** 前端在 `categoriesApi.tree()` 中派生的子节点，后端不返回该字段。 */
  children?: Category[]
}

/** `PUT /categories/:id` 可接受的字段。 */
export interface CategoryUpdatePayload {
  name?: string
  description?: string | null
  parent_id?: string | null
  sort_order?: number
}

/* --------------------------------------------------------------------------
   ApiKey — 镜像 toApiKey()
   -------------------------------------------------------------------------- */

export interface ApiKey {
  id: string
  name: string
  key_prefix: string
  /** 掩码后的密钥，仅供展示。 */
  key_masked: string
  scopes: ApiKeyScope[]
  is_active: boolean
  last_used_at: string | null
  expires_at: string | null
  created_at: string
}

/**
 * `POST /api-keys` 的响应 —— 明文密钥只在创建时返回一次。
 *
 * 注意字段名是 `key`，不是 `api_key`。
 */
export interface ApiKeyCreated {
  id: string
  name: string
  key: string
  key_prefix: string
  scopes: ApiKeyScope[]
  expires_at: string | null
  warning: string
}

/** `PUT /api-keys/:id` 可接受的字段。 */
export interface ApiKeyUpdatePayload {
  name?: string
  scopes?: ApiKeyScope[]
  expires_at?: string | null
  is_active?: boolean
}

/* --------------------------------------------------------------------------
   Webhook — 镜像 toWebhook()
   -------------------------------------------------------------------------- */

export interface WebhookEndpoint {
  id: string
  name: string
  url: string
  is_active: boolean
  /** 订阅的事件列表；空数组表示订阅全部事件。 */
  events: WebhookEvent[]
  created_at: string
}

/** `POST /webhooks` 的响应 —— secret 只在创建时返回一次。 */
export interface WebhookCreated {
  id: string
  name: string
  url: string
  secret: string
  events: WebhookEvent[]
  warning: string
}

/** `PUT /webhooks/:id` 可接受的字段。 */
export interface WebhookUpdatePayload {
  name?: string
  url?: string
  events?: WebhookEvent[]
  is_active?: boolean
}

/* --------------------------------------------------------------------------
   分片上传 — 镜像 backend/src/routes/upload.js
   -------------------------------------------------------------------------- */

/** `POST /upload/init` 的响应。 */
export interface UploadSession {
  session_id: string
  chunk_size: number
  total_chunks: number
  received_chunks: number[]
  expires_at: string
}

/** `PUT /upload/chunk/:session_id` 的响应。 */
export interface UploadChunkResult {
  received_chunks: number[]
  received: number
  total_chunks: number
}

/** `POST /upload/init` 的请求体。 */
export interface UploadInitPayload {
  filename: string
  file_size: number
  mime_type?: string
  file_hash?: string
  chunk_size?: number
  title?: string
  description?: string
  category_id?: string
  tag_names?: string
}

/** `POST /upload/complete` 的请求体。 */
export interface UploadCompletePayload {
  session_id: string
  title?: string
  description?: string
  category_id?: string
  tag_names?: string
}

/* --------------------------------------------------------------------------
   统计
   -------------------------------------------------------------------------- */

/** `GET /stats` 的响应。 */
export interface AssetStats {
  total: number
  images: number
  videos: number
  total_size: number
  recent: Asset[]
}

/** `GET /stats/dashboard` 的响应。 */
export interface DashboardData {
  summary: {
    total_assets: number
    image_count: number
    video_count: number
    total_size_bytes: number
    storage_used_gb: number
    today_uploads: number
    week_uploads: number
    month_uploads: number
    tag_count: number
    category_count: number
    user_count: number
  }
  upload_trend: { date: string; count: number }[]
  recent_assets: Asset[]
}

/* --------------------------------------------------------------------------
   分页信封 — 镜像 toPage()
   -------------------------------------------------------------------------- */

export interface PageResponse<T> {
  items: T[]
  total: number
  page: number
  page_size: number
  total_pages: number
}
