/**
 * wk-harness 门禁执行：跑不跑（降级判定）、拿什么参数跑、跑挂了怎么办
 *
 * 外部 python 调用全程 mock（`node:child_process.execFile`）——单测不依赖本机
 * 装没装 python3、也不真去动文档仓。
 *
 * ⚠️ mock **认真实文件系统**：脚本不在盘上时按真 python 的形态返回
 * （退 2 + stderr「can't open file …」）。老 mock 无脑吐成功、于是
 * 「团队库里压根没有 `wk-context-init.py`」这种线上每次推进刷假告警的问题
 * 一条用例都拦不住（只断言了「参数里出现了脚本名」）。
 *
 * 重点锁：
 * 1. 六种降级（非 wk / 没填 REQ-ID / 没仓 / 没配 doc_repo / 团队库缺脚本 / 文档仓没这个 REQ-ID）
 * 2. 参数拼装对齐 `command-contract.md`「无 hook fallback preflight」段
 * 3. preflight 非 0 = blocked（调用方据此不启动 agent）、脚本起不来 / 缺席 / 超时 = warn 放行
 * 4. 阶段门禁未过不调 delivery sync；没配 hub 压根不调
 */
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// 类型是编译期擦除的，静态 import 不会先于下面的 FLOWSHIP_DATA_DIR 赋值触发模块副作用
import type { WkGatePlanActive } from "@/lib/server/wk-gate";

const TMP_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "wk-gate-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const DOC_REPO = path.join(TMP_ROOT, "doc-repo");
const REPO = path.join(TMP_ROOT, "crm-web");
const REQ_ID = "REQ-7042596005";

/** 假输出流：真 Readable 的 setEncoding 会把 Buffer 解成 utf8 字符串，这里本来就发字符串 */
type FakeStream = EventEmitter & { setEncoding: (encoding: string) => FakeStream };

/** 假子进程：EventEmitter + stdout/stderr + pid + kill，够 runWkScript 那套监听用 */
interface FakeChild extends EventEmitter {
  stdout: FakeStream;
  stderr: FakeStream;
  pid: number;
  kill: (signal?: string) => boolean;
}

