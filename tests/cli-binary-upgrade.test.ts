/**
 * CLI 二进制覆盖安装（Windows 在跑的 exe 盖不掉 EPERM）：
 * 注册表 suspend/resume + inbound consumer 停后重拉 + 安装链兜底接线。
 */
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  installBridgeTestHooks,
  makeBridgeTmpDataDir,
  tick,
} from "./helpers/feishu-bridge-harness";

const TMP = makeBridgeTmpDataDir("cli-binary-upgrade");

const {
  __resetBridgeRuntimeForTest,
  __setConsumerBackoffBaseForTest,
  __setInboundSpawnForTest,
  getBridgeRuntimeStatus,
  syncBridgeRuntime,
} = await import("@/lib/server/feishu-bridge/inbound");
const { __setLarkExecForTest } = await import(
  "@/lib/server/feishu-bridge/lark-api"
);
const {
  registerBinaryUser,
  suspendBinaryUsers,
  resumeBinaryUsers,
} = await import("@/lib/server/kill-orphans");
const { withBinarySuspended } = await import("@/lib/server/feishu-cli");

installBridgeTestHooks({ tmpRoot: TMP });

// ----------------- fake child（同 feishu-bridge-inbound.test.ts 款） -----------------

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  pid: number;
  stdin = {
    end: (): void => {
      setImmediate(() => this.exit(0, null));
    },
  };

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  kill = (signal?: string): boolean => {
    this.killed = true;
    setImmediate(() => this.exit(null, signal ?? "SIGTERM"));
    return true;
  };

  exit = (code: number | null, signal: string | null): void => {
    if (this.exitCode !== null) return;
    this.exitCode = code ?? 0;
    this.emit("exit", code, signal);
  };
}

let spawned: Array<{ args: string[]; child: FakeChild }> = [];
let nextPid = 20000;

const fakeSpawn = ((_cmd: string, args: string[]) => {
  const child = new FakeChild(nextPid++);
  spawned.push({ args: args as string[], child });
  return child as unknown as ChildProcess;
}) as typeof nodeSpawn;

const setBridgeEnabled = async (on: boolean): Promise<void> => {
  await fs.mkdir(path.join(TMP, "data"), { recursive: true });
  await fs.writeFile(
    path.join(TMP, "data", "config.json"),
    JSON.stringify({ feishuChatBridge: on, feishuBridgeKeepAwake: false }),
    "utf-8",
  );
};

const consumerStatus = (eventKey: string) =>
  getBridgeRuntimeStatus().consumers.find((c) => c.eventKey === eventKey);

beforeEach(async () => {
  await __resetBridgeRuntimeForTest();
  spawned = [];
  __setInboundSpawnForTest(fakeSpawn);
  __setConsumerBackoffBaseForTest(20);
  __setLarkExecForTest(async (_bin, args) => {
    if (args[0] === "event" && args[1] === "status") {
      return {
        stdout: JSON.stringify({
          ok: true,
          apps: [
            {
              app_id: "cli_test",
              status: "running",
              running: true,
              consumers: [],
            },
          ],
        }),
        stderr: "",
      };
    }
    return { stdout: JSON.stringify({ ok: true, data: {} }), stderr: "" };
  });
});

afterEach(async () => {
  await __resetBridgeRuntimeForTest();
  __setInboundSpawnForTest(null);
  __setLarkExecForTest(null);
  __setConsumerBackoffBaseForTest(null);
});

// ----------------- 注册表 -----------------

describe("kill-orphans 二进制占用登记", () => {
  it("未登记 = 无常驻占用，挂起/重拉直接过", async () => {
    await suspendBinaryUsers("not-registered-bin-xyz");
    await resumeBinaryUsers("not-registered-bin-xyz");
  });

  it("suspend 抛错向上传（安装链 abort），resume 失败吞掉（轮询再兜）", async () => {
    let resumed = false;
    registerBinaryUser("test-bin-flaky", {
      suspend: async () => {
        throw new Error("停不掉");
      },
      resume: async () => {
        resumed = true;
        throw new Error("拉不起");
      },
    });
    await expect(suspendBinaryUsers("test-bin-flaky")).rejects.toThrow(
      "停不掉",
    );
    await resumeBinaryUsers("test-bin-flaky");
    expect(resumed).toBe(true);
  });
});

