/**
 * lark-api runLark：传给 lark-cli 的 env 只减不增（摘宿主注入变量 + GitLab PAT）。
 * 与 inbound consumer spawn、feishu-cli 登录 / opener 出口统一（见 tests/spawn-host-env-strip.test.ts）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __resetLarkBinCacheForTest,
  __setLarkExecForTest,
  __setLarkRetryBaseForTest,
  larkApi,
  runLark,
} from "@/lib/server/feishu-bridge/lark-api";

const INJECTED: Record<string, string> = {
  FLOWSHIP_GITLAB_TOKEN: "fake-pat-for-test-only",
  ELECTRON_RUN_AS_NODE: "1",
  FLOWSHIP_DATA_DIR: "/tmp/flowship-env-strip-fake-data",
  FLOWSHIP_PORT: "3456",
  PORT: "3456",
  HOSTNAME: "127.0.0.1",
  __NEXT_PRIVATE_ORIGIN: "http://127.0.0.1:3456",
  HTTPS_PROXY: "http://proxy.test:8080",
};
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const [k, v] of Object.entries(INJECTED)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  __resetLarkBinCacheForTest();
  __setLarkRetryBaseForTest(0);
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  __setLarkExecForTest(null);
  __resetLarkBinCacheForTest();
  __setLarkRetryBaseForTest(null);
});

describe("runLark / larkApi：exec 收到的 env 只减不增", () => {
  it("不带 PAT 与宿主注入变量；PATH / HOME / 代理保留；process.env 本体不变；每次调用都是新副本", async () => {
    const envs: Array<NodeJS.ProcessEnv | undefined> = [];
    __setLarkExecForTest(async (_bin, _args, opts) => {
      envs.push(opts.env);
      return { stdout: JSON.stringify({ ok: true, data: {} }), stderr: "" };
    });
    await runLark(["im", "+messages-send"]);
    await larkApi("GET", "/open-apis/x");
    expect(envs).toHaveLength(2);
    for (const env of envs) {
      expect(env).toBeDefined();
      expect(env).not.toBe(process.env);
      for (const k of [
        "FLOWSHIP_GITLAB_TOKEN",
        "ELECTRON_RUN_AS_NODE",
        "FLOWSHIP_DATA_DIR",
        "FLOWSHIP_PORT",
        "PORT",
        "HOSTNAME",
        "__NEXT_PRIVATE_ORIGIN",
      ]) {
        expect(env![k], k).toBeUndefined();
      }
      expect(env!.PATH).toBe(process.env.PATH);
      expect(env!.HOME).toBe(process.env.HOME);
      expect(env!.HTTPS_PROXY).toBe("http://proxy.test:8080");
    }
    expect(envs[0]).not.toBe(envs[1]);
    // process.env 本体没被剔
    for (const [k, v] of Object.entries(INJECTED)) expect(process.env[k], k).toBe(v);
  });

  it("重试时每次 attempt 也都是摘过的 env（瞬时失败重试不会换回完整 process.env）", async () => {
    const envs: Array<NodeJS.ProcessEnv | undefined> = [];
    let n = 0;
    __setLarkExecForTest(async (_bin, _args, opts) => {
      envs.push(opts.env);
      n += 1;
      if (n === 1) {
        throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
      }
      return { stdout: JSON.stringify({ ok: true, data: {} }), stderr: "" };
    });
    await larkApi("GET", "/open-apis/x"); // GET 幂等 → 瞬时失败会重试
    expect(envs.length).toBeGreaterThanOrEqual(2);
    for (const env of envs) {
      expect(env!.FLOWSHIP_GITLAB_TOKEN).toBeUndefined();
      expect(env!.ELECTRON_RUN_AS_NODE).toBeUndefined();
      expect(env!.HTTPS_PROXY).toBe("http://proxy.test:8080");
    }
  });
});
