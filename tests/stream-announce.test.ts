/**
 * 事件流「关键事件播报」（V14-01 + V16-10）
 *
 * 问题：整个事件流没有任何播报区——失败 / 待答 / 完成对读屏用户是无声的。
 * 又不能把 role=alert 贴到列表卡片上（虚拟列表，卡片每次滚进视口都会重新挂载 → 反复播报，
 * 见 error-card.tsx 头注释）。所以播报区放在列表外，用「基线 seq」去重：
 *   - 挂载 / 切任务那一刻已存在的事件 = 基线，不播报；
 *   - 之后 seq 更大的新事件才播报，且同一条只播一次（nextSeq 单调不回退）。
 *
 * 这个文件两层：
 *   ① 纯函数 deriveAnnouncements / maxEventSeq（node 里直接跑）；
 *   ② 源码契约：播报区的 DOM 属性、放在列表外、秒数不进播报区、列表卡片里没有 live 属性。
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { analyzingToolLabel } from "@/lib/chat-turns";
import { announceStatusLabel, deriveAnnouncements, maxEventSeq } from "@/lib/stream-announce";
import type { TaskEvent } from "@/lib/types";

let nextId = 0;
const ev = (over: Partial<TaskEvent> & Pick<TaskEvent, "kind">): TaskEvent => ({
  id: `e${++nextId}`,
  ts: 1_700_000_000_000 + nextId,
  text: "",
  ...over,
});

describe("maxEventSeq（挂载基线）", () => {
  it("空列表 = 0（seq 从 1 起，0 就是「什么都没见过」）", () => {
    expect(maxEventSeq([])).toBe(0);
  });

  it("取最大 seq；旧事件没有 seq 的忽略", () => {
    expect(
      maxEventSeq([
        ev({ kind: "info", seq: 3 }),
        ev({ kind: "info" }),
        ev({ kind: "info", seq: 9 }),
        ev({ kind: "info", seq: 5 }),
      ]),
    ).toBe(9);
  });

  it("全是旧事件（都没有 seq）= 0", () => {
    expect(maxEventSeq([ev({ kind: "error" }), ev({ kind: "info" })])).toBe(0);
  });
});

describe("deriveAnnouncements：基线去重", () => {
  it("seq ≤ 基线的事件一律不播（挂载时已存在的历史错误不能一进页面就念出来）", () => {
    const events = [
      ev({ kind: "error", text: "连接中断", seq: 4 }),
      ev({ kind: "ask_user_request", text: "选哪个", seq: 5 }),
    ];
    const r = deriveAnnouncements(5, events);
    expect(r.text).toBe("");
    expect(r.nextSeq).toBe(5);
  });

  it("基线之后新增的才播，nextSeq 推进到最大 seq", () => {
    const events = [
      ev({ kind: "error", text: "旧错误", seq: 4 }),
      ev({ kind: "error", text: "连接中断", seq: 6 }),
    ];
    const r = deriveAnnouncements(5, events);
    expect(r.text).toBe("出错了：连接中断");
    expect(r.nextSeq).toBe(6);
  });

  it("同一批事件拿 nextSeq 再喂一次 = 空（同一条只播一次）", () => {
    const events = [ev({ kind: "error", text: "连接中断", seq: 6 })];
    const first = deriveAnnouncements(5, events);
    expect(first.text).not.toBe("");
    const again = deriveAnnouncements(first.nextSeq, events);
    expect(again.text).toBe("");
    expect(again.nextSeq).toBe(first.nextSeq);
  });

  it("没有 seq 的事件不播（无从判断它新不新，宁可漏播也不反复念）", () => {
    const r = deriveAnnouncements(0, [ev({ kind: "error", text: "没 seq" })]);
    expect(r.text).toBe("");
    expect(r.nextSeq).toBe(0);
  });

  it("nextSeq 单调不回退：回退 / 编辑重发把列表截短后，基线不被拉低", () => {
    const r = deriveAnnouncements(20, [ev({ kind: "info", seq: 3 })]);
    expect(r.nextSeq).toBe(20);
    expect(r.text).toBe("");
  });

  it("向前翻页（loadEarlier）补进来的更早事件 seq 都在基线之下，不播", () => {
    const older = [
      ev({ kind: "error", text: "很久以前的错误", seq: 2 }),
      ev({ kind: "ask_user_request", text: "很久以前的提问", seq: 3 }),
    ];
    const current = [ev({ kind: "info", seq: 40 })];
    const r = deriveAnnouncements(40, [...older, ...current]);
    expect(r.text).toBe("");
  });

  it("历史很长时只有尾部的新事件被播（不会把 5000 条旧事件翻一遍再播旧的）", () => {
    const events: TaskEvent[] = [];
    for (let i = 1; i <= 5000; i++) {
      events.push(ev({ kind: "error", text: `旧错误 ${i}`, seq: i }));
    }
    events.push(ev({ kind: "error", text: "刚发生的", seq: 5001 }));
    const r = deriveAnnouncements(5000, events);
    expect(r.text).toBe("出错了：刚发生的");
    expect(r.nextSeq).toBe(5001);
  });
});

describe("deriveAnnouncements：哪些算关键事件、怎么说", () => {
  it("失败：出错了：正文第一行（不带 meta.detail 里的原始诊断）", () => {
    const r = deriveAnnouncements(0, [
      ev({
        kind: "error",
        seq: 1,
        text: "网络连接中断，已停止自动重连\n第二行解释",
        meta: { detail: "ECONNRESET at socket.js:123 …原始堆栈" },
      }),
    ]);
    expect(r.text).toBe("出错了：网络连接中断，已停止自动重连");
    expect(r.text).not.toContain("ECONNRESET");
  });

  it("待答：AI 在等你回答：问题摘要；没有摘要就只说前半句", () => {
    expect(
      deriveAnnouncements(0, [
        ev({ kind: "ask_user_request", seq: 1, text: "要用哪个分支做基线？" }),
      ]).text,
    ).toBe("AI 在等你回答：要用哪个分支做基线？");
    expect(
      deriveAnnouncements(0, [ev({ kind: "ask_user_request", seq: 1, text: "  " })]).text,
    ).toBe("AI 在等你回答");
  });

  it("完成（task）：Action 产出完成、等你确认（info 里带 meta.awaitingAck）", () => {
    const r = deriveAnnouncements(0, [
      ev({ kind: "info", seq: 1, text: "plan 产出完成", meta: { awaitingAck: true } }),
    ]);
    expect(r.text).toBe("这一步的产出已完成，等你确认");
  });

  it("完成（chat）：AI 有新回复", () => {
    const r = deriveAnnouncements(0, [
      ev({ kind: "assistant_message", seq: 1, text: "好的，已经改完了" }),
    ]);
    expect(r.text).toBe("AI 有新回复");
  });

  it("过程事件不播：thinking / tool_call / tool_result / 普通 info / user_reply 只推进 nextSeq", () => {
    const r = deriveAnnouncements(0, [
      ev({ kind: "thinking", seq: 1, text: "想一想" }),
      ev({ kind: "tool_call", seq: 2, text: "shell" }),
      ev({ kind: "tool_result", seq: 3, text: "ok" }),
      ev({ kind: "info", seq: 4, text: "普通提示" }),
      ev({ kind: "user_reply", seq: 5, text: "我说的话" }),
    ]);
    expect(r.text).toBe("");
    expect(r.nextSeq).toBe(5);
  });

  it("流里本来就不显示的事件不播：被平台消音的 / 答疑旁路 run 的 error / 回合内工具失败", () => {
    const r = deriveAnnouncements(0, [
      ev({ kind: "assistant_message", seq: 1, text: "消音", meta: { muted: true } }),
      ev({ kind: "error", seq: 2, text: "别人提问触发的旁路 run 失败", meta: { groupRun: "g_1" } }),
    ]);
    expect(r.text).toBe("");
    expect(r.nextSeq).toBe(2);
  });

  it("chat 里启动进度类 info 不播（opts.isChat 与 isHiddenFromEventStream 同口径）", () => {
    // 复用单一隐藏闸：这里只确认 isChat 被透传——普通 info 在 chat / task 下都不播
    const events = [ev({ kind: "info", seq: 1, text: "启动中" })];
    expect(deriveAnnouncements(0, events, { isChat: true }).text).toBe("");
    expect(deriveAnnouncements(0, events, { isChat: false }).text).toBe("");
  });

  it("一批里有多种：失败优先、其次待答、再是完成，用「；」连起来", () => {
    const r = deriveAnnouncements(0, [
      ev({ kind: "assistant_message", seq: 1, text: "说了点什么" }),
      ev({ kind: "ask_user_request", seq: 2, text: "选哪个？" }),
      ev({ kind: "error", seq: 3, text: "跑挂了" }),
    ]);
    expect(r.text).toBe("出错了：跑挂了；AI 在等你回答：选哪个？；AI 有新回复");
  });

  it("一批里连续多条同类：只说一句（失败带条数、取最新一条的摘要）", () => {
    const r = deriveAnnouncements(0, [
      ev({ kind: "error", seq: 1, text: "第一次失败" }),
      ev({ kind: "error", seq: 2, text: "第二次失败" }),
      ev({ kind: "assistant_message", seq: 3, text: "a" }),
      ev({ kind: "assistant_message", seq: 4, text: "b" }),
    ]);
    expect(r.text).toBe("出错了（共 2 条）：第二次失败；AI 有新回复");
  });

  it("摘要截断：长文本只留前 60 个字，加省略号；多余空白折叠", () => {
    const long = "很长".repeat(80);
    const r = deriveAnnouncements(0, [ev({ kind: "error", seq: 1, text: long })]);
    expect(r.text.startsWith("出错了：")).toBe(true);
    const brief = r.text.slice("出错了：".length);
    expect(brief.endsWith("…")).toBe(true);
    expect([...brief].length).toBe(61);

    const spaced = deriveAnnouncements(0, [
      ev({ kind: "error", seq: 1, text: "  连接   已\t断开  " }),
    ]);
    expect(spaced.text).toBe("出错了：连接 已 断开");
  });

  it("error 没有正文时也要说一声（不能念出「出错了：」就断）", () => {
    const r = deriveAnnouncements(0, [ev({ kind: "error", seq: 1, text: "" })]);
    expect(r.text).toBe("出错了");
  });
});

// ===========================================
// ② 源码契约
// ===========================================

const srcDir = path.resolve(import.meta.dirname, "..", "src");
const read = (...segments: string[]): string =>
  readFileSync(path.join(srcDir, ...segments), "utf-8");
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

describe("播报区接线契约", () => {
  const announcer = stripComments(read("components", "tasks", "stream-announcer.tsx"));
  const hook = stripComments(read("hooks", "use-stream-announcement.ts"));
  const stream = stripComments(read("components", "tasks", "event-stream.tsx"));

  it("播报区：sr-only + role=status + aria-live=polite + aria-atomic=false", () => {
    expect(announcer).toMatch(/className="sr-only"/);
    expect(announcer).toContain('role="status"');
    expect(announcer).toContain('aria-live="polite"');
    // role=status 默认 atomic=true：状态行 label 一变就会把整块（含上一条旧的关键事件）重念一遍
    expect(announcer).toContain('aria-atomic="false"');
  });

  it("关键事件那一格用递增 id 做 key：连续两条同文案的错误也能再播一次", () => {
    expect(announcer).toMatch(/<span key=\{announcement\.id\}>\s*\{announcement\.text\}\s*<\/span>/);
  });

  it("状态行 label 进播报区，但不带秒数（逐秒走字会每秒念一次）", () => {
    expect(announcer).toContain("statusLabel");
    expect(announcer).not.toMatch(/elapsed|sinceTs|formatDuration|startedAt/i);
  });

  it("hook：挂载 / 切任务时用 maxEventSeq 定基线并 return，不播；之后走 deriveAnnouncements 推进基线", () => {
    expect(hook).toContain("maxEventSeq(events)");
    expect(hook).toContain("deriveAnnouncements(");
    expect(hook).toMatch(/baselineRef\.current\.taskId !== taskId/);
    // 基线那一次必须 return，否则挂载时的历史事件会被当成「新增」
    const i = hook.indexOf("maxEventSeq(events)");
    expect(hook.slice(i, i + 200)).toContain("return;");
    expect(hook).toMatch(/baselineRef\.current\.seq = \w+\.nextSeq/);
  });

  it("event-stream.tsx：播报区挂在列表外（状态行槽位之后），statusLabel 取自 activeStatus", () => {
    expect(stream).toContain('import { StreamAnnouncer } from "./stream-announcer"');
    const iSlot = stream.indexOf('reserveTaskStatusSlot ? "h-7" : "h-0"');
    const iAnnouncer = stream.indexOf("<StreamAnnouncer");
    expect(iSlot).toBeGreaterThan(-1);
    expect(iAnnouncer).toBeGreaterThan(iSlot);
    const tag = stream.slice(iAnnouncer, stream.indexOf("/>", iAnnouncer) + 2);
    expect(tag).toContain("taskId={task.id}");
    expect(tag).toContain("events={task.events}");
    expect(tag).toContain("isChat={isChat}");
    expect(tag).toContain("statusLabel={activeStatus?.label");
    // 只挂一份
    expect(stream.split("<StreamAnnouncer").length - 1).toBe(1);
  });

  it("没有把 task.events 塞进 activeStatus 的 memo（状态行接线契约不被破坏）", () => {
    const i = stream.indexOf("const activeStatus = useMemo");
    expect(i).toBeGreaterThan(-1);
    const memo = stream.slice(i, stream.indexOf("]);", i));
    expect(memo).not.toContain("task.events");
  });
});

describe("列表卡片里不加 live 属性（error-card.tsx 头注释的禁令仍然有效）", () => {
  const streamDir = path.join(srcDir, "components", "tasks", "event-stream");
  const files = readdirSync(streamDir).filter((f) => f.endsWith(".tsx"));

  it("event-stream/ 下没有 aria-live / role=alert / role=status", () => {
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const src = stripComments(readFileSync(path.join(streamDir, f), "utf-8"));
      expect(src, f).not.toMatch(/aria-live|role="(?:alert|status)"/);
    }
  });
});


describe("R8-03：播报不外露工具名；工具之间的叙述句不念「AI 有新回复」", () => {
  const ev = (seq: number, kind: TaskEvent["kind"]): TaskEvent =>
    ({ id: `e${seq}`, taskId: "t", kind, text: "x", ts: seq, seq }) as unknown as TaskEvent;

  it("announceStatusLabel：真实状态行文案（含 analyzingToolLabel）里的工具名被粗化，其它原样", () => {
    expect(announceStatusLabel("正在执行 shell")).toBe("正在执行工具");
    expect(announceStatusLabel("正在执行 mcp__feishu__search")).toBe("正在执行工具");
    expect(announceStatusLabel(analyzingToolLabel("read"))).toBe("正在分析工具结果");
    expect(announceStatusLabel(analyzingToolLabel("some long tool name"))).toBe("正在分析工具结果");
    for (const l of ["思考中", "等待中", "等你回答", "正在回复…", "正在启动…", "处理中…", "子代理工作中", ""]) {
      expect(announceStatusLabel(l)).toBe(l);
    }
  });

  it("连续换工具：粗化后文案相同（播报区文本不变 → 读屏不重念）", () => {
    expect(announceStatusLabel("正在执行 shell")).toBe(announceStatusLabel("正在执行 grep"));
  });

  it("批内最后是回复 → 念；叙述句后面还跟着工具调用 → 不念", () => {
    expect(deriveAnnouncements(0, [ev(1, "assistant_message")]).text).toBe("AI 有新回复");
    expect(
      deriveAnnouncements(0, [ev(1, "tool_call"), ev(2, "tool_result"), ev(3, "assistant_message")]).text,
    ).toBe("AI 有新回复");
    expect(
      deriveAnnouncements(0, [ev(1, "assistant_message"), ev(2, "tool_call"), ev(3, "tool_result")]).text,
    ).toBe("");
  });

  it("基线仍推进到批内最大 seq（不因为没播而回头重播）", () => {
    const r = deriveAnnouncements(0, [ev(1, "assistant_message"), ev(2, "tool_call")]);
    expect(r.text).toBe("");
    expect(r.nextSeq).toBe(2);
  });

  it("接线：StreamAnnouncer 用 announceStatusPresence 包 statusLabel（Q8-05：只在空 / 非空间切换）", () => {
    const src = readFileSync(path.join(srcDir, "components", "tasks", "stream-announcer.tsx"), "utf-8");
    expect(src).toContain("announceStatusPresence(statusLabel)");
  });
});

// ---------------------------------------------------------------------------
// Q8-05：「AI 有新回复」trailing 节流 + 状态 label 只在空 / 非空间切换
// ---------------------------------------------------------------------------
import {
  ANNOUNCE_BUSY_LABEL,
  REPLY_ANNOUNCEMENT,
  REPLY_ANNOUNCE_QUIET_MS,
  announceStatusPresence,
  nextReplyTimerAction,
} from "@/lib/stream-announce";

describe("Q8-05：逐事件喂入「叙述 → tool_call → tool_result」不再逐轮念「AI 有新回复」", () => {
  const ev = (seq: number, kind: string, text = ""): TaskEvent =>
    ({ id: `e${seq}`, taskId: "t", ts: seq, seq, kind, text, meta: {} }) as unknown as TaskEvent;

  /** 复刻 hook：逐事件喂入，按 nextReplyTimerAction 驱动一个「计时器是否在走」的布尔 */
  const simulate = (batches: TaskEvent[][]) => {
    const all: TaskEvent[] = [];
    let baseline = 0;
    let armed = false;
    let spoken = 0; // 计时器真正走完才念：这里统计「到达静默窗口」的次数
    for (const batch of batches) {
      all.push(...batch);
      const d = deriveAnnouncements(baseline, all, { isChat: true });
      baseline = d.nextSeq;
      const action = nextReplyTimerAction(d, armed);
      if (action === "restart") armed = true;
      else if (action === "cancel") armed = false;
    }
    // 事件流结束后静默 → 仍在走的计时器会念一次
    if (armed) spoken += 1;
    return spoken;
  };

  it("20 轮「叙述 → tool_call → tool_result」逐事件到达：整个过程 0 次（旧：逐事件念 20 次）", () => {
    const batches: TaskEvent[][] = [];
    let seq = 1;
    for (let i = 0; i < 20; i++) {
      batches.push([ev(seq++, "assistant_message", "我先看下 X")]);
      batches.push([ev(seq++, "tool_call", "read")]);
      batches.push([ev(seq++, "tool_result", "ok")]);
    }
    expect(simulate(batches)).toBe(0);
  });

  it("最后一条是真正的回复（之后没有工具往返）→ 静默窗口后念一次", () => {
    const batches: TaskEvent[][] = [
      [ev(1, "assistant_message", "我先看下")],
      [ev(2, "tool_call", "read")],
      [ev(3, "tool_result", "ok")],
      [ev(4, "assistant_message", "改好了")],
    ];
    expect(simulate(batches)).toBe(1);
  });

  it("同一批里既有工具往返又以回复收尾 → 计时器重启（旧行为保留：批内最后一个相关事件是回复才念）", () => {
    const d = deriveAnnouncements(0, [ev(1, "tool_call"), ev(2, "assistant_message", "好了")], { isChat: true });
    expect(d.replyPending).toBe(true);
    expect(d.text).toContain(REPLY_ANNOUNCEMENT);
    expect(d.urgentText).toBe(""); // 回复不再混进要立刻播的那句
    const d2 = deriveAnnouncements(0, [ev(1, "assistant_message", "叙述"), ev(2, "tool_call")], { isChat: true });
    expect(d2.replyPending).toBe(false);
    expect(d2.toolActivity).toBe(true);
  });

  it("失败 / 待答仍立刻播（urgentText），不被回复的 trailing 节流拖住", () => {
    const d = deriveAnnouncements(
      0,
      [ev(1, "assistant_message", "x"), { ...ev(2, "ask_user_request", "要不要继续？") }],
      { isChat: true },
    );
    expect(d.urgentText).toContain("AI 在等你回答");
    expect(nextReplyTimerAction(d, false)).toBe("restart");
  });

  it("nextReplyTimerAction：没有新信息保持原计时器", () => {
    expect(nextReplyTimerAction({ replyPending: false, toolActivity: false }, true)).toBe("keep");
    expect(nextReplyTimerAction({ replyPending: false, toolActivity: true }, false)).toBe("keep");
    expect(nextReplyTimerAction({ replyPending: false, toolActivity: true }, true)).toBe("cancel");
    expect(nextReplyTimerAction({ replyPending: true, toolActivity: true }, true)).toBe("restart");
  });

  it("静默窗口是个有意义的值（> 一次工具往返的常见间隔）", () => {
    expect(REPLY_ANNOUNCE_QUIET_MS).toBeGreaterThanOrEqual(3000);
  });
});

describe("Q8-05：状态 label 只在「空 ↔ 非空」间切换", () => {
  it("无论是什么阶段文案，非空都映射成同一句；空 → 空（切换才会触发读屏）", () => {
    const labels = ["思考中", "正在执行 shell", "正在分析 read 的结果", "等你回答", "正在回复…"];
    const spoken = new Set(labels.map(announceStatusPresence));
    expect([...spoken]).toEqual([ANNOUNCE_BUSY_LABEL]);
    expect(announceStatusPresence("")).toBe("");
    expect(announceStatusPresence("   ")).toBe("");
  });

  it("20 次工具往返里 label 来回变：播报区文本序列只有「开始」「结束」两次变化", () => {
    const seq = ["", "思考中", "正在执行 shell", "正在分析 shell 的结果", "思考中", "正在执行 read", "正在回复…", ""];
    const rendered = seq.map(announceStatusPresence);
    let changes = 0;
    for (let i = 1; i < rendered.length; i++) if (rendered[i] !== rendered[i - 1]) changes += 1;
    expect(changes).toBe(2);
  });
});
