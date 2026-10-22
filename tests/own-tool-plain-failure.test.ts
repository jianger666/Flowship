/**
 * R7-01：自有工具的「纯文本」失败也要认成 error（V4-03 只覆盖了 JSON `{ok:false}` 子集）。
 *
 * `schedule` 的「创建失败 / 取消失败 / 参数错误 / 定时不可用」、`create_custom_action` 的「挂载失败」、`wait` 的「参数错误」
 * 等都是 `return text("…")` 的**正常返回**（不抛、不带 isError），Cursor 路径的 MCP 信封里也没有错误信号 →
 * 工具行与工作组头亮绿勾，摘要是失败文案首行。
 *
 * 判据保持收紧（误判代价不对称：把成功标红比漏标更糟）：
 *  - 只对自有工具判（shell 输出、第三方 MCP 里碰巧出现同样的字不算）；
 *  - 按「工具」分表、**精确前缀**匹配（含全角冒号）、只看正文开头——正文中段出现不算；
 *  - 不做模糊匹配（「失败」「错误」字样一律不算）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { mapSubmitWorkNotifyToToolText } from "../src/lib/server/flowship-tools";
import type { NotifyAwaitingResult } from "../src/lib/server/chat-pending";
import {
  OWN_TOOL_PLAIN_FAILURE_PREFIXES,
  buildInlineToolResultMeta,
  isFlowshipOwnToolName,
  resolveToolResultStatus,
} from "../src/lib/server/tool-result-persist";

const piText = (text: string) => ({ content: [{ type: "text", text }] });
const cursorMcpText = (text: string) => ({
  status: "success",
  value: { content: [{ text: { text } }], isError: false },
});
const toolText = (r: { content: Array<{ text: string }> }) => r.content[0]!.text;

describe("R7-01：自有工具纯文本失败 → error（三种工具名形状 × 两种回包形状）", () => {
  const cases = Object.entries(OWN_TOOL_PLAIN_FAILURE_PREFIXES).flatMap(
    ([tool, prefixes]) => prefixes.map((p) => [tool, p] as const),
  );

  it("前缀表不是空的，且覆盖了报告点名的三个工具", () => {
    expect(cases.length).toBeGreaterThanOrEqual(8);
    const tools = new Set(cases.map(([t]) => t));
    for (const t of ["schedule", "create_custom_action", "wait", "ask_user"]) {
      expect(tools.has(t), t).toBe(true);
    }
    // 表里的每个工具都是自有工具
    for (const t of tools) expect(isFlowshipOwnToolName(t), t).toBe(true);
  });

  for (const [tool, prefix] of cases) {
    it(`${tool}：「${prefix}…」→ error`, () => {
      const body = `${prefix}这个会话已归档`;
      expect(resolveToolResultStatus("completed", tool, piText(body))).toBe("error");
      expect(
        resolveToolResultStatus("completed", `mcp:custom-user-tools:${tool}`, cursorMcpText(body)),
      ).toBe("error");
      // 旧会话的合成 server 名
      expect(
        resolveToolResultStatus("completed", `mcp:flowshipChat:${tool}`, cursorMcpText(body)),
      ).toBe("error");
      // 前后空白不影响
      expect(resolveToolResultStatus("completed", tool, piText(`\n  ${body}\n`))).toBe("error");
    });
  }

  it("端到端：落盘的 tool_result 元数据 status=error、output 仍是原文案", () => {
    const body = "创建失败：这个会话已归档，不能再设定时。";
    const meta = buildInlineToolResultMeta({
      callId: "c_sched_fail",
      rawName: "schedule",
      msgStatus: "completed",
      args: {},
      result: piText(body),
    });
    expect(meta.status).toBe("error");
    expect(meta.output).toBe(body);
    // Cursor 的 MCP 信封形状：同样落成 error（output 的展开口径不是本项范围）
    const cursorMeta = buildInlineToolResultMeta({
      callId: "c_sched_fail2",
      rawName: "mcp:custom-user-tools:schedule",
      msgStatus: "completed",
      args: {},
      result: cursorMcpText(body),
    });
    expect(cursorMeta.status).toBe("error");
  });
});

describe("Q7a-01：submit_work 被拒的全部真实文案 → error；真正交卷成功 → success（不抄字符串，直接跑真实映射函数）", () => {
  const rejected: Array<[string, NotifyAwaitingResult]> = [
    ["error", { status: "error", message: "写盘失败：磁盘已满" }],
    ["busy", { status: "busy", message: "上一个交卷还在处理" }],
    ["stale", { status: "stale" }],
    ["mismatch", { status: "mismatch" }],
    ["no_notifier", { status: "no_notifier" }],
  ];

  for (const [name, result] of rejected) {
    it(`${name} → error（pi 形状 + Cursor MCP 形状）`, () => {
      const text = mapSubmitWorkNotifyToToolText(result, "a_1");
      expect(resolveToolResultStatus("completed", "submit_work", piText(text))).toBe("error");
      expect(
        resolveToolResultStatus(
          "completed",
          "mcp:custom-user-tools:submit_work",
          cursorMcpText(text),
        ),
      ).toBe("error");
    });
  }

  it("已受理（delivered / accepted → [SUBMITTED]）仍是 success——不把成功标红", () => {
    for (const status of ["delivered", "accepted"] as const) {
      const ok = mapSubmitWorkNotifyToToolText({ status }, "a_1");
      expect(ok).toContain("[SUBMITTED]");
      expect(resolveToolResultStatus("completed", "submit_work", piText(ok))).toBe("success");
    }
  });
});

describe("R7-01：不误判（成功文案 / 非自有工具 / 前缀不在开头 / 近似措辞）", () => {
  const failure = "创建失败：这个会话已归档，不能再设定时。";

  it("非自有工具：shell 输出 / read 内容 / 第三方 MCP 里出现同样的字 → success", () => {
    expect(resolveToolResultStatus("completed", "shell", piText(failure))).toBe("success");
    expect(
      resolveToolResultStatus("completed", "shell", {
        status: "success",
        value: { stdout: failure, stderr: "", exitCode: 0 },
      }),
    ).toBe("success");
    expect(resolveToolResultStatus("completed", "read", piText(failure))).toBe("success");
    expect(resolveToolResultStatus("completed", "mcp:feishu:schedule", cursorMcpText(failure))).toBe("success");
    // 同名前缀不是保留 server
    expect(
      resolveToolResultStatus("completed", "mcp:custom-user-tools-x:schedule", cursorMcpText(failure)),
    ).toBe("success");
  });

  it("工具分表：别的自有工具不吃 schedule 的前缀（wait 回「创建失败：」不算）", () => {
    expect(resolveToolResultStatus("completed", "wait", piText(failure))).toBe("success");
    expect(resolveToolResultStatus("completed", "submit_mr", piText(failure))).toBe("success");
  });

  it("只看正文开头：中段 / 行首第二行出现不算（定时列表的标题里可以写任何字）", () => {
    expect(
      resolveToolResultStatus(
        "completed",
        "schedule",
        piText("本会话有 1 条定时：\n- 每天 9 点（创建失败：重试一下）"),
      ),
    ).toBe("success");
    expect(
      resolveToolResultStatus("completed", "schedule", piText(`好的。\n${failure}`)),
    ).toBe("success");
  });

  it("精确前缀：缺全角冒号 / 近似措辞 / 空文本 → success", () => {
    for (const t of ["创建失败", "创建失败了：x", "创建失敗：x", "参数错误 x", "失败：x", "", "   "]) {
      expect(resolveToolResultStatus("completed", "schedule", piText(t)), JSON.stringify(t)).toBe("success");
    }
    expect(resolveToolResultStatus("completed", "schedule", undefined)).toBe("success");
    expect(resolveToolResultStatus("completed", "schedule", { content: [] })).toBe("success");
  });

  it("各工具真实的成功文案 → success", () => {
    for (const [tool, t] of [
      ["schedule", "[SCHEDULED id=s1] 已设定定时「喝水」：每天 9 点，首次 2026-10-22T09:00（本机时间）。"],
      ["schedule", "[CANCELLED id=s1] 已取消定时「喝水」。"],
      ["schedule", "本会话没有进行中的定时。"],
      ["create_custom_action", "已挂载自定义 Action：id=a1、label=x、skill=y。"],
      ["wait", "已等 30s / 计划 30s"],
      ["ask_user", "[ASK_SUBMITTED] 问题组 ask_1 已推送给用户（UI 答题卡）。"],
    ] as const) {
      expect(resolveToolResultStatus("completed", tool, piText(t)), t).toBe("success");
    }
  });

  it("旧判定不回归：JSON {ok:false} 仍 error、ok:true 仍 success", () => {
    expect(
      resolveToolResultStatus("completed", "submit_mr", piText(JSON.stringify({ ok: false, error: "x" }))),
    ).toBe("error");
    expect(
      resolveToolResultStatus("completed", "submit_mr", piText(JSON.stringify({ ok: true }))),
    ).toBe("success");
  });
});

describe("R7-01：真实工具 handler 的失败回包 → error（防文案漂移，不靠抄字符串）", () => {
  it("wait：seconds 非法", async () => {
    const { flowShipTools } = await import("../src/lib/server/flowship-tools");
    const wait = flowShipTools.find((t) => t.name === "wait")!;
    const r = await wait.handler({ seconds: "abc" }, undefined, undefined);
    expect(toolText(r as never)).toMatch(/^参数错误：/);
    expect(resolveToolResultStatus("completed", "wait", r)).toBe("error");
    expect(resolveToolResultStatus("completed", "mcp:custom-user-tools:wait", {
      status: "success",
      value: { content: r.content.map((c) => ({ text: { text: (c as { text: string }).text } })) },
    })).toBe("error");
  });

  it("schedule：没有会话信息（定时不可用）", async () => {
    const { flowShipTools } = await import("../src/lib/server/flowship-tools");
    const schedule = flowShipTools.find((t) => t.name === "schedule")!;
    const r = await schedule.handler({ action: "list" }, undefined, undefined);
    expect(toolText(r as never)).toMatch(/^定时不可用：/);
    expect(resolveToolResultStatus("completed", "schedule", r)).toBe("error");
  });

  it("create_custom_action：label 为空", async () => {
    const { flowShipTools } = await import("../src/lib/server/flowship-tools");
    const tool = flowShipTools.find((t) => t.name === "create_custom_action")!;
    const r = await tool.handler({ label: "  ", skill: "x" }, undefined, undefined);
    expect(resolveToolResultStatus("completed", "create_custom_action", r)).toBe("error");
  });

  it("被新 agent 接管（CALLER_MISMATCH_ERROR）：对所有自有工具都是失败", async () => {
    const { CALLER_MISMATCH_ERROR } = await import("../src/lib/server/chat-pending");
    for (const tool of ["schedule", "ask_user", "share_to_group", "submit_work"]) {
      expect(
        resolveToolResultStatus("completed", tool, piText(CALLER_MISMATCH_ERROR)),
        tool,
      ).toBe("error");
    }
    // 但不是自有工具就不算
    expect(resolveToolResultStatus("completed", "shell", piText(CALLER_MISMATCH_ERROR))).toBe("success");
  });

  it("契约：表里的每条前缀都真的出现在 flowship-tools / chat-pending 源码里（文案改了必须同步改表）", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src =
      readFileSync(resolve(__dirname, "../src/lib/server/flowship-tools.ts"), "utf8") +
      readFileSync(resolve(__dirname, "../src/lib/server/chat-pending.ts"), "utf8");
    const all = new Set(Object.values(OWN_TOOL_PLAIN_FAILURE_PREFIXES).flat());
    for (const p of all) {
      expect(src.includes(p), `源码里找不到前缀「${p}」`).toBe(true);
    }
  });
});

describe("第五轮 Q7a-01：反向完备性——源码里的每条「失败文案」都必须在前缀表里", () => {
  // 以前只守「表里的前缀都在源码里」：漏掉一个源码里真实存在的失败文案（例如 schedule 的「取消失败：」）时，
  // 没有任何测试会红，该工具失败仍亮绿勾。这里反过来扫 flowship-tools.ts 的 `text(…)` 字面量。
  const source = readFileSync(
    path.join(process.cwd(), "src/lib/server/flowship-tools.ts"),
    "utf8",
  );
  /** `text(` 之后第一个字符串 / 模板字面量的「第一个 `${` 之前的部分」（参数是变量、JSON.stringify 的不在此列） */
  const literalPrefixes = (): string[] => {
    const out: string[] = [];
    const re = /\btext\(\s*([`"'])((?:\\.|(?!\1)[^\\])*)\1/g;
    for (const m of source.matchAll(re)) {
      const body = m[2]!;
      const prefix = body.split("${")[0]!;
      if (prefix) out.push(prefix);
    }
    return out;
  };
  /** 看上去像失败回包的文案（宁可多抓、由下面的白名单显式豁免成功 / 中性文案） */
  const LOOKS_LIKE_FAILURE = /失败|错误|不可用|未受理|不能为空|不能再|已结束|已被后续|被拒/;
  /** 确认是成功 / 中性回包的文案前缀（显式豁免；新增的「像失败」文案必须二选一：进表，或在这里写明为什么不是失败） */
  const NOT_FAILURE_PREFIXES = ["[CANCELLED id=", "本会话没有进行中的定时"];

  const allTablePrefixes = Object.values(OWN_TOOL_PLAIN_FAILURE_PREFIXES).flat();

  it("扫描器本身能工作：抓得到已知的几条字面量（防止正则坏了而测试空转）", () => {
    const prefixes = literalPrefixes();
    expect(prefixes.length).toBeGreaterThanOrEqual(10);
    expect(prefixes).toContain("取消失败：");
    expect(prefixes).toContain("创建失败：");
    expect(prefixes).toContain("挂载失败：");
  });

  it("每条像失败的 text(…) 字面量都被前缀表覆盖（或显式豁免）", () => {
    const missing = literalPrefixes().filter(
      (prefix) =>
        LOOKS_LIKE_FAILURE.test(prefix) &&
        !NOT_FAILURE_PREFIXES.some((ok) => prefix.startsWith(ok)) &&
        !allTablePrefixes.some((p) => prefix.startsWith(p)),
    );
    expect(missing, `这些失败文案没进 OWN_TOOL_PLAIN_FAILURE_PREFIXES：${JSON.stringify(missing)}`).toEqual([]);
  });

  it("按工具归属：schedule 的 4 类前缀、create_custom_action 的「挂载失败：」各归各表", () => {
    const sched = OWN_TOOL_PLAIN_FAILURE_PREFIXES.schedule ?? [];
    for (const p of ["定时不可用：", "参数错误：", "取消失败：", "创建失败："]) {
      expect(sched, p).toContain(p);
    }
    expect(OWN_TOOL_PLAIN_FAILURE_PREFIXES.create_custom_action ?? []).toContain("挂载失败：");
  });
});
