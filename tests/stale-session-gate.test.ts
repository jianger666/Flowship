/**
 * 过期会话闸（第十八轮；第十六轮评审 P3-T2 / P3-C3 的收口，用户授权「都按你推荐的来」）
 *
 * 背景：群非属主轮的标记只按 taskId 存、不认「是哪个会话的 run」。被强清（task 的 forceClearStaleRunnerState / chat 的 forceClearChatRun）放弃、
 * 但 cancel 卡住没真停的旧 run，在属主新启动清掉标记（task）/ chat 摘表当场按名清掉标记之后，就不再受标记限制——
 * 而咽喉里的两道标记闸（白名单硬拒、desktop / 恒拒清单）都只看标记。callerToken 表（chat-pending 的 expectedCallerTokens）是 task / chat / 一次性问答共用的一张**单槽**表，
 * 「标记没了的那一刻旧 run 的 token 已对不上」在各路径上靠的**不是同一件事**（第十九轮评审 R19-6 订正）：task 的 internalStartAgent 与一次性问答先装后继 token、再清标记；
 * task 的属主 send 起点先清标记，靠强清当场同步作废旧 token（R19-3）兜住；chat 靠 closeChatSession 同一个同步段里摘表 + 清标记 + 摘 token。
 * 咽喉在标记闸**之后**补一道：标记会拒的那几类调用（desktop_* 除收尾、`groupOpenTurnToolDenied` 命中的几个），调用方 token 不是该任务当前会话的就拒（`isStaleSessionRestrictedCall`）。
 * 闸只圈这几类——圈外的（`browser_navigate` / `click` / `type` / `upload` 等，handler 自己不核对 token）旧 run 在标记没了之后仍不受限（第二十轮评审 R20-7：已定、写明、不扩圈）。
 *
 * 钉死：
 *  1. 圈哪些调用（纯函数）：desktop_*（除精确名字的收尾）与恒拒清单命中的；不圈同权轮本来就放行的（browser_navigate / wait / submit_work…）；
 *  2. 咽喉行为：当前会话 token → 放行进 handler；被接管 / 已停止（invalidateCallerToken）/ 会话已关 / 从没登记 → CALLER_MISMATCH_ERROR + isError、handler 一次都没调
 *     （拒绝形状跟 handler 自己核对失败时一致：advance_next / set_owner_note 是 JSON { ok:false, error }，其余纯文本——用真 handler 对账）；
 *     收尾 desktop_end_session 对过期会话也放行；没有 ctx.taskId 不在管辖内；只认 ctx.taskId（模型填的 task_id 绕不过）；标记还在时仍走原来的拒绝文案（闸在标记闸之后）；
 *  3. 两个故事（task 强清 / chat 强清 restart）：标记没了之后旧 run 仍被拒、后继放行；覆盖语义（T4：all → desktop 被覆盖）下旧 run 同样拒；
 *  4. 源码结构：闸在两道标记闸**之后**、handler **之前**；chat 的 closeChatSession 摘表时同步摘掉 token（C3 的前提）。
 * 真链路（真 runner + 假 SDK）的对应用例在 task-forceclear-keeps-marker.test.ts（T2）与 chat-runner-foreign-marker-cleanup.test.ts（C3）。
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { blockAfter, maskLiterals, readSource, stripComments } from "./helpers/source-text";

const { flowShipTools, invokeFlowshipTool, isStaleSessionRestrictedCall } = await import("@/lib/server/flowship-tools");
const {
  CALLER_MISMATCH_ERROR,
  clearOneShotCallerTokenIf,
  getExpectedCallerToken,
  invalidateCallerToken,
  setChatAwaitingNotifier,
  setOneShotCallerToken,
} = await import("@/lib/server/chat-pending");
const { DESKTOP_NON_OWNER_DENIED, DESKTOP_TOOL_NAMES } = await import("@/lib/server/desktop/tools");
const guard = await import("@/lib/server/non-owner-turn-guard");

const TASK = "t_stale_gate";
const OTHER = "t_stale_gate_other";

const mkTool = (name: string) => {
  const handler = vi.fn(async () => ({ content: [{ type: "text" as const, text: `HANDLED:${name}` }] }));
  return { tool: { name, label: name, description: "", parameters: {} as never, handler } as never, handler };
};
const textOf = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? "").join("");
/**
 * 闸拒绝时的文本：`advance_next` / `set_owner_note` 的 handler 自己核对 token 失败时回的是 JSON `{ ok:false, error }`（工具描述里写给模型的契约），
 * 闸站在 handler 前面，形状要跟它一致；其余被圈的（desktop_* / browser_* / create_custom_action / schedule）纯文本。
 */
const JSON_FAILURE_TOOLS = new Set(["advance_next", "set_owner_note"]);
const mismatchText = (name: string): string =>
  JSON_FAILURE_TOOLS.has(name) ? JSON.stringify({ ok: false, error: CALLER_MISMATCH_ERROR }) : CALLER_MISMATCH_ERROR;
/** taskId 传 null = 没有 ctx.taskId（注意不能传 undefined：会命中参数默认值） */
const call = (tool: never, args: Record<string, unknown>, token: string | undefined, taskId: string | null = TASK) =>
  invokeFlowshipTool(tool, args, token, (taskId ? { taskId } : {}) as never);

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  guard.__resetNonOwnerTurnGuardForTest();
  for (const t of [TASK, OTHER]) invalidateCallerToken(t);
});

/** 标记会拒、闸要圈进来的调用（名字 + 入参）：每一类都要有 */
const RESTRICTED: Array<[string, Record<string, unknown>]> = [
  ["desktop_screenshot", {}],
  ["desktop_click", { x: 1, y: 2 }],
  ["desktop_some_future_op", {}], // 按前缀、失败即关闭：以后新增的 desktop_* 默认也圈
  ["set_owner_note", { content: "x" }],
  ["schedule", { action: "create" }],
  ["advance_next", {}],
  ["create_custom_action", { label: "x", skill: "y" }],
  ["browser_storage", { action: "cookies_list" }],
  ["browser_evaluate", { expression: "1+1" }],
  ["browser_network", { include_body: true, request_id: 1 }],
  ["browser_debug", { action: "scope" }],
  ["browser_perf", { action: "heap_snapshot" }],
  ["browser_network_rules", { action: "mock" }],
  ["browser_permissions", { action: "grant" }],
];

