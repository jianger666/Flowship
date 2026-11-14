/**
 * 「继续上次 Action」纯函数（src/lib/resume-interrupted-action.ts）+ 接线断言。
 *
 * 覆盖：boot-recovery 标记识别 / 普通 error / 非最近 action / chat / 已有 running / 归档终态 / 未答提问 /
 * 各 actionType 参数还原 / 模型跨家守卫 / 二次确认文案不做代码不保证的承诺；
 * 接线：标记写入点、页面走既有提交链路（不复制 fetch）、组件不自动续跑且用 useDialog 确认。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildResumeAdvanceInput,
  findInterruptedAction,
  isBootRecoveryError,
  planResumeInterruptedAction,
  resumeConfirmCopy,
  type ResumeTaskView,
} from "@/lib/resume-interrupted-action";
import {
  BOOT_RECOVERY_ACTION_WAS_RUNNING_KEY,
  BOOT_RECOVERY_SUBKIND,
  BOOT_RECOVERY_TEXT,
} from "@/lib/stop-copy";
import type { ActionRecord, ActionType, TaskEvent } from "@/lib/types";

const root = path.join(import.meta.dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf-8");

// ---------- fixtures ----------

const action = (over: Partial<ActionRecord> = {}): ActionRecord => ({
  id: "act_1",
  n: 1,
  type: "build",
  status: "error",
  userInstruction: "按 plan 实现登录页",
  artifactPath: null,
  startedAt: 1_000,
  endedAt: 2_000,
  ...over,
});

const ev = (over: Partial<TaskEvent> = {}): TaskEvent => ({
  id: `ev_${Math.random().toString(36).slice(2)}`,
  ts: 3_000,
  kind: "info",
  text: "x",
  ...over,
});

/** 真实写入的那条：kind=error + meta.subkind，文案取单一来源 */
const bootEv = (over: Partial<TaskEvent> = {}): TaskEvent =>
  ev({ kind: "error", text: BOOT_RECOVERY_TEXT, meta: { subkind: BOOT_RECOVERY_SUBKIND }, ...over });

/** 命中场景的基线：task 模式、唯一 action 被打断、事件流末尾是 boot-recovery */
const task = (over: Partial<ResumeTaskView> = {}): ResumeTaskView => ({
  mode: "task",
  repoStatus: "developing",
  runStatus: "error",
  archived: false,
  provider: undefined,
  actions: [action()],
  events: [ev({ ts: 1_500 }), bootEv()],
  ...over,
});

// ---------- isBootRecoveryError ----------

describe("isBootRecoveryError：只认机器标记", () => {
  it("error + meta.subkind=boot-recovery → true", () => {
    expect(isBootRecoveryError(bootEv())).toBe(true);
  });

  it("文案一模一样但没有标记（旧数据 / 手写）→ false，不靠文案匹配", () => {
    expect(isBootRecoveryError(ev({ kind: "error", text: BOOT_RECOVERY_TEXT }))).toBe(false);
  });

  it("别的 subkind / 非 error 事件带标记 → false", () => {
    expect(isBootRecoveryError(ev({ kind: "error", meta: { subkind: "other" } }))).toBe(false);
    expect(isBootRecoveryError(bootEv({ kind: "info" }))).toBe(false);
  });
});

// ---------- findInterruptedAction：显示条件 ----------

describe("findInterruptedAction：该显示", () => {
  it("最近 action=error + 最近 error 事件是 boot-recovery → 返回该 action", () => {
    expect(findInterruptedAction(task())?.id).toBe("act_1");
  });

  it("mode 缺省（老数据）按 task 处理", () => {
    const t = task();
    delete (t as { mode?: string }).mode;
    expect(findInterruptedAction(t)?.id).toBe("act_1");
  });

  it("boot-recovery 之后又来了「回合内工具失败」（kind=error + meta.callId，对主流不可见）→ 仍命中", () => {
    const t = task({
      events: [bootEv({ ts: 3_000 }), ev({ kind: "error", ts: 3_100, meta: { callId: "c1" } })],
    });
    expect(findInterruptedAction(t)?.id).toBe("act_1");
  });

  it("actions 数组乱序：以序号 n 最大者为「最近」", () => {
    const t = task({
      actions: [
        action({ id: "act_2", n: 2, status: "error", startedAt: 2_500 }),
        action({ id: "act_1", n: 1, status: "completed" }),
      ],
      events: [bootEv({ ts: 3_000 })],
    });
    expect(findInterruptedAction(t)?.id).toBe("act_2");
  });

  it.each(["plan", "build", "review", "ship", "dev"] as ActionType[])("%s 类型都能命中", (type) => {
    expect(findInterruptedAction(task({ actions: [action({ type })] }))?.type).toBe(type);
  });

  it("custom 且保留着 customActionId → 命中", () => {
    const t = task({ actions: [action({ type: "custom", customActionId: "ca_1" })] });
    expect(findInterruptedAction(t)?.customActionId).toBe("ca_1");
  });
});

