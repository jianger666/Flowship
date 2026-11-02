/**
 * 快捷键界面文案按平台显示 + ⌘J 走 isModCombo 的口径测试（第 5 轮 P3）
 *
 * 背景：上一轮把 mac 上的全局快捷键收窄成只认 ⌘（isModCombo / isSidebarToggleCombo），
 * 但界面文案还写「Cmd/Ctrl+K」「⌘/Ctrl+B」，⌘J 的监听还是 `metaKey || ctrlKey`。
 * - 文案：mac 显示 ⌘、其它平台显示 Ctrl，复用 platform-shortcuts 的平台判断 + useShellPlatform（SSR / 首屏为 ""，
 *   mount 后才切到 mac，不会 hydration 不一致）；
 * - ⌘J：与其它 mod 快捷键同口径（isModCombo）。
 *
 * 渲染没有 jsdom：文案的行为部分测纯函数 getModShortcutLabel，组件接线用源码契约。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { getModShortcutLabel, isModCombo, type KeyComboEvent } from "@/lib/keyboard-shortcuts";
import { getModFShortcutLabel } from "@/lib/platform-shortcuts";

const read = (rel: string): string => readFileSync(path.join(process.cwd(), rel), "utf8");

const key = (partial: Partial<KeyComboEvent> & { key: string }): KeyComboEvent => ({
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...partial,
});

describe("getModShortcutLabel（mac ⌘ / 其它 Ctrl）", () => {
  it("darwin 写 ⌘ + 键（无加号）", () => {
    for (const k of ["K", "N", "B", "J", "End"]) {
      expect(getModShortcutLabel("darwin", k)).toBe(`⌘${k}`);
    }
  });

  it("win32 / linux / 平台未知（SSR、首屏、无壳）写 Ctrl+键", () => {
    for (const platform of ["win32", "linux", ""] as const) {
      for (const k of ["K", "N", "B", "J", "End"]) {
        expect(getModShortcutLabel(platform, k), `${platform}/${k}`).toBe(`Ctrl+${k}`);
      }
    }
  });

  it("任何平台都不再出现笼统的 Cmd/Ctrl / ⌘/Ctrl", () => {
    for (const platform of ["darwin", "win32", "linux", ""] as const) {
      const label = getModShortcutLabel(platform, "K");
      expect(label).not.toContain("Cmd/Ctrl");
      expect(label).not.toContain("⌘/Ctrl");
    }
  });

  it("与 platform-shortcuts 的 ⌘F / Ctrl+F 是同一套（getModFShortcutLabel === getModShortcutLabel(.., 'F')）", () => {
    for (const platform of ["darwin", "win32", "linux", ""] as const) {
      expect(getModShortcutLabel(platform, "F"), platform).toBe(getModFShortcutLabel(platform));
    }
  });

  it("文案与判定同口径：文案写 ⌘ 的平台判定只认 metaKey；文案写 Ctrl 的平台 ctrlKey 命中", () => {
    for (const k of ["k", "n", "b", "j"]) {
      expect(getModShortcutLabel("darwin", k.toUpperCase())).toMatch(/^⌘/);
      expect(isModCombo(key({ key: k, metaKey: true }), k, "darwin")).toBe(true);
      expect(isModCombo(key({ key: k, ctrlKey: true }), k, "darwin")).toBe(false);
      expect(getModShortcutLabel("win32", k.toUpperCase())).toMatch(/^Ctrl\+/);
      expect(isModCombo(key({ key: k, ctrlKey: true }), k, "win32")).toBe(true);
    }
  });
});

describe("⌘J（聚焦输入条）走 isModCombo 的口径", () => {
  it("darwin：只认 ⌘J；Ctrl+J 不命中；带 Shift / Alt 不命中", () => {
    expect(isModCombo(key({ key: "j", metaKey: true }), "j", "darwin")).toBe(true);
    expect(isModCombo(key({ key: "J", metaKey: true }), "j", "darwin")).toBe(true);
    expect(isModCombo(key({ key: "j", ctrlKey: true }), "j", "darwin")).toBe(false);
    expect(isModCombo(key({ key: "j", metaKey: true, shiftKey: true }), "j", "darwin")).toBe(false);
    expect(isModCombo(key({ key: "j", metaKey: true, altKey: true }), "j", "darwin")).toBe(false);
  });

  it("win32 / linux：Ctrl+J 命中；带 Shift / Alt 不命中", () => {
    for (const platform of ["win32", "linux"] as const) {
      expect(isModCombo(key({ key: "j", ctrlKey: true }), "j", platform), platform).toBe(true);
      expect(isModCombo(key({ key: "j", ctrlKey: true, shiftKey: true }), "j", platform), platform).toBe(false);
      expect(isModCombo(key({ key: "j", ctrlKey: true, altKey: true }), "j", platform), platform).toBe(false);
    }
  });

  it("task-talk-composer：⌘J 监听走 isModCombo(e, \"j\")，不再手写 metaKey || ctrlKey", () => {
    const src = read("src/components/tasks/task-talk-composer.tsx");
    const start = src.indexOf("const focusInput = rich.focus;");
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start, src.indexOf("}, [focusInput]);", start));
    expect(body).toContain('if (!isModCombo(e, "j")) return;');
    expect(body).not.toMatch(/metaKey|ctrlKey/);
    // 仍是「命中就 preventDefault + 聚焦」
    expect(body).toContain("e.preventDefault();");
    expect(body).toContain("focusInput();");
    expect(src).toMatch(/import \{[^}]*\bisModCombo\b[^}]*\} from "@\/lib\/keyboard-shortcuts";/);
  });
});

describe("界面文案接线（不再写死 Cmd/Ctrl / ⌘/Ctrl）", () => {
  it("快捷键表：K / N / B / J / End 五行都按平台出文案、平台来自 useShellPlatform（SSR 安全）", () => {
    const src = read("src/components/keyboard-shortcuts-dialog.tsx");
    expect(src).toContain("useShellPlatform()");
    expect(src).not.toMatch(/getShellPlatform\(/);
    for (const [label, k] of [
      ["搜索对话", "K"],
      ["新建对话", "N"],
      ["切换侧栏", "B"],
      ["聚焦输入框（任务页）", "J"],
      ["回到最新（事件流）", "End"],
    ] as const) {
      expect(src, label).toContain(
        `{ label: "${label}", keys: [getModShortcutLabel(platform, "${k}")] }`,
      );
    }
    // 搜索此栏仍走 platform-shortcuts 的 ⌘F / Ctrl+F（别的测试也盯着这条）
    expect(src).toContain("getModFShortcutLabel(platform)");
    expect(src).not.toMatch(/["'`]Cmd\/Ctrl\+/);
  });

  it("顶栏侧栏 toggle tooltip：用 getModShortcutLabel(平台, \"B\")，平台是 mount 后才读的 state（不在 render 里直接读壳）", () => {
    const src = read("src/components/app-header.tsx");
    expect(src).toContain('getModShortcutLabel(normalizeShellPlatform(platform), "B")');
    expect(src).toContain("`${sidebarOpen ? \"收起侧栏\" : \"展开侧栏\"}（${sidebarToggleKeys}）`");
    expect(src).not.toContain("⌘/Ctrl+B");
    expect(src).not.toMatch(/getShellPlatform\(/);
    // 平台 state 初值为 ""、只在 effect 里读 window.__shell（SSR 与首次客户端渲染一致）
    expect(src).toContain('const [platform, setPlatform] = useState("");');
    expect(src).toMatch(/useEffect\(\(\) => \{\s*setPlatform\(window\.__shell\?\.platform \?\? ""\);\s*\}, \[\]\);/);
  });

  it("输入条 placeholder：⌘J / Ctrl+J 按平台显示、平台来自 useShellPlatform", () => {
    const src = read("src/components/tasks/task-talk-composer.tsx");
    expect(src).toContain("const shellPlatform = useShellPlatform();");
    expect(src).toContain('getModShortcutLabel(shellPlatform, "J")');
    expect(src).not.toContain("⌘/Ctrl+J");
    expect(src).not.toMatch(/getShellPlatform\(/);
  });

  it("全仓 src 不再有 ⌘/Ctrl 字面量，也没有「Cmd/Ctrl+K|N|B|J|End」字符串字面量（注释里的泛称不管）", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name)) {
          const s = readFileSync(full, "utf8");
          if (s.includes("⌘/Ctrl")) hits.push(`${full} ⌘/Ctrl`);
          if (/["'`]Cmd\/Ctrl\+(K|N|B|J|End)\b/.test(s)) hits.push(`${full} Cmd/Ctrl+字面量`);
        }
      }
    };
    walk(path.join(process.cwd(), "src"));
    expect(hits).toEqual([]);
  });

  it("keyboard-shortcuts 的 isModCombo 注释已订正：不再说「界面文案也只写 ⌘」，改为按平台显示", () => {
    const src = read("src/lib/keyboard-shortcuts.ts");
    expect(src).not.toContain("界面文案也只写 ⌘");
    expect(src).toContain("界面文案对应按平台显示");
  });
});
