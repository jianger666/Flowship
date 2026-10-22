/**
 * host-env：agent shell 环境清洗——宿主注入变量黑名单剔除
 *
 * 背景：Electron 宿主拉起 app-server 时注入 ELECTRON_RUN_AS_NODE / PORT /
 * FLOWSHIP_DATA_DIR 等，泄进 agent shell 会让用户命令启动 Electron 二进制静默秒退、
 * next build 报 generate is not a function（对齐 VS Code getUnixShellEnvironment 做法）。
 */
import { describe, expect, it } from "vitest";

import { spawnSync } from "node:child_process";

import {
  HOST_INJECTED_ENV_KEYS,
  stripHostInjectedEnv,
  stripReportFlagsFromNodeOptions,
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

describe("NODE_OPTIONS 里宿主的取证旗标不泄进 agent shell（第二轮 review §10）", () => {
  const hostOptions =
    '--max-old-space-size=4096 --report-on-fatalerror --report-uncaught-exception --report-exclude-env --report-directory="/Users/x/Library/Application Support/fe-ai-flow/data/diagnostics/node-reports"';

  it("只剔 --report-*（含带引号、带空格的 --report-directory），--max-old-space-size 保留", () => {
    expect(stripReportFlagsFromNodeOptions(hostOptions)).toBe(
      "--max-old-space-size=4096",
    );
  });

  it("用户自带的其它 --report-* 设置不动", () => {
    expect(
      stripReportFlagsFromNodeOptions("--report-signal=SIGUSR2 --report-on-fatalerror"),
    ).toBe("--report-signal=SIGUSR2");
  });

  it("stripHostInjectedEnv：保留其余、全剔光时整条 NODE_OPTIONS 删掉、不留空串", () => {
    const kept = stripHostInjectedEnv({ NODE_OPTIONS: hostOptions, PATH: "/bin" });
    expect(kept.NODE_OPTIONS).toBe("--max-old-space-size=4096");
    expect(kept.PATH).toBe("/bin");

    const gone = stripHostInjectedEnv({
      NODE_OPTIONS:
        '--report-on-fatalerror --report-directory="/a b/c"',
    });
    expect("NODE_OPTIONS" in gone).toBe(false);
  });

  it("剔完的 NODE_OPTIONS 交给真 Node 仍然合法（引号切词没被破坏）", () => {
    const cleaned = stripHostInjectedEnv({ NODE_OPTIONS: hostOptions, PATH: process.env.PATH });
    const r = spawnSync(process.execPath, ["-e", "process.stdout.write('ok')"], {
      env: cleaned,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("ok");
  });

  it("不修改传入对象", () => {
    const base: Record<string, string | undefined> = { NODE_OPTIONS: hostOptions };
    stripHostInjectedEnv(base);
    expect(base.NODE_OPTIONS).toBe(hostOptions);
  });
});

describe("Q1-06：server 自己的 NODE_ENV=production 不泄进用户命令（第四轮）", () => {
  it("production 被剔掉；development / test / 未设置原样保留；不改传入对象", () => {
    const base = { NODE_ENV: "production", PATH: "/usr/bin", HOME: "/Users/demo" };
    const cleaned = stripHostInjectedEnv(base);
    expect("NODE_ENV" in cleaned).toBe(false);
    expect(cleaned.PATH).toBe("/usr/bin");
    expect(base.NODE_ENV).toBe("production"); // 浅拷贝，不动传入对象

    expect(stripHostInjectedEnv({ NODE_ENV: "development", PATH: "/usr/bin" }).NODE_ENV).toBe("development");
    expect(stripHostInjectedEnv({ NODE_ENV: "test", PATH: "/usr/bin" }).NODE_ENV).toBe("test");
    expect("NODE_ENV" in stripHostInjectedEnv({ PATH: "/usr/bin" })).toBe(false);
  });

  it("真子进程：用 stripHostInjectedEnv 的结果起 node，看到的 NODE_ENV 是 undefined", () => {
    const env = stripHostInjectedEnv({
      NODE_ENV: "production",
      PATH: process.env.PATH,
    });
    const r = spawnSync(
      process.execPath,
      ["-e", "process.stdout.write(String(process.env.NODE_ENV))"],
      { env, encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("undefined");
  });

  it("不放进 HOST_INJECTED_ENV_KEYS（hermetic-env 据此表删键，会把 vitest 的 NODE_ENV=test 一起删掉）", () => {
    expect((HOST_INJECTED_ENV_KEYS as readonly string[]).includes("NODE_ENV")).toBe(false);
  });
});
