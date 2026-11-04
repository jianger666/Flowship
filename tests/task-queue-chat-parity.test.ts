/**
 * task 排队与 chat 对齐（客户端侧）：
 * - 入队不弹成功 toast（排队条自己就是反馈），失败 toast 还在；
 * - 两个排队条共用一份面板、文案同源；
 * - 一行能做什么（编辑 / 立即发送）的来源矩阵、task 的立即发送文案、行内编辑保存的校验；
 * - 客户端 store：编辑 / 立即发送 / 取完整正文的请求形状与「已送出」的静默对齐。
 *
 * 组件的 effect / 事件在 node 测试环境跑不起来（无 jsdom），所以：决策抽成纯函数写行为测试，
 * 组件接线只钉「必须长这样」的几处源码（连着行为测试一起看，别单靠源码形状）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  queueEditDraftToSave,
  sendNowCopy,
  taskSendNowCopy,
} from "@/lib/queue-banner";
import { stoppableQueuedCount } from "@/lib/stop-copy";
import {
  TALK_QUEUE_EDITABLE_SOURCES,
  TALK_QUEUE_SEND_NOW_SOURCES,
  canEditTalkQueueItem,
  canSendNowTalkQueueItem,
  type TalkQueueSource,
} from "@/lib/talk-queue";
import {
  ApiRequestError,
  fetchTalkQueueEditTexts,
  isTalkQueueItemGone,
  sendTalkQueueItemNow,
  updateTalkQueueItem,
} from "@/lib/task-store";

const source = (rel: string) =>
  readFileSync(path.resolve(import.meta.dirname, "..", rel), "utf-8");

describe("入队不弹成功 toast（与 chat 一致）", () => {
  const composer = source("src/components/tasks/task-talk-composer.tsx");

  it("composer 里没有「已排队」成功提示，失败 / 落盘告警的 toast 仍在", () => {
    expect(composer).not.toContain("已排队，当前这轮跑完自动发送");
    expect(composer).not.toMatch(/toast\.success\(/);
    // 失败提示不能被顺手删掉（只去掉成功提示）
    expect(composer).toMatch(/toast\.error\(/);
    expect(composer).toContain("消息已送达但记录保存失败");
  });

  it("入队（202）分支仍然在：不弹提示也不当作送达（不 onTaskUpdate）", () => {
    // 两处（跨挂载认领 / 正常提交）都要在 queued 时提前 return，不能掉进「已送达」分支
    const hits = composer.match(/if \(result\.queued\)/g) ?? [];
    expect(hits).toHaveLength(2);
  });
});

describe("两个排队条共用一份面板", () => {
  const panel = source("src/components/tasks/queue-banner.tsx");
  const chat = source("src/components/tasks/chat-queue-banner.tsx");
  const talk = source("src/components/tasks/talk-queue-banner.tsx");

  it("条上文案只在共用面板里写一份；task 旧文案没了", () => {
    expect(panel).toContain("条排队中 · 点击管理");
    for (const shell of [chat, talk]) {
      expect(shell).not.toContain("条排队中");
      expect(shell).not.toContain("当前这轮跑完自动送达");
      expect(shell).toMatch(/<QueueBanner\b/);
      // 外壳不再自己造 Popover——面板只有一份
      expect(shell).not.toContain("<Popover");
    }
    expect(talk).not.toContain("条消息排队中");
  });

  it("chat 外壳拉服务端快照（fetchRows）；task 外壳吃 SSE 实时快照（rows），不另拉", () => {
    expect(chat).toMatch(/fetchRows=/);
    expect(chat).not.toMatch(/\brows=/);
    expect(talk).toMatch(/\brows=\{talkQueue\.map\(rowOf\)\}/);
    expect(talk).not.toMatch(/fetchRows=/);
  });

  it("task 编辑取完整正文（?full=1），不拿 ≤120 字的预览去编辑", () => {
    expect(talk).toMatch(/loadEditText: async \(row\) => \(await fetchTalkQueueEditTexts\(taskId\)\)\[row\.id\] \?\? null/);
    // 面板：有 loadEditText 就用它的结果当草稿，没有才用 row.text
    expect(panel).toMatch(/adapter\.loadEditText/);
  });

  it("task 外壳按行的来源给按钮（与服务端同一份判定），而不是写死", () => {
    expect(talk).toMatch(/canEdit: canEditTalkQueueItem\(it\)/);
    expect(talk).toMatch(/canSendNow: canSendNowTalkQueueItem\(it\)/);
    expect(panel).toMatch(/row\.canEdit \?/);
    expect(panel).toMatch(/row\.canSendNow \?/);
  });

  it("面板里「保存时这条已送出」要告诉用户改动没生效（不能静默当成功）", () => {
    expect(panel).toMatch(/result === "gone"[\s\S]{0,120}toast\.info\(/);
  });
});

describe("一行能做什么：来源矩阵（客户端按钮显隐与服务端校验共用）", () => {
  const sources: TalkQueueSource[] = ["app", "group_owner", "group_reply", "group_question"];

  it("编辑：只有 app；立即发送：app + group_owner；群回执 / 群提问只能删", () => {
    expect(sources.filter((source) => canEditTalkQueueItem({ source }))).toEqual(["app"]);
    expect(sources.filter((source) => canSendNowTalkQueueItem({ source }))).toEqual([
      "app",
      "group_owner",
    ]);
    expect([...TALK_QUEUE_EDITABLE_SOURCES]).toEqual(["app"]);
    expect([...TALK_QUEUE_SEND_NOW_SOURCES]).toEqual(["app", "group_owner"]);
  });
});

describe("暂存（held）行：立即发送窗口内照常显示但不可操作（第十七轮 N1）", () => {
  const panel = source("src/components/tasks/queue-banner.tsx");
  const talk = source("src/components/tasks/talk-queue-banner.tsx");

  it("task 外壳把快照的 held 带进行；面板对 held 行禁用编辑 / 立即发送 / 删除并给提示", () => {
    expect(talk).toMatch(/held: it\.held === true/);
    expect(panel).toMatch(/const locked = row\.held === true/);
    // busy 含 locked——三个按钮都吃 disabled={busy}
    expect(panel).toMatch(/const busy =\s*locked \|\|/);
    expect((panel.match(/disabled=\{busy\}/g) ?? []).length).toBe(3);
    // 三个 hover 提示在 held 时都换成「让位」说明
    expect((panel.match(/locked \? QUEUE_ROW_HELD_TIP/g) ?? []).length).toBe(3);
  });

  it("正在编辑的行恰好被暂存：保存不发请求、不报「已经送出」（它并没送出），留在编辑态", () => {
    const save = panel.slice(panel.indexOf("const handleSaveEdit"), panel.indexOf("// 常驻挂载"));
    const heldGuard = save.indexOf("if (row.held === true)");
    expect(heldGuard).toBeGreaterThan(-1);
    // 守卫在发请求（setSavingEdit / adapter.save）之前
    expect(heldGuard).toBeLessThan(save.indexOf("setSavingEdit(true)"));
    expect(heldGuard).toBeLessThan(save.indexOf("adapter"));
    expect(save.slice(heldGuard, save.indexOf("setSavingEdit(true)"))).toMatch(
      /toast\.info\(QUEUE_ROW_HELD_TIP\);\s*return;/,
    );
  });

  it("停止确认框的「会清掉 N 条」不算暂存的（它们不在队列里，停止清不到）", () => {
    expect(
      stoppableQueuedCount([
        { source: "app" },
        { source: "app", held: true },
        { source: "group_owner" },
        { source: "app", held: false },
      ]),
    ).toBe(2);
  });
});

describe("task 的立即发送文案", () => {
  it("agent 在跑：先确认、如实说会停止这一轮，其余排队保留；没在跑：不打扰", () => {
    const running = taskSendNowCopy(true);
    expect(running.confirm).toMatchObject({ confirmLabel: "停止并发送" });
    // 如实说后果：task 打断的是当前 action 的运行，正在改代码 / 写产物时会留半成品
    expect(running.confirm?.description).toContain("中断");
    expect(running.confirm?.description).toContain("半成品");
    expect(running.confirm?.description).toContain("其余排队消息会保留");
    expect(running.tooltip).toContain("中断");

    const idle = taskSendNowCopy(false);
    expect(idle.confirm).toBeNull();
    expect(idle.tooltip).not.toContain("中断");
  });

  it("task 不套用 chat 的「当前模型不支持中途插话」（那是 provider 能力问题，task 没有 steer 这一说）", () => {
    expect(taskSendNowCopy(true).confirm?.description).not.toContain("不支持中途插话");
    // chat 的文案没被改动
    expect(sendNowCopy("interrupt").confirm?.description).toContain("当前模型不支持中途插话");
    expect(sendNowCopy("steer").confirm).toBeNull();
  });
});

describe("行内编辑保存校验（queueEditDraftToSave）", () => {
  it("trim 后提交；纯文字条清空不提交；带附件的条允许清空", () => {
    expect(queueEditDraftToSave("  改后  ", false)).toBe("改后");
    expect(queueEditDraftToSave("   ", false)).toBeNull();
    expect(queueEditDraftToSave("", false)).toBeNull();
    expect(queueEditDraftToSave("  ", true)).toBe("");
    expect(queueEditDraftToSave("x", true)).toBe("x");
  });
});

describe("task-store：编辑 / 立即发送 / 完整正文", () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const stubFetch = (status: number, body: unknown) => {
    calls.length = 0;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    });
  };
  afterEach(() => vi.unstubAllGlobals());

  it("fetchTalkQueueEditTexts：GET ?full=1，取 texts；缺省给空对象", async () => {
    stubFetch(200, { items: [], texts: { tq_1: "全文" } });
    expect(await fetchTalkQueueEditTexts("t 1")).toEqual({ tq_1: "全文" });
    expect(calls[0]!.url).toBe("/api/tasks/t%201/talk-queue?full=1");
    stubFetch(200, { items: [] });
    expect(await fetchTalkQueueEditTexts("t")).toEqual({});
  });

  it("updateTalkQueueItem：PUT { itemId, text }，回新条目", async () => {
    stubFetch(200, { ok: true, item: { id: "tq_1", source: "app", preview: "新", createdAt: 1 } });
    const it = await updateTalkQueueItem("t", "tq_1", "新");
    expect(it.preview).toBe("新");
    expect(calls[0]!.init.method).toBe("PUT");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ itemId: "tq_1", text: "新" });
  });

  it("编辑撞「已送出」：抛 409 + queue_item_gone，isTalkQueueItemGone 认得；别的 409 / 400 不认", async () => {
    stubFetch(409, { error: "这条消息已经送出或被移除", code: "queue_item_gone" });
    const err = await updateTalkQueueItem("t", "tq_1", "x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(isTalkQueueItemGone(err)).toBe(true);

    stubFetch(409, { error: "忙", code: "task_busy" });
    expect(isTalkQueueItemGone(await updateTalkQueueItem("t", "a", "x").catch((e: unknown) => e))).toBe(false);
    stubFetch(400, { error: "这类排队消息不支持编辑" });
    const bad = await updateTalkQueueItem("t", "a", "x").catch((e: unknown) => e);
    expect(isTalkQueueItemGone(bad)).toBe(false);
    expect((bad as Error).message).toBe("这类排队消息不支持编辑");
    expect(isTalkQueueItemGone(new Error("x"))).toBe(false);
  });

  it("sendTalkQueueItemNow：POST { action: send_now, itemId }；200 → sent；已送出 → gone（不抛）；其余失败照抛并带服务端文案", async () => {
    stubFetch(200, { ok: true, itemId: "tq_1" });
    expect(await sendTalkQueueItemNow("t", "tq_1")).toBe("sent");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ action: "send_now", itemId: "tq_1" });

    stubFetch(409, { error: "这条消息已经送出或被移除", code: "queue_item_gone" });
    expect(await sendTalkQueueItemNow("t", "tq_1")).toBe("gone");

    stubFetch(409, { error: "agent 正在跑、等它说完这轮再问", code: "task_busy" });
    await expect(sendTalkQueueItemNow("t", "tq_1")).rejects.toThrow("agent 正在跑");
    stubFetch(500, { error: "起会话失败" });
    await expect(sendTalkQueueItemNow("t", "tq_1")).rejects.toThrow("起会话失败");
  });
});
