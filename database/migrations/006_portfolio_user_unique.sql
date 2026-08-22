-- 006: portfolio.user_id 唯一索引
-- 首登 user+portfolio 两跳写入非原子（auth.ts 2026-08-22 审计 P2）：
-- 第二条 INSERT 瞬时失败后 user 已落库，后续登录不再补建 portfolio。
-- 该索引让 auth 的 INSERT OR IGNORE 幂等补建具备并发安全（无索引时
-- NOT EXISTS 守卫在并发下仍可双插）。
CREATE UNIQUE INDEX IF NOT EXISTS idx_portfolio_user_id ON portfolio(user_id);

-- config 表删除（2026-08-22 审计）：播种后全代码无 FROM config 读取，
-- 真实事实源是 TRIGGER_CONSTANTS / ETF_CONSTANTS（src/types/api.ts）。
DROP TABLE IF EXISTS config;