describe("findInterruptedAction：不该显示", () => {
  it("普通 error（agent 自己出错 / 无标记）→ null", () => {
    const t = task({ events: [ev({ kind: "error", text: "模型 429", ts: 3_000 })] });
    expect(findInterruptedAction(t)).toBeNull();
  });

  it("boot-recovery 之后又出现一条普通 error（最近一条不是标记）→ null", () => {
    const t = task({
      events: [bootEv({ ts: 3_000 }), ev({ kind: "error", text: "后来又失败", ts: 3_100 })],
    });
    expect(findInterruptedAction(t)).toBeNull();
  });

  it("没有任何 error 事件 → null", () => {
    expect(findInterruptedAction(task({ events: [ev()] }))).toBeNull();
  });

  it("非最近 action：被打断的是 #1、之后 #2 已完成 → null", () => {
    const t = task({
      actions: [
        action({ id: "act_1", n: 1, status: "error" }),
        action({ id: "act_2", n: 2, status: "completed", startedAt: 4_000, endedAt: 5_000 }),
      ],
      events: [bootEv({ ts: 3_000 })],
    });
    expect(findInterruptedAction(t)).toBeNull();
  });

  it("非最近 action：#1 被打断、#2 因普通原因 error → 不回头重跑 #1（最近 error 事件时间早于 #2 开始）", () => {
    const t = task({
      actions: [
        action({ id: "act_1", n: 1, status: "error" }),
        action({ id: "act_2", n: 2, status: "error", startedAt: 4_000, endedAt: 5_000 }),
      ],
      // 只有 #1 那次的 boot-recovery 事件（#2 的失败没有留 error 事件）：标记早于 #2 开始 → 不属于 #2
      events: [bootEv({ ts: 3_000 })],
    });
    expect(findInterruptedAction(t)).toBeNull();
  });

  it("最近 action 是 cancelled / awaiting_ack / completed → null", () => {
    for (const status of ["cancelled", "awaiting_ack", "completed"] as const) {
      expect(findInterruptedAction(task({ actions: [action({ status })] }))).toBeNull();
    }
  });

  it("没有 action → null", () => {
    expect(findInterruptedAction(task({ actions: [] }))).toBeNull();
  });

  it("chat 模式 → null（chat 没有 action 体系，boot-recovery 后靠继续发消息）", () => {
    expect(findInterruptedAction(task({ mode: "chat" }))).toBeNull();
  });

  it("已有 action 在跑 / 任务 running → null（不再叠一条）", () => {
    expect(
      findInterruptedAction(
        task({
          actions: [
            action({ id: "act_1", n: 1, status: "error" }),
            action({ id: "act_2", n: 2, status: "running", startedAt: 4_000, endedAt: null }),
          ],
        }),
      ),
    ).toBeNull();
    expect(findInterruptedAction(task({ runStatus: "running" }))).toBeNull();
  });

  it("已归档 / 已合并 / 已废弃 → null", () => {
    expect(findInterruptedAction(task({ archived: true }))).toBeNull();
    expect(findInterruptedAction(task({ repoStatus: "merged" }))).toBeNull();
    expect(findInterruptedAction(task({ repoStatus: "abandoned" }))).toBeNull();
  });

  it("被划除（excluded）的 action → null", () => {
    expect(findInterruptedAction(task({ actions: [action({ excluded: true })] }))).toBeNull();
  });

  it("还有未答的提问 → null（与顶部「推进」同口径，先答题）", () => {
    const t = task({
      events: [
        ev({ kind: "ask_user_request", ts: 1_800, meta: { askId: "ask_1" } }),
        bootEv({ ts: 3_000 }),
      ],
    });
    expect(findInterruptedAction(t)).toBeNull();
  });

  it("R21-03：boot-recovery 标了 actionWasRunning=false（已交卷的 action 在一次性问答期间碰上重启、被一并翻成 error）→ null，不给「继续」", () => {
    // 场景：#1 build 已交卷（awaiting_ack），用户又发了一次性问答（任务级 runStatus=running），此时服务重启 →
    // 开机恢复把 #1 翻成 error 并写 boot-recovery。#1 早就跑完了，点「继续」会把它整个重跑。
    const t = task({
      events: [
        ev({ ts: 1_500 }),
        bootEv({ meta: { subkind: BOOT_RECOVERY_SUBKIND, [BOOT_RECOVERY_ACTION_WAS_RUNNING_KEY]: false } }),
      ],
    });
    expect(findInterruptedAction(t)).toBeNull();
    expect(planResumeInterruptedAction(t)).toBeNull();
  });

  it("R21-03 对照：actionWasRunning=true（真被打断）→ 照常命中；字段缺省（旧标记）也按「被打断」处理", () => {
    const withTrue = task({
      events: [
        ev({ ts: 1_500 }),
        bootEv({ meta: { subkind: BOOT_RECOVERY_SUBKIND, [BOOT_RECOVERY_ACTION_WAS_RUNNING_KEY]: true } }),
      ],
    });
    expect(findInterruptedAction(withTrue)?.id).toBe("act_1");
    // task() 默认的 bootEv 没有这个字段
    expect(findInterruptedAction(task())?.id).toBe("act_1");
  });

  it("R21-03：只有明确的 false 才排除——字段是 0 / null / 字符串 \"false\" 这类非 false 值不算", () => {
    for (const v of [0, null, "false", undefined]) {
      const t = task({
        events: [
          ev({ ts: 1_500 }),
          bootEv({ meta: { subkind: BOOT_RECOVERY_SUBKIND, [BOOT_RECOVERY_ACTION_WAS_RUNNING_KEY]: v } }),
        ],
      });
      expect(findInterruptedAction(t)?.id, `值 ${String(v)} 不该排除`).toBe("act_1");
    }
  });

  it("custom 丢了 customActionId（无法还原，推进接口也会 400）→ null", () => {
    expect(findInterruptedAction(task({ actions: [action({ type: "custom" })] }))).toBeNull();
    expect(
      findInterruptedAction(task({ actions: [action({ type: "custom", customActionId: "  " })] })),
    ).toBeNull();
  });
});

