/* eslint-disable @typescript-eslint/no-explicit-any -- 假 tab / 假 CDP 结果是任意 JSON，逐处标类型没有收益 */
/**
 * R1-29 复审（读页面侧，主进程出口）：inspect 的 sanitizeInspectResult 再保险与 handler 对 htmlNote 的透传。
 * 页内脚本本身（配对失败 → html 置空）的行为在 tests/browser-v2-page-read.test.ts，picker 在 tests/browser-picker.test.ts。
 */
import { describe, expect, it, vi } from "vitest";

import { createHandlers, sanitizeInspectResult } from "../electron-app/browser/ops/read.mjs";

describe("R1-29 复审：sanitizeInspectResult 再保险", () => {
  it("attrs：type=hidden 的 value 也不给（CSRF 等）；无 type 但 autocomplete=cc-* / one-time-code 的 input 与 textarea 同样；普通 input 照给", () => {
    const hidden = sanitizeInspectResult({ tag: "input", attrs: { type: "HIDDEN", name: "csrf", value: "CSRF-1" } }) as any;
    expect(hidden.attrs).toEqual({ type: "HIDDEN", name: "csrf" });
    const card = sanitizeInspectResult({ tag: "input", attrs: { autocomplete: "billing cc-number", value: "4111" } }) as any;
    expect(card.attrs.value).toBeUndefined();
    const area = sanitizeInspectResult({ tag: "textarea", attrs: { autocomplete: "one-time-code", value: "123456" } }) as any;
    expect(area.attrs.value).toBeUndefined();
    const plain = sanitizeInspectResult({ tag: "input", attrs: { type: "text", value: "alice" } }) as any;
    expect(plain.attrs.value).toBe("alice");
    // 不是 input / textarea 的 value 属性照常给
    expect((sanitizeInspectResult({ tag: "li", attrs: { type: "hidden", value: "3" } }) as any).attrs.value).toBe("3");
  });

  it("html：字符串级再清一遍 hidden / 密码 / style 遮罩 input 的 value（页内漏了也不外传）；普通 textarea 的默认文本保留", () => {
    const out = sanitizeInspectResult({
      tag: "form",
      html:
        '<form><input type="hidden" value="CSRF-2"><input type="password" value="pw2">' +
        '<input type="text" value="MASK-2" style="-webkit-text-security: disc"><input type="text" value="keep-2">' +
        "<textarea>默认文本</textarea></form>",
    }) as any;
    for (const s of ["CSRF-2", "pw2", "MASK-2"]) expect(out.html).not.toContain(s);
    expect(out.html).toContain("keep-2");
    expect(out.html).toContain("默认文本");
  });

  it("htmlNote：字符串原样透传（≤300）；非字符串不出现在结果里；不改入参", () => {
    const input = { tag: "form", html: "", htmlNote: "x".repeat(400) };
    const out = sanitizeInspectResult(input) as any;
    expect(out.html).toBe("");
    expect(out.htmlNote).toHaveLength(300);
    expect(input.htmlNote).toHaveLength(400);
    expect("htmlNote" in (sanitizeInspectResult({ tag: "form", htmlNote: 5 }) as any)).toBe(false);
    expect("htmlNote" in (sanitizeInspectResult({ tag: "form" }) as any)).toBe(false);
  });
});

describe("R1-29 复审：inspect handler 把页内脚本的 htmlNote 带给调用方", () => {
  const makeHandlers = (scriptResult: Record<string, unknown>) => {
    const tab: any = {
      id: "t1",
      url: "https://a.test/",
      title: "页",
      mainFrameId: "F1",
      ensureCdp: async () => {},
      resolveRef: vi.fn(() => ({ backendNodeId: 9, sessionId: null, role: "form", name: "登录" })),
      send: vi.fn(async (method: string) => {
        if (method === "Page.createIsolatedWorld") return { executionContextId: 5 };
        if (method === "DOM.resolveNode") return { object: { objectId: "obj1" } };
        if (method === "Runtime.callFunctionOn") return { result: { value: scriptResult } };
        return {};
      }),
    };
    const handlers = createHandlers({
      requireSession: () => ({ getTab: () => tab }),
      getConfig: () => ({}),
      abortable: (p: Promise<unknown>) => p,
      scheduleState: vi.fn(),
      app: { getPath: () => "/tmp" },
      now: () => new Date(2026, 10, 8, 12, 0, 0),
      actions: { callOnNode: vi.fn() },
      log: () => {},
    } as any);
    return handlers;
  };

  it("html 为空串 + htmlNote → 结果里 html 仍是空串（不是 undefined）且带 htmlNote；没有 htmlNote 的正常结果不带该字段", async () => {
    const withheld = (await makeHandlers({ tag: "form", html: "", htmlNote: "html 已隐藏：配对失败" }).inspect("task", { ref: "e1", include: ["html"] }, undefined)) as any;
    expect(withheld.html).toBe("");
    expect(withheld.htmlNote).toBe("html 已隐藏：配对失败");
    const normal = (await makeHandlers({ tag: "form", html: "<form></form>" }).inspect("task", { ref: "e1", include: ["html"] }, undefined)) as any;
    expect(normal.html).toBe("<form></form>");
    expect(normal).not.toHaveProperty("htmlNote");
  });
});
