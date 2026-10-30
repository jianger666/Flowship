/**
 * git-exec：git 子进程环境与容量的单一来源（R14 Q10-02 / Q10-04 / Q10-07）。
 *
 * 真钩子 / 真 fsmonitor 里看到的环境见 git-hook-env.test.ts；
 * 「src 下没有漏网的 git 调用点」见 git-exec-guard.test.ts。这里只钉 `gitEnv()` 本身的语义。
 *
 * 全程只用假 PAT（glpat-FAKE-…），不涉及任何真实凭据；每条用例前后保存 / 恢复被改动的环境变量。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GIT_MAX_BUFFER, gitEnv } from "@/lib/server/git-exec";
import { GITLAB_TOKEN_ENV_NAME } from "@/lib/server/git-token-env";
import { HOST_INJECTED_ENV_KEYS } from "@/lib/server/host-env";
import { GIT_MAX_BUFFER as WORKTREE_GIT_MAX_BUFFER } from "@/lib/server/task-worktrees";

const FAKE_PAT = "glpat-FAKE-unit-sentinel-0002";

const TOUCHED = [
  GITLAB_TOKEN_ENV_NAME,
  "flowship_gitlab_token",
  "GIT_TERMINAL_PROMPT",
  "GCM_INTERACTIVE",
  "GIT_INDEX_FILE",
  "TL_GIT_TOKEN",
  "ELECTRON_RUN_AS_NODE",
  "PORT",
  "FE_TEST_KEEP",
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of TOUCHED) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("gitEnv：交给 git 子进程（含它拉起的钩子 / 配置命令）的环境", () => {
  it("剔掉 GitLab PAT（含大小写变体）：任何变量名、任何变量值里都不该有", () => {
    process.env[GITLAB_TOKEN_ENV_NAME] = FAKE_PAT;
    process.env.flowship_gitlab_token = FAKE_PAT;

    const env = gitEnv();

    const names = Object.keys(env).filter(
      (k) => k.toLowerCase() === GITLAB_TOKEN_ENV_NAME.toLowerCase(),
    );
    expect(names).toEqual([]);
    expect(Object.values(env)).not.toContain(FAKE_PAT);
  });

  it("不等人输入：GIT_TERMINAL_PROMPT=0、GCM_INTERACTIVE=never，宿主设成别的值也一律覆盖", () => {
    delete process.env.GIT_TERMINAL_PROMPT;
    delete process.env.GCM_INTERACTIVE;
    expect(gitEnv()).toMatchObject({
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
    });

    process.env.GIT_TERMINAL_PROMPT = "1";
    process.env.GCM_INTERACTIVE = "always";
    expect(gitEnv()).toMatchObject({
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
    });
  });

  it("剔宿主注入变量、保留其余变量（PATH 等没被洗空）", () => {
    // 黑名单若改名 / 删项，下面的断言就失去意义——先钉住前提
    expect(HOST_INJECTED_ENV_KEYS).toEqual(
      expect.arrayContaining(["ELECTRON_RUN_AS_NODE", "PORT"]),
    );
    process.env.ELECTRON_RUN_AS_NODE = "1";
    process.env.PORT = "8876";
    process.env.FE_TEST_KEEP = "keep";

    const env = gitEnv();

    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.PORT).toBeUndefined();
    expect(env.FE_TEST_KEEP).toBe("keep");
    expect(env.PATH).toBe(process.env.PATH);
  });

  it("extra 叠在最后：调用方按需加变量（GIT_INDEX_FILE / GIT_OPTIONAL_LOCKS），undefined = 不设置", () => {
    const env = gitEnv({
      GIT_INDEX_FILE: "/tmp/fe-test.index",
      GIT_OPTIONAL_LOCKS: "0",
    });
    expect(env).toMatchObject({
      GIT_INDEX_FILE: "/tmp/fe-test.index",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
    });

    process.env.GIT_INDEX_FILE = "/tmp/outer.index";
    expect(gitEnv({ GIT_INDEX_FILE: undefined }).GIT_INDEX_FILE).toBeUndefined();

    // git-exec.ts 注释的承诺：extra 叠在最后，调用方可以显式覆盖 prompt 守卫（钉住「谁赢」；将来改顺序必须同时改这里）
    expect(gitEnv({ GIT_TERMINAL_PROMPT: "1", GCM_INTERACTIVE: "auto" })).toMatchObject({
      GIT_TERMINAL_PROMPT: "1",
      GCM_INTERACTIVE: "auto",
    });
    // 传 undefined = 取消守卫（key 还在、值是 undefined，spawn 会略过它）：这也是「可覆盖」的一部分，钉住它
    expect(gitEnv({ GIT_TERMINAL_PROMPT: undefined }).GIT_TERMINAL_PROMPT).toBeUndefined();
  });

  it("extra 也带不回 PAT：调用方即使显式传进来，最终环境里仍然没有", () => {
    const env = gitEnv({ [GITLAB_TOKEN_ENV_NAME]: FAKE_PAT });

    expect(
      Object.keys(env).filter(
        (k) => k.toLowerCase() === GITLAB_TOKEN_ENV_NAME.toLowerCase(),
      ),
    ).toEqual([]);
    expect(Object.values(env)).not.toContain(FAKE_PAT);
  });

  it("团队库自己的认证通道 TL_GIT_TOKEN 不被误伤：它走 extra 传入、原样保留", () => {
    const env = gitEnv({ TL_GIT_TOKEN: FAKE_PAT });

    expect(env.TL_GIT_TOKEN).toBe(FAKE_PAT);
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("不改 process.env；每次返回新对象（调用方随便改返回值也不会串到下一次）", () => {
    // prompt 守卫只在返回值里：宿主没设时，调用之后 process.env 里仍然没有（测试环境默认就设了 =0，所以先删再看）
    delete process.env.GIT_TERMINAL_PROMPT;
    delete process.env.GCM_INTERACTIVE;
    gitEnv();
    expect(process.env.GIT_TERMINAL_PROMPT).toBeUndefined();
    expect(process.env.GCM_INTERACTIVE).toBeUndefined();

    process.env[GITLAB_TOKEN_ENV_NAME] = FAKE_PAT;

    const a = gitEnv();
    a.FE_TEST_KEEP = "mutated";
    delete a.PATH;

    expect(process.env[GITLAB_TOKEN_ENV_NAME]).toBe(FAKE_PAT);
    expect(process.env.PATH).toBeTruthy();
    const b = gitEnv();
    expect(b).not.toBe(a);
    expect(b.FE_TEST_KEEP).toBe(process.env.FE_TEST_KEEP);
    expect(b.PATH).toBe(process.env.PATH);
  });
});

describe("GIT_MAX_BUFFER：git 输出容量的单一来源", () => {
  it("256MiB，且 task-worktrees 对外导出的同名常量就是它（既有 import 不用改）", () => {
    expect(GIT_MAX_BUFFER).toBe(256 * 1024 * 1024);
    expect(WORKTREE_GIT_MAX_BUFFER).toBe(GIT_MAX_BUFFER);
  });
});
