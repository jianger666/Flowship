/**
 * 全局快捷键处理器（Cmd+B 切侧栏 / Cmd+K 搜索面板 / Cmd+N 新建对话）的行为测试。
 *
 * 复审指出：原先 Cmd+B 对 contentEditable 让行，但主输入条是 Lexical PlainTextPlugin 的 ContentEditable，
 * 于是主输入条里 Cmd+B 仍然失效；旧契约测试只匹配源码字符串、区分不了「主输入条 / contentEditable」。
 * 这里改成真正调处理器：模拟焦点在 contentEditable（= 主输入条）上，断言照样触发。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isModCombo } from "@/lib/keyboard-shortcuts";
import { createModHotkeyHandler, isSidebarToggleCombo } from "@/components/hotkey-handler";

interface Ev {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  preventDefault: () => void;
}
const ev = (over: Partial<Ev> = {}): Ev => ({
  key: "b",
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
  preventDefault: vi.fn(),
  ...over,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isSidebarToggleCombo", () => {
  it("Cmd+B / Ctrl+B（大小写不敏感）命中；单按 B / 别的键不命中", () => {
    expect(isSidebarToggleCombo(ev())).toBe(true);
    expect(isSidebarToggleCombo(ev({ key: "B" }))).toBe(true);
    expect(isSidebarToggleCombo(ev({ metaKey: false, ctrlKey: true }))).toBe(true);
    expect(isSidebarToggleCombo(ev({ metaKey: false }))).toBe(false);
    expect(isSidebarToggleCombo(ev({ key: "k" }))).toBe(false);
  });
});

describe("createModHotkeyHandler", () => {
  it("命中：preventDefault + 触发一次", () => {
    const run = vi.fn();
    const e = ev();
    createModHotkeyHandler(isSidebarToggleCombo, run)(e);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("长按 repeat 帧：照样吞掉默认行为，但不重复触发", () => {
    const run = vi.fn();
    const e = ev({ repeat: true });
    createModHotkeyHandler(isSidebarToggleCombo, run)(e);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });

  it("没命中：既不 preventDefault 也不触发（不劫持别的键）", () => {
    const run = vi.fn();
    const e = ev({ key: "x" });
    createModHotkeyHandler(isSidebarToggleCombo, run)(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("⌘⇧B / ⌘⌥B 不触发（与 ⌘K / ⌘N 同一口径：不吃 Shift / Alt，不劫持系统位）", () => {
    for (const mod of [{ shiftKey: true }, { altKey: true }, { shiftKey: true, altKey: true }]) {
      const run = vi.fn();
      const e = ev(mod);
      createModHotkeyHandler(isSidebarToggleCombo, run)(e);
      expect(e.preventDefault, JSON.stringify(mod)).not.toHaveBeenCalled();
      expect(run, JSON.stringify(mod)).not.toHaveBeenCalled();
    }
  });

  it("mac 壳里只认 ⌘B：Ctrl+B（Emacs 式光标左移）不被拦、也不切侧栏；Windows 壳里 Ctrl+B 照常切", () => {
    const cases: Array<[string, Partial<Ev>, boolean]> = [
      ["darwin", { metaKey: true, ctrlKey: false }, true],
      ["darwin", { metaKey: false, ctrlKey: true }, false],
      ["win32", { metaKey: false, ctrlKey: true }, true],
      ["linux", { metaKey: false, ctrlKey: true }, true],
    ];
    for (const [platform, mods, fires] of cases) {
      vi.stubGlobal("window", { __shell: { platform } });
      const run = vi.fn();
      const e = ev(mods);
      createModHotkeyHandler(isSidebarToggleCombo, run)(e);
      expect(run, `${platform} ${JSON.stringify(mods)}`).toHaveBeenCalledTimes(fires ? 1 : 0);
      expect(e.preventDefault, `${platform} ${JSON.stringify(mods)}`).toHaveBeenCalledTimes(fires ? 1 : 0);
    }
  });

  it("处理器不读焦点：document.activeElement 一被访问就抛——有人把「对 contentEditable 让行」加回来这里会红", () => {
    // 旧实现读 document.activeElement.isContentEditable 并让行，主输入条（Lexical PlainTextPlugin 的 ContentEditable）里
    // ⌘B 整个失效。这个用例不模拟「焦点在哪」（处理器根本不该关心），而是断言处理器从不碰焦点；
    // app-shell 侧不再读焦点另有接线断言（下面「接线」一组）。
    vi.stubGlobal("document", {
      get activeElement(): never {
        throw new Error("hotkey handler 不应读取 document.activeElement");
      },
    });
    const run = vi.fn();
    expect(() => createModHotkeyHandler(isSidebarToggleCombo, run)(ev())).not.toThrow();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("Cmd+K / Cmd+N 同款：isModCombo 命中触发、repeat 只吞默认行为", () => {
    for (const key of ["k", "n"]) {
      const run = vi.fn();
      const handler = createModHotkeyHandler((e: Ev) => isModCombo(e, key), run);
      const first = ev({ key });
      handler(first);
      const held = ev({ key, repeat: true });
      handler(held);
      expect(first.preventDefault).toHaveBeenCalledTimes(1);
      expect(held.preventDefault).toHaveBeenCalledTimes(1);
      expect(run, key).toHaveBeenCalledTimes(1);
      // 带 Shift 的组合键不归我们（isModCombo 不吃 Shift）
      const shifted = ev({ key, shiftKey: true });
      handler(shifted);
      expect(shifted.preventDefault).not.toHaveBeenCalled();
    }
  });
});

describe("接线（语义）：三处都走 createModHotkeyHandler；Cmd+B 的前提「全仓没有富文本」成立", () => {
  const read = (rel: string): string => readFileSync(path.join(process.cwd(), rel), "utf8");

  it("app-shell：Cmd+B 处理函数用 createModHotkeyHandler、且不再读焦点元素", () => {
    const src = read("src/components/app-shell.tsx");
    const start = src.indexOf("Cmd/Ctrl+B 切侧栏");
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start, src.indexOf("Cmd/Ctrl+F", start));
    expect(body).toContain("createModHotkeyHandler(isSidebarToggleCombo, toggleSidebar)");
    expect(body).not.toContain("activeElement");
    expect(body).not.toContain("isContentEditable");
  });

  it("global-shortcuts / search-dialog：Cmd+N / Cmd+K 走同一个处理器工厂", () => {
    expect(read("src/components/global-shortcuts.tsx")).toContain("createModHotkeyHandler(");
    expect(read("src/components/search-dialog.tsx")).toContain("createModHotkeyHandler(");
  });

  it("全仓没有富文本编辑器：无 RichTextPlugin / FORMAT_TEXT_COMMAND（Cmd+B 在任何编辑区都没有「加粗」语义）", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name)) {
          const s = readFileSync(full, "utf8");
          if (/RichTextPlugin|FORMAT_TEXT_COMMAND|registerRichText/.test(s)) hits.push(full);
        }
      }
    };
    walk(path.join(process.cwd(), "src"));
    expect(hits).toEqual([]);
    // 主输入条确实是纯文本 Lexical
    expect(read("src/components/composer-editor.tsx")).toContain("PlainTextPlugin");
  });
});
