/**
 * 改动面板快捷键解析：键位映射 / 修饰键 / 打字目标 / 输入法 / 长按规则。
 * 守的核心语义：宁可不触发也不能抢用户的输入、浏览器快捷键与输入法。
 */
import { describe, expect, it } from "vitest";

import {
  CHANGES_HOTKEY_HELP,
  resolveChangesHotkey,
  type ChangesHotkey,
  type HotkeyEventLike,
} from "@/lib/changes/hotkeys";

const ev = (key: string, extra: Partial<HotkeyEventLike> = {}): HotkeyEventLike => ({
  key,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  ...extra,
});

const target = (
  tagName: string,
  opts: { editable?: boolean; role?: string | null } = {},
): NonNullable<HotkeyEventLike["target"]> => ({
  tagName,
  isContentEditable: opts.editable ?? false,
  getAttribute: (name: string) => (name === "role" ? (opts.role ?? null) : null),
});

describe("键位映射", () => {
  const table: Array<[string, ChangesHotkey, Partial<HotkeyEventLike>?]> = [
    ["j", "nextFile"],
    ["k", "prevFile"],
    ["n", "nextChange"],
    ["p", "prevChange"],
    ["v", "viewedAndNext"],
    ["V", "toggleViewed", { shiftKey: true }],
    ["s", "toggleSplit"],
    ["w", "toggleIgnoreWs"],
    ["e", "toggleExpandAll"],
    ["/", "focusSearch"],
    ["f", "toggleWide"],
    ["t", "toggleTree"],
    ["?", "help", { shiftKey: true }],
  ];

  it.each(table)("%s → %s", (key, action, extra) => {
    expect(resolveChangesHotkey(ev(key, extra))).toBe(action);
  });

  it("所有动作都被某个按键覆盖到（映射表无遗漏）", () => {
    const all: ChangesHotkey[] = [
      "nextFile",
      "prevFile",
      "nextChange",
      "prevChange",
      "viewedAndNext",
      "toggleViewed",
      "toggleSplit",
      "toggleIgnoreWs",
      "toggleExpandAll",
      "focusSearch",
      "toggleWide",
      "toggleTree",
      "help",
    ];
    expect(table.map((r) => r[1]).sort()).toEqual([...all].sort());
  });

  it("未映射的字母 / 数字 / 符号返回 null", () => {
    for (const key of ["a", "z", "1", "0", "-", "=", ",", ".", "[", "]"]) {
      expect(resolveChangesHotkey(ev(key))).toBeNull();
    }
  });

  it("空 key 返回 null", () => {
    expect(resolveChangesHotkey(ev(""))).toBeNull();
  });
});

describe("大小写与 shift", () => {
  it("字母不区分大小写（CapsLock 打开时 key 为大写但无 shift）", () => {
    expect(resolveChangesHotkey(ev("J"))).toBe("nextFile");
    expect(resolveChangesHotkey(ev("S"))).toBe("toggleSplit");
  });

  it("v 与 shift+V 是两个动作", () => {
    expect(resolveChangesHotkey(ev("v"))).toBe("viewedAndNext");
    expect(resolveChangesHotkey(ev("V", { shiftKey: true }))).toBe("toggleViewed");
  });

  it("CapsLock 下 shift+v（key 为小写 v、shiftKey 为真）同样是 toggleViewed", () => {
    expect(resolveChangesHotkey(ev("v", { shiftKey: true }))).toBe("toggleViewed");
  });

  it("其余带 shift 的字母返回 null，避免误触", () => {
    for (const key of ["J", "K", "N", "P", "S", "W", "E", "F", "T", "j", "s"]) {
      expect(resolveChangesHotkey(ev(key, { shiftKey: true }))).toBeNull();
    }
  });

  it("? 无论 shiftKey 真假都是 help；/ 不看 shift", () => {
    expect(resolveChangesHotkey(ev("?", { shiftKey: true }))).toBe("help");
    expect(resolveChangesHotkey(ev("?", { shiftKey: false }))).toBe("help");
    expect(resolveChangesHotkey(ev("/", { shiftKey: true }))).toBe("focusSearch");
  });
});

describe("特殊键一律 null", () => {
  it("方向键 / Enter / Space / Esc / Tab / 其他命名键", () => {
    for (const key of [
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Enter",
      " ",
      "Escape",
      "Tab",
      "Backspace",
      "Delete",
      "Home",
      "End",
      "PageDown",
      "F5",
      "Shift",
      "Control",
      "Meta",
      "Alt",
      "Dead",
      "Unidentified",
    ]) {
      expect(resolveChangesHotkey(ev(key))).toBeNull();
      expect(resolveChangesHotkey(ev(key, { shiftKey: true }))).toBeNull();
    }
  });
});

describe("修饰键", () => {
  it("ctrl / meta / alt 任一为真都返回 null，不抢浏览器与系统快捷键", () => {
    for (const mod of ["ctrlKey", "metaKey", "altKey"] as const) {
      for (const key of ["j", "k", "v", "s", "/", "?", "f"]) {
        expect(resolveChangesHotkey(ev(key, { [mod]: true }))).toBeNull();
      }
    }
  });

  it("ctrl+shift+V 也返回 null", () => {
    expect(resolveChangesHotkey(ev("V", { ctrlKey: true, shiftKey: true }))).toBeNull();
  });

  it("纯 shift 修饰（? 与 V）仍放行", () => {
    expect(resolveChangesHotkey(ev("?", { shiftKey: true }))).toBe("help");
    expect(resolveChangesHotkey(ev("V", { shiftKey: true }))).toBe("toggleViewed");
  });
});

