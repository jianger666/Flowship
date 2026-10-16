/**
 * 会话启动 / 恢复时的 GitLab Token → process.env 同步（task-runner.syncSessionGitTokenEnv）
 *
 * 背景：FLOWSHIP_GITLAB_TOKEN 是进程级全局变量，所有并行 task / chat 的 agent shell 共用。
 * 以前这里写成 `syncGitTokenEnv(await resolveSessionGitToken(...))`，而回落读盘的 `readServerGitToken`
 * 把「读失败」（权限 / 被杀软占用的 EBUSY / JSON 读到一半）和「确定没有」都吞成 undefined——
 * 于是一次瞬时读失败就会 delete 掉这个变量，正在跑的**别的会话**下一条命令就拿不到凭据（401）。
 * git-token-env.ts 的 `syncGitTokenEnvFromSettingsResult` 早就按三态处理（error 不动 env），
 * chat-runner / instrumentation 都用它，只有 task-runner 这两处漏了。
 *
 * 全程用假 token，不读真实 config.json。
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GITLAB_TOKEN_ENV_NAME } from "@/lib/server/git-token-env";
import type { SettingsReadResult } from "@/lib/server/settings-fs";
import { syncSessionGitTokenEnv } from "@/lib/server/task-runner";

const ENTRY_TOKEN = "glpat-ENTRYFAKE0000000001";
const DISK_TOKEN = "glpat-DISKFAKE00000000002";
const RUNNING_TOKEN = "glpat-RUNNINGFAKE000000003";

const ok = (settings: Record<string, unknown>): SettingsReadResult => ({
  status: "ok",
  settings,
});

let saved: string | undefined;
beforeEach(() => {
  saved = process.env[GITLAB_TOKEN_ENV_NAME];
  // 模拟「另一个并行会话已经把 token 放进 env、正在用」
  process.env[GITLAB_TOKEN_ENV_NAME] = RUNNING_TOKEN;
});
afterEach(() => {
  if (saved === undefined) delete process.env[GITLAB_TOKEN_ENV_NAME];
  else process.env[GITLAB_TOKEN_ENV_NAME] = saved;
});

describe("syncSessionGitTokenEnv", () => {
  it("入口带了 token → 写入 env（trim 后），不读盘", async () => {
    const read = vi.fn(async () => ok({ gitToken: DISK_TOKEN }));
    await syncSessionGitTokenEnv({ gitToken: `  ${ENTRY_TOKEN}\n` }, read);
    expect(process.env[GITLAB_TOKEN_ENV_NAME]).toBe(ENTRY_TOKEN);
    expect(read).not.toHaveBeenCalled();
  });

  it("入口没带 → 回落盘上的 gitToken", async () => {
    await syncSessionGitTokenEnv({}, async () => ok({ gitToken: ` ${DISK_TOKEN} ` }));
    expect(process.env[GITLAB_TOKEN_ENV_NAME]).toBe(DISK_TOKEN);
  });

  it("入口带的是空串 / 纯空白 → 同样回落读盘", async () => {
    const read = vi.fn(async () => ok({ gitToken: DISK_TOKEN }));
    await syncSessionGitTokenEnv({ gitToken: "   " }, read);
    expect(read).toHaveBeenCalledTimes(1);
    expect(process.env[GITLAB_TOKEN_ENV_NAME]).toBe(DISK_TOKEN);
  });

  it("确定没有（config.json 不存在）→ 清掉 env，而不是留空串", async () => {
    await syncSessionGitTokenEnv({}, async () => ({ status: "missing" }));
    expect(GITLAB_TOKEN_ENV_NAME in process.env).toBe(false);
  });

  it("确定没有（文件在、gitToken 缺失 / 全空白）→ 清掉 env", async () => {
    await syncSessionGitTokenEnv({}, async () => ok({ apiKey: "k" }));
    expect(GITLAB_TOKEN_ENV_NAME in process.env).toBe(false);

    process.env[GITLAB_TOKEN_ENV_NAME] = RUNNING_TOKEN;
    await syncSessionGitTokenEnv({}, async () => ok({ gitToken: "  \n" }));
    expect(GITLAB_TOKEN_ENV_NAME in process.env).toBe(false);
  });

  // 核心回归点：读失败 ≠ 用户清空了 token
  it("读盘失败（error）→ 不动 env：别把并行会话正在用的 token 清掉", async () => {
    await syncSessionGitTokenEnv({}, async () => ({
      status: "error",
      reason: "EBUSY: resource busy or locked",
    }));
    expect(process.env[GITLAB_TOKEN_ENV_NAME]).toBe(RUNNING_TOKEN);

    await syncSessionGitTokenEnv({ gitToken: "   " }, async () => ({
      status: "error",
      reason: "json_parse: Unexpected end of JSON input",
    }));
    expect(process.env[GITLAB_TOKEN_ENV_NAME]).toBe(RUNNING_TOKEN);
  });

  it("入口带了 token 时，读盘失败与否都无关（不会读盘）", async () => {
    await syncSessionGitTokenEnv({ gitToken: ENTRY_TOKEN }, async () => {
      throw new Error("不该被调用");
    });
    expect(process.env[GITLAB_TOKEN_ENV_NAME]).toBe(ENTRY_TOKEN);
  });
});

// 接线契约：task-runner 里启动 / 恢复两处都必须走带状态的 syncSessionGitTokenEnv，
// 不能退回 `syncGitTokenEnv(<可能因读失败而是 undefined 的值>)`
describe("task-runner 接线", () => {
  // 只看代码、不看注释：注释里要解释「旧写法为什么不行」，会原样引用旧写法
  const src = fs
    .readFileSync(path.join(process.cwd(), "src/lib/server/task-runner.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("启动（Agent.create 之前）与恢复（Agent.resume 之前）都调 syncSessionGitTokenEnv", () => {
    const occurrences = src.split("await syncSessionGitTokenEnv(").length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it("不再有「把 resolveSessionGitToken 的结果直接塞给 syncGitTokenEnv」的写法", () => {
    expect(src).not.toMatch(/syncGitTokenEnv\(\s*await resolveSessionGitToken\(/);
    expect(src).not.toMatch(/^\s*syncGitTokenEnv\(gitToken\);/m);
  });
});
