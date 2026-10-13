/**
 * boot-recovery 的第二层闸（第一层是 vitest setupFiles 的环境隔离，见 hermetic-vitest-env.test.ts）：
 * 测试进程（VITEST）的 DATA_DIR 落在桌面包数据目录下时，一律不做恢复——
 * 恢复会把 running 的聊天标 error、清 worktree、杀预览进程、GC SDK store，全是破坏性动作。
 *
 * 数据目录用「长得像桌面包、实际在临时目录里」的假路径，真数据不受牵连。
 * task-fs-core 在模块加载时钉死 DATA_DIR，所以这里每次都 resetModules + 先设 env 再 import。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { isAppUserDataPath } from "@/lib/server/app-data-dir";

const RECOVERY_FLAG = "__flowshipBootRecoveryPromiseV2__";
const g = globalThis as unknown as Record<string, unknown>;

const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowship-recovery-guard-"));
const appLikeData = path.join(
  root,
  "Library",
  "Application Support",
  "fe-ai-flow",
  "data",
);
const plainData = path.join(root, "plain", "data");

const seedRunning = (dataDir: string, id: string): { meta: string; events: string } => {
  const dir = path.join(dataDir, "tasks", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({
      id,
      title: "running 的聊天",
      mode: "chat",
      repoStatus: "developing",
      runStatus: "running",
      currentActionId: null,
      actions: [],
      mrs: [],
      repoPaths: [],
      createdAt: 1,
      updatedAt: 1,
    }),
    "utf-8",
  );
  return {
    meta: path.join(dir, "meta.json"),
    events: path.join(dir, "events.jsonl"),
  };
};

/** 以指定数据目录重新加载 task-fs（DATA_DIR 此刻钉死），加载完立刻还原 env，免得被 setup 的 beforeEach 拦 */
const loadTaskFsAt = async (dataDir: string) => {
  delete g[RECOVERY_FLAG];
  vi.resetModules();
  const saved = process.env.FLOWSHIP_DATA_DIR;
  process.env.FLOWSHIP_DATA_DIR = dataDir;
  try {
    return await import("@/lib/server/task-fs");
  } finally {
    process.env.FLOWSHIP_DATA_DIR = saved;
  }
};

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  delete g[RECOVERY_FLAG];
  fs.rmSync(root, { recursive: true, force: true });
});

describe("boot-recovery · 测试进程碰到桌面包数据目录", () => {
  it("假的桌面包目录（DATA_DIR 落在 <appData>/fe-ai-flow/data 下）：跳过恢复，running 的聊天原样不动", async () => {
    expect(isAppUserDataPath(appLikeData)).toBe(true);
    const seeded = seedRunning(appLikeData, "t_guarded");
    const before = fs.readFileSync(seeded.meta, "utf-8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { listTasks } = await loadTaskFsAt(appLikeData);
    await listTasks();

    // 没有被标 error、没有追加 [boot-recovery] 事件
    expect(fs.readFileSync(seeded.meta, "utf-8")).toBe(before);
    expect(JSON.parse(before).runStatus).toBe("running");
    expect(fs.existsSync(seeded.events)).toBe(false);
    // 留了一条说明：为什么跳过、跳过的是哪个目录
    const warned = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warned).toContain("boot recovery 已跳过");
    expect(warned).toContain(appLikeData);
  });

  it("对照：同样的种子放在普通临时目录里，恢复照常执行（running → error + [boot-recovery] 事件）", async () => {
    expect(isAppUserDataPath(plainData)).toBe(false);
    const seeded = seedRunning(plainData, "t_recovered");

    const { listTasks } = await loadTaskFsAt(plainData);
    await listTasks();

    // 没有这条对照，上一条「没被标 error」可能只是因为测试装置本身没法触发恢复
    expect(JSON.parse(fs.readFileSync(seeded.meta, "utf-8")).runStatus).toBe("error");
    expect(fs.readFileSync(seeded.events, "utf-8")).toContain("[boot-recovery]");
  });

  it("接线：闸只在测试进程（VITEST）里生效，且判的是模块加载时钉死的 DATA_DIR", () => {
    const src = fs.readFileSync(
      path.join(import.meta.dirname, "..", "src", "lib", "server", "task-fs.ts"),
      "utf-8",
    );
    expect(src).toMatch(
      /if \(process\.env\.VITEST && isAppUserDataPath\(DATA_DIR\)\) \{[\s\S]*?g\[RECOVERY_FLAG\] = Promise\.resolve\(\);[\s\S]*?return;/,
    );
    // 闸在真正跑恢复之前
    expect(src.indexOf("isAppUserDataPath(DATA_DIR)")).toBeLessThan(
      src.indexOf("runBootRecovery().catch("),
    );
  });
});
