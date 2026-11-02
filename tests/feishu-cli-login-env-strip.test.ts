/**
 * feishu-cli 登录流程的子进程环境（评审：L856 login 用 `env: process.env`、opener 没传 env）。
 *
 * 登录子进程（lark-cli / meegle 的 auth login）和随后弹出的系统浏览器 opener 都不需要 GitLab PAT
 * （`FLOWSHIP_GITLAB_TOKEN`）：opener 在 mac 上是 `open`、会把 env 传给被拉起的浏览器进程树，
 * login 子进程可能再派生浏览器 / 回调服务。宿主注入变量（ELECTRON_RUN_AS_NODE 等）同理不该透传。
 * 用 `stripHostInjectedEnvAndGitToken()`：只摘上述两类，PATH / HOME / 代理等照常保留。
 *
 * 行为测试：mock node:child_process 的 spawn、记录每次调用的 options.env；
 * 假 child 先后吐出一行飞书授权 URL，触发「抓 URL 自动开浏览器」的 opener spawn。
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SpawnCall = { cmd: string; args: string[]; opts: { env?: NodeJS.ProcessEnv } };
const spawnCalls = vi.hoisted(() => [] as SpawnCall[]);
const fakeChildren = vi.hoisted(() => [] as Array<{ stdout: unknown }>);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter: EE } = await import("node:events");
  return {
    ...actual,
    spawn: (cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
      spawnCalls.push({ cmd, args, opts });
      const child = Object.assign(new EE(), {
        stdout: new EE(),
        stderr: new EE(),
        pid: 4242,
        kill: () => true,
        unref: () => undefined,
      });
      fakeChildren.push(child);
      return child;
    },
  };
});

import { startLogin } from "@/lib/server/feishu-cli";

const SENTINELS: Record<string, string> = {
  FLOWSHIP_GITLAB_TOKEN: "glpat-SECRET-sentinel",
  ELECTRON_RUN_AS_NODE: "1",
  FLOWSHIP_PORT: "8876",
  HTTPS_PROXY: "http://proxy.local:3128",
};
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  spawnCalls.length = 0;
  fakeChildren.length = 0;
  for (const [k, v] of Object.entries(SENTINELS)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});

afterEach(() => {
  for (const k of Object.keys(SENTINELS)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("startLogin：login 子进程与 opener 都不带 PAT / 宿主注入变量", () => {
  it("lark-cli 登录子进程 env：无 PAT、无宿主注入变量，PATH / HOME / 代理保留；opener 同样", async () => {
    const r = await startLogin("lark-cli");
    expect(r.ok).toBe(true);

    // ① login 子进程
    expect(spawnCalls).toHaveLength(1);
    const loginEnv = spawnCalls[0]!.opts.env;
    expect(loginEnv, "login spawn 必须显式传 env").toBeTruthy();
    expect(loginEnv!.FLOWSHIP_GITLAB_TOKEN).toBeUndefined();
    expect(loginEnv!.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(loginEnv!.FLOWSHIP_PORT).toBeUndefined();
    // 该保留的保留（lark-cli 要找得到 PATH / HOME / 走代理）
    expect(loginEnv!.PATH).toBe(process.env.PATH);
    if (process.env.HOME) expect(loginEnv!.HOME).toBe(process.env.HOME);
    expect(loginEnv!.HTTPS_PROXY).toBe("http://proxy.local:3128");
    // 不污染 server 自己的 process.env
    expect(process.env.FLOWSHIP_GITLAB_TOKEN).toBe("glpat-SECRET-sentinel");

    // ② opener：CLI 打印飞书授权 URL → 服务端自动开系统浏览器
    const child = fakeChildren[0]! as unknown as { stdout: EventEmitter };
    child.stdout.emit("data", Buffer.from("请打开 https://accounts.feishu.cn/oauth/device?code=ABCD 完成授权\n"));
    expect(spawnCalls.length).toBe(2);
    const opener = spawnCalls[1]!;
    expect(opener.opts.env, "opener spawn 必须显式传 env（否则继承整份 process.env 含 PAT）").toBeTruthy();
    expect(opener.opts.env!.FLOWSHIP_GITLAB_TOKEN).toBeUndefined();
    expect(opener.opts.env!.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(opener.opts.env!.PATH).toBe(process.env.PATH);
  });
});