describe("事件目标：用户在打字时不抢键", () => {
  it.each(["input", "INPUT", "textarea", "TextArea", "select", "SELECT"])("目标 %s 返回 null", (tag) => {
    expect(resolveChangesHotkey(ev("j", { target: target(tag) }))).toBeNull();
    expect(resolveChangesHotkey(ev("/", { target: target(tag) }))).toBeNull();
  });

  it("contenteditable 返回 null", () => {
    expect(resolveChangesHotkey(ev("j", { target: target("DIV", { editable: true }) }))).toBeNull();
  });

  it.each(["textbox", "combobox", "searchbox", "TextBox"])("role=%s 返回 null", (role) => {
    expect(resolveChangesHotkey(ev("j", { target: target("DIV", { role }) }))).toBeNull();
  });

  it("普通元素（div / button / body）放行", () => {
    expect(resolveChangesHotkey(ev("j", { target: target("DIV") }))).toBe("nextFile");
    expect(resolveChangesHotkey(ev("j", { target: target("BUTTON", { role: "tab" }) }))).toBe("nextFile");
    expect(resolveChangesHotkey(ev("j", { target: target("BODY") }))).toBe("nextFile");
  });

  it("target 为 null / undefined / 缺字段时放行", () => {
    expect(resolveChangesHotkey(ev("j", { target: null }))).toBe("nextFile");
    expect(resolveChangesHotkey(ev("j"))).toBe("nextFile");
    expect(resolveChangesHotkey(ev("j", { target: {} }))).toBe("nextFile");
  });

  it("没有 getAttribute 的目标不会抛", () => {
    expect(resolveChangesHotkey(ev("j", { target: { tagName: "DIV" } }))).toBe("nextFile");
  });

  it("输入控件上 ? 与 shift+V 同样被拦截", () => {
    expect(resolveChangesHotkey(ev("?", { shiftKey: true, target: target("INPUT") }))).toBeNull();
    expect(resolveChangesHotkey(ev("V", { shiftKey: true, target: target("TEXTAREA") }))).toBeNull();
  });
});

describe("输入法组合", () => {
  it("isComposing 为真返回 null", () => {
    expect(resolveChangesHotkey(ev("j", { isComposing: true }))).toBeNull();
  });

  it("keyCode 229 返回 null（部分浏览器组合态只带这个）", () => {
    expect(resolveChangesHotkey(ev("j", { keyCode: 229 }))).toBeNull();
  });

  it("isComposing 为假、普通 keyCode 放行", () => {
    expect(resolveChangesHotkey(ev("j", { isComposing: false, keyCode: 74 }))).toBe("nextFile");
  });
});

describe("repeat（按住不放）", () => {
  it("j k n p 连发放行", () => {
    expect(resolveChangesHotkey(ev("j", { repeat: true }))).toBe("nextFile");
    expect(resolveChangesHotkey(ev("k", { repeat: true }))).toBe("prevFile");
    expect(resolveChangesHotkey(ev("n", { repeat: true }))).toBe("nextChange");
    expect(resolveChangesHotkey(ev("p", { repeat: true }))).toBe("prevChange");
  });

  it("切换类动作长按返回 null，避免反复翻转", () => {
    const toggles: Array<[string, Partial<HotkeyEventLike>?]> = [
      ["v"],
      ["V", { shiftKey: true }],
      ["s"],
      ["w"],
      ["e"],
      ["/"],
      ["f"],
      ["t"],
      ["?", { shiftKey: true }],
    ];
    for (const [key, extra] of toggles) {
      expect(resolveChangesHotkey(ev(key, { ...extra, repeat: true }))).toBeNull();
    }
  });

  it("repeat 为 false 时全部正常", () => {
    expect(resolveChangesHotkey(ev("s", { repeat: false }))).toBe("toggleSplit");
  });
});

describe("CHANGES_HOTKEY_HELP", () => {
  it("非空，且每条 keys 非空、label 非空", () => {
    expect(CHANGES_HOTKEY_HELP.length).toBeGreaterThan(0);
    for (const row of CHANGES_HOTKEY_HELP) {
      expect(row.keys.length).toBeGreaterThan(0);
      for (const k of row.keys) expect(k.trim().length).toBeGreaterThan(0);
      expect(row.label.trim().length).toBeGreaterThan(0);
    }
  });

  it("label 互不重复", () => {
    const labels = CHANGES_HOTKEY_HELP.map((r) => r.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("每个动作在帮助里都有一行（帮助条数 = 动作数）", () => {
    expect(CHANGES_HOTKEY_HELP).toHaveLength(13);
  });

  it("帮助里的单字符键位都能解析出动作（帮助不会骗人）", () => {
    for (const row of CHANGES_HOTKEY_HELP) {
      const shift = row.keys.includes("Shift");
      const key = row.keys[row.keys.length - 1];
      const action = resolveChangesHotkey(
        ev(shift ? key.toUpperCase() : key, { shiftKey: shift || key === "?" }),
      );
      expect(action).not.toBeNull();
    }
  });
});