/** 同权轮本来就放行的、不在闸管辖内的调用 */
const NOT_RESTRICTED: Array<[string, Record<string, unknown>]> = [
  ["desktop_end_session", {}], // 收尾：只会把电脑锁回去
  ["browser_navigate", { url: "https://example.com" }],
  ["browser_click", { ref: "e1" }],
  ["browser_snapshot", {}],
  ["browser_network", { action: "list" }], // 不读 body
  ["browser_debug", { action: "list_breakpoints" }],
  ["browser_perf", { action: "metrics" }],
  ["browser_network_rules", { action: "block" }],
  ["browser_permissions", { action: "list" }],
  ["schedule", { action: "list" }],
  ["schedule", { action: "cancel", id: "sch_x" }],
  ["wait", { seconds: 1 }],
  ["submit_work", {}],
  ["ask_user", {}],
  ["subagent", {}],
];

describe("isStaleSessionRestrictedCall：圈哪些调用", () => {
  it("标记会拒的都圈进来（每一类、含未来的 desktop_*）", () => {
    for (const [name, args] of RESTRICTED) expect(isStaleSessionRestrictedCall(name, args), `${name} ${JSON.stringify(args)}`).toBe(true);
    for (const n of DESKTOP_TOOL_NAMES) {
      expect(isStaleSessionRestrictedCall(n, {}), n).toBe(n !== "desktop_end_session");
    }
  });

  it("同权轮本来就放行的不圈（收尾 desktop_end_session、普通浏览器操作、schedule 的 list / cancel、wait / 交卷 / 提问 / 子代理）", () => {
    for (const [name, args] of NOT_RESTRICTED) expect(isStaleSessionRestrictedCall(name, args), `${name} ${JSON.stringify(args)}`).toBe(false);
  });

  it("收尾只认精确名字（名字稍有出入的 desktop_* 照圈）；工具名来自模型，原型上的名字不命中", () => {
    for (const n of ["desktop_end_session_now", "desktop_end", "desktop_end_session2", "desktop_end_session "]) {
      expect(isStaleSessionRestrictedCall(n, {}), n).toBe(true);
    }
    for (const n of ["valueOf", "constructor", "__proto__", "toString", "hasOwnProperty", ""]) {
      expect(isStaleSessionRestrictedCall(n, {}), n).toBe(false);
    }
    expect(isStaleSessionRestrictedCall("schedule", undefined)).toBe(false); // args 缺失不炸
  });
});

