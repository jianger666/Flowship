/**
 * R1-02（server 部分）：浏览器工具的明文入参不得落盘 / 不得进聊天流。
 *
 * ① `redactBrowserArgs` 纯函数：browser_type.text / browser_fill_form.fields[].value / browser_press_key 单字符 key
 *    / browser_dialog.prompt_text → `[已隐藏 N 字符]`；SDK（MCP 外壳）与 pi（裸名）两种工具名形态都认。
 * ② `handleSdkMessage`（SDK 与 pi 两条路径的共同咽喉）：tool_call 事件的三处写入（普通 running 的 writeEv、
 *    askSeen 消音审计的 appendEvent、artifact 写入的 writeEv）里 text / meta.args 都不含明文。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  HIDDEN_CHARS_RE,
  hiddenCharsText,
  redactBrowserArgs,
  redactBrowserToolCallMessage,
} from "@/lib/server/browser/redact-args";

type WrittenEvent = { kind: string; text?: string; meta?: Record<string, unknown> };

const writeOwnedEventAndPublish = vi.fn<(...a: unknown[]) => Promise<void>>(async () => {});
const appendEvent = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => null);

vi.mock("@/lib/server/task-fs", () => ({
  getTask: vi.fn(),
  patchActionIfOwner: vi.fn(),
  appendEvent: (...a: unknown[]) => appendEvent(...a),
}));
vi.mock("@/lib/server/failpoints", () => ({ failpoint: vi.fn(async () => {}) }));
vi.mock("@/lib/server/task-stream", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/task-stream")>();
  return {
    ...actual,
    writeOwnedEventAndPublish: (...a: unknown[]) => writeOwnedEventAndPublish(...a),
    publish: vi.fn(),
    publishIfCurrent: vi.fn(),
  };
});
vi.mock("@/lib/server/tool-result-persist", () => ({
  buildToolResultMeta: vi.fn(async (input: { callId: string; rawName: string; msgStatus: string }) => ({
    callId: input.callId,
    name: input.rawName,
    status: input.msgStatus === "error" ? "error" : "success",
    output: "ok",
  })),
}));

const { handleSdkMessage, __resetToolCallRunningSeenForTest } = await import("@/lib/server/sdk-message-handler");
import type { AssistantBufferCtx } from "@/lib/server/sdk-message-handler";

const hidden = hiddenCharsText;

// ───────────── ① 纯函数 ─────────────

describe("redactBrowserArgs（纯函数）", () => {
  it("browser_type：text 换成 [已隐藏 N 字符]；ref / submit / clear 原样；不改入参对象", () => {
    const args = { ref: "e5", text: "hunter2", submit: true, clear: false };
    const frozen = JSON.stringify(args);
    const out = redactBrowserArgs("browser_type", args) as Record<string, unknown>;
    expect(out).toEqual({ ref: "e5", text: hidden(7), submit: true, clear: false });
    expect(JSON.stringify(args)).toBe(frozen); // 原对象没被动过（工具真实执行用的就是它）
    expect(out).not.toBe(args);
  });

  it("N 按码点数（中文 / emoji 各算 1 个，不是 UTF-16 码元数）", () => {
    expect((redactBrowserArgs("browser_type", { ref: "e1", text: "你好😀" }) as { text: string }).text).toBe(hidden(3));
    expect((redactBrowserArgs("browser_type", { ref: "e1", text: "a".repeat(5000) }) as { text: string }).text).toBe(hidden(5000));
  });

  it("空串（清空输入框）不隐藏；没有需要藏的字段时返回原引用；非字符串 text 也会被藏（fail-closed）", () => {
    const empty = { ref: "e1", text: "" };
    expect(redactBrowserArgs("browser_type", empty)).toBe(empty);
    const click = { ref: "e1", button: "right" };
    expect(redactBrowserArgs("browser_click", click)).toBe(click);
    expect((redactBrowserArgs("browser_type", { ref: "e1", text: 123456 }) as { text: string }).text).toBe(hidden(6));
  });

  it("幂等：已经是占位符的值不会被再包一层", () => {
    const once = redactBrowserArgs("browser_type", { ref: "e1", text: "hunter2" });
    expect(redactBrowserArgs("browser_type", once)).toBe(once);
    expect(HIDDEN_CHARS_RE.exec((once as { text: string }).text)?.[1]).toBe("7");
  });

  it("browser_fill_form：每个 fields[].value 都藏（字符串 / 数字）；checked / values / ref / submit_ref 不动", () => {
    const args = {
      fields: [
        { ref: "e1", value: "13800138000" },
        { ref: "e2", value: 123456 },
        { ref: "e3", checked: true },
        { ref: "e4", values: ["北京", "上海"] },
        { ref: "e5", value: "" },
      ],
      submit_ref: "e9",
    };
    const out = redactBrowserArgs("browser_fill_form", args) as typeof args;
    expect(out.fields).toEqual([
      { ref: "e1", value: hidden(11) },
      { ref: "e2", value: hidden(6) },
      { ref: "e3", checked: true },
      { ref: "e4", values: ["北京", "上海"] },
      { ref: "e5", value: "" },
    ]);
    expect(out.submit_ref).toBe("e9");
    expect(JSON.stringify(args)).toContain("13800138000"); // 原对象不变
  });

  it("browser_fill_form：fields 是 JSON 字符串（模型常这么写）也要藏；JSON 不完整（SDK 流式补 args 的中间态）整体隐藏", () => {
    const asString = redactBrowserArgs("browser_fill_form", {
      fields: JSON.stringify([{ ref: "e1", value: "p@ssw0rd" }]),
    }) as { fields: string };
    expect(JSON.parse(asString.fields)).toEqual([{ ref: "e1", value: hidden(8) }]);
    expect(asString.fields).not.toContain("p@ssw0rd");

    const partial = '[{"ref":"e1","value":"p@ssw0';
    const out = redactBrowserArgs("browser_fill_form", { fields: partial }) as { fields: string };
    expect(out.fields).toBe(hidden(partial.length));
    expect(out.fields).not.toContain("p@ss");
  });

  it("args 本身是 JSON 字符串（流式中间态）：能解析就脱敏后再序列化，解析不了对会带明文的工具整体隐藏、对其它工具原样", () => {
    const ok = redactBrowserArgs("browser_type", '{"ref":"e1","text":"hunter2"}') as string;
    expect(JSON.parse(ok)).toEqual({ ref: "e1", text: hidden(7) });
    const broken = '{"ref":"e1","text":"hunt';
    expect(redactBrowserArgs("browser_type", broken)).toBe(hidden(broken.length));
    expect(redactBrowserArgs("browser_click", '{"ref":"e1')).toBe('{"ref":"e1');
  });

  it("browser_press_key：单字符 key 藏；Enter / Escape / Control+a / Meta+Enter 这类命名键 / 快捷键不动", () => {
    for (const key of ["a", "Z", "@", "7", " ", "你", "😀", "+"]) {
      expect((redactBrowserArgs("browser_press_key", { key }) as { key: string }).key, `key=${JSON.stringify(key)}`).toBe(hidden(1));
    }
    for (const key of ["Enter", "Escape", "Tab", "ArrowDown", "F5", "Control+a", "Meta+Enter", "Control+Shift+Tab", "Meta+c", "Alt+ArrowLeft"]) {
      const args = { key, ref: "e1" };
      expect(redactBrowserArgs("browser_press_key", args), `key=${key}`).toBe(args);
    }
  });

  it("browser_press_key：会打出字符的组合（Shift+a、Alt+@、AltGr / Ctrl+Alt+键）同样藏，ref 保留", () => {
    for (const key of ["Shift+a", "Alt+@", "Option+e", "AltGr+q", "Control+Alt+q", "Shift++"]) {
      expect(redactBrowserArgs("browser_press_key", { key, ref: "e2" }), `key=${key}`).toEqual({ key: hidden(1), ref: "e2" });
    }
  });

  it("browser_dialog：prompt_text 藏（页面可以问「请输入密码」）；action 不动", () => {
    expect(redactBrowserArgs("browser_dialog", { action: "accept", prompt_text: "s3cret" })).toEqual({
      action: "accept",
      prompt_text: hidden(6),
    });
    const noPrompt = { action: "dismiss" };
    expect(redactBrowserArgs("browser_dialog", noPrompt)).toBe(noPrompt);
  });

  it("Cursor SDK 路径：MCP 外壳（name=mcp，args={providerIdentifier,toolName,args:{…}}）里的真入参被藏，外壳字段保留", () => {
    const wrapped = {
      providerIdentifier: "custom-user-tools",
      toolName: "browser_type",
      args: { ref: "e5", text: "hunter2" },
    };
    const out = redactBrowserArgs("mcp", wrapped) as typeof wrapped;
    expect(out).toEqual({ ...wrapped, args: { ref: "e5", text: hidden(7) } });
    expect(wrapped.args.text).toBe("hunter2");

    const fill = {
      providerIdentifier: "custom-user-tools",
      toolName: "browser_fill_form",
      args: { fields: [{ ref: "e1", value: "abc" }] },
    };
    expect(redactBrowserArgs("mcp", fill)).toEqual({ ...fill, args: { fields: [{ ref: "e1", value: hidden(3) }] } });
    // 归一化后的展示名 mcp:<server>:<tool> 也认
    expect(redactBrowserArgs("mcp:custom-user-tools:browser_type", { ref: "e1", text: "abc" })).toEqual({ ref: "e1", text: hidden(3) });
    expect(
      redactBrowserArgs("mcp:custom-user-tools:browser_type", wrapped),
    ).toEqual({ ...wrapped, args: { ref: "e5", text: hidden(7) } });
  });

  it("不是浏览器工具的一律原样（包括 MCP 外壳里的别的工具、带 text 字段的别的工具）", () => {
    const shell = { command: "echo hi", text: "x" };
    expect(redactBrowserArgs("shell", shell)).toBe(shell);
    const submit = { providerIdentifier: "custom-user-tools", toolName: "submit_work", args: { text: "x" } };
    expect(redactBrowserArgs("mcp", submit)).toBe(submit);
    expect(redactBrowserArgs("mcp:feishu:send", { text: "x" })).toEqual({ text: "x" });
    expect(redactBrowserArgs(undefined, { text: "x" })).toEqual({ text: "x" });
    expect(redactBrowserArgs("browser_type", undefined)).toBeUndefined();
    expect(redactBrowserArgs("browser_type", null)).toBeNull();
  });

  it("redactBrowserToolCallMessage：有改动返回浅拷贝（args 已脱敏、其它字段保留），没改动返回原引用", () => {
    const msg = { type: "tool_call", call_id: "c1", name: "browser_type", status: "running", args: { ref: "e1", text: "abc" } };
    const out = redactBrowserToolCallMessage(msg);
    expect(out).not.toBe(msg);
    expect(out).toMatchObject({ type: "tool_call", call_id: "c1", name: "browser_type", status: "running", args: { text: hidden(3) } });
    expect(msg.args.text).toBe("abc");
    const click = { type: "tool_call", call_id: "c2", name: "browser_click", args: { ref: "e1" } };
    expect(redactBrowserToolCallMessage(click)).toBe(click);
  });
});

// ───────────── ② 事件落盘（SDK 与 pi 两条路径的咽喉） ─────────────

const leaseOk = () => true;
const newCtx = (extra: Partial<AssistantBufferCtx> = {}): AssistantBufferCtx => ({ buffer: "", flush: async () => {}, ...extra });

const written = (): WrittenEvent[] => writeOwnedEventAndPublish.mock.calls.map((c) => c[2] as WrittenEvent);
const appended = (): WrittenEvent[] => appendEvent.mock.calls.map((c) => c[1] as WrittenEvent);
/** 全部落盘 / 广播的内容序列化成一个字符串：明文不得出现在任何一处 */
const everything = (): string => JSON.stringify([written(), appended()]);

