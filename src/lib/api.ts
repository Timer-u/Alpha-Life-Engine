export const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

/**
 * 统一 fetch 封装：401 一律抛 'UNAUTHORIZED'（调用方统一按会话过期处理，
 * 各 hook 不再各自漏识别）；HTTP 层错误转中文提示。
 */
export async function apiFetch(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, { credentials: 'include', ...init });
  if (res.status === 401) {
    throw new Error('UNAUTHORIZED');
  }
  if (!res.ok) {
    throw new Error(`请求失败 (HTTP ${res.status})`);
  }
  return res.json();
}

/** React Query retry 谓词：会话过期不重试 */
export function retryExceptUnauthorized(failureCount: number, error: unknown): boolean {
  if (error instanceof Error && error.message === 'UNAUTHORIZED') return false;
  return failureCount < 3;
}
