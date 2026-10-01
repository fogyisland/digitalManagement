import axios, { AxiosError } from 'axios';

const TOKEN_KEY = 'dam.token';

export function getToken(): string | null { return localStorage.getItem(TOKEN_KEY); }
export function setToken(t: string | null) { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); }

export const apiClient = axios.create({ baseURL: '/api/v1', timeout: 30000 });

apiClient.interceptors.request.use((cfg) => {
  const t = getToken();
  if (t) cfg.headers.Authorization = `Bearer ${t}`;
  return cfg;
});

apiClient.interceptors.response.use(
  (r) => r,
  (err: AxiosError) => {
    if (err.response?.status === 401 && !location.pathname.startsWith('/login')) {
      setToken(null);
      location.href = '/login';
    }
    return Promise.reject(err);
  }
);
