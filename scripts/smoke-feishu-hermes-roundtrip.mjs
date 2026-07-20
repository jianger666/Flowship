#!/usr/bin/env node
/**
 * 真机三张卡全流程入口（不重启 FlowshipTest）：
 * ① 纯思考轮 ② 带工具轮 ③ ask 按钮卡
 *
 * 用法（仓库根）：
 *   FLOWSHIP_DATA_DIR="$HOME/Library/Application Support/fe-ai-flow-test/data" \
 *   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-flowship-test" \
 *   node scripts/smoke-feishu-hermes-roundtrip.mjs
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = process.env.HOME || "";

const env = {
  ...process.env,
  FEISHU_BRIDGE_LIVE: "1",
  FLOWSHIP_TEST: "1",
  FLOWSHIP_DATA_DIR:
    process.env.FLOWSHIP_DATA_DIR ||
    path.join(home, "Library/Application Support/fe-ai-flow-test/data"),
  LARKSUITE_CLI_CONFIG_DIR:
    process.env.LARKSUITE_CLI_CONFIG_DIR ||
    path.join(home, ".lark-cli-flowship-test"),
};

const r = spawnSync(
  "pnpm",
  [
    "exec",
    "vitest",
    "run",
    "tests/feishu-bridge-live-smoke.test.ts",
    "-t",
    "Hermes 三卡验收",
  ],
  { cwd: root, env, stdio: "inherit", shell: process.platform === "win32" },
);

process.exit(r.status ?? 1);
