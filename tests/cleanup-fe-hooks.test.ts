/**
 * 存量 fe hooks.json 清理：指纹只认 fe 自己注入的形态，不误删业务仓库同名脚本（review C1-01）。
 * hooks.json 在业务仓里是已跟踪文件，误删会被带进 MR。
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanupFeHooksJson, isFeCommand } from "@/lib/server/cleanup-fe-hooks";

describe("isFeCommand 指纹", () => {
  it.each([
    // 旧 .sh 代：整串就是 fe scripts 目录的绝对路径（含 Windows、含空格）
    "/Applications/Flowship.app/Contents/Resources/app-server/scripts/stop-hook.sh",
    "/opt/fe-ai-flow/scripts/shell-guard.sh",
    "C:\\Users\\John Smith\\AppData\\fe-ai-flow\\scripts\\stop-hook.sh",
    '"/Users/me/fe ai flow/scripts/stop-hook.sh"',
    // V0.8+ .mjs 代：带 ELECTRON_RUN_AS_NODE
    'ELECTRON_RUN_AS_NODE=1 "/x/Flowship" "/x/app-server/scripts/stop-hook.mjs"',
  ])("命中 fe 注入：%s", (cmd) => {
    expect(isFeCommand(cmd)).toBe(true);
  });

  it.each([
    // 业务仓库自己的同名脚本
    "./scripts/stop-hook.sh",
    "scripts/shell-guard.sh",
    "bash scripts/stop-hook.sh",
    "sh ./scripts/shell-guard.sh --strict",
    '"$CURSOR_PROJECT_DIR/scripts/stop-hook.sh"',
    ".cursor/scripts/stop-hook.sh",
    "/abs/path/scripts/stop-hook.sh --flag",
    // .mjs 但没有 fe 的 env 特征
    "node scripts/stop-hook.mjs",
    // 完全无关
    "npx prettier --check .",
  ])("不碰仓库自己的：%s", (cmd) => {
    expect(isFeCommand(cmd)).toBe(false);
  });
});

describe("cleanupFeHooksJson", () => {
  let cwd: string;
  const hooksPath = () => path.join(cwd, ".cursor", "hooks.json");
  const write = (obj: unknown) => {
    mkdirSync(path.join(cwd, ".cursor"), { recursive: true });
    writeFileSync(hooksPath(), JSON.stringify(obj, null, 2));
  };

  beforeEach(() => {
    cwd = mkdtempSync(path.join(os.tmpdir(), "cleanup-hooks-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(cwd, { recursive: true, force: true });
  });

  it("全是 fe 的 → 删整文件", async () => {
    write({
      version: 1,
      hooks: {
        stop: [{ command: "/opt/fe-ai-flow/scripts/stop-hook.sh", loop_limit: 3 }],
      },
    });
    await cleanupFeHooksJson(cwd);
    expect(existsSync(hooksPath())).toBe(false);
  });

  it("仓库自己的同名 stop-hook.sh 原样保留（文件不被改写）", async () => {
    const original = {
      version: 1,
      hooks: { stop: [{ command: "./scripts/stop-hook.sh" }] },
    };
    write(original);
    const before = readFileSync(hooksPath(), "utf8");
    await cleanupFeHooksJson(cwd);
    expect(readFileSync(hooksPath(), "utf8")).toBe(before);
  });

  it("混合：只删 fe 条目，保留仓库自己的（含同名相对路径）", async () => {
    write({
      version: 1,
      hooks: {
        stop: [
          { command: "/opt/fe-ai-flow/scripts/stop-hook.sh" },
          { command: "./scripts/stop-hook.sh" },
        ],
      },
    });
    await cleanupFeHooksJson(cwd);
    const after = JSON.parse(readFileSync(hooksPath(), "utf8"));
    expect(after.hooks.stop).toEqual([{ command: "./scripts/stop-hook.sh" }]);
  });
});
