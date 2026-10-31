import { http, apiGet, apiPost, apiPut, apiDelete, unwrap } from './client'
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

/** Aggregate counters as served by `GET /stats`. */
export interface AssetStats {
  total: number
  images: number
  videos: number
  total_size: number
  recent: Array<{
    id: string
    title: string
    asset_type: AssetType
    file_size: number
    created_at: string
  }>
}

export const assetsApi = {
  list: (params: AssetListParams = {}) => {
    const { keyword, ...rest } = params
    // The backend's search parameter is `q`; the UI calls it `keyword`.
    // Translate here so each side keeps its own vocabulary and the search
    // box does not silently return the unfiltered list.
    return apiGet<PageResponse<Asset>>('/assets', keyword ? { ...rest, q: keyword } : rest)
  },

  get: (id: number) => apiGet<Asset>(`/assets/${id}`),

  update: (id: number, payload: Partial<Asset>) =>
    apiPut<Asset>(`/assets/${id}`, payload),

  remove: (id: number, permanent = false) =>
    apiDelete(`/assets/${id}`, { params: { permanent } }),

  restore: (id: number) => apiPost<Asset>(`/assets/${id}/restore`),

  getDownloadUrl: (id: number) =>
    apiPost<{ download_url: string; filename: string; size: number }>(`/assets/${id}/download`),

  upload: (file: File, meta: {
    title?: string
    description?: string
    category_id?: number
    tag_names?: string
    onProgress?: (e: ProgressEvent) => void
  }) => {
    const form = new FormData()
    // The backend mounts `upload.array('files', 20)` — the field name is the
    // plural `files`. A field named `file` is rejected by multer with
    // "Unexpected field".
    form.append('files', file)
    if (meta.title) form.append('title', meta.title)
    if (meta.description) form.append('description', meta.description)
    if (meta.category_id) form.append('category_id', String(meta.category_id))
    if (meta.tag_names) form.append('tag_names', meta.tag_names)
    return http.post('/assets/upload', form, {
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
    // The backend has a single multi-file endpoint (`upload.array('files', 20)`);
    // there is no separate `/assets/upload/batch` route.
    return http.post('/assets/upload', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then((r) => unwrap<Asset[]>(r))
  },

  stats: () => apiGet<AssetStats>('/stats'),

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
    '/upload/init', params,
  ),

  uploadChunk: (session_id: string, chunk_index: number, chunk: Blob, onProgress?: (e: ProgressEvent) => void) => {
    const form = new FormData()
    form.append('chunk', chunk)
    return http.put(`/upload/chunk/${session_id}`, form, {
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
    apiPost<Asset>('/upload/complete', { session_id, ...meta }),
}

/* ============================================================================
   Task 14 — Import API surface
   ----------------------------------------------------------------------------
   The legacy `assetsApi` above talks to a missing `http/apiGet/...` wrapper
   module and is kept untouched per the "no blind refactor" rule. The new
   entrypoints below ride the shared `apiClient` (baseURL `/api/v1`, 401 ->
   /login redirect) and return shapes the UI can consume directly.
   ============================================================================ */

import { apiClient } from './client';
import type { Asset as DtoAsset } from '@/types/dto';

export interface UploadAssetMeta {
  title?: string;
  description?: string;
  prompt?: string;
  seed?: number | null;
  model_name?: string;
  job_id?: string;
  source_tool?: 'manual' | 'comfyui' | 'admin' | string | null;
  metadata_json?: string | null;
}

/**
 * Build the multipart payload expected by `POST /assets/upload`.
 *
 * The caller owns the `files` (plural — matches the backend's
 * `upload.array('files', 20)`) entry; everything else is optional and only
 * appended when truthy so we never send empty strings.
 */
export function buildUploadFormData(files: File[], meta: UploadAssetMeta): FormData {
  const form = new FormData();
  for (const f of files) form.append('files', f);
  if (meta.title) form.append('title', meta.title);
  if (meta.description) form.append('description', meta.description);
  if (meta.prompt) form.append('prompt', meta.prompt);
  if (meta.seed !== undefined && meta.seed !== null && Number.isFinite(meta.seed)) {
    form.append('seed', String(meta.seed));
  }
  if (meta.model_name) form.append('model_name', meta.model_name);
  if (meta.job_id) form.append('job_id', meta.job_id);
  if (meta.source_tool) form.append('source_tool', meta.source_tool);
  if (meta.metadata_json && meta.metadata_json.trim().length > 0) {
    form.append('metadata_json', meta.metadata_json);
  }
  return form;
}

/**
 * `POST /assets/upload` — multipart upload + ComfyUI metadata fields.
 *
 * Backend response shape: `{ items: Asset[], count: number }`. We unwrap to
 * the array; callers that need a single asset use `uploadAssetOne`.
 */
export async function uploadAsset(form: FormData): Promise<DtoAsset[]> {
  const r = await apiClient.post<{ items?: DtoAsset[] } | DtoAsset[]>(
    '/assets/upload',
    form,
    { headers: { 'content-type': 'multipart/form-data' } },
  );
  const data = r.data;
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.items)) return data.items;
  return [];
}

/** Convenience wrapper — returns the first uploaded asset, or null. */
export async function uploadAssetOne(form: FormData): Promise<DtoAsset | null> {
  const items = await uploadAsset(form);
  return items.length > 0 ? items[0] : null;
}

/**
 * `POST /assets/import-url` — import an asset by external URL.
 *
 * Concern parked: as of this task's baseline, no route by that name exists
 * on the backend. The call will surface a 404 in the UI until the backend
 * ships a matching handler; the wrapper is here so the page can land and
 * the route can be wired without touching the page code.
 */
export async function importUrlByUrl(form: {
  url: string;
  title?: string;
  source_tool?: string | null;
}): Promise<DtoAsset> {
  const r = await apiClient.post<DtoAsset>('/assets/import-url', form);
  return r.data;
}

/**
 * `GET /jobs/by-comfyui/:job_id` — look up an existing job by the upstream
 * ComfyUI identifier.
 *
 * Concern parked: backend currently has no `jobs` table or `/jobs/...`
 * routes (only the asset-level `job_id` column). The endpoint is expected
 * to be added when the jobs dashboard lands; until then, this will 404 and
 * the UI surfaces the error gracefully.
 */
export async function lookupComfyUiJob(jobId: string): Promise<DtoAsset | null> {
  const r = await apiClient.get<DtoAsset | null>(`/jobs/by-comfyui/${encodeURIComponent(jobId)}`);
  return r.data ?? null;
}

/**
 * `POST /assets/from-comfyui/:job_id` — register a placeholder asset from
 * a known ComfyUI job.
 *
 * Concern parked: backend has no such route today. Same rationale as
 * `importUrlByUrl` above — keep the surface ready, surface 404 in UI.
 */
export async function registerAssetByComfyJob(jobId: string): Promise<DtoAsset> {
  const r = await apiClient.post<DtoAsset>(`/assets/from-comfyui/${encodeURIComponent(jobId)}`, {});
  return r.data;
}
