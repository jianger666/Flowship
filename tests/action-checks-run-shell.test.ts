/**
 * action-checks.runShell（评审 P2）：
 *  - env 不再带 GitLab PAT（与其它 git 出口同口径，用户仓钩子整份继承 env 会拿到它）、带 GIT_OPTIONAL_LOCKS=0；
 *  - 超时强杀后孙进程占着 stdout 管道时 close 不来，不能让推进检查永远挂住；
 *  - 单路输出有上限。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  RUN_SHELL_KILL_GRACE_MS,
  RUN_SHELL_OUTPUT_CAP,
  runShell,
} from "@/lib/server/action-checks";

const TOKEN_NAME = "FLOWSHIP_GITLAB_TOKEN";
let savedToken: string | undefined;
beforeEach(() => {
  savedToken = process.env[TOKEN_NAME];
});
afterEach(() => {
  if (savedToken === undefined) delete process.env[TOKEN_NAME];
  else process.env[TOKEN_NAME] = savedToken;
});

describe("runShell", () => {
  it("子进程 env 里没有 GitLab PAT（任意大小写），有 GIT_OPTIONAL_LOCKS=0 / GIT_TERMINAL_PROMPT=0", async () => {
    process.env[TOKEN_NAME] = "glpat-should-not-leak";
    const r = await runShell(
      process.execPath,
      [
        "-e",
        "process.stdout.write(JSON.stringify({" +
          "leak: Object.keys(process.env).filter(k => k.toUpperCase() === 'FLOWSHIP_GITLAB_TOKEN')," +
          "locks: process.env.GIT_OPTIONAL_LOCKS, prompt: process.env.GIT_TERMINAL_PROMPT }))",
      ],
      process.cwd(),
      20_000,
    );
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ leak: [], locks: "0", prompt: "0" });
  });

  it("超时强杀后孙进程仍占着 stdout 管道：宽限后照样返回（不无限挂住），stderr 带超时说明", async () => {
    // sh 起一个后台 sleep 继承管道、自己再 sleep：SIGKILL 杀掉 sh 后，管道仍被后台 sleep 持有 → close 不来
    const t0 = Date.now();
    const r = await runShell("sh", ["-c", "sleep 6 & sleep 6"], process.cwd(), 200);
    const took = Date.now() - t0;
    expect(r.exitCode).toBe(-1);
    expect(r.stderr).toContain("超时 200ms、强杀");
    // 必须在「超时 + 宽限」附近返回，远早于孙进程自己退出（6s）
    expect(took).toBeLessThan(200 + RUN_SHELL_KILL_GRACE_MS + 1500);
  }, 15_000);

  it("单路输出超过上限后丢弃后续输出并留提示，进程照常正常退出", async () => {
    const over = RUN_SHELL_OUTPUT_CAP + 4 * 1024 * 1024;
    const r = await runShell(
      process.execPath,
      ["-e", `process.stdout.write('x'.repeat(${over}))`],
      process.cwd(),
      30_000,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout.length).toBeLessThan(over);
    expect(r.stdout).toContain("stdout 超过上限");
  }, 30_000);

  it("命令不存在 → notFound，不抛", async () => {
    const r = await runShell("definitely-not-a-real-command-xyz", [], process.cwd(), 5_000);
    expect(r.notFound).toBe(true);
    expect(r.exitCode).toBe(-1);
  });
});