describe("invokeFlowshipTool 咽喉：调用方 token 必须是该任务当前会话的", () => {
  it("当前会话 token：被圈的每一类都放行进 handler", async () => {
    setOneShotCallerToken(TASK, "A");
    for (const [name, args] of RESTRICTED) {
      const t = mkTool(name);
      expect(textOf(await call(t.tool, args, "A")), name).toBe(`HANDLED:${name}`);
      expect(t.handler, name).toHaveBeenCalledTimes(1);
    }
  });

  it("被新 agent 接管（后继换了 token）：旧 token 被圈的每一类都拒——CALLER_MISMATCH_ERROR + isError，handler 一次都没调；后继照常放行", async () => {
    setOneShotCallerToken(TASK, "A");
    setOneShotCallerToken(TASK, "B"); // 后继装好自己的 token
    for (const [name, args] of RESTRICTED) {
      const stale = mkTool(name);
      const r = await call(stale.tool, args, "A");
      expect(textOf(r), name).toBe(mismatchText(name));
      expect(textOf(r), name).toContain(CALLER_MISMATCH_ERROR);
      expect(r.isError, name).toBe(true);
      expect(stale.handler, name).not.toHaveBeenCalled();
      const fresh = mkTool(name);
      expect(textOf(await call(fresh.tool, args, "B")), name).toBe(`HANDLED:${name}`);
    }
  });

  it("已停止（invalidateCallerToken）/ 会话已关（token 被摘）/ 从没登记：都拒", async () => {
    const t = mkTool("desktop_click");
    // 从没登记
    expect(textOf(await call(t.tool, {}, "A"))).toBe(CALLER_MISMATCH_ERROR);
    // 登记过、被 stop 摘了
    setOneShotCallerToken(TASK, "A");
    expect(textOf(await call(t.tool, {}, "A"))).toBe("HANDLED:desktop_click");
    invalidateCallerToken(TASK);
    expect(textOf(await call(t.tool, {}, "A"))).toBe(CALLER_MISMATCH_ERROR);
    // 一次性 agent 收尾摘自己的 token
    setOneShotCallerToken(TASK, "A");
    expect(clearOneShotCallerTokenIf(TASK, "A")).toBe(true);
    expect(textOf(await call(t.tool, {}, "A"))).toBe(CALLER_MISMATCH_ERROR);
    expect(t.handler).toHaveBeenCalledTimes(1);
  });

  it("token 缺失（undefined / 空串）fail-closed：即使该任务有登记的 token 也拒", async () => {
    setOneShotCallerToken(TASK, "A");
    for (const tok of [undefined, ""]) {
      const t = mkTool("browser_evaluate");
      expect(textOf(await call(t.tool, { expression: "1" }, tok)), String(tok)).toBe(CALLER_MISMATCH_ERROR);
      expect(t.handler).not.toHaveBeenCalled();
    }
  });

  it("拒绝的形状跟 handler 自己核对 token 失败时一致（用真 handler 对账——闸站在 handler 前面，不能换掉写给模型的契约）：advance_next / set_owner_note 是 JSON { ok:false, error }，schedule 纯文本", async () => {
    // 没登记 token：三个 handler 自己核对都会拒；直接调 handler（绕过咽喉）拿到它们自己的拒绝，再和经过咽喉的对比
    const cases: Array<[string, Record<string, unknown>]> = [
      ["advance_next", { task_id: TASK, action: "plan" }],
      ["set_owner_note", { task_id: TASK, content: "x" }],
      ["schedule", { task_id: TASK, action: "create", title: "x", message: "y", delay_minutes: 30 }],
    ];
    for (const [name, args] of cases) {
      const def = flowShipTools.find((t) => t.name === name);
      expect(def, `${name} 的真定义`).toBeDefined();
      const direct = await def!.handler(args, "A", { taskId: TASK } as never);
      const viaGate = await invokeFlowshipTool(def!, args, "A", { taskId: TASK } as never);
      expect(textOf(direct), `${name} handler 自己的拒绝`).toBe(mismatchText(name));
      expect(textOf(viaGate), `${name} 经过咽喉的拒绝与 handler 自己的逐字一致`).toBe(textOf(direct));
      expect(viaGate.isError, name).toBe(true);
    }
    // JSON 形状的那两个：解析得出、ok 为 false、error 是那句固定文案
    for (const name of JSON_FAILURE_TOOLS) {
      const def = flowShipTools.find((t) => t.name === name)!;
      const r = await invokeFlowshipTool(def, { task_id: TASK, action: "plan", content: "x" }, "A", { taskId: TASK } as never);
      expect(JSON.parse(textOf(r)), name).toEqual({ ok: false, error: CALLER_MISMATCH_ERROR });
    }
    // 其余被圈的（没有「handler 自己的契约」可对）：纯文本、不是 JSON
    for (const name of ["desktop_click", "browser_evaluate", "create_custom_action"]) {
      const t = mkTool(name);
      const text = textOf(await call(t.tool, name === "browser_evaluate" ? { expression: "1" } : { label: "x", skill: "y" }, "A"));
      expect(text, name).toBe(CALLER_MISMATCH_ERROR);
      expect(() => JSON.parse(text), name).toThrow();
    }
  });

  it("R20-9：闸的拒绝回包，对每个被圈的**自有**工具，光凭文本（把 isError 拿掉）就被 resolveToolResultStatus 认成失败——展示层不能只靠 isError 这一位", async () => {
    const { isFlowshipOwnToolName, resolveToolResultStatus } = await import("@/lib/server/tool-result-persist");
    let checked = 0;
    for (const [name, args] of RESTRICTED) {
      if (!isFlowshipOwnToolName(name)) continue; // desktop_* / browser_*：它们的失败位走 value.isError，由 isMcpToolName / isBrowserToolName / isDesktopToolName 认
      const r = await call(mkTool(name).tool, args, "stale-token");
      expect(r.isError, `${name} 的拒绝本就带 isError`).toBe(true);
      const textOnly = { content: r.content }; // 去掉 isError：模拟只剩文本的信封
      expect(resolveToolResultStatus("completed", name, textOnly), `${name}（pi 形状，只看文本）`).toBe("error");
      expect(
        resolveToolResultStatus("completed", `mcp:custom-user-tools:${name}`, {
          status: "success",
          value: { content: r.content.map((c) => ({ text: { text: (c as { text: string }).text } })) },
        }),
        `${name}（Cursor MCP 形状，只看文本）`,
      ).toBe("error");
      checked++;
    }
    // 防空转：RESTRICTED 里的自有工具（set_owner_note / schedule / advance_next / create_custom_action）一个都不能漏
    expect(checked, "被圈的自有工具数").toBe(4);
  });

  it("收尾 desktop_end_session 对过期会话也放行（它只会把电脑锁回去）；同权轮本来就放行的浏览器操作 / wait / 交卷也不受这道闸影响", async () => {
    setOneShotCallerToken(TASK, "B"); // A 已是过期会话
    for (const [name, args] of NOT_RESTRICTED) {
      const t = mkTool(name);
      expect(textOf(await call(t.tool, args, "A")), name).toBe(`HANDLED:${name}`);
    }
  });

  it("只认 ctx.taskId：别的任务的 token 借不来，模型把 task_id 填成别的任务也绕不过；没有 ctx.taskId 的调用不在管辖内", async () => {
    setOneShotCallerToken(TASK, "A");
    setOneShotCallerToken(OTHER, "X");
    // 拿别的任务的 token 调本任务：拒
    const a = mkTool("desktop_click");
    expect(textOf(await call(a.tool, {}, "X", TASK))).toBe(CALLER_MISMATCH_ERROR);
    // 入参里 task_id 填成别的任务：核对的仍是 ctx.taskId（本任务）
    const b = mkTool("browser_evaluate");
    expect(textOf(await call(b.tool, { task_id: OTHER, expression: "1" }, "X", TASK))).toBe(CALLER_MISMATCH_ERROR);
    // 没有 ctx.taskId：闸不判（桌面工具本身没 taskId 会在 run() 里报错），交给 handler
    const c = mkTool("desktop_click");
    expect(textOf(await call(c.tool, {}, "whatever", null))).toBe("HANDLED:desktop_click");
  });

  it("标记还在时仍走原来的拒绝文案（闸在标记闸之后）：同权轮的 desktop_* 回 DESKTOP_NON_OWNER_DENIED，不是 mismatch；「只答疑」轮回通用拒绝", async () => {
    // 过期会话 + 标记在：标记闸先拒
    guard.beginNonOwnerTurn(TASK, Date.now(), "desktop");
    const d = mkTool("desktop_click");
    expect(textOf(await call(d.tool, {}, "stale"))).toBe(DESKTOP_NON_OWNER_DENIED);
    const e = mkTool("browser_storage");
    expect(textOf(await call(e.tool, { action: "cookies_list" }, "stale"))).toMatch(/^\[DENIED\] 本轮由群里的非任务所有者触发，系统禁止调用 browser_storage/);
    guard.beginNonOwnerTurn(TASK); // 覆盖成 scope=all
    const f = mkTool("desktop_click");
    expect(textOf(await call(f.tool, {}, "stale"))).toMatch(/^\[DENIED\]/);
    expect(textOf(await call(f.tool, {}, "stale"))).not.toBe(CALLER_MISMATCH_ERROR);
    expect(d.handler).not.toHaveBeenCalled();
    expect(e.handler).not.toHaveBeenCalled();
    expect(f.handler).not.toHaveBeenCalled();
  });
});