// ---------- buildResumeAdvanceInput：参数还原 ----------

describe("buildResumeAdvanceInput：各 actionType 参数还原", () => {
  it("通用：类型与指令原文原样带（不 trim、保留换行），reuseAgent 固定 false", () => {
    const a = action({ type: "review", userInstruction: "  重点看并发\n\n和错误处理  " });
    const input = buildResumeAdvanceInput(a);
    expect(input.actionType).toBe("review");
    expect(input.userInstruction).toBe("  重点看并发\n\n和错误处理  ");
    expect(input.reuseAgent).toBe(false);
  });

  it("plan：带 replanMode，不带别类字段", () => {
    const input = buildResumeAdvanceInput(
      action({ type: "plan", replanMode: "rebuild", devPushMode: "mr", requestedBatchIds: ["x"] }),
    );
    expect(input.replanMode).toBe("rebuild");
    expect(input.devPushMode).toBeUndefined();
    expect(input.requestedBatchIds).toBeUndefined();
    expect(input.customActionId).toBeUndefined();
  });

  it("build：带 requestedBatchIds（拷贝、不共享引用）；空数组 / 缺省 → 不带", () => {
    const src = action({ type: "build", requestedBatchIds: ["p1:b1", "p1:b2"] });
    const input = buildResumeAdvanceInput(src);
    expect(input.requestedBatchIds).toEqual(["p1:b1", "p1:b2"]);
    expect(input.requestedBatchIds).not.toBe(src.requestedBatchIds);
    expect(buildResumeAdvanceInput(action({ type: "build", requestedBatchIds: [] })).requestedBatchIds).toBeUndefined();
    expect(buildResumeAdvanceInput(action({ type: "build" })).requestedBatchIds).toBeUndefined();
  });

  it("dev：带 devPushMode（direct / mr 原样）；老数据缺省 → 不带", () => {
    expect(buildResumeAdvanceInput(action({ type: "dev", devPushMode: "mr" })).devPushMode).toBe("mr");
    expect(buildResumeAdvanceInput(action({ type: "dev", devPushMode: "direct" })).devPushMode).toBe("direct");
    expect(buildResumeAdvanceInput(action({ type: "dev" })).devPushMode).toBeUndefined();
  });

  it("custom：带 customActionId；其余类型即使记录上有也不带", () => {
    expect(buildResumeAdvanceInput(action({ type: "custom", customActionId: "ca_9" })).customActionId).toBe("ca_9");
    expect(buildResumeAdvanceInput(action({ type: "ship", customActionId: "ca_9" })).customActionId).toBeUndefined();
  });

  it("ship / review：除通用字段外什么都不带", () => {
    for (const type of ["ship", "review"] as ActionType[]) {
      const input = buildResumeAdvanceInput(action({ type, devPushMode: "mr", replanMode: "append" }));
      expect(input.devPushMode).toBeUndefined();
      expect(input.replanMode).toBeUndefined();
      expect(input.requestedBatchIds).toBeUndefined();
      expect(input.customActionId).toBeUndefined();
    }
  });

  describe("模型沿用 + 跨家守卫", () => {
    const model = { id: "gpt-5", params: [{ id: "effort", value: "high" }] };

    it("同提供方 / 当前未定提供方 / 老数据无戳 → 沿用 action.agentModel", () => {
      expect(buildResumeAdvanceInput(action({ agentModel: model, agentProvider: "cursor" }), "cursor").model).toEqual(model);
      expect(buildResumeAdvanceInput(action({ agentModel: model, agentProvider: "cursor" }), null).model).toEqual(model);
      expect(buildResumeAdvanceInput(action({ agentModel: model }), "codex").model).toEqual(model);
    });

    it("切过提供方（action 的戳与当前不一致）→ 不带，交给 prepareRunArgs 用当前家默认", () => {
      expect(buildResumeAdvanceInput(action({ agentModel: model, agentProvider: "cursor" }), "codex").model).toBeUndefined();
    });

    it("action 没记过模型 / 模型 id 为空 → 不带", () => {
      expect(buildResumeAdvanceInput(action()).model).toBeUndefined();
      expect(buildResumeAdvanceInput(action({ agentModel: { id: " " } })).model).toBeUndefined();
    });
  });
});

