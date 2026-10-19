/**
 * 编辑已发送的消息（Codex / Cursor IDE 式：替换这条及之后的对话、从这里重跑）——客户端侧：
 *   - planEditRewind / editRewindConfirmCopy（纯函数）：会删多少、会不会还原文件、要不要先停、要不要弹确认；
 *   - 接线契约（源码）：任意一条用户消息都有编辑入口、发送走「确认 → 停 → 回退(mode:edit) → 发新消息」、
 *     回退成功但没发出去时文字放回输入框、没接 onEditRewind 就退回旧的「编辑后追加」语义。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { editRewindConfirmCopy, planEditRewind } from "../src/lib/edit-rewind";
import type { TaskEvent } from "../src/lib/types";

let n = 0;
const ev = (
  kind: TaskEvent["kind"],
  text: string,
  meta?: Record<string, unknown>,
): TaskEvent =>
  ({ id: `e${++n}`, ts: n, kind, text, ...(meta ? { meta } : {}) }) as TaskEvent;

const read = (rel: string) =>
  fs.readFile(path.join(process.cwd(), rel), "utf-8");

describe("planEditRewind", () => {
  it("找不到事件 / 目标不是用户消息 → null（不该给这条出编辑入口）", () => {
    const events = [ev("user_reply", "a"), ev("assistant_message", "b")];
    expect(planEditRewind({ events, eventId: "nope", runActive: false })).toBeNull();
    expect(
      planEditRewind({ events, eventId: events[1]!.id, runActive: false }),
    ).toBeNull();
  });

  it("刚发的最后一句、没有检查点、没在跑：不弹确认、不停、删的是它和 AI 对它的回复", () => {
    const events = [
      ev("user_reply", "一"),
      ev("assistant_message", "答一"),
      ev("user_reply", "二"),
      ev("thinking", "想"),
      ev("assistant_message", "答二"),
    ];
    const plan = planEditRewind({ events, eventId: events[2]!.id, runActive: false })!;
    expect(plan).toEqual({
      eventId: events[2]!.id,
      restoresFiles: false,
      laterUserTurns: 0,
      removedEventCount: 3,
      needsStop: false,
      needsConfirm: false,
    });
  });

  it("改更早的一句（之后还有别的轮次）：弹确认，laterUserTurns 数的是之后的用户消息", () => {
    const events = [
      ev("user_reply", "一"),
      ev("assistant_message", "答一"),
      ev("user_reply", "二"),
      ev("assistant_message", "答二"),
      ev("user_reply", "三"),
      ev("assistant_message", "答三"),
    ];
    const plan = planEditRewind({ events, eventId: events[0]!.id, runActive: false })!;
    expect(plan.laterUserTurns).toBe(2);
    expect(plan.removedEventCount).toBe(6);
    expect(plan.needsConfirm).toBe(true);
    expect(plan.restoresFiles).toBe(false);
  });

  it("消息带文件检查点：会还原文件 → 即使是最后一句也要确认", () => {
    const events = [
      ev("user_reply", "改代码", { checkpointed: true }),
      ev("assistant_message", "改好了"),
    ];
    const plan = planEditRewind({ events, eventId: events[0]!.id, runActive: false })!;
    expect(plan.restoresFiles).toBe(true);
    expect(plan.laterUserTurns).toBe(0);
    expect(plan.needsConfirm).toBe(true);
  });

  it("checkpointed 不是严格 true（false / 字符串）不算有检查点", () => {
    for (const checkpointed of [false, "true", 1, undefined]) {
      const events = [
        ev("user_reply", "x", checkpointed === undefined ? undefined : { checkpointed }),
      ];
      expect(
        planEditRewind({ events, eventId: events[0]!.id, runActive: false })!
          .restoresFiles,
      ).toBe(false);
    }
  });

  it("正在跑：要先停；单是在跑不弹确认（改刚发的那句、没检查点）", () => {
    const events = [ev("user_reply", "x"), ev("thinking", "…")];
    const plan = planEditRewind({ events, eventId: events[0]!.id, runActive: true })!;
    expect(plan.needsStop).toBe(true);
    expect(plan.needsConfirm).toBe(false);
  });

  it("其它种类的事件不算「之后的用户消息」（ask 回答 / info 等）", () => {
    const events = [
      ev("user_reply", "x"),
      ev("ask_user_reply", "选 A"),
      ev("info", "i"),
    ];
    expect(
      planEditRewind({ events, eventId: events[0]!.id, runActive: false })!
        .laterUserTurns,
    ).toBe(0);
  });
});

describe("editRewindConfirmCopy", () => {
  const base = {
    eventId: "e",
    restoresFiles: false,
    laterUserTurns: 0,
    removedEventCount: 1,
    needsStop: false,
    needsConfirm: true,
  };

  it("会还原文件：说清覆盖未提交改动 / 暂存区无法恢复 / 之后有几轮", () => {
    const c = editRewindConfirmCopy(
      { ...base, restoresFiles: true, laterUserTurns: 2 },
      { repoBound: true },
    );
    expect(c.description).toContain("恢复文件");
    expect(c.description).toContain("未提交的改动会被覆盖");
    expect(c.description).toContain("暂存区");
    expect(c.description).toContain("其后还有 2 轮");
    expect(c.confirmLabel).toBe("编辑并重发");
  });

  it("只回退对话：写明删几轮；绑了仓才补一句「文件不会被还原」", () => {
    const withRepo = editRewindConfirmCopy(
      { ...base, laterUserTurns: 3 },
      { repoBound: true },
    );
    expect(withRepo.description).toContain("3 轮对话会被删除");
    expect(withRepo.description).toContain("文件不会被还原");
    const noRepo = editRewindConfirmCopy(
      { ...base, laterUserTurns: 3 },
      { repoBound: false },
    );
    expect(noRepo.description).toContain("3 轮对话会被删除");
    expect(noRepo.description).not.toContain("文件");
  });

  it("正在跑：提醒会先停掉当前回复", () => {
    const c = editRewindConfirmCopy(
      { ...base, laterUserTurns: 1, needsStop: true },
      { repoBound: false },
    );
    expect(c.description).toContain("先被停止");
  });
});

describe("接线契约", () => {
  it("rows：传了 onEditInPlace → 编辑入口走它、文案说明会替换；没传 → 退回旧「编辑后重发（原消息保留）」", async () => {
    const src = await read("src/components/tasks/event-stream/rows.tsx");
    expect(src).toMatch(/const editHandler = onEditInPlace \?\? onResend;/);
    // 编辑态与「发送」都以 editHandler 为准（不是只认 onResend）
    expect(src).toMatch(/if \(editing && editHandler\) \{/);
    expect(src).toMatch(/const ok = await runEdit\(trimmed, ev\);/);
    // （定时触发的消息不是用户说的话，另加 `!isScheduleMsg &&` 不给编辑 / 重发——见 schedule-wiring-contract）
    expect(src).toMatch(/editHandler &&\s*(?:!isScheduleMsg &&\s*)?\{\s*key: "edit"/);
    expect(src).toContain("编辑（之后的对话会被替换）");
    expect(src).toContain("编辑后重发（原消息保留）");
    // 「原样重发」仍只认 onResend（只有最后一条）
    expect(src).toMatch(/onResend &&\s*(?:!isScheduleMsg &&\s*)?\{\s*key: "resend"/);
  });

  it("event-stream：onEditInPlace 只在 chat + 能发消息 + 接了 onEditRewind 时给，且不再限制最后一条", async () => {
    const src = await read("src/components/tasks/event-stream.tsx");
    expect(src).toMatch(
      /onEditInPlace=\{\s*isChat && canCompose && onEditRewind\s*\?\s*handleEditInPlace\s*:\s*undefined\s*\}/,
    );
    // 旧的「重发」入口仍只给最后一条
    expect(src).toMatch(/isChat && canCompose && item\.id === lastUserReplyId/);
  });

  it("event-stream.handleEditInPlace 的顺序：先回读图 → 回退 → 让一拍 → 发新消息；失败放回输入框", async () => {
    const src = await read("src/components/tasks/event-stream.tsx");
    const start = src.indexOf("const handleEditInPlace = useCallback(");
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start, src.indexOf("// 最后一条用户消息：重发入口挂它", start));
    const iPayload = body.indexOf("await buildResendPayload(");
    const iRewind = body.indexOf("await onEditRewind(sourceEv)");
    const iYield = body.indexOf("setTimeout(r, 50)");
    const iSend = body.indexOf("onUserReplyRef.current?.(");
    expect(iPayload).toBeGreaterThan(0);
    expect(iRewind).toBeGreaterThan(iPayload); // 回退会删事件：图要在删之前取
    expect(iYield).toBeGreaterThan(iRewind);
    expect(iSend).toBeGreaterThan(iYield);
    // 发的是编辑后的文本，不是原文
    expect(body).toMatch(/\.\.\.sourceEv,\s*text,/);
    expect(body).toMatch(/onUserReplyRef\.current\?\.\(\s*text,/);
    // 回退没成功不发
    expect(body).toMatch(/if \(rewound !== "ok"\) return false;/);
    // 发送失败：文字放回输入框（旧消息已经被删）
    expect(body).toMatch(/if \(sent === false\) \{[\s\S]*setDraft\(/);
    // 同一把锁防连点
    expect(body).toContain("resendLockRef");
  });

  it("chat-view.handleEditRewind：会丢东西才确认 → 在跑先停 → mode:edit 回退（409 短重试）→ 应用回退标记与新 task", async () => {
    const src = await read("src/components/tasks/chat-view.tsx");
    const start = src.indexOf("const handleEditRewind = useCallback(");
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start, src.indexOf("// C：待发送气泡直改", start));
    const iPlan = body.indexOf("planEditRewind(");
    const iConfirm = body.indexOf("await confirm(");
    const iStop = body.indexOf("await stopAgentCore()");
    const iRewind = body.indexOf("rewindChatToEvent(");
    expect(iPlan).toBeGreaterThan(0);
    expect(iConfirm).toBeGreaterThan(iPlan);
    expect(iStop).toBeGreaterThan(iConfirm); // 确认之前不能先把当前回复停了
    expect(iRewind).toBeGreaterThan(iStop);
    expect(body).toMatch(/if \(plan\.needsConfirm\) \{/);
    expect(body).toMatch(/if \(plan\.needsStop && !\(await stopAgentCore\(\)\)\) return "failed";/);
    expect(body).toMatch(/mode: "edit"/);
    expect(body).toMatch(/err\.status === 409/);
    expect(body).toMatch(/onRewoundRef\.current\?\.\(result\.rewound\)/);
    expect(body).toMatch(/onTaskUpdateRef\.current\(result\.task\)/);
    // 取消 / 失败都不让上层继续发送
    expect(body).toContain('return "cancelled"');
    expect(body).toContain('return "failed"');
    // 稳定回调：读 ref 里的最新 task，不把 task 放进依赖
    expect(body).toContain("latestTaskRef.current");
    expect(body).toMatch(/\[confirm, stopAgentCore\]/);
    // 接到 EventStream
    expect(src).toMatch(/onEditRewind=\{handleEditRewind\}/);
  });

  it("task-store：rewindChatToEvent 带 mode 才把它写进请求体；缺省体不变", async () => {
    const src = await read("src/lib/task-store.ts");
    expect(src).toMatch(
      /opts\?\.mode \? \{ eventId, mode: opts\.mode \} : \{ eventId \}/,
    );
  });
});
