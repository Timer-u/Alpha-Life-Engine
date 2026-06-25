import type { ApiResponse, AuthSession } from '../types/api';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

interface User {
  id: number;
  email: string;
  name: string | null;
}

// 类型守卫：验证 /auth/me 的响应格式
function isMeResponse(obj: unknown): obj is { user: User } {
  if (!obj || typeof obj !== 'object') return false;
  const o = obj as Record<string, unknown>;
  return (
    'user' in o && typeof o.user === 'object' && o.user !== null
  );
}

// 类型守卫：验证 /auth/otp/verify 的完整 AuthSession 响应
function isAuthSessionData(obj: unknown): obj is { user: User; token: string; expires_at: string } {
  if (!obj || typeof obj !== 'object') return false;
  const o = obj as Record<string, unknown>;
  return (
    'user' in o && typeof o.user === 'object' && o.user !== null &&
    'token' in o && typeof o.token === 'string' &&
    'expires_at' in o && typeof o.expires_at === 'string'
  );
}

async function fetchMe(): Promise<{ user: User }> {
  const res = await fetch(`${API_BASE}/api/auth/me`, { credentials: 'include' });
  if (!res.ok) {
    throw new Error('Not authenticated');
  }
  const json = await res.json() as unknown;
  if (!isApiResponse(json) || !isMeResponse(json.data)) {
    throw new Error('Invalid response format from /me');
  }
  return { user: json.data.user };
}

async function requestOtp(email: string): Promise<{ message: string; expires_in: number }> {
  const res = await fetch(`${API_BASE}/api/auth/otp/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const json = await res.json() as unknown;
  if (!isApiResponse(json) || !json.success) {
    const msg = json && typeof json === 'object' && 'message' in json ? String(json.message) : 'Request failed';
    throw new Error(msg);
  }
  const data = json.data as Record<string, unknown> | undefined;
  if (!data || typeof data.message !== 'string' || typeof data.expires_in !== 'number') {
    throw new Error('Invalid response format');
  }
  return { message: data.message, expires_in: data.expires_in };
}

async function verifyOtp({ email, otp }: { email: string; otp: string }): Promise<AuthSession> {
  const res = await fetch(`${API_BASE}/api/auth/otp/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email, otp }),
  });
  const json = await res.json() as unknown;
  if (!isApiResponse(json) || !json.success) {
    const msg = json && typeof json === 'object' && 'message' in json ? String(json.message) : 'Verification failed';
    throw new Error(msg);
  }
  if (!isAuthSessionData(json.data)) {
    throw new Error('Invalid session data');
  }
  return json.data as AuthSession;
}

async function logout(): Promise<void> {
  await fetch(`${API_BASE}/api/auth/logout`, { method: 'POST', credentials: 'include' });
}

function isApiResponse(obj: unknown): obj is ApiResponse<unknown> {
  return (
    obj !== null &&
    typeof obj === 'object' &&
    'success' in obj &&
    typeof (obj as Record<string, unknown>).success === 'boolean'
  );
}

export function useAuth() {
  const queryClient = useQueryClient();

  const { data: meData, isLoading, isFetched } = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: fetchMe,
    retry: false,
    staleTime: Infinity,
  });

  const isAuthenticated = !!meData;

  // isLoading: 首次加载且无缓存数据
  // isFetched: 查询已完成（无论成功/失败）
  const derivedLoading = isLoading && !isFetched;

  const requestOtpFn = useCallback(async (email: string) => {
    return requestOtp(email);
  }, []);

  // 在 verifyOtp 成功后同步写入 React Query 缓存
  const verifyOtpFn = useCallback(async (params: { email: string; otp: string }) => {
    const data = await verifyOtp(params);
    queryClient.setQueryData(['auth', 'me'], { user: data.user });
    return data;
  }, [queryClient]);

  const requestOtpMutation = useMutation({
    mutationFn: requestOtpFn,
  });

  const verifyOtpMutation = useMutation({
    mutationFn: verifyOtpFn,
  });

  const logoutMutation = useMutation({
    mutationFn: logout,
    onSuccess: () => {
      queryClient.setQueryData(['auth', 'me'], undefined);
      queryClient.clear();
    },
  });

  return {
    user: meData?.user ?? null,
    isAuthenticated,
    isLoading: derivedLoading,
    requestOtp: requestOtpMutation.mutateAsync,
    isRequestingOtp: requestOtpMutation.isPending,
    requestOtpError: requestOtpMutation.error,
    verifyOtp: verifyOtpMutation.mutateAsync,
    isVerifyingOtp: verifyOtpMutation.isPending,
    verifyOtpError: verifyOtpMutation.error,
    logout: logoutMutation.mutateAsync,
    isLoggingOut: logoutMutation.isPending,
  };
}