describe("故事：标记没了之后，被放弃的旧 run 仍被拒（T2 / C3 / T4）", () => {
  it("T2 · task 强清：旧 run（token A）被强清放弃但没停；强清不碰标记、但同步作废旧 token；后继装好 token B、属主新启动清掉标记——此后旧 run 的 desktop_* / 恒拒清单被拒，后继放行", async () => {
    setOneShotCallerToken(TASK, "A");
    guard.beginNonOwnerTurn(TASK, Date.now(), "desktop"); // A 是外来内容驱动的一轮
    // 强清（第十九轮 R19-3 起）：不碰标记，但同步作废旧 token（forceClearStaleRunnerState → invalidateCallerToken）——这里手工模拟这两件事的账本；
    // 真强清函数的链路（含「强清之后、后继 Agent.create 之前旧 run 已被拒」）在 task-forceclear-keeps-marker.test.ts
    invalidateCallerToken(TASK);
    expect(getExpectedCallerToken(TASK), "强清当场作废旧 token：此刻表里没有任何合法会话（fail-closed）").toBeNull();
    expect(guard.isGroupNonOwnerTurnActive(TASK), "强清不碰标记").toBe(true);
    // 后继起来：token 先装（installSessionIfCurrent）、再属主新启动清标记（internalStartAgent，send 之前）
    setOneShotCallerToken(TASK, "B");
    guard.clearNonOwnerTurn(TASK);
    expect(guard.isGroupNonOwnerTurnActive(TASK), "前置：标记确实没了——此刻旧 run 不再被标记限制").toBe(false);

    for (const [name, args] of RESTRICTED) {
      const stale = mkTool(name);
      expect(textOf(await call(stale.tool, args, "A")), `旧 run 调 ${name}`).toBe(mismatchText(name));
      expect(stale.handler, name).not.toHaveBeenCalled();
      const fresh = mkTool(name);
      expect(textOf(await call(fresh.tool, args, "B")), `后继调 ${name}`).toBe(`HANDLED:${name}`);
    }
  });

  it("C3 · chat 强清（restart 摘表）：closeChatSession 同一个同步段里清 midRun 标记 + 摘 token（chat 没有 task action handler，notifier 一摘 token 就没了）——旧 run 被拒，新会话装好 token 后放行", async () => {
    setChatAwaitingNotifier(TASK, async () => "accepted" as const, "A"); // registerChatNotifier 同款登记
    expect(getExpectedCallerToken(TASK)).toBe("A");
    expect(guard.beginForeignContentMidRun(TASK), "前置：别人的内容送进这一轮、新建 midRun 标记").toBeDefined();
    // closeChatSession(reason=restart) 的摘表段：endMidRunForeignContent + setChatAwaitingNotifier(taskId, null)
    guard.endMidRunForeignContent(TASK);
    setChatAwaitingNotifier(TASK, null);
    expect(guard.isGroupNonOwnerTurnActive(TASK), "前置：标记确实没了").toBe(false);
    expect(getExpectedCallerToken(TASK), "摘表后旧 token 不在了").toBeNull();

    const stale = mkTool("desktop_screenshot");
    expect(textOf(await call(stale.tool, {}, "A")), "摘表之后、新会话起来之前，旧 run 的电脑操作").toBe(CALLER_MISMATCH_ERROR);
    // 新会话起来（registerChatNotifier 装新 token）
    setChatAwaitingNotifier(TASK, async () => "accepted" as const, "B");
    const stale2 = mkTool("desktop_screenshot");
    expect(textOf(await call(stale2.tool, {}, "A")), "新会话起来之后旧 run 仍被拒").toBe(CALLER_MISMATCH_ERROR);
    const fresh = mkTool("desktop_screenshot");
    expect(textOf(await call(fresh.tool, {}, "B"))).toBe("HANDLED:desktop_screenshot");
    expect(stale.handler).not.toHaveBeenCalled();
    expect(stale2.handler).not.toHaveBeenCalled();
  });

  it("T4 · 覆盖语义（决定：保持覆盖、不取严）：强清留下的 all 标记被后继的外来唤醒覆盖成 desktop——旧 run 的 desktop_* / 恒拒清单靠 token 仍被拒；后继（同权轮）照常能用同权工具", async () => {
    setOneShotCallerToken(TASK, "A");
    guard.beginNonOwnerTurn(TASK); // 旧 run：scope=all（只答疑）
    setOneShotCallerToken(TASK, "B"); // 后继装 token
    guard.beginNonOwnerTurn(TASK, Date.now(), "desktop"); // 外来唤醒缺省 scope=desktop：覆盖
    expect(guard.isNonOwnerTurnActive(TASK), "前置：覆盖后不再是系统工具整体硬拒（这就是 T4 说的降级）").toBe(false);
    expect(guard.isGroupNonOwnerTurnActive(TASK)).toBe(true);

    // 旧 run：标记现在是 desktop 范围，desktop_* 被标记闸拒（文案是标记那条）；恒拒清单同理；其余被 token 拒
    const shot = mkTool("desktop_screenshot");
    expect(textOf(await call(shot.tool, {}, "A"))).toBe(DESKTOP_NON_OWNER_DENIED);
    const ev = mkTool("browser_evaluate");
    expect(textOf(await call(ev.tool, { expression: "1" }, "A"))).toMatch(/^\[DENIED\]/);
    expect(shot.handler).not.toHaveBeenCalled();
    expect(ev.handler).not.toHaveBeenCalled();

    // 标记随后被清（后继收尾 / 属主新启动）：旧 run 失去标记，但 token 仍对不上
    guard.clearNonOwnerTurn(TASK);
    const shot2 = mkTool("desktop_screenshot");
    expect(textOf(await call(shot2.tool, {}, "A"))).toBe(CALLER_MISMATCH_ERROR);
    const sw = mkTool("submit_work");
    expect(textOf(await call(sw.tool, {}, "B"))).toBe("HANDLED:submit_work");
  });
});

