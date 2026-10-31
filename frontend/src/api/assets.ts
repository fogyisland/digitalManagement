/**
 * Asset API surface.
 *
 * Every shape here mirrors the backend one-for-one:
 *   - `backend/src/routes/assets.js`   — the asset routes
 *   - `backend/src/routes/upload.js`   — the chunked-upload routes
 *   - `backend/src/routes/stats.js`    — the statistics routes
 *   - `backend/src/lib/dto.js`         — the canonical serializers
 *
 * Two rules the whole file obeys:
 *
 * 1. **Paths are relative to `/api/v1`** — the shared axios instance already
 *    carries the prefix, so a path that repeats it resolves to
 *    `/api/v1/api/v1/...` and answers 404.
 * 2. **Ids are strings.** The backend uses nanoid TEXT primary keys, so an
 *    `id` is never a number.
 */
import { http, apiGet, apiPost, apiPut, apiDelete, apiClient, isNotFound } from './client'
import type {
  Asset,
  AssetDownloadTicket,
  AssetListParams,
  AssetManifest,
  AssetStats,
  AssetUpdatePayload,
  AssetUploadResult,
  DashboardData,
  PageResponse,
  UploadChunkResult,
  UploadCompletePayload,
  UploadInitPayload,
  UploadSession,
} from '@/types'

