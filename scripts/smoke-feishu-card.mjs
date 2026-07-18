#!/usr/bin/env node
/**
 * 飞书桥接 S1 真机冒烟入口：
 * 建卡 → 发给 ou_965d86010f477fe5b3cca0e7e33665a2 → 流式 push×3 → finalize
 *
 * 用法（在 worktree 根目录）：
 *   node scripts/smoke-feishu-card.mjs
 *
 * 依赖：本机 PATH / tools/bin 上有已登录 bot 的 lark-cli。
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const env = {
  ...process.env,
  FEISHU_BRIDGE_LIVE: "1",
};

const r = spawnSync(
  "pnpm",
  ["exec", "vitest", "run", "tests/feishu-bridge-live-smoke.test.ts"],
  { cwd: root, env, stdio: "inherit", shell: process.platform === "win32" },
);

process.exit(r.status ?? 1);
