import axios, { AxiosError, AxiosInstance, AxiosRequestConfig } from 'axios'
import { message } from 'antd'

const baseURL = import.meta.env.VITE_API_BASE_URL || ''

export const http: AxiosInstance = axios.create({
  baseURL,
  timeout: 60000,
})

let isRedirectingToLogin = false

http.interceptors.request.use((config) => {
  const token = localStorage.getItem('dam_access_token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

http.interceptors.response.use(
  (response) => response,
  (error: AxiosError<any>) => {
    const status = error.response?.status
    const data = error.response?.data
    const msg = data?.message || error.message

    if (status === 401) {
      if (!isRedirectingToLogin) {
        isRedirectingToLogin = true
        message.error('登录已过期，请重新登录')
        localStorage.removeItem('dam_access_token')
        localStorage.removeItem('dam_refresh_token')
        setTimeout(() => {
          window.location.href = '/login'
        }, 500)
      }
    } else if (status === 403) {
      message.error(msg || '权限不足')
    } else if (status === 413) {
      message.error(msg || '文件过大')
    } else if (status === 415) {
      message.error(msg || '不支持的文件类型')
    } else if (status && status >= 500) {
      message.error(msg || '服务器错误')
    } else if (msg && status !== 422) {
      message.error(msg)
    }

    return Promise.reject(error)
  },
)

export interface ApiEnvelope<T = any> {
  code: number
  message: string
  data: T
  request_id?: string
}

export function unwrap<T = any>(resp: { data: ApiEnvelope<T> } | ApiEnvelope<T>): T {
  const envelope = ('data' in resp ? resp.data : resp) as ApiEnvelope<T>
  if (envelope.code !== 0) {
    throw new Error(envelope.message || 'Request failed')
  }
  return envelope.data as T
}

export async function apiGet<T = any>(url: string, params?: any, config?: AxiosRequestConfig): Promise<T> {
  const resp = await http.get(url, { params, ...config })
  return unwrap<T>(resp)
}

export async function apiPost<T = any>(url: string, data?: any, config?: AxiosRequestConfig): Promise<T> {
  const resp = await http.post(url, data, config)
  return unwrap<T>(resp)
}

export async function apiPatch<T = any>(url: string, data?: any, config?: AxiosRequestConfig): Promise<T> {
  const resp = await http.patch(url, data, config)
  return unwrap<T>(resp)
}

export async function apiDelete<T = any>(url: string, config?: AxiosRequestConfig): Promise<T> {
  const resp = await http.delete(url, config)
  return unwrap<T>(resp)
}