describe("源码结构（接线）", () => {
  const src = readSource("src/lib/server/flowship-tools.ts");
  const body = blockAfter(src, "export const invokeFlowshipTool = async (");

  it("咽喉里：过期会话闸在两道标记闸之后、handler 之前，且核对的是 ctx.taskId + callerToken", () => {
    const markerGate1 = body.indexOf("NON_OWNER_TURN_ALLOWED_TOOLS.includes(tool.name)");
    const markerGate2 = body.indexOf("isGroupNonOwnerTurnActive(ctx?.taskId)");
    const desktopGate = body.indexOf("desktopDeniedInNonOwnerTurn(tool.name, ctx?.taskId)");
    const staleGate = body.indexOf("isStaleSessionRestrictedCall(tool.name, args)");
    const handlerCall = body.indexOf("return tool.handler(args, callerToken, ctx)");
    expect(markerGate1).toBeGreaterThan(-1);
    expect(markerGate2).toBeGreaterThan(-1);
    expect(desktopGate).toBeGreaterThan(-1);
    expect(staleGate, "没找到过期会话闸").toBeGreaterThan(-1);
    expect(handlerCall).toBeGreaterThan(-1);
    expect(staleGate, "闸要在标记闸之后（标记还在时走原来的拒绝文案）").toBeGreaterThan(Math.max(markerGate1, markerGate2, desktopGate));
    expect(staleGate, "闸要在 handler 之前").toBeLessThan(handlerCall);
    const gate = body.slice(body.lastIndexOf("if (", staleGate), handlerCall);
    expect(gate).toMatch(/ctx\?\.taskId/);
    expect(gate).toMatch(/!matchExpectedCallerToken\(ctx\.taskId,\s*callerToken\)/);
    expect(gate).toMatch(/return staleSessionDenial\(tool\.name\)/);
  });

  it("拒绝形状统一由 staleSessionDenial 出：advance_next / set_owner_note → JSON { ok:false, error }，其余纯文本，一律走 denial（带 isError）", () => {
    const at = src.indexOf("const staleSessionDenial = (toolName: string): FlowshipToolResult =>");
    expect(at, "没找到 staleSessionDenial").toBeGreaterThan(-1);
    const helper = src.slice(at, src.indexOf(");\n", at) + 3);
    expect(helper).toMatch(/denial\(/);
    expect(helper).toMatch(/toolName === ADVANCE_NEXT_TOOL_NAME \|\| toolName === OWNER_NOTE_TOOL_NAME/);
    expect(helper).toMatch(/JSON\.stringify\(\{ ok: false, error: CALLER_MISMATCH_ERROR \}\)/);
    expect(helper).toMatch(/: CALLER_MISMATCH_ERROR/);
  });

  it("chat 的 closeChatSession 摘表时同步摘 notifier（= 摘 token，C3 的前提）：不挂在 reason 条件下，且在 agent.close() 之前", () => {
    const chat = readSource("src/lib/server/chat-runner.ts");
    // 函数声明带参数类型块（blockAfter 会先取到那个），所以按「声明起点 → 第一个顶格的 `};`」切函数全文（函数体里的行都有缩进）
    const start = chat.indexOf("const closeChatSession = (");
    expect(start, "没找到 closeChatSession 声明").toBeGreaterThan(-1);
    const end = chat.indexOf("\n};", start);
    expect(end).toBeGreaterThan(start);
    const fn = chat.slice(start, end);
    const removeToken = fn.indexOf("setChatAwaitingNotifier(taskId, null)");
    const agentClose = fn.indexOf("rec.agent.close()");
    expect(removeToken, "closeChatSession 里没有摘 notifier（旧 token 会留在表里，旧 run 的电脑操作被闸放行）").toBeGreaterThan(-1);
    expect(agentClose).toBeGreaterThan(removeToken);
    // 不能挂在某个 if 的块里（只在特定 reason 下摘）：摘 notifier 那一行所在行的缩进应与函数体顶层一致（两格）
    const lineStart = fn.lastIndexOf("\n", removeToken) + 1;
    expect(fn.slice(lineStart, removeToken)).toBe("  ");
  });
});

// =====================================================================
// 第十九轮评审补的钉子（R19-1 / R19-6 / R19-7 / R19-10）
// =====================================================================

const ROOT = path.resolve(import.meta.dirname, "..");

/** 递归列出目录下满足条件的文件（相对仓库根的路径、正斜杠） */
const listFiles = (dir: string, keep: (rel: string) => boolean): string[] => {
  const out: string[] = [];
  const walk = (abs: string): void => {
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      const p = path.join(abs, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === "node_modules" || ent.name === ".next") continue;
        walk(p);
      } else {
        const rel = path.relative(ROOT, p).split(path.sep).join("/");
        if (keep(rel)) out.push(rel);
      }
    }
  };
  walk(path.join(ROOT, dir));
  return out.sort();
};

/** 「静态上就不是一个真 token」的字面量：`undefined` / `void 0` / `null` / 空串（`""` `''` ``` `` ```） */
const NO_TOKEN_LITERAL = /^(?:undefined|void\s*\(?\s*0\s*\)?|null|""|''|``)$/;

/** 实参里剥掉类型断言 / 括号 / 非空断言：`(undefined as never)`、`undefined as unknown as string`、`<never>undefined`、`null!` 都还原成里面的字面量 */
const unwrapArg = (arg: string): string => {
  /** 第一个字符的 `(` 正好和最后一个字符的 `)` 配对（`(a)(b)` 不算整体被括号包着） */
  const wrapped = (s: string): boolean => {
    if (!s.startsWith("(") || !s.endsWith(")")) return false;
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "(") depth++;
      else if (s[i] === ")" && --depth === 0) return i === s.length - 1;
    }
    return false;
  };
  let a = arg.trim();
  for (let round = 0; round < 20; round++) {
    const before = a;
    if (wrapped(a)) a = a.slice(1, -1).trim();
    a = a
      .replace(/^<[^<>]*>\s*/, "")
      .replace(/\s+(?:as|satisfies)\s+[\s\S]*$/, "")
      .replace(/!+$/, "")
      .trim();
    if (a === before) break;
  }
  return a;
};

/**
 * 同一文件里，标识符 `id` 是不是「声明时就是 `undefined` / `void 0` / `null`」或「`let` / `var` 声明了却从没赋过值」（持有的必然是 undefined）。
 * 只看声明处的字面量，看不到运行时才变成 undefined 的值——那一类靠咽喉自己 fail-closed（表里没有 token 就拒），不靠这里的扫描。
 */
const holdsNoToken = (masked: string, id: string): boolean => {
  const esc = id.replace(/\$/g, "\\$");
  const init = new RegExp(`\\b(?:const|let|var)\\s+${esc}\\b\\s*(?::[^=;\\n]+)?=\\s*(?:undefined|void\\s*\\(?\\s*0\\s*\\)?|null)(?![\\w$])`);
  if (init.test(masked)) return true;
  const bare = new RegExp(`\\b(?:let|var)\\s+${esc}\\b\\s*(?::[^=;\\n]+)?;`);
  if (!bare.test(masked)) return false;
  return !new RegExp(`(?<![\\w$.])${esc}\\s*=(?!=)`).test(masked.replace(bare, ""));
};