// ---------- resumeConfirmCopy：二次确认 ----------

describe("resumeConfirmCopy：对外副作用类才确认，且不做代码不保证的承诺", () => {
  it("plan / build / review 无需确认", () => {
    for (const type of ["plan", "build", "review"] as ActionType[]) {
      expect(resumeConfirmCopy({ type, n: 1 })).toBeNull();
    }
  });

  it("ship / dev / custom 要确认，标题带序号 + 名称", () => {
    expect(resumeConfirmCopy({ type: "ship", n: 3 })?.title).toContain("#3");
    expect(resumeConfirmCopy({ type: "dev", n: 4 })?.title).toContain("#4");
    const custom = resumeConfirmCopy({ type: "custom", n: 5, customLabel: "发周报" });
    expect(custom?.title).toContain("#5");
    expect(custom?.title).toContain("发周报");
    expect(custom?.description).toContain("发周报");
  });

  it("ship：只承诺代码保证的「已有未合并 MR 会复用」；push / 通知明说可能再执行、请留意事件流", () => {
    const d = resumeConfirmCopy({ type: "ship", n: 1 })!.description;
    expect(d).toContain("可能已经 push 或提了 MR");
    expect(d).toContain("复用");
    expect(d).toContain("请留意事件流");
    // 不得出现「不会重复 push / 推送 / 通知」之类没有代码保证的话
    expect(d).not.toMatch(/不会重复(push|推送|通知|发送)/);
    expect(d).not.toMatch(/(自动|会)(检查|核对|跳过)已(push|推送|提)/);
  });

  it("dev：不确定就明说请留意事件流确认是否已有 push / MR", () => {
    const d = resumeConfirmCopy({ type: "dev", n: 1 })!.description;
    expect(d).toContain("请留意事件流确认是否已有 push / MR");
    expect(d).not.toMatch(/不会重复/);
  });

  it("文案带可识别的确认键名，且与继续动作对应", () => {
    expect(resumeConfirmCopy({ type: "ship", n: 1 })?.confirmLabel).toBe("继续提测");
    expect(resumeConfirmCopy({ type: "dev", n: 1 })?.confirmLabel).toBe("继续联调");
    expect(resumeConfirmCopy({ type: "custom", n: 1 })?.confirmLabel).toBe("继续执行");
  });
});

