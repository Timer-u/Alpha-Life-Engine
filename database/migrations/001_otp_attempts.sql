-- Migration 001: OTP 验证尝试次数（P0 安全修复）
--
-- 背景：schema.sql 采用「整体幂等重放」（CREATE TABLE IF NOT EXISTS），
-- 无法对已存在的表做 ALTER。新库由 schema.sql 的 CREATE TABLE 直接带上
-- attempts 列；已存在的库需要执行本文件一次。
--
-- 本迁移只能执行一次（重复执行会报 duplicate column name: attempts，可忽略）。
--
-- 本地：npx wrangler d1 execute alpha-life-dev  --local  --env development --file=./database/migrations/001_otp_attempts.sql
-- 生产：npx wrangler d1 execute alpha-life-prod --remote --env production  --file=./database/migrations/001_otp_attempts.sql

ALTER TABLE otps ADD COLUMN attempts INTEGER DEFAULT 0;
