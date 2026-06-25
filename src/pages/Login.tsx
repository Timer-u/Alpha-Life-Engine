import { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAuth } from '../hooks/useAuth';

export default function Login() {
  const navigate = useNavigate();
  const { isAuthenticated, requestOtp, verifyOtp, isRequestingOtp, isVerifyingOtp, requestOtpError, verifyOtpError } = useAuth();
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [step, setStep] = useState<'email' | 'otp'>('email');
  const [countdown, setCountdown] = useState(0);

  useEffect(() => {
    if (isAuthenticated) {
      void navigate('/', { replace: true });
    }
  }, [isAuthenticated, navigate]);

  const startCountdown = useCallback(() => {
    setCountdown(60);
    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) { clearInterval(timer); return 0; }
        return prev - 1;
      });
    }, 1000);
  }, []);

  const handleRequestOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    try {
      await requestOtp(email.trim());
      setStep('otp');
      startCountdown();
    } catch {
      // requestOtpError 已在 UI 中通过 useAuth 显示
    }
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!otp.trim() || otp.length !== 6) return;
    try {
      await verifyOtp({ email: email.trim(), otp: otp.trim() });
      void navigate('/', { replace: true });
    } catch {
      // verifyOtpError 已在 UI 中通过 useAuth 显示
    }
  };

  const handleResend = async () => {
    if (countdown > 0) return;
    try {
      await requestOtp(email.trim());
      startCountdown();
    } catch {
      // requestOtpError 已在 UI 中通过 useAuth 显示
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-50 to-gray-100 px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">Alpha-Life Engine</h1>
          <p className="text-gray-500">个人量化定投系统</p>
        </div>

        <div className="card">
          {step === 'email' ? (
            <form onSubmit={handleRequestOtp} className="space-y-4">
              <div>
                <label className="label">邮箱地址</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="your@email.com"
                  className="input"
                  required
                  autoFocus
                />
                <p className="mt-1 text-xs text-gray-500">仅限白名单邮箱</p>
              </div>
              {requestOtpError && (
                <div className="p-3 bg-danger-50 text-danger-600 text-sm rounded-lg">
                  {requestOtpError.message}
                </div>
              )}
              <button
                type="submit"
                disabled={isRequestingOtp || !email.trim()}
                className="btn-primary w-full disabled:opacity-50"
              >
                {isRequestingOtp ? '发送中...' : '发送验证码'}
              </button>
            </form>
          ) : (
            <form onSubmit={handleVerifyOtp} className="space-y-4">
              <div>
                <label className="label">验证码</label>
                <p className="text-sm text-gray-600 mb-2">已发送至 {email}</p>
                <input
                  type="text"
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="000000"
                  className="input text-center text-2xl tracking-[0.5em] font-mono"
                  maxLength={6}
                  required
                  autoFocus
                />
              </div>
              {verifyOtpError && (
                <div className="p-3 bg-danger-50 text-danger-600 text-sm rounded-lg">
                  {verifyOtpError.message}
                </div>
              )}
              <button
                type="submit"
                disabled={isVerifyingOtp || otp.length !== 6}
                className="btn-primary w-full disabled:opacity-50"
              >
                {isVerifyingOtp ? '验证中...' : '验证并登录'}
              </button>
              <div className="flex items-center justify-between text-sm">
                <button type="button" onClick={() => setStep('email')} className="text-primary-600">
                  ← 返回
                </button>
                <button
                  type="button"
                  onClick={handleResend}
                  disabled={countdown > 0}
                  className="text-primary-600 disabled:text-gray-400"
                >
                  {countdown > 0 ? `${countdown}秒后重发` : '重新发送'}
                </button>
              </div>
            </form>
          )}
        </div>

        <p className="text-center text-xs text-gray-400 mt-6">
          Alpha-Life Engine v1.0 · OTP 认证 · 7天会话
        </p>
      </div>
    </div>
  );
}