/** mock 的 spawn：记录调用、按队列吐结果 */
const hoisted = vi.hoisted(() => ({
  calls: [] as {
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    /** 有没有要求自成进程组（超时杀整组的前提） */
    detached: boolean;
  }[],
  /** 每次调用弹一个；空队列默认成功 */
  queue: [] as {
    code?: number | string;
    /** 永不退出：留给「超时 → 杀进程组」用例 */
    hang?: boolean;
    stdout?: string;
    stderr?: string;
  }[],
  /** 收到过的 kill（pid 为负 = 整组） */
  kills: [] as { pid: number; signal: string }[],
  /** pid → 假子进程；process.kill 的 spy 靠它模拟「被杀 → close」 */
  children: new Map<number, { emit: (event: string, ...args: unknown[]) => boolean }>(),
  /** 本机不可能出现的 pid 段（mac PID_MAX 99998、linux 上限 4194304）：
   *  万一哪条路径漏掉 spy 也不会真去杀本机进程 */
  nextPid: 1_000_000_000,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("node:child_process")>();
  const { existsSync } = await import("node:fs");
  const { EventEmitter: Emitter } = await import("node:events");
  return {
    ...actual,
    spawn: (
      _file: string,
      args: string[],
      opts: { cwd: string; env: NodeJS.ProcessEnv; detached?: boolean },
    ) => {
      hoisted.calls.push({
        args,
        cwd: opts.cwd,
        env: opts.env,
        detached: !!opts.detached,
      });
      const makeStream = (): FakeStream => {
        const stream = new Emitter() as FakeStream;
        stream.setEncoding = () => stream;
        return stream;
      };
      const child = new Emitter() as FakeChild;
      child.stdout = makeStream();
      child.stderr = makeStream();
      hoisted.nextPid += 1;
      child.pid = hoisted.nextPid;
      child.kill = (signal = "SIGTERM") => {
        hoisted.kills.push({ pid: child.pid, signal });
        queueMicrotask(() => child.emit("close", null, signal));
        return true;
      };
      hoisted.children.set(child.pid, child);

      const scriptPath = args[0]!;
      // 脚本不在盘上：照抄真 python 的形态（退 2、stderr 一行 can't open file），
      // 别让 mock 把「团队库没这个脚本」演成成功（也不消耗队列）
      const next = existsSync(scriptPath)
        ? hoisted.queue.shift() ?? {}
        : {
            code: 2,
            stderr: `python3: can't open file '${scriptPath}': [Errno 2] No such file or directory\n`,
          };
      queueMicrotask(() => {
        if ("hang" in next && next.hang) return; // 永不退出、交给外层超时收拾
        // spawn 起不来（没装 python3）：只发 error、不发 close
        if (typeof next.code === "string") {
          child.emit(
            "error",
            Object.assign(new Error("spawn failed"), { code: next.code }),
          );
          return;
        }
        const code = next.code ?? 0;
        const stdout = next.stdout ?? (code === 0 ? "PASS: ok\n" : "");
        if (stdout) child.stdout.emit("data", stdout);
        if (next.stderr) child.stderr.emit("data", next.stderr);
        child.emit("close", code);
      });
      return child;
    },
  };
});

/** doc_repo / hub / baseline 开关由测试逐例设定 */
const wkCfg = vi.hoisted(() => ({
  docRepoPath: "",
  hubBaseUrl: "",
  requireBaseline: false,
}));
vi.mock("@/lib/server/wk-config", () => ({
  readWkConfig: async () => ({
    docRepoPath: wkCfg.docRepoPath,
    hubBaseUrl: wkCfg.hubBaseUrl,
    requireBaseline: wkCfg.requireBaseline,
    requireSync: false,
  }),
}));

const {
  buildContextInitArgs,
  buildDeliverySyncArgs,
  buildPreflightArgs,
  buildStageArgs,
  evaluateWkAdvanceGate,
  planWkGate,
  preflightTimeoutMs,
  runWkPostStage,
  runWkPreflight,
  runWkScript,
  wkScriptsDir,
} = await import("@/lib/server/wk-gate");

/**
 * 非隔离任务 → getTaskWorkRepoPaths 原样返回 repoPaths。
 * REQ-ID 只认手填（系统不再从飞书链接 / task id 派生），所以 fixture 得自己带一个。
 */
const makeTask = (over: Record<string, unknown> = {}) => ({
  id: "t_1779873168206_hr7qin",
  repoPaths: [REPO],
  isolateWorktree: false,
  reqId: REQ_ID,
  ...over,
});

type ActionDef = { skill: string; order?: number };
const WK_DEF: ActionDef = { skill: "wk-repo-execute", order: 50 };

/** 造出「能跑门禁」的世界：新版团队库（三个脚本都在）+ 文档仓有该 REQ-ID 目录 */
const setupHappyWorld = async () => {
  await fs.mkdir(wkScriptsDir(), { recursive: true });
  for (const name of [
    "doc-quality-gate.py",
    "wk-context-init.py",
    "wk-delivery-sync.py",
  ]) {
    await fs.writeFile(path.join(wkScriptsDir(), name), "#\n");
  }
  await fs.mkdir(path.join(DOC_REPO, "requirements", REQ_ID), {
    recursive: true,
  });
  wkCfg.docRepoPath = DOC_REPO;
  wkCfg.hubBaseUrl = "";
  wkCfg.requireBaseline = false;
};

/** 老版本团队库：`wk-context-init.py` 是 2026-07-27 才加的、旧镜像里没有 */
const removeContextInitScript = async () => {
  await fs.rm(path.join(wkScriptsDir(), "wk-context-init.py"), { force: true });
};

/** 断言拿到 active plan（收窄类型 + 顺带校验没被误降级） */
const expectActive = async (
  task: ReturnType<typeof makeTask>,
  def: ActionDef = WK_DEF,
): Promise<WkGatePlanActive> => {
  const plan = await planWkGate(task, def);
  if (!plan.applies) throw new Error(`预期 active、实际降级：${plan.reason}`);
  return plan;
};

beforeEach(() => {
  hoisted.calls.length = 0;
  hoisted.queue.length = 0;
  hoisted.kills.length = 0;
  hoisted.children.clear();
});

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("planWkGate 降级判定", () => {
  it("普通 action → not-wk，静默（连提示都不给）", async () => {
    await setupHappyWorld();
    const plan = await planWkGate(makeTask(), { skill: "my-own-skill" });
    expect(plan).toMatchObject({ applies: false, reason: "not-wk", message: "" });
  });

  it("任务没绑仓库 → no-repo", async () => {
    await setupHappyWorld();
    const plan = await planWkGate(makeTask({ repoPaths: [] }), WK_DEF);
    expect(plan).toMatchObject({ applies: false, reason: "no-repo" });
  });

  it("没配 doc_repo → no-doc-repo，提示去设置页配", async () => {
    await setupHappyWorld();
    wkCfg.docRepoPath = "";
    const plan = await planWkGate(makeTask(), WK_DEF);
    expect(plan.applies).toBe(false);
    if (plan.applies) return;
    expect(plan.reason).toBe("no-doc-repo");
    expect(plan.message).toContain("设置页");
  });

  it("团队库里没有门禁脚本 → no-scripts", async () => {
    await setupHappyWorld();
    await fs.rm(path.join(wkScriptsDir(), "doc-quality-gate.py"), {
      force: true,
    });
    const plan = await planWkGate(makeTask(), WK_DEF);
    expect(plan).toMatchObject({ applies: false, reason: "no-scripts" });
  });

  // ⚠️ 回归锁：以前没填编号时会派生一个假 ID（`REQ-TASK-<id 末段>`）拿去撞目录、
  // 走到 no-req-dir；规范要求「没有 REQ-ID 必须先要求补充、不要猜测」，现在直接停在这一步
  it("任务没填 REQ-ID → no-req-id 跳过，不拿假 ID 去查目录", async () => {
    await setupHappyWorld();
    for (const reqId of [undefined, "", "   "]) {
      const plan = await planWkGate(makeTask({ reqId }), WK_DEF);
      expect(plan.applies).toBe(false);
      if (plan.applies) return;
      expect(plan.reason).toBe("no-req-id");
      expect(plan.message).toContain("需求编号");
      // 没有编号就没有目录可查——连 doc_repo 都不该去翻
      expect(plan.message).not.toContain("REQ-TASK");
    }
  });

  it("填了编号但 WK 产出目录里没有对应需求目录 → no-req-dir 跳过，不是失败", async () => {
    await setupHappyWorld();
    const plan = await planWkGate(makeTask({ reqId: "REQ-NO-DIR" }), WK_DEF);
    expect(plan.applies).toBe(false);
    if (plan.applies) return;
    expect(plan.reason).toBe("no-req-dir");
    expect(plan.message).toContain("REQ-NO-DIR");
  });

  it("no-req-dir 分语境：biz-analyze 是建目录的那条指令、不该诱导用户去改编号", async () => {
    await setupHappyWorld();
    const analyze = await planWkGate(makeTask({ reqId: "REQ-NO-DIR" }), {
      skill: "wk-biz-analyze",
    });
    const execute = await planWkGate(makeTask({ reqId: "REQ-NO-DIR" }), WK_DEF);
    if (analyze.applies || execute.applies) throw new Error("预期两条都降级");

    expect(analyze.message).toContain("wk:biz-analyze");
    expect(analyze.message).not.toContain("改需求编号");
    // 其余指令才是「前置没跑 / 编号填错了」，给改编号的指引
    expect(execute.message).toContain("编号填错了");
  });

  it("老版本团队库没有 wk-context-init.py → 仍能跑门禁、plan 标记这一步不做", async () => {
    await setupHappyWorld();
    await removeContextInitScript();
    const plan = await expectActive(makeTask());
    expect(plan.hasContextInit).toBe(false);
  });

  it("产物目录跟着手填的编号走（换一个编号就换一个目录）", async () => {
    await setupHappyWorld();
    await fs.mkdir(path.join(DOC_REPO, "requirements", "REQ-CUSTOM-9"), {
      recursive: true,
    });
    const plan = await expectActive(makeTask({ reqId: "REQ-CUSTOM-9" }));
    expect(plan.reqId).toBe("REQ-CUSTOM-9");
    expect(plan.bizDir).toBe(
      path.join(DOC_REPO, "requirements", "REQ-CUSTOM-9"),
    );
  });

  it("能跑时把两个产物目录 / repo 名都算好", async () => {
    await setupHappyWorld();
    const plan = await expectActive(makeTask());
    expect(plan).toMatchObject({
      command: "wk:repo-execute",
      stage: "repo-execute",
      reqId: REQ_ID,
      repoRoot: REPO,
      repoName: "crm-web",
    });
    expect(plan.bizDir).toBe(path.join(DOC_REPO, "requirements", REQ_ID));
    expect(plan.repoDir).toBe(
      path.join(REPO, "wk-doc", "requirements", REQ_ID),
    );
  });
});

describe("脚本参数拼装（对齐 command-contract.md）", () => {
  it("context-init：--req-id + --cwd", async () => {
    await setupHappyWorld();
    const plan = await expectActive(makeTask());
    expect(buildContextInitArgs(plan)).toEqual([
      "--req-id",
      REQ_ID,
      "--cwd",
      REPO,
    ]);
  });

  it("preflight：repo-execute 带 biz + repo 两个 path", async () => {
    await setupHappyWorld();
    const plan = await expectActive(makeTask());
    expect(buildPreflightArgs(plan)).toEqual([
      "--command",
      "wk:repo-execute",
      "--biz-path",
      plan.bizDir,
      "--repo-path",
      plan.repoDir,
    ]);
  });

  it("preflight：repo-design 同时带 hard gate 的 biz-path 与 baseline 的 repo-path", async () => {
    await setupHappyWorld();
    const plan = await expectActive(makeTask(), { skill: "wk-repo-design" });
    expect(buildPreflightArgs(plan)).toEqual([
      "--command",
      "wk:repo-design",
      "--biz-path",
      plan.bizDir,
      "--repo-path",
      plan.repoDir,
    ]);
  });

  it("preflight：repo baseline 使用与 delivery sync 相同的 repoName scope", async () => {
    await setupHappyWorld();
    wkCfg.hubBaseUrl = "http://127.0.0.1:8088";
    wkCfg.requireBaseline = true;
    const plan = await expectActive(makeTask());
    expect(buildPreflightArgs(plan)).toEqual([
      "--command",
      "wk:repo-execute",
      "--biz-path",
      plan.bizDir,
      "--repo-path",
      plan.repoDir,
      "--delivery-repo-name",
      "crm-web",
    ]);
  });

  it("preflight：repo-review 只带 repo-path、biz-analyze 只带 biz-path", async () => {
    await setupHappyWorld();
    const review = await expectActive(makeTask(), { skill: "wk-repo-review" });
    expect(buildPreflightArgs(review)).toEqual([
      "--command",
      "wk:repo-review",
      "--repo-path",
      review.repoDir,
    ]);

    const analyze = await expectActive(makeTask(), { skill: "wk-biz-analyze" });
    expect(buildPreflightArgs(analyze)).toEqual([
      "--command",
      "wk:biz-analyze",
      "--biz-path",
      analyze.bizDir,
    ]);
  });

  it("阶段门禁：仓库级指令查 repoDir、业务级查 bizDir", async () => {
    await setupHappyWorld();
    const repoStage = await expectActive(makeTask());
    expect(buildStageArgs(repoStage)).toEqual([
      "--stage",
      "repo-execute",
      "--path",
      repoStage.repoDir,
    ]);

    const bizStage = await expectActive(makeTask(), { skill: "wk-biz-confirm" });
    expect(buildStageArgs(bizStage)).toEqual([
      "--stage",
      "biz-confirm",
      "--path",
      bizStage.bizDir,
    ]);
  });

  it("delivery sync：仓库级带 repo-path + repo-name、业务级不带", async () => {
    await setupHappyWorld();
    wkCfg.hubBaseUrl = "http://127.0.0.1:8088";

    const repoPlan = await expectActive(makeTask());
    expect(buildDeliverySyncArgs(repoPlan)).toEqual([
      "--command",
      "wk:repo-execute",
      "--biz-path",
      repoPlan.bizDir,
      "--repo-path",
      repoPlan.repoDir,
      "--repo-name",
      "crm-web",
      "--hub-url",
      "http://127.0.0.1:8088",
    ]);

    const bizPlan = await expectActive(makeTask(), { skill: "wk-biz-analyze" });
    expect(buildDeliverySyncArgs(bizPlan)).toEqual([
      "--command",
      "wk:biz-analyze",
      "--biz-path",
      bizPlan.bizDir,
      "--hub-url",
      "http://127.0.0.1:8088",
    ]);
  });
});

describe("runWkPreflight（推进前硬拦）", () => {
  it("两步都过 → pass，顺序是 context-init 再 preflight", async () => {
    await setupHappyWorld();
    const plan = await expectActive(makeTask());
    const report = await runWkPreflight(plan);

    expect(report.verdict).toBe("pass");
    expect(hoisted.calls).toHaveLength(2);
    expect(hoisted.calls[0]!.args[0]).toContain("wk-context-init.py");
    expect(hoisted.calls[1]!.args[0]).toContain("doc-quality-gate.py");
    // 显式喂环境变量，脚本才不会退回作者本机的 hardcode 路径
    expect(hoisted.calls[0]!.env.WK_DOC_ROOT).toBe(DOC_REPO);
    expect(hoisted.calls[0]!.env.WK_REQ_ID).toBe(REQ_ID);
    expect(hoisted.calls[0]!.cwd).toBe(REPO);
  });

  it("preflight 非 0 → blocked，明细渲染成人话（不是一坨 stderr）", async () => {
    await setupHappyWorld();
    const plan = await expectActive(makeTask());
    hoisted.queue.push({}); // context-init 过
    hoisted.queue.push({
      code: 1,
      stdout:
        "FAIL: wk:repo-execute hard gate failed\n" +
        "- wk:repo-execute requires repo_status REPO_DESIGN_READY\n" +
        "- tasks.md: missing marker `## Execution Plan`\n",
    });

    const report = await runWkPreflight(plan);
    expect(report.verdict).toBe("blocked");
    expect(report.message).toContain("wk:repo-execute 执行前门禁未过");
    expect(report.message).toContain("requires repo_status REPO_DESIGN_READY");
    expect(report.message).toContain("## Execution Plan");
    expect(report.message).not.toContain("FAIL:");
  });

  it("context-init 失败只 warn、不拦（它对「业务级 status 还没有」也返 1）", async () => {
    await setupHappyWorld();
    const plan = await expectActive(makeTask());
    hoisted.queue.push({
      code: 1,
      stdout: "WK context bootstrap skipped: business status not found\n",
    });
    hoisted.queue.push({}); // preflight 过

    const report = await runWkPreflight(plan);
    expect(report.verdict).toBe("warn");
    expect(report.message).toContain("wk 上下文初始化未完成");
    expect(report.message).toContain("business status not found");
  });

  it("本机没装 python3 → warn 放行、且不再白跑第二个脚本", async () => {
    await setupHappyWorld();
    const plan = await expectActive(makeTask());
    hoisted.queue.push({ code: "ENOENT" });

    const report = await runWkPreflight(plan);
    expect(report.verdict).toBe("warn");
    expect(report.message).toContain("本机起不动 python3");
    // 第一个脚本就 ENOENT，第二个必然同样起不来——短路，也免得同一句话说两遍
    expect(hoisted.calls).toHaveLength(1);
    expect(report.message.match(/起不动/g)).toHaveLength(1);
  });

  it("脚本超时 → warn 放行", async () => {
    await setupHappyWorld();
    const plan = await expectActive(makeTask());
    hoisted.queue.push({}); // context-init 过
    hoisted.queue.push({ hang: true }); // preflight 卡死不返回

    // 预算是 10s 起步、假表快进到点，别让门禁用例真等十秒
    vi.useFakeTimers();
    try {
      const pending = runWkPreflight(plan);
      await vi.advanceTimersByTimeAsync(preflightTimeoutMs(plan));
      const report = await pending;
      expect(report.verdict).toBe("warn");
      expect(report.message).toContain("超时");
    } finally {
      vi.useRealTimers();
    }
  });

  // ⚠️ 回归锁（第二轮双审 P1-1）：上一轮把「脚本不可用」收窄到只认解释器那句
  // can't open file，反向留了缺口——门禁工具自己坏了会被判成 blocked 把推进挡死。
  // 现在的判据是「输出里有没有 FAIL: / `- ` 结构」，两种故障形态各锁一条。
  it("门禁脚本自己崩了（traceback）→ warn 放行，不能冒充「门禁未过」", async () => {
    await setupHappyWorld();
    const plan = await expectActive(makeTask());
    hoisted.queue.push({}); // context-init 过
    // 真 python 的形态：traceback 走 stderr、退 1
    hoisted.queue.push({
      code: 1,
      stderr:
        "Traceback (most recent call last):\n" +
        `  File "${path.join(wkScriptsDir(), "doc-quality-gate.py")}", line 20, in <module>\n` +
        "    from gates.runner import COMMANDS, GATES, check_command_gate, check_gate\n" +
        "ModuleNotFoundError: No module named 'gates'\n",
    });

    const report = await runWkPreflight(plan);
    expect(report.verdict).toBe("warn");
    expect(report.message).toContain("门禁脚本自身报错");
    // 线索得留着（这坨是排查工具故障的唯一依据）
    expect(report.message).toContain("ModuleNotFoundError");
  });

  it("参数不认（argparse 退 2）→ warn 放行，不能冒充「门禁未过」", async () => {
    await setupHappyWorld();
    const plan = await expectActive(makeTask());
    hoisted.queue.push({}); // context-init 过
    // 脚本换了签名 / 我们参数拼错时的形态：usage + error 走 stderr、退 2
    hoisted.queue.push({
      code: 2,
      stderr:
        "usage: doc-quality-gate.py [-h] [--stage {biz-analyze,repo-execute}]\n" +
        "                          [--command {wk:biz-analyze,wk:repo-execute}]\n" +
        "doc-quality-gate.py: error: argument --command: invalid choice: 'wk:repo-exec'\n",
    });

    const report = await runWkPreflight(plan);
    expect(report.verdict).toBe("warn");
    expect(report.message).toContain("门禁脚本自身报错");
    expect(report.message).toContain("invalid choice");
  });

  it("真门禁失败（有 FAIL: / `- ` 结构）照样硬拦——降级不能把该拦的放过去", async () => {
    await setupHappyWorld();
    const plan = await expectActive(makeTask());
    hoisted.queue.push({}); // context-init 过
    // 只有结论行、没有明细行的最小形态也得认出来
    hoisted.queue.push({ code: 1, stdout: "FAIL: wk:repo-execute hard gate failed\n" });

    const report = await runWkPreflight(plan);
    expect(report.verdict).toBe("blocked");
  });

  // ⚠️ 回归锁（线上：每次 wk 推进都刷一条「wk 上下文初始化未完成 + Python: can't open file」）
  it("团队库缺 wk-context-init.py → 整步不跑、干净 pass（不是 warn）", async () => {
    await setupHappyWorld();
    await removeContextInitScript();
    const plan = await expectActive(makeTask());

    const report = await runWkPreflight(plan);
    expect(report.verdict).toBe("pass");
    expect(report.message).not.toContain("上下文初始化");
    // 只 spawn 了 preflight 一次——缺席的脚本连试都不试
    expect(hoisted.calls).toHaveLength(1);
    expect(hoisted.calls[0]!.args[0]).toContain("doc-quality-gate.py");
  });

  it("探测之后脚本才被删（竞态）→ 归成「团队库没这个脚本」而不是门禁失败", async () => {
    await setupHappyWorld();
    const plan = await expectActive(makeTask());
    expect(plan.hasContextInit).toBe(true);
    // plan 探过了才删：runWkScript 的兜底得认得出 python 的 can't open file
    await removeContextInitScript();

    const report = await runWkPreflight(plan);
    expect(report.verdict).toBe("warn");
    expect(report.message).toContain("团队库里没有这个脚本");
    // 不能被当成「本机没装 python3」而短路——preflight 该跑还得跑
    expect(report.message).not.toContain("起不动");
    expect(hoisted.calls).toHaveLength(2);
  });

  // ⚠️ 回归锁：Hub 连不上时脚本吐的是 KeyError traceback（官方 wk-delivery-baseline.py
  // 在 URLError 分支 return 的 dict 漏了 `conflicts` 键）。这坨**原样展示**——
  // 曾经把它改写成「Delivery Hub 连不上 / 检查网络或 VPN」并把 traceback 藏起来，
  // 用户拍板撤掉：团队脚本的输出才是权威的，同事之间要对着同一段错误信息沟通，
  // 而且这个 bug 露出来才有人去修。
  it("Hub 连不上导致 preflight 挂 → blocked，且脚本原文一字不改地端出来", async () => {
    await setupHappyWorld();
    wkCfg.hubBaseUrl = "http://172.16.7.45:8088";
    wkCfg.requireBaseline = true;
    const plan = await expectActive(makeTask());
    hoisted.queue.push({}); // context-init 过
    hoisted.queue.push({
      code: 1,
      stdout:
        "FAIL: wk:repo-execute delivery baseline failed\n" +
        "- Traceback (most recent call last):\n" +
        '-   File "/x/wk-delivery-baseline.py", line 475, in check_baseline\n' +
        '-     if result["conflicts"]:\n' +
        "- KeyError: 'conflicts'\n",
    });

    const report = await runWkPreflight(plan);
    expect(report.verdict).toBe("blocked");
    expect(report.message).toContain(
      "wk:repo-execute 执行前门禁未过：wk:repo-execute delivery baseline failed",
    );
    expect(report.message).toContain("- KeyError: 'conflicts'");
    expect(report.message).toContain("line 475, in check_baseline");
    // 不替脚本解释根因、不给建议
    expect(report.message).not.toContain("连不上");
    expect(report.message).not.toContain("VPN");
    expect(report.message).not.toContain("下一步");
  });

  it("preflight 脚本本身缺席 → warn 放行，绝不冒充「门禁未过」把推进拦死", async () => {
    await setupHappyWorld();
    const plan = await expectActive(makeTask());
    await fs.rm(path.join(wkScriptsDir(), "doc-quality-gate.py"), {
      force: true,
    });

    const report = await runWkPreflight(plan);
    expect(report.verdict).toBe("warn");
    expect(report.message).toContain("团队库里没有这个脚本");
  });
});

describe("runWkPostStage（收尾门禁 + 交付同步）", () => {
  it("没配 hub → 只跑阶段门禁、不调 delivery sync", async () => {
    await setupHappyWorld();
    const plan = await expectActive(makeTask());

    const report = await runWkPostStage(plan);
    expect(report.verdict).toBe("pass");
    expect(hoisted.calls).toHaveLength(1);
    expect(hoisted.calls[0]!.args).toContain("--stage");
  });

  it("配了 hub 且门禁过 → 追加一次 delivery sync", async () => {
    await setupHappyWorld();
    wkCfg.hubBaseUrl = "http://127.0.0.1:8088";
    const plan = await expectActive(makeTask());

    const report = await runWkPostStage(plan);
    expect(report.verdict).toBe("pass");
    expect(hoisted.calls).toHaveLength(2);
    expect(hoisted.calls[1]!.args[0]).toContain("wk-delivery-sync.py");
    expect(report.message).toContain("已同步 Delivery Hub");
  });

  it("阶段门禁未过 → blocked，且不再同步 Delivery Hub", async () => {
    await setupHappyWorld();
    wkCfg.hubBaseUrl = "http://127.0.0.1:8088";
    const plan = await expectActive(makeTask());
    hoisted.queue.push({
      code: 1,
      stdout:
        "FAIL: repo-execute quality gate failed for /x/y\n" +
        "- verification.md: missing marker `## Unverified Items`\n",
    });

    const report = await runWkPostStage(plan);
    expect(report.verdict).toBe("blocked");
    expect(report.message).toContain("## Unverified Items");
    expect(hoisted.calls).toHaveLength(1);
  });

  it("阶段门禁脚本自己崩了 → warn（别拿工具故障给用户的产物挂红条），也不推 Delivery Hub", async () => {
    await setupHappyWorld();
    wkCfg.hubBaseUrl = "http://127.0.0.1:8088";
    const plan = await expectActive(makeTask());
    hoisted.queue.push({
      code: 1,
      stderr:
        "Traceback (most recent call last):\n" +
        "  File \"gates/runner.py\", line 88, in check_gate\n" +
        "KeyError: 'repo-execute'\n",
    });

    const report = await runWkPostStage(plan);
    expect(report.verdict).toBe("warn");
    expect(report.message).toContain("门禁脚本自身报错");
    // 门禁结论未知 = 不往 hub 推（同「脚本起不来」那条口径）
    expect(hoisted.calls).toHaveLength(1);
  });

  it("Hub 同步失败只 warn（产物已经落好了、不该因此标红）", async () => {
    await setupHappyWorld();
    wkCfg.hubBaseUrl = "http://127.0.0.1:8088";
    const plan = await expectActive(makeTask());
    hoisted.queue.push({}); // 阶段门禁过
    hoisted.queue.push({
      code: 1,
      stdout: "FAIL: publish to delivery hub failed: Connection refused\n",
    });

    const report = await runWkPostStage(plan);
    expect(report.verdict).toBe("warn");
    expect(report.message).toContain("阶段门禁已通过");
    expect(report.message).toContain("Delivery Hub 同步失败");
  });
});

// ⚠️ 第二轮双审 P1-2：上一轮把 preflight 压到 10s 时按「纯本地校验」算，
// 漏了 doc-quality-gate 在 require_baseline 下会内部起 wk-delivery-baseline.py 去 hub 拉产物。
describe("超时预算（纯本地校验 vs 要去 hub 拉产物）", () => {
  it("没开 baseline → 本地档 10s", async () => {
    await setupHappyWorld();
    const plan = await expectActive(makeTask());
    expect(plan.pullsBaseline).toBe(false);
    expect(preflightTimeoutMs(plan)).toBe(10_000);
  });

  it("开了「运行前拉取最新产物」+ 有 hub 地址 → 给足网络时间（45s）", async () => {
    await setupHappyWorld();
    wkCfg.hubBaseUrl = "http://127.0.0.1:8088";
    wkCfg.requireBaseline = true;
    const plan = await expectActive(makeTask());
    expect(plan.pullsBaseline).toBe(true);
    expect(preflightTimeoutMs(plan)).toBe(45_000);
  });

  it("开关开着但没配 hub 地址 → 脚本立刻 FAIL、不走网络，仍是本地档", async () => {
    await setupHappyWorld();
    wkCfg.requireBaseline = true;
    const plan = await expectActive(makeTask());
    expect(plan.pullsBaseline).toBe(false);
  });

  it("仓库里有同事手配的 .wk/config.yaml → 判不准就按「会拉」算", async () => {
    await setupHappyWorld();
    const repo = path.join(TMP_ROOT, "crm-web-wk");
    await fs.mkdir(path.join(repo, ".wk"), { recursive: true });
    await fs.writeFile(
      path.join(repo, ".wk", "config.yaml"),
      "delivery_hub:\n  require_baseline: true\n",
    );
    const plan = await expectActive(makeTask({ repoPaths: [repo] }));
    expect(plan.pullsBaseline).toBe(true);
  });

  it("环境变量 WK_REQUIRE_DELIVERY_BASELINE（脚本里优先级最高）也算数", async () => {
    await setupHappyWorld();
    process.env.WK_REQUIRE_DELIVERY_BASELINE = "1";
    try {
      const plan = await expectActive(makeTask());
      expect(plan.pullsBaseline).toBe(true);
    } finally {
      delete process.env.WK_REQUIRE_DELIVERY_BASELINE;
    }
  });

  it("超时杀的是整个进程组——只杀父 python 会留孤儿、还会把 await 挂死", async () => {
    await setupHappyWorld();
    hoisted.queue.push({ hang: true });
    // 真进程组不存在会走兜底分支，这里接管 kill 才能断言「发的是负 pid」
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation(((pid: number, signal?: string) => {
        hoisted.kills.push({ pid, signal: String(signal) });
        // 被 SIGKILL 的进程会退出 → close
        queueMicrotask(() =>
          hoisted.children.get(Math.abs(pid))?.emit("close", null, "SIGKILL"),
        );
        return true;
      }) as typeof process.kill);

    try {
      const result = await runWkScript(
        path.join(wkScriptsDir(), "doc-quality-gate.py"),
        ["--command", "wk:repo-execute"],
        { cwd: REPO, env: process.env, timeoutMs: 20 },
      );
      expect(result.outcome).toBe("timeout");
      // spawn 时要过 detached、否则子进程留在我们自己的组里、负 pid 打空
      expect(hoisted.calls[0]!.detached).toBe(true);
      expect(hoisted.kills).toHaveLength(1);
      expect(hoisted.kills[0]!.pid).toBeLessThan(0);
      expect(hoisted.kills[0]!.signal).toBe("SIGKILL");
    } finally {
      killSpy.mockRestore();
    }
  });
});

describe("evaluateWkAdvanceGate（推进钩子的决策 + 事件）", () => {
  /** 收集写进事件流的提示 */
  const makeSink = () => {
    const events: { kind: string; text: string }[] = [];
    return {
      events,
      sink: async (kind: "info" | "error", text: string) => {
        events.push({ kind, text });
      },
    };
  };

  it("普通 action → proceed，且一条事件都不写（别给非 wk 用户刷屏）", async () => {
    await setupHappyWorld();
    const { events, sink } = makeSink();
    const result = await evaluateWkAdvanceGate(
      makeTask(),
      { skill: "my-own-skill" },
      sink,
    );
    expect(result.decision).toBe("proceed");
    expect(events).toEqual([]);
    expect(hoisted.calls).toHaveLength(0);
  });

  it("降级（没配 doc_repo）→ proceed + 一条 info，不跑任何脚本", async () => {
    await setupHappyWorld();
    wkCfg.docRepoPath = "";
    const { events, sink } = makeSink();
    const result = await evaluateWkAdvanceGate(makeTask(), WK_DEF, sink);

    expect(result.decision).toBe("proceed");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "info" });
    expect(events[0]!.text).toContain("设置页");
    expect(hoisted.calls).toHaveLength(0);
  });

  it("门禁通过 → proceed 且不写事件（agent 起来本身就是回执）", async () => {
    await setupHappyWorld();
    const { events, sink } = makeSink();
    const result = await evaluateWkAdvanceGate(makeTask(), WK_DEF, sink);

    expect(result.decision).toBe("proceed");
    expect(events).toEqual([]);
  });

  // ⚠️ 回归锁：老版本团队库（没 wk-context-init.py）下，每次推进都往事件流刷一条
  // 「wk 上下文初始化未完成：Python: can't open file …」——「通过时不写事件」直接失效
  it("团队库缺 wk-context-init.py → 照样一条事件都不写", async () => {
    await setupHappyWorld();
    await removeContextInitScript();
    const { events, sink } = makeSink();
    const result = await evaluateWkAdvanceGate(makeTask(), WK_DEF, sink);

    expect(result.decision).toBe("proceed");
    expect(events).toEqual([]);
  });

  it("写事件抛错不影响降级判定（外层 catch 不该把 skip 提示一起吞了）", async () => {
    await setupHappyWorld();
    wkCfg.docRepoPath = "";
    const result = await evaluateWkAdvanceGate(makeTask(), WK_DEF, async () => {
      throw new Error("写事件炸了");
    });

    expect(result.decision).toBe("proceed");
    // 提示文本仍算得出来（老写法会掉进外层 catch、message 变空串）
    expect(result.message).toContain("设置页");
  });

  it("preflight 非 0 → block + 一条 error 事件（调用方据此不启动 agent）", async () => {
    await setupHappyWorld();
    hoisted.queue.push({}); // context-init 过
    hoisted.queue.push({
      code: 1,
      stdout:
        "FAIL: wk:repo-execute hard gate failed\n- tasks.md: missing marker `## Task Status`\n",
    });

    const { events, sink } = makeSink();
    const result = await evaluateWkAdvanceGate(makeTask(), WK_DEF, sink);

    expect(result.decision).toBe("block");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "error" });
    expect(events[0]!.text).toContain("## Task Status");
    expect(result.message).toBe(events[0]!.text);
  });

  it("门禁链路任意一环崩（这里让写事件抛）→ 仍 proceed，绝不阻塞主流程", async () => {
    await setupHappyWorld();
    const boom = async () => {
      throw new Error("写事件炸了");
    };
    const result = await evaluateWkAdvanceGate(
      makeTask({ repoPaths: [] }),
      WK_DEF,
      boom,
    );
    expect(result.decision).toBe("proceed");
  });
});