// ---------- planResumeInterruptedAction：一站式 ----------

describe("planResumeInterruptedAction", () => {
  it("命中：返回 action + 还原入参 + 确认文案（build 不需确认）", () => {
    const plan = planResumeInterruptedAction(
      task({ actions: [action({ type: "build", requestedBatchIds: ["p1:b1"] })] }),
    );
    expect(plan?.action.id).toBe("act_1");
    expect(plan?.input).toMatchObject({
      actionType: "build",
      userInstruction: "按 plan 实现登录页",
      reuseAgent: false,
      requestedBatchIds: ["p1:b1"],
    });
    expect(plan?.confirm).toBeNull();
  });

  it("ship 命中：带确认文案；provider 取自 task（切过家则不带模型）", () => {
    const plan = planResumeInterruptedAction(
      task({
        provider: "codex",
        actions: [
          action({ type: "ship", agentModel: { id: "gpt-5" }, agentProvider: "cursor" }),
        ],
      }),
    );
    expect(plan?.confirm?.title).toContain("提测");
    expect(plan?.input.model).toBeUndefined();
  });

  it("不命中 → null", () => {
    expect(planResumeInterruptedAction(task({ mode: "chat" }))).toBeNull();
    expect(planResumeInterruptedAction(task({ runStatus: "running" }))).toBeNull();
  });
});

// ---------- 接线断言 ----------

describe("接线", () => {
  it("标记写入点：markZombieTaskError 的 error 事件带 meta.subkind，文案仍是 BOOT_RECOVERY_TEXT（stop-copy 断言不被破坏）", () => {
    const src = read("src/lib/server/task-fs.ts");
    const m = src.match(/const markZombieTaskError[\s\S]*?\n\};/);
    expect(m).not.toBeNull();
    expect(m![0]).toMatch(/text:\s*BOOT_RECOVERY_TEXT/);
    // meta 里两个机器标记：subkind + actionWasRunning（翻 error 之前该 action 是否真在跑，R21-03）
    expect(m![0]).toMatch(/subkind:\s*BOOT_RECOVERY_SUBKIND/);
    expect(m![0]).toMatch(/\[BOOT_RECOVERY_ACTION_WAS_RUNNING_KEY\]:\s*actionWasRunning/);
    // 必须在翻 error 之前取（先于 action.status = "error"）
    expect(m![0].indexOf("const actionWasRunning")).toBeGreaterThan(-1);
    expect(m![0].indexOf("const actionWasRunning")).toBeLessThan(m![0].indexOf('action.status = "error"'));
    expect(BOOT_RECOVERY_ACTION_WAS_RUNNING_KEY).toBe("actionWasRunning");
    // 标记值是稳定常量，不是散落的字面量
    expect(BOOT_RECOVERY_SUBKIND).toBe("boot-recovery");
  });

  it("页面：条复用既有提交链路（handleAdvance）、整个页面只有一处 advance fetch", () => {
    const src = read("src/app/tasks/[id]/page.tsx");
    expect(src).toContain("<InterruptedActionBar");
    expect(src).toMatch(/onResume=\{handleResumeInterrupted\}/);
    // 继续 = 调同一个 handleAdvance；推进弹窗的 onSubmit 也是它的薄包装（只丢掉返回值）
    expect(src).toMatch(/const handleResumeInterrupted[\s\S]*?await handleAdvance\(input\)/);
    expect(src).toMatch(/const handleDialogSubmit[\s\S]*?await handleAdvance\(input\)/);
    expect(src).toMatch(/onSubmit=\{handleDialogSubmit\}/);
    // 没有复制第二份提交逻辑
    expect(src.match(/\/advance`/g)?.length).toBe(1);
  });

  it("组件：必须点击才起（无 useEffect / 无自动触发）、确认走 useDialog 而不是原生弹窗、重操作默认聚焦取消", () => {
    const src = read("src/components/tasks/interrupted-action-bar.tsx");
    expect(src).not.toMatch(/useEffect/);
    expect(src).toMatch(/useDialog\(\)/);
    expect(src).toMatch(/defaultFocus:\s*"cancel"/);
    expect(src).not.toMatch(/window\.(alert|confirm|prompt)/);
    // 只有点击回调里调 onResume
    expect(src.match(/onResume\(/g)?.length).toBe(1);
  });
});
