import { http, apiGet, apiPost, apiPatch, apiDelete, unwrap } from './client'
import type { Asset, AssetType, AssetStatus, PageResponse } from '@/types'

export interface AssetListParams {
  keyword?: string
  asset_type?: AssetType
  category_id?: number
  tag_names?: string
  uploader_id?: number
  status?: AssetStatus
  include_deleted?: boolean
  order_by?: string
  page?: number
  page_size?: number
}

export const assetsApi = {
  list: (params: AssetListParams = {}) =>
    apiGet<PageResponse<Asset>>('/api/v1/assets', params),

  get: (id: number) => apiGet<Asset>(`/api/v1/assets/${id}`),

  update: (id: number, payload: Partial<Asset>) =>
    apiPatch<Asset>(`/api/v1/assets/${id}`, payload),

  remove: (id: number, permanent = false) =>
    apiDelete(`/api/v1/assets/${id}`, { params: { permanent } }),

  restore: (id: number) => apiPost<Asset>(`/api/v1/assets/${id}/restore`),

  getDownloadUrl: (id: number) =>
    apiPost<{ download_url: string; filename: string; size: number }>(`/api/v1/assets/${id}/download`),

  upload: (file: File, meta: {
    title?: string
    description?: string
    category_id?: number
    tag_names?: string
    onProgress?: (e: ProgressEvent) => void
  }) => {
    const form = new FormData()
    form.append('file', file)
    if (meta.title) form.append('title', meta.title)
    if (meta.description) form.append('description', meta.description)
    if (meta.category_id) form.append('category_id', String(meta.category_id))
    if (meta.tag_names) form.append('tag_names', meta.tag_names)
    return http.post('/api/v1/assets/upload', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
      onUploadProgress: (e) => {
        if (meta.onProgress && e.total) {
          meta.onProgress({
            loaded: e.loaded,
            total: e.total,
            lengthComputable: true,
          } as ProgressEvent)
        }
      },
    }).then((r) => unwrap<Asset>(r))
  },

  uploadBatch: (files: File[], meta: { category_id?: number; tag_names?: string }) => {
    const form = new FormData()
    files.forEach((f) => form.append('files', f))
    if (meta.category_id) form.append('category_id', String(meta.category_id))
    if (meta.tag_names) form.append('tag_names', meta.tag_names)
    return http.post('/api/v1/assets/upload/batch', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then((r) => unwrap<Asset[]>(r))
  },

  stats: () => apiGet<any>('/api/v1/assets/stats'),

  // Chunked upload
  initUpload: (params: {
    filename: string
    file_size: number
    mime_type?: string
    file_hash?: string
    chunk_size?: number
    title?: string
    description?: string
    category_id?: number
    tag_names?: string
  }) => apiPost<{ session_id: string; chunk_size: number; total_chunks: number; received_chunks: number[]; expires_at: string }>(
    '/api/v1/upload/init', params,
  ),

  uploadChunk: (session_id: string, chunk_index: number, chunk: Blob, onProgress?: (e: ProgressEvent) => void) => {
    const form = new FormData()
    form.append('chunk', chunk)
    return http.put(`/api/v1/upload/chunk/${session_id}`, form, {
      params: { chunk_index },
      headers: { 'Content-Type': 'multipart/form-data' },
      onUploadProgress: (e) => {
        if (onProgress && e.total) {
          onProgress({
            loaded: e.loaded,
            total: e.total,
            lengthComputable: true,
          } as ProgressEvent)
        }
      },
    })
  },

  completeUpload: (session_id: string, meta: { title?: string; description?: string; category_id?: number; tag_names?: string }) =>
    apiPost<Asset>('/api/v1/upload/complete', { session_id, ...meta }),
}
