export type AssetType = 'image' | 'video' | 'other';
export type AssetStatus = 'ready' | 'processing' | 'failed' | 'deleted';

export interface Asset {
  id: string;
  title: string;
  description?: string | null;
  filename: string;
  original_name: string;
  mime_type: string;
  file_size: number;
  file_hash: string;
  asset_type: AssetType;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
  storage_path: string;
  thumbnail_path?: string | null;
  status: AssetStatus;
  uploaded_by?: string | null;
  source: string;
  source_tool?: string | null;
  prompt?: string | null;
  seed?: number | null;
  model_name?: string | null;
  job_id?: string | null;
  metadata_json?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Category { id: string; name: string; slug: string; parent_id?: string | null; description?: string | null; sort_order: number; }
export interface Tag { id: string; name: string; slug: string; color?: string | null; usage_count: number; }
export interface ApiKey { id: string; name: string; key_prefix: string; key_masked: string; scopes: string; is_active: boolean; last_used_at?: string | null; expires_at?: string | null; created_at: string; }
export interface WebhookEndpoint { id: string; name: string; url: string; is_active: boolean; created_at: string; }
export interface Job { id: string; title: string; status: AssetStatus; asset_type: AssetType; source_tool: string; job_id?: string | null; created_at: string; }
export interface PageResp<T> { items: T[]; total: number; page: number; page_size: number; }