/**
 * 找出源码里「调 invokeFlowshipTool 时第三个实参（callerToken）静态上就不是一个真 token」的调用，返回每处的片段（供报错）。
 * 第二十轮评审 R20-9 把第十九轮只认字面 `undefined` 的扫描扩成（R19-1 的 P2 就是这么漏的）：
 *  · 字面量的各种写法：`undefined` / `undefined as never`（含 `as unknown as …`、`<never>undefined`、括号）/ `void 0` / `null` / 空串；
 *  · 省略第三个实参（只传两个，或第三个位置是空的）、展开实参（`...args`，看不到第三个是谁，按「看不清」处理）；
 *  · 同一文件里声明时就是 `undefined` / `null` 的变量（`const tok = undefined` → `invokeFlowshipTool(t, a, tok, c)`）、`let` 声明了却从没赋值的变量；
 *  · `invokeFlowshipTool` 被当「值」用而不是直接调用——别名（`const f = invokeFlowshipTool`）、`.call` / `.apply` / `.bind`、当回调传——扫描看不到那之后的实参，按「看不清」处理，
 *    要么改成直接调用、要么扩展本扫描。放行的：import / 解构的绑定列表、`const invokeFlowshipTool = …` 这种声明本身。
 * 先去注释、再把字符串 / 模板的内容抹掉（调用写在字符串里的不算），按括号配平后在顶层逗号处切实参。
 * **看不到的**：运行时才变成 undefined 的值（如 `let t; if (x) t = "a"; call(…, t, …)`）、经包装函数转发的 token（`call(tool, args, undefined)` 这种由包装函数的调用方决定的）。
 * 纯函数；下面有合成样本自检。
 */
const tokenlessCalls = (rawSrc: string): string[] => {
  const src = stripComments(rawSrc);
  const masked = maskLiterals(src);
  const hits: string[] = [];
  const snippet = (from: number, to: number): string => src.slice(from, to).replace(/\s+/g, " ").slice(0, 160);

  // 1) 直接调用：切实参、看第三个
  const re = /\binvokeFlowshipTool\s*\(/g;
  for (let m = re.exec(masked); m; m = re.exec(masked)) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let close = -1;
    const cuts: number[] = [];
    for (let i = open; i < masked.length; i++) {
      const ch = masked[i]!;
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") {
        depth--;
        if (depth === 0) {
          close = i;
          break;
        }
      } else if (ch === "," && depth === 1) cuts.push(i);
    }
    if (close < 0) continue;
    const bounds = [open, ...cuts, close];
    const args = bounds.slice(0, -1).map((from, k) => src.slice(from + 1, bounds[k + 1]).trim());
    const tokenArg = args[2];
    const spread = args.some((a) => a.startsWith("..."));
    if (tokenArg === undefined || tokenArg === "" || spread) {
      hits.push(snippet(m.index, close + 1));
      continue;
    }
    const inner = unwrapArg(tokenArg);
    if (NO_TOKEN_LITERAL.test(inner) || (/^[A-Za-z_$][\w$]*$/.test(inner) && holdsNoToken(masked, inner))) {
      hits.push(snippet(m.index, close + 1));
    }
  }

  // 2) 当「值」用的引用：扫描看不到之后的实参
  const ref = /\binvokeFlowshipTool\b/g;
  for (let m = ref.exec(masked); m; m = ref.exec(masked)) {
    const next = masked.slice(m.index + m[0].length).match(/^\s*(\S)/)?.[1] ?? "";
    if (next === "(") continue; // 直接调用：上面查过实参
    const head = masked.slice(0, m.index);
    const prev = head.match(/(\S)\s*$/)?.[1] ?? "";
    if ((prev === "{" || prev === ",") && (next === "}" || next === ",")) continue; // import / 解构的绑定列表
    if (next === "=" && /\b(?:const|let|var|function)\s+$/.test(head)) continue; // 声明本身（flowship-tools.ts 里的 export const invokeFlowshipTool = …）
    if (/\btypeof\s+$/.test(head)) continue; // 类型位置（custom-agent-backend.ts 的 ReturnType<typeof invokeFlowshipTool>）：不是值引用
    hits.push(`（被当值用，扫描看不到实参）${snippet(Math.max(0, m.index - 20), m.index + m[0].length + 40)}`);
  }
  return hits;
};

