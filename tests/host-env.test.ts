/**
 * host-env：agent shell 环境清洗——宿主注入变量黑名单剔除
 *
 * 背景：Electron 宿主拉起 app-server 时注入 ELECTRON_RUN_AS_NODE / PORT /
 * FLOWSHIP_DATA_DIR 等，泄进 agent shell 会让用户命令启动 Electron 二进制静默秒退、
 * next build 报 generate is not a function（对齐 VS Code getUnixShellEnvironment 做法）。
 */
import { describe, expect, it } from "vitest";

import {
  HOST_INJECTED_ENV_KEYS,
  stripHostInjectedEnv,
} from "@/lib/server/host-env";

describe("stripHostInjectedEnv", () => {
  it("剔除全部黑名单变量", () => {
    const env = stripHostInjectedEnv({
      ELECTRON_RUN_AS_NODE: "1",
      PORT: "8876",
      HOSTNAME: "127.0.0.1",
      FLOWSHIP_DATA_DIR: "/tmp/fe-ai-flow/data",
      __NEXT_PRIVATE_STANDALONE_CONFIG: "{}",
      NEXT_DEPLOYMENT_ID: "abc",
      PATH: "/usr/bin:/bin",
      HOME: "/Users/demo",
    });
    for (const key of HOST_INJECTED_ENV_KEYS) {
      expect(env[key]).toBeUndefined();
    }
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/Users/demo");
  });

  it("不修改传入对象与 process.env 本体", () => {
    const base: Record<string, string | undefined> = {
      ELECTRON_RUN_AS_NODE: "1",
      A: "1",
    };
    const cleaned = stripHostInjectedEnv(base);
    expect(base.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(cleaned.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(cleaned.A).toBe("1");
    // 默认参数场景：process.env 不被原地修改
    const before = process.env.HOME;
    stripHostInjectedEnv();
    expect(process.env.HOME).toBe(before);
  });
});
