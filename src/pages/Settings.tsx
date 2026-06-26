import { useState, useEffect, useMemo } from 'react';

import { useAuth } from '../hooks/useAuth';
import { calculateLCHAllocation } from '../lib/lch-allocation';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

function getTodayString(): string {
  return new Date().toISOString().split('T')[0];
}

export default function Settings() {
  const { logout } = useAuth();
  const maxDate = useMemo(() => getTodayString(), []);
  const [birthDate, setBirthDate] = useState('');
  const [savedBirthYear, setSavedBirthYear] = useState<number | null>(null);
  const [savedBirthMonth, setSavedBirthMonth] = useState<number | null>(null);
  const [savedBirthDay, setSavedBirthDay] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<{ safe_ratio: number; ambition_ratio: number; age: number } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${API_BASE}/api/auth/profile`, { credentials: 'include', signal: controller.signal })
      .then(r => r.json() as Promise<{ success: boolean; data: { preferences?: Record<string, unknown> } }>)
      .then(json => {
        if (json.success) {
          const p = json.data.preferences ?? {};
          const by = p.birth_year as number | undefined;
          const bm = p.birth_month as number | undefined;
          const bd = p.birth_day as number | undefined;
          if (typeof by === 'number') {
            setSavedBirthYear(by);
            setSavedBirthMonth(typeof bm === 'number' ? bm : 6);
            setSavedBirthDay(typeof bd === 'number' ? bd : 15);
            setPreview(calculateLCHAllocation(by, bm ?? 6, bd ?? 15));
          }
        }
      })
      .catch((err) => console.error('Failed to fetch profile:', err))
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  const handleSave = async () => {
    if (!birthDate) return;
    const d = new Date(birthDate);
    const year = d.getFullYear();
    const month = d.getMonth() + 1;
    const day = d.getDate();
    if (year < 1900 || year > new Date().getFullYear()) {
      setMessage({ type: 'error', text: '请输入有效的出生日期' });
      return;
    }
    if (d.getMonth() !== month - 1) {
      setMessage({ type: 'error', text: '请输入有效的出生日期' });
      return;
    }

    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`${API_BASE}/api/auth/profile`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ birth_year: year, birth_month: month, birth_day: day }),
      });
      const json = await res.json() as { success: boolean; message?: string };
      if (json.success) {
        setSavedBirthYear(year);
        setSavedBirthMonth(month);
        setSavedBirthDay(day);
        setPreview(calculateLCHAllocation(year, month, day));
        setMessage({ type: 'success', text: `出生日期已保存: ${year}年${month}月${day}日` });
        setBirthDate('');
      } else {
        setMessage({ type: 'error', text: json.message ?? '保存失败' });
      }
    } catch (err) {
      console.error('Failed to save profile:', err);
      setMessage({ type: 'error', text: '网络错误' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-primary-600 rounded-lg flex items-center justify-center">
                <span className="text-white font-bold text-sm">α</span>
              </div>
              <h1 className="text-lg font-semibold text-gray-900">设置</h1>
            </div>
            <div className="flex items-center gap-4">
              <a href="/" className="text-sm text-primary-600 hover:text-primary-700">返回仪表盘</a>
              <button onClick={() => logout()} className="text-sm text-gray-500 hover:text-gray-700">退出登录</button>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="card">
          <h2 className="text-lg font-semibold text-gray-900 mb-2">生命周期假说（LCH）配置</h2>
          <p className="text-sm text-gray-500 mb-6">
            根据您的年龄，系统会自动计算安全层与进取层的资金分配比例。年龄越大，安全层比例越高。
          </p>

          {message && (
            <div className={`mb-4 p-3 text-sm rounded-lg ${message.type === 'success' ? 'bg-success-50 text-success-600' : 'bg-danger-50 text-danger-600'}`}>
              {message.text}
            </div>
          )}

          <div className="space-y-4">
            <div>
              <label className="label">出生日期</label>
              <input type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)}
                className="input" max={maxDate} />
              <p className="mt-1 text-xs text-gray-500">出生日期仅用于计算周岁年龄和LCH分配比例，不会用于其他用途</p>
            </div>

            <button onClick={handleSave} disabled={!birthDate || saving}
              className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed">
              {saving ? '保存中...' : '保存'}
            </button>
          </div>

          {preview && (
            <div className="mt-8 p-4 bg-gray-50 rounded-lg border border-gray-200">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">当前LCH分配预览</h3>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-500">年龄</span>
                  <span className="font-mono font-medium">{preview.age} 岁</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">安全层比例</span>
                  <span className="font-mono font-medium text-success-600">{(preview.safe_ratio * 100).toFixed(0)}%</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">进取层比例</span>
                  <span className="font-mono font-medium text-primary-600">{(preview.ambition_ratio * 100).toFixed(0)}%</span>
                </div>
                <div className="mt-3 pt-3 border-t border-gray-200">
                  <p className="text-xs text-gray-400">当策略演化报告不可用或 PBO &gt; 50% 时，将使用此分配方案。</p>
                </div>
              </div>
            </div>
          )}

          {loading && (
            <div className="mt-6 p-4 bg-gray-50 rounded-lg border border-gray-200">
              <p className="text-sm text-gray-500 animate-pulse">加载中...</p>
            </div>
          )}

          {!loading && savedBirthYear && !preview && (
            <div className="mt-6 p-4 bg-gray-50 rounded-lg border border-gray-200">
              <p className="text-sm text-gray-500">已保存出生日期: <span className="font-mono font-medium">{savedBirthYear}年{savedBirthMonth ?? 6}月{savedBirthDay ?? 15}日</span></p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