const toolCall = (name: string, args: unknown, status = "running", callId = "call-1") =>
  ({ type: "tool_call", call_id: callId, name, status, args }) as never;

beforeEach(() => {
  writeOwnedEventAndPublish.mockClear();
  appendEvent.mockClear();
  __resetToolCallRunningSeenForTest();
});

describe("handleSdkMessage：浏览器工具明文入参不落盘（text 摘要行与 meta.args 都查）", () => {
  it("pi 路径（裸名 browser_type）：events 里没有明文，有 [已隐藏 7 字符]；ref 仍在", async () => {
    await handleSdkMessage("t1", toolCall("browser_type", { ref: "e5", text: "hunter2" }), newCtx(), leaseOk);
    const [ev] = written();
    expect(ev?.kind).toBe("tool_call");
    expect(ev?.text).toContain(hidden(7));
    expect(ev?.text).not.toContain("hunter2");
    expect(String(ev?.meta?.args)).toContain(hidden(7));
    expect(String(ev?.meta?.args)).toContain('"ref":"e5"');
    expect(everything()).not.toContain("hunter2");
    expect(ev?.meta?.name).toBe("browser_type");
  });

  it("Cursor SDK 路径（name=mcp 外壳）：同样没有明文；落事件前已拆壳成扁平 browser_type（折叠行摘要按名字认它），外壳字段不再出现", async () => {
    await handleSdkMessage(
      "t1",
      toolCall("mcp", { providerIdentifier: "custom-user-tools", toolName: "browser_type", args: { ref: "e5", text: "hunter2" } }),
      newCtx(),
      leaseOk,
    );
    const [ev] = written();
    expect(everything()).not.toContain("hunter2");
    expect(String(ev?.meta?.args)).toContain(hidden(7));
    expect(String(ev?.meta?.args)).toContain('"ref":"e5"');
    // 拆壳（toBrowserDisplayCall）后与 pi 路径同形：name 是内层工具名、args 是扁平真入参
    expect(ev?.meta?.name).toBe("browser_type");
    expect(String(ev?.meta?.args)).not.toContain("custom-user-tools");
  });

  it("browser_fill_form：每个 value 都不落盘（pi 与 SDK 外壳各一次）", async () => {
    const fields = [
      { ref: "e1", value: "13800138000" },
      { ref: "e2", value: "6222020200112233445" },
      { ref: "e3", checked: true },
    ];
    await handleSdkMessage("t1", toolCall("browser_fill_form", { fields, submit_ref: "e9" }, "running", "c-pi"), newCtx(), leaseOk);
    await handleSdkMessage(
      "t1",
      toolCall("mcp", { providerIdentifier: "custom-user-tools", toolName: "browser_fill_form", args: { fields } }, "running", "c-sdk"),
      newCtx(),
      leaseOk,
    );
    expect(written()).toHaveLength(2);
    const all = everything();
    expect(all).not.toContain("13800138000");
    expect(all).not.toContain("6222020200112233445");
    expect(all).toContain(hidden(11));
    expect(all).toContain(hidden(19));
    expect(all).toContain('\\"checked\\":true'); // 结构信息还在
  });

  it("browser_press_key 单字符：藏；Enter 不动", async () => {
    await handleSdkMessage("t1", toolCall("browser_press_key", { key: "@" }, "running", "k1"), newCtx(), leaseOk);
    await handleSdkMessage("t1", toolCall("browser_press_key", { key: "Enter" }, "running", "k2"), newCtx(), leaseOk);
    const [a, b] = written();
    expect(String(a?.meta?.args)).toContain(hidden(1));
    expect(String(a?.meta?.args)).not.toContain("@");
    expect(String(b?.meta?.args)).toContain("Enter");
  });

  it("askSeen 消音审计路径（appendEvent，不是 writeEv）也要脱敏——这是第三处 tool_call 写入", async () => {
    await handleSdkMessage("t1", toolCall("browser_type", { ref: "e5", text: "hunter2" }), newCtx({ askSeen: true }), leaseOk);
    expect(written()).toHaveLength(0);
    const [ev] = appended();
    expect(ev?.kind).toBe("tool_call");
    expect(ev?.meta?.muted).toBe(true);
    expect(everything()).not.toContain("hunter2");
    expect(String(ev?.meta?.args)).toContain(hidden(7));
  });

  it("completed / error 的终态消息也带 args：落 tool_result 前同样脱敏（args 不会经 tool_result 泄露）", async () => {
    await handleSdkMessage("t1", toolCall("browser_type", { ref: "e5", text: "hunter2" }, "completed", "c-done"), newCtx(), leaseOk);
    await handleSdkMessage("t1", toolCall("browser_type", { ref: "e5", text: "hunter2" }, "error", "c-err"), newCtx(), leaseOk);
    expect(everything()).not.toContain("hunter2");
  });

  it("反例：别的工具的 args 原样落盘（shell 命令、browser_click 的 ref）", async () => {
    await handleSdkMessage("t1", toolCall("shell", { command: "echo hunter2" }, "running", "s1"), newCtx(), leaseOk);
    await handleSdkMessage("t1", toolCall("browser_click", { ref: "e12" }, "running", "s2"), newCtx(), leaseOk);
    const [sh, click] = written();
    expect(String(sh?.meta?.args)).toContain("echo hunter2");
    expect(String(click?.meta?.args)).toContain('"ref":"e12"');
  });

  it("工具真实入参不被改：传进来的 msg.args 对象执行完后仍是明文（模型与 SDK 手里的就是它）", async () => {
    const args = { ref: "e5", text: "hunter2" };
    await handleSdkMessage("t1", toolCall("browser_type", args), newCtx(), leaseOk);
    expect(args.text).toBe("hunter2");
  });
});
