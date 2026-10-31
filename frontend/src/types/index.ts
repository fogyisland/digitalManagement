/* ============================================
   Shared Types
   ============================================ */

export type AssetType = 'image' | 'video' | 'other'
export type AssetStatus = 'active' | 'processing' | 'failed' | 'deleted'
export type UserRole = 'admin' | 'editor' | 'viewer'
export type UserStatus = 'active' | 'disabled' | 'locked'

export interface User {
  id: number
  username: string
  email: string
  display_name?: string | null
  avatar_url?: string | null
  role: UserRole
  status: UserStatus
  is_superuser: boolean
  last_login_at?: string | null
  created_at: string
}

export interface LoginResponse {
  access_token: string
  /**
   * The backend issues a single bearer token (`expiresIn: '7d'`) and does not
   * return a refresh token, so this field is absent from the response. It is
   * declared optional rather than removed so a future refresh flow can fill
   * it in without touching the type again.
   */
  refresh_token?: string
  token_type: string
  expires_in?: number
  user: User
}

export interface Asset {
  id: number
  asset_code: string
  title: string
  description?: string | null
  asset_type: AssetType
  mime_type: string
  file_ext: string
  file_size: number
  width?: number | null
  height?: number | null
  duration?: number | null
  thumbnail_url?: string | null
  preview_url?: string | null
  original_url?: string | null
  category_id?: number | null
  tag_names: string[]
  status: AssetStatus
  is_public: boolean
  uploader_id?: number | null
  uploader_name?: string | null
  source?: string
  source_url?: string | null
  external_ref?: string | null
  exif?: Record<string, any> | null
  file_hash: string
  download_count: number
  view_count: number
  versions?: AssetVersion[]
  created_at: string
  updated_at: string
}

export interface AssetVersion {
  id: number
  version_number: number
  file_size: number
  file_hash: string
  note?: string | null
  uploader_id?: number | null
  created_at: string
}

export interface Category {
  id: number
  name: string
  slug: string
  description?: string | null
  icon?: string | null
  color?: string | null
  sort_order: number
  parent_id?: number | null
  created_at: string
  children?: Category[]
}

export interface Tag {
  id: number
  name: string
  slug: string
  color: string
  description?: string | null
  usage_count: number
  created_at: string
}

export interface ApiKey {
  id: number
  name: string
  key_prefix: string
  key_masked?: string
  scopes: string[]
  is_active: boolean
  expires_at?: string | null
  last_used_at?: string | null
  last_used_ip?: string | null
  description?: string | null
  owner_id: number
  created_at: string
}

export interface ApiKeyCreated extends ApiKey {
  api_key: string
}

export interface PageResponse<T> {
  items: T[]
  total: number
  page: number
  page_size: number
  total_pages: number
}

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