// ----------------- inbound 停后重拉 -----------------

describe("安装期 consumer 停后重拉（新二进制生效）", () => {
  it("suspend 停掉两个 consumer；hold 期间 sync 不重拉；resume 用新进程拉起", async () => {
    await setBridgeEnabled(true);
    await syncBridgeRuntime();
    expect(spawned.length).toBe(2);
    const oldPids = spawned.map((s) => s.child.pid);

    // 安装前挂起：两个 fake child 都应退出、状态 stopped，返回已停标识供日志
    const stopped = await suspendBinaryUsers("lark-cli");
    expect(stopped).toEqual(
      expect.arrayContaining(["im.message.receive_v1", "card.action.trigger"]),
    );
    await tick(50);
    expect(consumerStatus("im.message.receive_v1")?.status).toBe("stopped");
    expect(consumerStatus("card.action.trigger")?.status).toBe("stopped");

    // hold 期间 sync（30s 轮询同款）绝不重拉——否则正要覆盖的 exe 被重新锁住
    await syncBridgeRuntime();
    await tick(20);
    expect(spawned.length).toBe(2);

    // 安装后重拉：新进程（新 pid = 新二进制）
    await resumeBinaryUsers("lark-cli");
    await tick(20);
    expect(spawned.length).toBe(4);
    const newPids = spawned.slice(2).map((s) => s.child.pid);
    for (const pid of newPids) expect(oldPids).not.toContain(pid);
  });
});

// ----------------- 安装链接线（契约） -----------------

describe("withBinarySuspended 编排（P0：suspend 进 try，失败也 resume）", () => {
  it("suspend 失败 → resume 照调复位 hold，错误照常抛，安装体不跑", async () => {
    const order: string[] = [];
    registerBinaryUser("test-bin-p0", {
      suspend: async () => {
        order.push("suspend");
        throw new Error("停不掉");
      },
      resume: async () => {
        order.push("resume");
      },
    });
    await expect(
      withBinarySuspended(
        "test-bin-p0",
        async () => {
          order.push("fn");
        },
        { win: true },
      ),
    ).rejects.toThrow("停不掉");
    expect(order).toEqual(["suspend", "resume"]);
  });

  it("正常路径：停 → 装 → 拉，stopped 透给回调", async () => {
    const order: string[] = [];
    registerBinaryUser("test-bin-ok", {
      suspend: async () => {
        order.push("suspend");
        return ["im.message.receive_v1"];
      },
      resume: async () => {
        order.push("resume");
      },
    });
    let seen: string[] = [];
    await withBinarySuspended(
      "test-bin-ok",
      async (stopped) => {
        seen = stopped;
        order.push("fn");
      },
      { win: true },
    );
    expect(order).toEqual(["suspend", "fn", "resume"]);
    expect(seen).toEqual(["im.message.receive_v1"]);
  });

  it("非 win 直接过（零打扰 mac/linux）", async () => {
    const order: string[] = [];
    registerBinaryUser("test-bin-nix", {
      suspend: async () => {
        order.push("suspend");
        return [];
      },
      resume: async () => {
        order.push("resume");
      },
    });
    await withBinarySuspended("test-bin-nix", async () => {}, { win: false });
    expect(order).toEqual([]);
  });
});
describe("feishu-cli 安装链兜底接线", () => {
  const feishuCli = readFileSync(
    path.resolve(import.meta.dirname, "..", "src/lib/server/feishu-cli.ts"),
    "utf8",
  );

  it("lark-cli/meegle 安装走挂起编排（suspend 进 try，失败也 resume）", () => {
    expect(feishuCli).toContain("withBinarySuspended(LARK_CLI_BINARY_USER");
    expect(feishuCli).toContain("withBinarySuspended(MEEGLE_BINARY_USER");
  });

  it("rename 锁住时按镜像名强制清一次再试（lark-cli / meegle 同策略）", () => {
    expect(feishuCli).toContain('killImageOnLock: "lark-cli.exe"');
    expect(feishuCli).toContain('killImageOnLock: "meegle.exe"');
    expect(feishuCli).toContain("killImageBestEffort");
  });
});