export const assetsApi = {
  /**
   * `GET /assets` — paginated asset list.
   *
   * The backend's search parameter is `q`; the UI calls it `keyword`. The
   * translation happens here so each side keeps its own vocabulary and the
   * search box does not silently return the unfiltered list.
   */
  list: (params: AssetListParams = {}) => {
    const { keyword, ...rest } = params
    return apiGet<PageResponse<Asset>>(
      '/assets',
      keyword ? { ...rest, q: keyword } : rest,
    )
  },

  /** `GET /assets/:id` */
  get: (id: string) => apiGet<Asset>(`/assets/${id}`),

  /** `GET /assets/:id/manifest` */
  manifest: (id: string) => apiGet<AssetManifest>(`/assets/${id}/manifest`),

  /** `PUT /assets/:id` — only title / description / category_id / tag_names / status. */
  update: (id: string, payload: AssetUpdatePayload) =>
    apiPut<Asset>(`/assets/${id}`, payload),

  /**
   * `DELETE /assets/:id`
   *
   * The backend **soft-deletes** by default: the row moves to the recycle
   * bin (`status='deleted'`) and the file stays on disk. `permanent=true`
   * erases the row *and* the file. `POST /assets/:id/restore` brings a
   * soft-deleted asset back.
   */
  remove: (id: string, permanent = false) =>
    apiDelete<void>(`/assets/${id}`, { params: { permanent } }),

  /** `POST /assets/:id/restore` — 400 when the asset is not in the recycle bin. */
  restore: (id: string) => apiPost<Asset>(`/assets/${id}/restore`),

  /** `POST /assets/:id/download` — 410 when the file is gone from disk. */
  getDownloadUrl: (id: string) =>
    apiPost<AssetDownloadTicket>(`/assets/${id}/download`),

  /**
   * `POST /assets/upload` — multipart upload of a single file.
   *
   * The backend mounts `upload.array('files', 20)` — the field name is the
   * plural `files`. A field named `file` is rejected by multer with
   * "Unexpected field". The response is `{ items, count }`, not a bare
   * array.
   */
  upload: (
    file: File,
    meta: {
      title?: string
      description?: string
      category_id?: string
      tag_names?: string
      onProgress?: (e: ProgressEvent) => void
    },
  ) => {
    const form = new FormData()
    form.append('files', file)
    if (meta.title) form.append('title', meta.title)
    if (meta.description) form.append('description', meta.description)
    if (meta.category_id) form.append('category_id', String(meta.category_id))
    if (meta.tag_names) form.append('tag_names', meta.tag_names)
    return http
      .post('/assets/upload', form, {
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
      })
      .then((r) => r.data as AssetUploadResult)
  },

  /**
   * `POST /assets/upload` — multipart upload of several files at once.
   *
   * The backend has a single multi-file endpoint (`upload.array('files', 20)`);
   * there is no separate `/assets/upload/batch` route.
   */
  uploadBatch: (
    files: File[],
    meta: { title?: string; category_id?: string; tag_names?: string },
  ) => {
    const form = new FormData()
    files.forEach((f) => form.append('files', f))
    if (meta.title) form.append('title', meta.title)
    if (meta.category_id) form.append('category_id', String(meta.category_id))
    if (meta.tag_names) form.append('tag_names', meta.tag_names)
    return http
      .post('/assets/upload', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      .then((r) => r.data as AssetUploadResult)
  },

  /** `GET /stats` */
  stats: () => apiGet<AssetStats>('/stats'),

  /** `GET /stats/dashboard` */
  dashboard: () => apiGet<DashboardData>('/stats/dashboard'),

  /* ---------------------------------------------------------------------
     Chunked upload — `backend/src/routes/upload.js`

       POST /upload/init              -> session descriptor
       PUT  /upload/chunk/:session_id -> progress (field name: `chunk`)
       POST /upload/complete          -> Asset

     The chunk index starts at **0**; the backend rejects anything outside
     `[0, total_chunks - 1]`.
     --------------------------------------------------------------------- */

  /** `POST /upload/init` */
  initUpload: (params: UploadInitPayload) =>
    apiPost<UploadSession>('/upload/init', params),

  /**
   * `PUT /upload/chunk/:session_id?chunk_index=N`
   *
   * The multipart field name is `chunk` (singular) here — unlike the
   * multi-file `files` field used by `POST /assets/upload`.
   */
  uploadChunk: (
    session_id: string,
    chunk_index: number,
    chunk: Blob,
    onProgress?: (e: ProgressEvent) => void,
  ) => {
    const form = new FormData()
    form.append('chunk', chunk)
    return http
      .put(`/upload/chunk/${session_id}`, form, {
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
      .then((r) => r.data as UploadChunkResult)
  },

  /** `POST /upload/complete` */
  completeUpload: (payload: UploadCompletePayload) =>
    apiPost<Asset>('/upload/complete', payload),
}

/* ============================================================================
   Import API surface
   ----------------------------------------------------------------------------
   `POST /assets/import-url` and `POST /assets/from-comfyui/:job_id` are
   served by the backend; they used to 404 while the routes were missing.
   The wrappers below mirror the real request/response shapes.
   ============================================================================ */

/** Extra fields `POST /assets/upload` accepts alongside the files. */
export interface UploadAssetMeta {
  title?: string
  description?: string
  prompt?: string
  seed?: number | null
  model_name?: string
  job_id?: string
  source_tool?: string | null
  metadata_json?: string | null
}

/**
 * Build the multipart payload expected by `POST /assets/upload`.
 *
 * The caller owns the `files` (plural — matches the backend's
 * `upload.array('files', 20)`) entries; everything else is optional and
 * only appended when truthy so we never send empty strings.
 */
export function buildUploadFormData(
  files: File[],
  meta: UploadAssetMeta,
): FormData {
  const form = new FormData()
  for (const f of files) form.append('files', f)
  if (meta.title) form.append('title', meta.title)
  if (meta.description) form.append('description', meta.description)
  if (meta.prompt) form.append('prompt', meta.prompt)
  if (
    meta.seed !== undefined &&
    meta.seed !== null &&
    Number.isFinite(meta.seed)
  ) {
    form.append('seed', String(meta.seed))
  }
  if (meta.model_name) form.append('model_name', meta.model_name)
  if (meta.job_id) form.append('job_id', meta.job_id)
  if (meta.source_tool) form.append('source_tool', meta.source_tool)
  if (meta.metadata_json && meta.metadata_json.trim().length > 0) {
    form.append('metadata_json', meta.metadata_json)
  }
  return form
}

/**
 * `POST /assets/upload` — multipart upload + ComfyUI metadata fields.
 *
 * Backend response shape: `{ items: Asset[], count: number }`. We unwrap to
 * the array; callers that need a single asset use `uploadAssetOne`.
 */
export async function uploadAsset(form: FormData): Promise<Asset[]> {
  const r = await apiClient.post<AssetUploadResult>('/assets/upload', form, {
    headers: { 'content-type': 'multipart/form-data' },
  })
  return Array.isArray(r.data?.items) ? r.data.items : []
}

/** Convenience wrapper — returns the first uploaded asset, or null. */
export async function uploadAssetOne(form: FormData): Promise<Asset | null> {
  const items = await uploadAsset(form)
  return items.length > 0 ? items[0] : null
}

/**
 * `POST /assets/import-url` — import an asset by external URL.
 *
 * The backend downloads the file, stores it and answers 201 with the new
 * asset. A download failure answers 502 with `{ detail }`.
 */
export async function importUrlByUrl(form: {
  url: string
  title?: string
  source_tool?: string | null
}): Promise<Asset> {
  const r = await apiClient.post<Asset>('/assets/import-url', form)
  return r.data
}

/**
 * `GET /jobs/by-comfyui/:job_id` — look up the asset registered for an
 * upstream ComfyUI identifier.
 *
 * The backend answers 404 when the job has no asset yet, so a 404 is
 * translated into `null` (meaning "not registered") rather than an
 * exception. Every other failure still propagates.
 */
export async function lookupComfyUiJob(jobId: string): Promise<Asset | null> {
  try {
    const r = await apiClient.get<Asset | null>(
      `/jobs/by-comfyui/${encodeURIComponent(jobId)}`,
    )
    return r.data ?? null
  } catch (e: unknown) {
    if (isNotFound(e)) return null
    throw e
  }
}

/**
 * `POST /assets/from-comfyui/:job_id` — register an asset from a known
 * ComfyUI job.
 *
 * With a `url` the backend downloads the real output (201). Without one it
 * registers a placeholder whose status is `processing` (201). If the job is
 * already registered the backend answers 200 with the existing asset.
 */
export async function registerAssetByComfyJob(
  jobId: string,
  payload: {
    url?: string
    title?: string
    prompt?: string
    seed?: number | null
    model_name?: string
    metadata?: string
  } = {},
): Promise<Asset> {
  const r = await apiClient.post<Asset>(
    `/assets/from-comfyui/${encodeURIComponent(jobId)}`,
    payload,
  )
  return r.data
}