describe("第十九轮评审补的钉子", () => {
  it("R19-10：RESTRICTED（手写）与 GROUP_OPEN_TURN_DENIED_RULES 的键程序化对账——恒拒清单增删一个工具，这张表不跟着改就红", () => {
    const flowship = readSource("src/lib/server/flowship-tools.ts");
    const head = "const GROUP_OPEN_TURN_DENIED_RULES = new Map<string, GroupOpenTurnRule>([";
    const from = flowship.indexOf(head);
    expect(from, "没找到恒拒清单").toBeGreaterThan(-1);
    const to = flowship.indexOf("\n]);", from);
    expect(to).toBeGreaterThan(from);
    const block = flowship.slice(from, to);
    // 每条规则是 `  [\n    NAME_TOOL_NAME,\n    {`：取键的常量名
    const idents = [...block.matchAll(/^ {2}\[\s*\n {4}([A-Z][A-Z0-9_]*),/gm)].map((m) => m[1]!);
    expect(idents.length, "键提取不到（清单的书写格式变了？）").toBeGreaterThanOrEqual(11);
    // 常量名 → 字符串：在 src/lib 里找 `const NAME = "xxx"`（flowship-tools 本地常量 + owner-note / one-shot-tools / schedule 的导出）
    const libSources = listFiles("src/lib", (rel) => rel.endsWith(".ts") && !rel.endsWith(".d.ts")).map((rel) =>
      stripComments(fs.readFileSync(path.join(ROOT, rel), "utf-8")),
    );
    const resolve = (ident: string): string => {
      const re = new RegExp(`\\bconst ${ident} = "([a-z_]+)"`);
      for (const s of libSources) {
        const m = re.exec(s);
        if (m) return m[1]!;
      }
      throw new Error(`没找到常量 ${ident} 的定义`);
    };
    const ruleNames = new Set(idents.map(resolve));
    const handWritten = new Set(RESTRICTED.map(([n]) => n).filter((n) => !n.startsWith("desktop_")));
    expect([...ruleNames].sort(), "恒拒清单里有工具没出现在 RESTRICTED（新规则没补闸的用例），或 RESTRICTED 里有工具已不在清单里").toEqual(
      [...handWritten].sort(),
    );
    // desktop_* 不在这张表里：由 DESKTOP_TOOL_NAMES 逐个对（上面第一个 describe）
    for (const [name] of RESTRICTED) {
      if (name.startsWith("desktop_")) expect(ruleNames.has(name), `${name} 是 desktop_*，不该在恒拒清单里（它走专用闸）`).toBe(false);
    }
  });

  it("R19-6：closeChatSession 是同步函数、整段没有 await / 微任务让出——摘表 / 清标记 / 摘 token 靠「单槽表 + 同一个同步段」，将来在中间插 await 就会破", () => {
    const chat = readSource("src/lib/server/chat-runner.ts");
    const start = chat.indexOf("const closeChatSession = (");
    expect(start, "没找到 closeChatSession 声明（或它被改成了 async：`const closeChatSession = async (`）").toBeGreaterThan(-1);
    const end = chat.indexOf("\n};", start);
    const fn = maskLiterals(chat.slice(start, end));
    expect(fn, "closeChatSession 里出现了 await").not.toMatch(/\bawait\b/);
    expect(fn, "closeChatSession 里出现了让出事件循环的写法（then / queueMicrotask / setTimeout / setImmediate / nextTick）").not.toMatch(
      /\.then\(|\bqueueMicrotask\(|\bsetTimeout\(|\bsetImmediate\(|\bnextTick\(/,
    );
    // 摘表 → 摘 token 之间尤其不能有：这两个语句都在函数体顶层
    const del = fn.indexOf("runningChats.delete(taskId)");
    const unset = fn.indexOf("setChatAwaitingNotifier(taskId, null)");
    expect(del).toBeGreaterThan(-1);
    expect(unset, "摘 token 要在摘表之后").toBeGreaterThan(del);
  });

  it("R19-7：chat 从不登记 scope=all——`beginNonOwnerTurn(` 只在 task-runner.ts 里被调；chat 侧只有 `beginForeignContentMidRun`，且它硬编码 scope=desktop", () => {
    const callers = listFiles("src", (rel) => /\.(ts|tsx)$/.test(rel))
      .filter((rel) => rel !== "src/lib/server/non-owner-turn-guard.ts")
      .filter((rel) => /\bbeginNonOwnerTurn\s*\(/.test(stripComments(fs.readFileSync(path.join(ROOT, rel), "utf-8"))));
    expect(callers, "beginNonOwnerTurn 出现在 task-runner.ts 之外：chat 侧可能开始登记 scope=all——要重新核对 isForeignTurn（不分 scope）与 subagent 的挂载").toEqual([
      "src/lib/server/task-runner.ts",
    ]);
    const chat = readSource("src/lib/server/chat-runner.ts");
    expect(chat, "chat-runner 不得直接登记标记（只能经 beginForeignContentMidRun）").not.toMatch(/\bbeginNonOwnerTurn\b/);
    const guardSrc = readSource("src/lib/server/non-owner-turn-guard.ts");
    const body = blockAfter(guardSrc, "export const beginForeignContentMidRun = (");
    expect(body).toMatch(/scope: "desktop"/);
    expect(body).toMatch(/midRun: true/);
    expect(body, "beginForeignContentMidRun 不得登记 scope=all").not.toMatch(/scope: "all"/);
  });

  it("R19-7：`backgroundSubagents: true`（后台子代理）只由 chat-runner 传；task 模式 / 一次性调用的 `subagent` 回「当前会话不支持 run_in_background」", () => {
    const passers = listFiles("src", (rel) => /\.(ts|tsx)$/.test(rel)).filter((rel) =>
      /\bbackgroundSubagents:\s*true\b/.test(stripComments(fs.readFileSync(path.join(ROOT, rel), "utf-8"))),
    );
    expect(passers, "backgroundSubagents: true 出现在 chat-runner.ts 之外：task 模式也可能开后台子代理了——scope=all 的轮里的链要重新核对").toEqual([
      "src/lib/server/chat-runner.ts",
    ]);
    // 拒绝路径本身的行为用例在 cursor-subagent-background.test.ts（没提供 background 依赖 → 拒）；这里钉拒绝的源码条件仍是「没传 background」
    const sub = readSource("src/lib/server/cursor-subagent.ts");
    expect(sub).toMatch(/if \(wantsBackground && !bg\) \{\s*throw new SubagentUsageError\(\s*"当前会话不支持 run_in_background/);
  });

  it("R19-1 / R20-9：tokenlessCalls 自检（合成样本）——字面量的各种写法、省略第三参、变量持有 undefined、别名 / call / bind 都认得出", () => {
    // 第十九轮的原样本：字面 undefined（单行 / 多行 / 参数里有嵌套括号）
    expect(tokenlessCalls("invokeFlowshipTool(tool, args, undefined, ctx)")).toHaveLength(1);
    expect(tokenlessCalls("mod.invokeFlowshipTool(\n  tool,\n  args,\n  undefined,\n  ctx,\n)")).toHaveLength(1);
    expect(tokenlessCalls("await invokeFlowshipTool(f(a, b), { x: [1, 2] }, undefined, { taskId })")).toHaveLength(1);
    // 第二十轮补的：断言包着的 / void 0 / null / 空串
    expect(tokenlessCalls("invokeFlowshipTool(tool, args, undefined as never, ctx)")).toHaveLength(1);
    expect(tokenlessCalls("invokeFlowshipTool(tool, args, (undefined as unknown as string), ctx)")).toHaveLength(1);
    expect(tokenlessCalls("invokeFlowshipTool(tool, args, <never>undefined, ctx)")).toHaveLength(1);
    expect(tokenlessCalls("invokeFlowshipTool(tool, args, undefined!, ctx)")).toHaveLength(1);
    expect(tokenlessCalls("invokeFlowshipTool(tool, args, void 0, ctx)")).toHaveLength(1);
    expect(tokenlessCalls("invokeFlowshipTool(tool, args, void(0), ctx)")).toHaveLength(1);
    expect(tokenlessCalls("invokeFlowshipTool(tool, args, null as never, ctx)")).toHaveLength(1);
    expect(tokenlessCalls('invokeFlowshipTool(tool, args, "", ctx)')).toHaveLength(1);
    // 省略第三参 / 第三个位置是空的 / 展开实参（看不清按「看不清」处理）
    expect(tokenlessCalls("invokeFlowshipTool(tool, args)")).toHaveLength(1);
    expect(tokenlessCalls("invokeFlowshipTool(tool, args,)")).toHaveLength(1);
    expect(tokenlessCalls("invokeFlowshipTool(...callArgs)")).toHaveLength(1);
    // 变量持有 undefined：声明时就是、或 let / var 声明了从没赋过值
    expect(tokenlessCalls("const tok = undefined;\ninvokeFlowshipTool(tool, args, tok, ctx)")).toHaveLength(1);
    expect(tokenlessCalls("const tok: string | undefined = void 0;\ninvokeFlowshipTool(tool, args, tok, ctx)")).toHaveLength(1);
    expect(tokenlessCalls("let tok: string | undefined;\ninvokeFlowshipTool(tool, args, tok, ctx)")).toHaveLength(1);
    expect(tokenlessCalls("let tok: string | undefined;\ntok = currentSessionToken(id);\ninvokeFlowshipTool(tool, args, tok, ctx)")).toHaveLength(0);
    expect(tokenlessCalls("const tok = currentSessionToken(id);\ninvokeFlowshipTool(tool, args, tok, ctx)")).toHaveLength(0);
    // 被当值用：别名 / call / apply / bind / 当回调传——扫描看不到实参
    expect(tokenlessCalls("const f = invokeFlowshipTool;\nf(tool, args, undefined, ctx)")).toHaveLength(1);
    expect(tokenlessCalls("invokeFlowshipTool.call(null, tool, args, undefined, ctx)")).toHaveLength(1);
    expect(tokenlessCalls("const g = invokeFlowshipTool.bind(null);")).toHaveLength(1);
    expect(tokenlessCalls("run(invokeFlowshipTool);")).toHaveLength(1);
    expect(tokenlessCalls("const { invokeFlowshipTool: invoke } = await import('x');")).toHaveLength(1);
    // 不算：传了变量 / 表达式 / 字符串 "undefined"；写在注释或字符串里的调用；token 在第四位；import / 解构的绑定列表；声明本身
    expect(tokenlessCalls("invokeFlowshipTool(tool, args, token, ctx)")).toHaveLength(0);
    expect(tokenlessCalls("invokeFlowshipTool(tool, args, currentSessionToken(id), ctx)")).toHaveLength(0);
    expect(tokenlessCalls("invokeFlowshipTool(tool, args, token as string, ctx)")).toHaveLength(0);
    expect(tokenlessCalls("invokeFlowshipTool(tool, args, cond ? undefined : token, ctx)")).toHaveLength(0); // 条件表达式：静态上拆不开，不判
    expect(tokenlessCalls('invokeFlowshipTool(tool, args, "undefined", ctx)')).toHaveLength(0);
    expect(tokenlessCalls("// invokeFlowshipTool(tool, args, undefined, ctx)")).toHaveLength(0);
    expect(tokenlessCalls("/* const f = invokeFlowshipTool; */")).toHaveLength(0);
    expect(tokenlessCalls('const s = "invokeFlowshipTool(tool, args, undefined, ctx)";')).toHaveLength(0);
    expect(tokenlessCalls("invokeFlowshipTool(tool, args, tok, undefined)")).toHaveLength(0);
    expect(tokenlessCalls("const { invokeFlowshipTool } = await import('x');")).toHaveLength(0);
    expect(tokenlessCalls("const {\n  flowShipTools,\n  invokeFlowshipTool,\n  other,\n} = await import('x');")).toHaveLength(0);
    expect(tokenlessCalls("import { invokeFlowshipTool, type Foo } from 'x';")).toHaveLength(0);
    expect(tokenlessCalls("export const invokeFlowshipTool = async (tool, args, callerToken, ctx) => {};")).toHaveLength(0);
    expect(tokenlessCalls("type R = Awaited<ReturnType<typeof invokeFlowshipTool>>;")).toHaveLength(0); // 类型位置的 typeof
  });

  it("R19-1 / R20-9：整仓（tests / scripts / src / electron-app，含 .cjs / .mjs / .js）没有任何文件以「静态上就不是真 token」的方式调 invokeFlowshipTool——含被 skipIf 圈住、默认门禁不跑的文件（第十九轮 P2 就是这么漏的）", () => {
    const offenders: string[] = [];
    // 第二十轮收尾补（变异 T6 活下来）：扫描范围本身也要钉。`scripts/` 里目前恰好没有文件提到 invokeFlowshipTool，
    // 把它从下面的目录表里删掉，offenders 照样是空、测试照样绿——「整仓」两个字没人兜着。
    // 所以按目录记下「实际读到了几个文件」，四个目录各自必须 > 0：范围被悄悄缩小（或目录改名后表里没跟着改）就红
    const visited: Record<string, number> = {};
    for (const dir of ["tests", "scripts", "src", "electron-app"]) {
      visited[dir] = 0;
      // 红线：scripts/browser-e2e/r14-experiment-tmp.cjs 是不入库的实验文件，按名字在读之前就跳过（只列名字、不读内容）
      for (const rel of listFiles(dir, (r) => /\.(?:ts|mts|cts|mjs|cjs|js)$/.test(r) && path.basename(r) !== "r14-experiment-tmp.cjs")) {
        visited[dir] += 1;
        const raw = fs.readFileSync(path.join(ROOT, rel), "utf-8");
        if (!raw.includes("invokeFlowshipTool")) continue;
        for (const h of tokenlessCalls(raw)) offenders.push(`${rel}: ${h}`);
      }
    }
    for (const dir of ["tests", "scripts", "src", "electron-app"]) {
      expect(visited[dir] ?? 0, `整仓扫描一个 ${dir}/ 下的文件都没读到——扫描范围被缩小了，或目录改名后这张表没跟着改`).toBeGreaterThan(0);
    }
    expect(
      offenders,
      "受限工具（desktop_* / browser_evaluate / schedule …）现在要求调用方 token 是当前会话的，token 缺失一律 fail-closed——测试里要登记并传 token（tests/helpers/session-token.ts）；被当值用的引用要改成直接调用或扩展本扫描",
    ).toEqual([]);
  });

  it("R19-1：FS_BROWSER_E2E=1 才跑的 browser-e2e-bridge.test.ts，其 invoke 包装传的是当前会话 token（默认门禁看得到它漂移）", () => {
    const e2e = readSource("tests/browser-e2e-bridge.test.ts");
    expect(e2e).toMatch(/invokeFlowshipTool\(tool, args, currentSessionToken\(ctx\.taskId\), ctx\)/);
    expect(e2e).toMatch(/describe\.skipIf\(/); // 前提：它确实是环境门控的（否则这条钉子没有存在的意义）
  });
});
