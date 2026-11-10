/* eslint-disable @typescript-eslint/no-explicit-any -- 假 tab / session 夹具与被测 .mjs 无类型声明，any 是刻意的 */
/**
 * R6-18：browser_clipboard 观察窗口缩短 + 必须有 AI 触发的页面动作 + 接管期间不返回。
 * R6-07：press_key 粘贴键的纯逻辑（isPasteCombo / 账本 / 裁决）与 write 写账本的接线。
 *   press_key 的集成用例（带 vm 假页面）在 tests/browser-r1-secret-input.test.ts 的「R6-07」一节。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { parseKeyCombo } from "../electron-app/browser/actions.mjs";
import { createActivityLog } from "../electron-app/browser/activity-log.mjs";
import {
  PASTE_CLIPBOARD_UNAVAILABLE_MESSAGE,
  PASTE_NOT_AI_CLIPBOARD_MESSAGE,
  WATCH_ARM_TTL_MS,
  WATCH_WINDOW_MS,
  aiWriteLedgerOf,
  createAiWriteLedger,
  createClipboardWatch,
  isPasteCombo,
  pasteRejection,
} from "../electron-app/browser/clipboard-policy.mjs";
import { createHandlers } from "../electron-app/browser/ops/clipboard.mjs";
import { BrowserSession } from "../electron-app/browser/session.mjs";
import { CLIPBOARD_NO_AI_ACTION_TEXT } from "../src/lib/server/browser/tools-clipboard";

const USER_SECRET = "用户原有的剪贴板：密码 hunter2-ORIGINAL";
const root = join(__dirname, "..");

describe("R6-18 clipboard-policy：窗口 ≤ 5s；变化必须发生在 AI 页面动作之后", () => {
  it("观察窗口 ≤ 5 秒（原 120 秒等同剪贴板监听）；等待首个 AI 动作的 TTL 另算，且不会比 5 秒窗口更宽地返回内容", () => {
    expect(WATCH_WINDOW_MS).toBeLessThanOrEqual(5_000);
    expect(WATCH_WINDOW_MS).toBeGreaterThan(0);
    expect(WATCH_ARM_TTL_MS).toBeGreaterThan(WATCH_WINDOW_MS);
  });

  it("窗口内没有 AI 动作：用户复制的内容一律 no_ai_action，不返回、不推进基线", () => {
    const w = createClipboardWatch();
    w.arm(USER_SECRET);
    expect(w.compare("用户新复制的 pw-1")).toEqual({ status: "no_ai_action" });
    expect(w.compare("用户又复制的 pw-2")).toEqual({ status: "no_ai_action" });
    expect(JSON.stringify(w)).not.toContain("pw-");
  });

  it("AI 动作之前用户复制的内容被排除（基线在首个 AI 动作时重定）；动作引起的变化才算 changed", () => {
    const w = createClipboardWatch();
    w.arm(USER_SECRET);
    // 用户在 AI 动作前自己复制了密码；AI 随后点击了一个无关按钮：此刻剪贴板 = 用户的密码
    expect(w.noteAiAction("用户复制的 pw-BEFORE")).toBe(true);
    expect(w.compare("用户复制的 pw-BEFORE")).toEqual({ status: "unchanged" });
    // AI 点的复制按钮之后剪贴板才变
    expect(w.compare("页面复制按钮放进来的")).toEqual({ status: "changed" });
  });

  it("只有窗口内第一次 AI 动作重定基线：之后的动作（如点完复制又点了别处）不能把真正的变化抹掉", () => {
    const w = createClipboardWatch();
    w.arm("base");
    expect(w.noteAiAction("base")).toBe(true);
    expect(w.noteAiAction("页面复制的")).toBe(false); // 复制按钮已经把剪贴板改了，第二次动作不重定
    expect(w.compare("页面复制的")).toEqual({ status: "changed" });
  });

  it("观察窗口从首个 AI 动作起算，5 秒后 expired；之后的变化不返回", () => {
    let t = 1_000;
    const w = createClipboardWatch({ now: () => t });
    w.arm("a");
    t += 10_000; // 等待期（< TTL）：不算过期
    expect(w.status()).toBe("armed");
    w.noteAiAction("a");
    t += WATCH_WINDOW_MS - 1;
    expect(w.compare("b")).toEqual({ status: "changed" });
    t += 2;
    expect(w.compare("c")).toEqual({ status: "expired" });
  });

  it("一直没有 AI 动作：等待超过 TTL 即 expired；过期后才来的 AI 动作不再生效", () => {
    let t = 1_000;
    const w = createClipboardWatch({ now: () => t });
    w.arm("a");
    t += WATCH_ARM_TTL_MS + 1;
    expect(w.status()).toBe("expired");
    expect(w.noteAiAction("a")).toBe(false);
    expect(w.compare("b")).toEqual({ status: "expired" });
  });

  it("未 arm 时 AI 动作不会顺带开启读取能力", () => {
    const w = createClipboardWatch();
    expect(w.noteAiAction("x")).toBe(false);
    expect(w.compare("y")).toEqual({ status: "not_armed" });
  });
});

// ───────────────────────── op（真 BrowserSession + 假 tab / 假剪贴板） ─────────────────────────

class FakeTab {
  ready = Promise.resolve();
  opener: string | null = null;
  hadRecentGesture = () => true;
  url = "https://example.com/";
  title = "t";
  destroy = vi.fn();
  setInputIgnored = vi.fn(async () => {});
  releaseHeldButtons = vi.fn(async () => {});
  overlaySetActive = vi.fn(async () => {});
  overlayHide = vi.fn(async () => {});
  moveToMain = vi.fn();
  moveToParking = vi.fn();
  setBounds = vi.fn();
  setVisible = vi.fn();
  capturePlaceholder = vi.fn(async () => null);
  constructor(public id: string) {}
  info(isActive: boolean) {
    return { id: this.id, url: this.url, title: this.title, favicon: null, loading: false, canGoBack: false, canGoForward: false, isActive };
  }
}

const setupOp = (initial = USER_SECRET) => {
  const hooksSeen: any[] = [];
  const host = {
    createTab: ({ id, hooks }: { id: string; hooks: unknown }) => {
      hooksSeen.push(hooks);
      return new FakeTab(id);
    },
    getMainWindow: () => ({}),
    getParkingWindow: () => ({}),
    onChange: vi.fn(),
    emitEvent: vi.fn(),
    emitPicked: vi.fn(),
    startPicker: () => ({ cancel: vi.fn() }),
  };
  const session = new BrowserSession({ taskId: "task-r6", host: host as never, activityLog: createActivityLog() });
  const clip = { text: initial };
  const electron = { clipboard: { readText: () => clip.text, writeText: (t: string) => void (clip.text = t) } };
  let now = 10_000;
  const handlers = createHandlers({ electron, getSession: () => session, ensureSession: () => session, now: () => now, log: vi.fn() });
  const call = (args: Record<string, unknown>) => handlers.clipboard("task-r6", args as never);
  return { session, clip, call, hooksSeen, advance: (ms: number) => (now += ms) };
};

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return "OK";
  } catch (err) {
    return (err as { code?: string }).code ?? "NO_CODE";
  }
};

describe("R6-18 op：窗口 / AI 动作 / 接管", () => {
  it("窗口内用户复制、没有任何 AI 页面动作：read = no_ai_action，结果里没有用户的内容", async () => {
    const s = setupOp();
    await s.call({ action: "watch_start" });
    s.clip.text = "用户在窗口内复制的密码 pw-USER-A";
    const r = await s.call({ action: "read" });
    expect(r).toEqual({ action: "read", status: "no_ai_action" });
    expect(JSON.stringify(r)).not.toContain("pw-USER-A");
  });

  it("用户先复制、AI 随后点了无关按钮：用户的内容不会被当成「AI 引起的变化」", async () => {
    const s = setupOp();
    await s.call({ action: "watch_start" });
    s.clip.text = "用户复制的 pw-USER-B"; // AI 动作之前
    s.session.notifyAiInput(); // AI 点了一下别的
    const r = await s.call({ action: "read" });
    expect(r).toEqual({ action: "read", status: "unchanged" });
    expect(JSON.stringify(r)).not.toContain("pw-USER-B");
  });

  it("AI 点复制按钮 → 剪贴板变 → read 拿到变化；窗口过 5 秒后同样的变化 = expired", async () => {
    const s = setupOp();
    await s.call({ action: "watch_start" });
    s.session.notifyAiInput();
    s.clip.text = "页面复制的内容";
    expect(((await s.call({ action: "read" })) as any).text).toBe("页面复制的内容");

    await s.call({ action: "watch_start" });
    s.session.notifyAiInput();
    s.advance(WATCH_WINDOW_MS + 1);
    s.clip.text = "窗口外才发生的变化 pw-LATE";
    const r = await s.call({ action: "read" });
    expect(r).toEqual({ action: "read", status: "expired" });
    expect(JSON.stringify(r)).not.toContain("pw-LATE");
  });

  it("watch_start 返回 5 秒窗口（windowSec），不再是 120", async () => {
    const s = setupOp();
    const w: any = await s.call({ action: "watch_start" });
    expect(w.windowSec).toBe(Math.round(WATCH_WINDOW_MS / 1000));
    expect(w.windowSec).toBeLessThanOrEqual(5);
  });

  it("接管期间：read / write / watch_start 都是 USER_CONTROL，不碰剪贴板", async () => {
    const s = setupOp();
    await s.call({ action: "watch_start" });
    s.session.notifyAiInput();
    s.session.controller = "user";
    s.clip.text = "用户接管时复制 pw-TAKEOVER";
    expect(await codeOf(s.call({ action: "read" }))).toBe("USER_CONTROL");
    expect(await codeOf(s.call({ action: "watch_start" }))).toBe("USER_CONTROL");
  });

  it("AI 动作之后用户接管又交还：watch 已作废，read = not_armed，不返回接管期间用户复制的内容", async () => {
    const s = setupOp();
    await s.call({ action: "watch_start" });
    s.session.notifyAiInput();
    s.session.controller = "user";
    s.clip.text = "用户在接管期间复制 pw-TAKEOVER";
    s.session.controller = "idle";
    const r = await s.call({ action: "read" });
    expect(r).toEqual({ action: "read", status: "not_armed" });
    expect(JSON.stringify(r)).not.toContain("pw-TAKEOVER");
  });

  it("接管期间发生的「AI 输入」通知不会让 watch 记下动作（controller=user 时监听直接忽略）", async () => {
    const s = setupOp();
    await s.call({ action: "watch_start" });
    const watch: any = s.session.getExt("clipboard", () => null);
    s.session.controller = "user"; // 触发 disarm
    s.session.notifyAiInput();
    expect(watch.status()).toBe("not_armed");
  });

  it("接线：tab 钩子 onAiInput → session.notifyAiInput → 剪贴板 watch 记下 AI 动作（真 session.openTab 路径）", async () => {
    const s = setupOp();
    await s.session.openTab({});
    const hooks = s.hooksSeen.at(-1);
    expect(typeof hooks.onAiInput).toBe("function");
    await s.call({ action: "watch_start" });
    s.clip.text = "用户先复制的 pw-PRE";
    hooks.onAiInput(); // 等价于 tab.withAiInput 入口
    s.clip.text = "页面复制按钮放进来的";
    expect(((await s.call({ action: "read" })) as any).text).toBe("页面复制按钮放进来的");
  });

  it("监听者抛错不影响 AI 输入（notifyAiInput 吞掉并记日志）", () => {
    const s = setupOp();
    s.session.onAiInput(() => {
      throw new Error("listener boom");
    });
    expect(() => s.session.notifyAiInput()).not.toThrow();
  });

  it("契约：tab.withAiInput 入口调用 hooks.onAiInput；session 把它接到 notifyAiInput", () => {
    const tabSrc = readFileSync(join(root, "electron-app/browser/tab.mjs"), "utf8");
    expect(tabSrc).toMatch(/async withAiInput\(fn\) \{[\s\S]{0,400}this\.hooks\.onAiInput\?\.\(\)/);
    const sessSrc = readFileSync(join(root, "electron-app/browser/session.mjs"), "utf8");
    expect(sessSrc).toContain("onAiInput: () => this.notifyAiInput()");
  });

  it("server 工具：no_ai_action 有专门的话术，指向点击 / 按键触发复制", () => {
    expect(CLIPBOARD_NO_AI_ACTION_TEXT).toContain("browser_click");
    expect(CLIPBOARD_NO_AI_ACTION_TEXT).toContain("5 秒");
  });
});

// ───────────────────────── R6-07 纯逻辑 ─────────────────────────

describe("R6-07 isPasteCombo：Ctrl/Cmd+V / Shift+Insert，大小写与修饰键顺序宽容", () => {
  it.each(["Control+v", "Control+V", "control+v", "ctrl+v", "Meta+v", "Cmd+v", "meta+V", "Shift+Control+v", "Control+Shift+v", "Control+Alt+v", "Shift+Insert", "shift+insert", "SHIFT+INSERT"])(
    "%s 是粘贴",
    (k) => {
      expect(isPasteCombo(parseKeyCombo(k))).toBe(true);
    },
  );
  it.each(["Control+c", "Control+x", "Control+a", "Meta+z", "v", "V", "Insert", "Control+Insert", "Alt+v", "Shift+v", "Enter", "Tab", "Shift+Delete"])("%s 不是粘贴", (k) => {
    expect(isPasteCombo(parseKeyCombo(k))).toBe(false);
  });
  it("脏入参不抛错：null / 空对象 → false", () => {
    expect(isPasteCombo(null)).toBe(false);
    expect(isPasteCombo({})).toBe(false);
  });
});

describe("R6-07 账本 / 裁决：只存摘要；与 AI 最近一次写入一致才放行", () => {
  it("一致放行；用户改写后拒绝；从未写入拒绝；AI 再次写入后以最新一次为准", () => {
    const l = createAiWriteLedger();
    expect(pasteRejection(l, "x")).toBe(PASTE_NOT_AI_CLIPBOARD_MESSAGE); // 从未写入
    l.record("AI v1");
    expect(pasteRejection(l, "AI v1")).toBeNull();
    expect(pasteRejection(l, "用户后来复制的")).toBe(PASTE_NOT_AI_CLIPBOARD_MESSAGE);
    l.record("AI v2");
    expect(pasteRejection(l, "AI v1")).toBe(PASTE_NOT_AI_CLIPBOARD_MESSAGE);
    expect(pasteRejection(l, "AI v2")).toBeNull();
    l.clear();
    expect(pasteRejection(l, "AI v2")).toBe(PASTE_NOT_AI_CLIPBOARD_MESSAGE);
  });

  it("读不到剪贴板（非字符串）→ unavailable 文案；没有账本 → 拒", () => {
    const l = createAiWriteLedger();
    l.record("a");
    expect(pasteRejection(l, undefined)).toBe(PASTE_CLIPBOARD_UNAVAILABLE_MESSAGE);
    expect(pasteRejection(l, null as never)).toBe(PASTE_CLIPBOARD_UNAVAILABLE_MESSAGE);
    expect(pasteRejection(null, "a")).toBe(PASTE_NOT_AI_CLIPBOARD_MESSAGE);
  });

  it("账本序列化不含原文（只存 sha256）", () => {
    const l = createAiWriteLedger();
    l.record("AI-WRITTEN-SECRET-xyz");
    expect(JSON.stringify(l)).not.toContain("xyz");
    expect(JSON.stringify(l)).toBe('{"written":true}');
  });

  it("拒绝文案自修复：说明不是本轮写入 / 保护用户剪贴板，指向 browser_type 或先 write", () => {
    expect(PASTE_NOT_AI_CLIPBOARD_MESSAGE).toContain("系统剪贴板不是你本轮写入的内容，已拒绝粘贴以保护用户剪贴板");
    expect(PASTE_NOT_AI_CLIPBOARD_MESSAGE).toContain("browser_type");
    expect(PASTE_NOT_AI_CLIPBOARD_MESSAGE).toContain("browser_clipboard write");
  });

  it("aiWriteLedgerOf：session 不支持 getExt → null；同一 session 复用同一账本", () => {
    expect(aiWriteLedgerOf(null)).toBeNull();
    expect(aiWriteLedgerOf({})).toBeNull();
    const s = setupOp();
    expect(aiWriteLedgerOf(s.session)).toBe(aiWriteLedgerOf(s.session));
  });
});

describe("R6-07 op：browser_clipboard write 写账本；接管 / 销毁清账本", () => {
  it("write 之后账本与剪贴板一致 → 粘贴放行；用户之后复制了别的 → 拒", async () => {
    const s = setupOp();
    await s.call({ action: "write", text: "AI 写的 token" });
    const ledger = aiWriteLedgerOf(s.session)!;
    expect(pasteRejection(ledger, s.clip.text)).toBeNull();
    s.clip.text = "用户后来复制的密码 pw-USER-C";
    expect(pasteRejection(ledger, s.clip.text)).toBe(PASTE_NOT_AI_CLIPBOARD_MESSAGE);
  });

  it("没写过：账本为空（不因 watch_start / read 而放行粘贴）", async () => {
    const s = setupOp();
    await s.call({ action: "watch_start" });
    s.session.notifyAiInput();
    const ledger = aiWriteLedgerOf(s.session)!;
    expect(pasteRejection(ledger, s.clip.text)).toBe(PASTE_NOT_AI_CLIPBOARD_MESSAGE);
  });

  it("用户接管后账本清空：交还后即使剪贴板碰巧还是 AI 写的内容也不再放行（「本轮」已结束）", async () => {
    const s = setupOp();
    await s.call({ action: "write", text: "AI 写的" });
    const ledger = aiWriteLedgerOf(s.session)!;
    s.session.controller = "user";
    s.session.controller = "idle";
    expect(ledger.hasWritten()).toBe(false);
    expect(pasteRejection(ledger, "AI 写的")).toBe(PASTE_NOT_AI_CLIPBOARD_MESSAGE);
  });

  it("会话销毁清账本", async () => {
    const s = setupOp();
    await s.call({ action: "write", text: "AI 写的" });
    const ledger = aiWriteLedgerOf(s.session)!;
    s.session.destroy();
    expect(ledger.hasWritten()).toBe(false);
  });
});
