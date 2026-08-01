import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAuth } from '../hooks/useAuth';

export default function Login() {
  const navigate = useNavigate();
  const { isAuthenticated, requestOtp, verifyOtp, isRequestingOtp, isVerifyingOtp, requestOtpError, verifyOtpError } = useAuth();
  const shouldReduceMotion = useReducedMotion() ?? false;
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

  const formVariants = {
    initial: { opacity: 0, x: shouldReduceMotion ? 0 : 16 },
    animate: { opacity: 1, x: 0, transition: { duration: shouldReduceMotion ? 0 : 0.26 } },
    exit: { opacity: 0, x: shouldReduceMotion ? 0 : -16, transition: { duration: shouldReduceMotion ? 0 : 0.18 } },
  };

  const buttonMotion = {
    whileHover: shouldReduceMotion ? undefined : { y: -1 },
    whileTap: shouldReduceMotion ? undefined : { scale: 0.98 },
  };

  return (
    <motion.div
      className="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-50 to-gray-100 px-4"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: shouldReduceMotion ? 0 : 0.35 }}
    >
      <div className="w-full max-w-md">
        <motion.div
          className="text-center mb-8"
          initial={{ opacity: 0, y: shouldReduceMotion ? 0 : -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: shouldReduceMotion ? 0 : 0.32 }}
        >
          <h1 className="text-3xl font-bold text-gray-900 mb-2">Alpha-Life Engine</h1>
          <p className="text-gray-500">个人量化定投系统</p>
        </motion.div>

        <motion.div
          className="card overflow-hidden"
          layout
          initial={{ opacity: 0, y: shouldReduceMotion ? 0 : 12, scale: shouldReduceMotion ? 1 : 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: shouldReduceMotion ? 0 : 0.32, delay: shouldReduceMotion ? 0 : 0.06 }}
        >
          <AnimatePresence mode="wait" initial={false}>
            {step === 'email' ? (
              <motion.form key="email" onSubmit={handleRequestOtp} className="space-y-4" variants={formVariants} initial="initial" animate="animate" exit="exit">
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
                <AnimatePresence initial={false}>
                  {requestOtpError && (
                    <motion.div key="request-error" className="p-3 bg-danger-50 text-danger-600 text-sm rounded-lg" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
                      {requestOtpError.message}
                    </motion.div>
                  )}
                </AnimatePresence>
                <motion.button
                  type="submit"
                  disabled={isRequestingOtp || !email.trim()}
                  className="btn-primary w-full disabled:opacity-50"
                  {...buttonMotion}
                >
                  {isRequestingOtp ? '发送中...' : '发送验证码'}
                </motion.button>
              </motion.form>
            ) : (
              <motion.form key="otp" onSubmit={handleVerifyOtp} className="space-y-4" variants={formVariants} initial="initial" animate="animate" exit="exit">
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
                <AnimatePresence initial={false}>
                  {verifyOtpError && (
                    <motion.div key="verify-error" className="p-3 bg-danger-50 text-danger-600 text-sm rounded-lg" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
                      {verifyOtpError.message}
                    </motion.div>
                  )}
                </AnimatePresence>
                <motion.button
                  type="submit"
                  disabled={isVerifyingOtp || otp.length !== 6}
                  className="btn-primary w-full disabled:opacity-50"
                  {...buttonMotion}
                >
                  {isVerifyingOtp ? '验证中...' : '验证并登录'}
                </motion.button>
                <div className="flex items-center justify-between text-sm">
                  <motion.button type="button" onClick={() => setStep('email')} className="text-primary-600" {...buttonMotion}>
                    ← 返回
                  </motion.button>
                  <motion.button
                    type="button"
                    onClick={handleResend}
                    disabled={countdown > 0}
                    className="text-primary-600 disabled:text-gray-400"
                    {...buttonMotion}
                  >
                    {countdown > 0 ? countdown + '秒后重发' : '重新发送'}
                  </motion.button>
                </div>
              </motion.form>
            )}
          </AnimatePresence>
        </motion.div>

        <motion.p className="text-center text-xs text-gray-400 mt-6" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: shouldReduceMotion ? 0 : 0.18 }}>
          Alpha-Life Engine v1.0 · OTP 认证 · 7天会话
        </motion.p>
      </div>
    </motion.div>
  );
}
