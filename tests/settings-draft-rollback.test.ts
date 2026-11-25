/**
 * S-5 / R20-10：保存被拒 / 重试放弃之后，boolean 开关与单选类字段的草稿回滚成已保存值
 * （src/lib/settings-draft-rollback.ts + src/hooks/use-settings.ts）。
 *
 * 背景：saveFieldValue 是乐观更新，失败后 savedSettings 不动、字段保持 dirty。5xx / 网络错误会自动重试（草稿停在新值合理）；
 * 但服务端 4xx 拒绝或重试放弃之后，草稿还停在新值、磁盘却是旧值——对「限制群里非宿主成员」这类保护类开关，界面显示已开、实际没开；
 * 单选控件（提供方 / 默认模型 / IDE / 链接打开方式 / 角色 / 提交快捷键 / 标签上限）同理，且字段一直 dirty、离页被 beforeunload 一直拦（第二十轮评审 R20-10）。
 * 决定：回滚 boolean 开关 + 单选类字段（CHOICE_FIELDS）；文本框 / 整块编辑的列表对象保持现状（回滚会吃掉用户刚输入的内容 / 盖掉并发修改）；首次失败（还会重试）不回滚。
 *
 * 三层：① 纯函数的真值表；② 分类对账（每个设置字段都必须归类：开关 / 单选 / 明写不回滚的，新增字段忘了归类就红）；
 * ③ 对 use-settings.ts 源码结构的钉子（三个出口都调回滚、首次失败的 onFailed 不调、ref 每次渲染同步）。
 * 看不到真实的 React 重渲染 / toast（没有 jsdom 渲染 hook），那一步要在 Electron 里手点（让 PUT /api/settings 回 400 / 一直回 500）。
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  applyDraftRollback,
  CHOICE_FIELDS,
  CHOICE_RESTORED_NOTE,
  rollbackBooleanDraft,
  rollbackChoiceDraft,
  SWITCH_RESTORED_NOTE,
  withRestoredNote,
} from "@/lib/settings-draft-rollback";

describe("rollbackBooleanDraft：boolean 开关", () => {
  it("草稿 true、已保存 false → 回滚成 false；草稿 false、已保存 true → 回滚成 true", () => {
    expect(rollbackBooleanDraft(true, false)).toEqual({ rollback: true, value: false });
    expect(rollbackBooleanDraft(false, true)).toEqual({ rollback: true, value: true });
  });

  it("草稿与已保存相同 → 不回滚（没东西可回）", () => {
    expect(rollbackBooleanDraft(true, true)).toEqual({ rollback: false });
    expect(rollbackBooleanDraft(false, false)).toEqual({ rollback: false });
  });

  it("非 boolean 字段不走这个函数：字符串 / 数字 / 数组 / 对象（回滚会吃掉用户刚输入的内容；单选类另有 rollbackChoiceDraft）", () => {
    expect(rollbackBooleanDraft("新输入的 token", "旧 token")).toEqual({ rollback: false });
    expect(rollbackBooleanDraft(30, 20)).toEqual({ rollback: false });
    expect(rollbackBooleanDraft(["a", "b"], ["a"])).toEqual({ rollback: false });
    expect(rollbackBooleanDraft({ order: ["x"] }, { order: [] })).toEqual({ rollback: false });
  });

  it("已保存值不是 boolean（取不到 / 字段缺省）→ 没有可信的回滚目标，不回滚", () => {
    expect(rollbackBooleanDraft(true, undefined)).toEqual({ rollback: false });
    expect(rollbackBooleanDraft(true, null)).toEqual({ rollback: false });
    expect(rollbackBooleanDraft(true, "false")).toEqual({ rollback: false });
  });

  it("草稿不是 boolean（undefined / 字符串 'true'）→ 不回滚", () => {
    expect(rollbackBooleanDraft(undefined, true)).toEqual({ rollback: false });
    expect(rollbackBooleanDraft("true", false)).toEqual({ rollback: false });
  });
});

describe("rollbackChoiceDraft（R20-10）：单选 / 步进类字段被拒后回滚成已保存值", () => {
  it("评审点名的 7 个字段 + 同类的 meegleProject：草稿与已保存不等 → 回滚成已保存值", () => {
    const cases: Array<[string, unknown, unknown]> = [
      ["provider", "openai", "cursor"],
      ["jumpIde", "vscode", "cursor"],
      ["linkOpenMode", "system", "builtin"],
      ["userRole", "be", "fe"],
      ["submitShortcut", "enter", "mod-enter"],
      ["browserMaxTabs", 30, 20],
      ["defaultModel", { id: "m-new" }, { id: "m-old" }],
      ["meegleProject", { key: "b", name: "B", simpleName: "b" }, { key: "a", name: "A", simpleName: "a" }],
    ];
    expect(new Set(cases.map(([k]) => k))).toEqual(CHOICE_FIELDS);
    for (const [key, draft, saved] of cases) {
      expect(rollbackChoiceDraft(key, draft, saved), key).toEqual({ rollback: true, value: saved });
    }
  });

  it("草稿等于已保存值 → 不回滚；对象按内容比、不看引用（defaultModel 的 params 也算）", () => {
    expect(rollbackChoiceDraft("provider", "cursor", "cursor")).toEqual({ rollback: false });
    expect(rollbackChoiceDraft("browserMaxTabs", 20, 20)).toEqual({ rollback: false });
    expect(rollbackChoiceDraft("defaultModel", { id: "m", params: [{ id: "p", value: "1" }] }, { id: "m", params: [{ id: "p", value: "1" }] })).toEqual({
      rollback: false,
    });
    // 只有 params 不同也要回滚
    expect(rollbackChoiceDraft("defaultModel", { id: "m", params: [{ id: "p", value: "2" }] }, { id: "m", params: [{ id: "p", value: "1" }] })).toEqual({
      rollback: true,
      value: { id: "m", params: [{ id: "p", value: "1" }] },
    });
  });

  it("不在单选表里的字段一律不回滚：文本框 / 列表 / 对象 / 集合（回滚会吃掉用户输入或盖掉并发修改）", () => {
    for (const key of ["apiKey", "gitToken", "branchTemplate", "repos", "customProviders", "mcpServers", "companyEnv", "actionLayout", "disabledMcpServers", "unknownField"]) {
      expect(rollbackChoiceDraft(key, "新", "旧"), key).toEqual({ rollback: false });
    }
  });

  it("已保存值取不到：缺省合法的 userRole 回滚成 undefined（草稿里的角色被清掉）；其余单选字段没有可信目标，不回滚", () => {
    expect(rollbackChoiceDraft("userRole", "be", undefined)).toEqual({ rollback: true, value: undefined });
    for (const key of ["provider", "defaultModel", "jumpIde", "linkOpenMode", "submitShortcut", "browserMaxTabs", "meegleProject"]) {
      expect(rollbackChoiceDraft(key, "x", undefined), key).toEqual({ rollback: false });
    }
    // 两边都没有：没东西可回
    expect(rollbackChoiceDraft("userRole", undefined, undefined)).toEqual({ rollback: false });
  });
});

describe("applyDraftRollback：只改这一个字段、不命中时原样返回同一个引用", () => {
  const draft = {
    guard: true,
    bridge: true,
    apiKey: "新key",
    maxTabs: 30,
    browserMaxTabs: 40,
    jumpIde: "vscode",
    provider: "cursor",
    userRole: "be",
  };
  const saved = {
    guard: false,
    bridge: true,
    apiKey: "旧key",
    maxTabs: 20,
    browserMaxTabs: 20,
    jumpIde: "cursor",
    provider: "cursor",
    userRole: undefined as string | undefined,
  };

  it("开关字段被回滚（kind=switch），其它字段（含正在输入的文本框草稿）一个字都不动", () => {
    const r = applyDraftRollback(draft, saved, "guard");
    expect(r.rolledBack).toBe(true);
    expect(r.kind).toBe("switch");
    expect(r.settings).toEqual({ ...draft, guard: false });
    expect(draft.guard).toBe(true); // 入参不被改
  });

  it("单选字段被回滚（kind=choice）：只改这一个字段；缺省合法的 userRole 回滚成 undefined", () => {
    const j = applyDraftRollback(draft, saved, "jumpIde");
    expect(j).toMatchObject({ rolledBack: true, kind: "choice" });
    expect(j.settings).toEqual({ ...draft, jumpIde: "cursor" });
    const t = applyDraftRollback(draft, saved, "browserMaxTabs");
    expect(t).toMatchObject({ rolledBack: true, kind: "choice" });
    expect(t.settings.browserMaxTabs).toBe(20);
    const u = applyDraftRollback(draft, saved, "userRole");
    expect(u).toMatchObject({ rolledBack: true, kind: "choice" });
    expect(u.settings.userRole).toBeUndefined();
    expect("userRole" in u.settings).toBe(true);
    expect(draft.jumpIde).toBe("vscode"); // 入参不被改
  });

  it("文本 / 不在单选表里的数字字段：不回滚，返回的就是传入的那个对象（setState 据此跳过重渲染）", () => {
    for (const key of ["apiKey", "maxTabs"] as const) {
      const r = applyDraftRollback(draft, saved, key);
      expect(r.rolledBack).toBe(false);
      expect(r.kind).toBeNull();
      expect(r.settings).toBe(draft);
    }
  });

  it("草稿本来就等于已保存值（开关 / 单选）：不回滚、同一个引用", () => {
    for (const key of ["bridge", "provider"] as const) {
      const r = applyDraftRollback(draft, saved, key);
      expect(r.rolledBack).toBe(false);
      expect(r.settings).toBe(draft);
    }
  });
});

describe("withRestoredNote：toast 带「已恢复」一句（开关 / 单选各一句）", () => {
  it("回滚了 → 追加对应的一句；没回滚 → 原样；true 兼容地按开关处理", () => {
    expect(SWITCH_RESTORED_NOTE).toBe("开关已恢复为保存前的状态");
    expect(CHOICE_RESTORED_NOTE).toBe("已恢复为保存前的值");
    const msg = "保存失败：服务端拒绝了这次修改";
    expect(withRestoredNote(msg, "switch")).toBe(`${msg}。${SWITCH_RESTORED_NOTE}`);
    expect(withRestoredNote(msg, "choice")).toBe(`${msg}。${CHOICE_RESTORED_NOTE}`);
    expect(withRestoredNote(msg, true)).toBe(`${msg}。${SWITCH_RESTORED_NOTE}`);
    expect(withRestoredNote(msg, false)).toBe(msg);
    expect(withRestoredNote(msg, null)).toBe(msg);
  });
});

// ─────────────── 分类对账：每个设置字段都归了类 ───────────────

const ROOT = path.resolve(import.meta.dirname, "..");
const hookSrc = readFileSync(path.join(ROOT, "src/hooks/use-settings.ts"), "utf8");

/** use-settings.ts 的 FIELD_EQ_KIND：字段名 → 比较类别（boolFalse / boolTrue = boolean 开关） */
const fieldKinds = ((): Record<string, string> => {
  const body = /const FIELD_EQ_KIND = \{([\s\S]*?)\} as const satisfies/.exec(hookSrc)?.[1];
  expect(body, "找不到 FIELD_EQ_KIND（表的写法变了？）").toBeTruthy();
  const out: Record<string, string> = {};
  for (const m of body!.matchAll(/^\s*(\w+):\s*"(\w+)",?\s*$/gm)) out[m[1]!] = m[2]!;
  return out;
})();

/**
 * 明写「不回滚」的字段及理由——新增设置字段既不是开关、也不在 CHOICE_FIELDS 里，就必须在这里补一条（逼人工归类，而不是默默退回旧行为）。
 * 有意保留的行为：这些字段被拒后仍显示被拒的值、仍 dirty、仍拦离页——内容还在，用户自己修正。
 */
const NOT_ROLLED_BACK: Record<string, string> = {
  apiKey: "文本框：回滚会吃掉用户刚输入的内容",
  gitToken: "文本框",
  branchTemplate: "文本框",
  repos: "整块编辑的仓库列表：整值回滚可能盖掉并发的别的仓库的修改，卡片里有各自的本地状态",
  customProviders: "整块编辑的自定义提供方列表",
  mcpServers: "整块编辑的 JSON 配置",
  companyEnv: "整块编辑的结构化对象（含密码字段）",
  actionLayout: "拖拽排序 / 显隐的整块布局：并发操作多，整值回滚会盖掉别的修改",
  disabledMcpServers: "集合：逐项开关各自提交整个集合，整值回滚会盖掉并发的别的元素",
  disabledSkills: "集合（同 disabledMcpServers）",
  disabledRules: "集合（同 disabledMcpServers）",
};

describe("R20-10 分类对账：use-settings 的每个字段都必须归类——开关 / 单选 / 明写不回滚（新增字段忘了归类就红）", () => {
  it("FIELD_EQ_KIND 解析得出（防正则坏了空转）", () => {
    expect(Object.keys(fieldKinds).length).toBeGreaterThanOrEqual(35);
    expect(fieldKinds.feishuGroupNonOwnerGuard).toBe("boolTrue");
    expect(fieldKinds.provider).toBe("provider");
  });

  it("每个字段：boolean 开关 / 单选类 / 明写不回滚 / ignore（starredModels）——四选一、且互不重叠", () => {
    const unclassified: string[] = [];
    for (const [key, kind] of Object.entries(fieldKinds)) {
      const isSwitch = kind === "boolFalse" || kind === "boolTrue";
      const isChoice = CHOICE_FIELDS.has(key);
      const isNot = key in NOT_ROLLED_BACK;
      const isIgnore = kind === "ignore";
      if (![isSwitch, isChoice, isNot, isIgnore].some(Boolean)) unclassified.push(key);
      expect(
        [isSwitch, isChoice, isNot, isIgnore].filter(Boolean).length,
        `${key} 同时属于多个类别（开关 / 单选 / 不回滚 / ignore）`,
      ).toBeLessThanOrEqual(1);
    }
    expect(
      unclassified,
      "这些字段没有归类：是开关就用 boolean 默认值；是单选控件就加进 CHOICE_FIELDS；确实不该回滚就在 NOT_ROLLED_BACK 写明理由",
    ).toEqual([]);
  });

  it("单选表 / 不回滚表里的字段都是真字段（字段改名 / 删除后表不会悄悄过期）", () => {
    for (const key of CHOICE_FIELDS) expect(fieldKinds[key], `CHOICE_FIELDS 里的 ${key} 不在 FIELD_EQ_KIND`).toBeDefined();
    for (const key of Object.keys(NOT_ROLLED_BACK)) expect(fieldKinds[key], `NOT_ROLLED_BACK 里的 ${key} 不在 FIELD_EQ_KIND`).toBeDefined();
  });

  it("单选表里的字段确实由 saveFieldValue(\"…\") 提交（否则回滚是死代码）；saveFieldValue 的所有字面量字段名都在 FIELD_EQ_KIND 里", () => {
    const callSiteKeys = new Set<string>();
    const walk = (dir: string): void => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        if (ent.name === "node_modules" || ent.name === ".next") continue;
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(ent.name)) {
          const src = readFileSync(p, "utf8");
          for (const m of src.matchAll(/\bsaveFieldValue\(\s*"(\w+)"/g)) callSiteKeys.add(m[1]!);
        }
      }
    };
    walk(path.join(ROOT, "src"));
    expect(callSiteKeys.size, "扫不到 saveFieldValue 调用点（扫描坏了？）").toBeGreaterThanOrEqual(20);
    for (const key of CHOICE_FIELDS) expect(callSiteKeys.has(key), `${key} 没有 saveFieldValue("${key}", …) 调用点`).toBe(true);
    for (const key of callSiteKeys) expect(fieldKinds[key], `saveFieldValue("${key}") 的字段不在 FIELD_EQ_KIND`).toBeDefined();
  });
});

// ─────────────── use-settings.ts 源码结构钉子 ───────────────

const sf = ts.createSourceFile("use-settings.ts", hookSrc, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

/** 源码里所有名为 name 的对象字面量属性（`name: …` / `name(…) {}`）的完整文本 */
const propsNamed = (name: string): string[] => {
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === name) out.push(n.getText(sf));
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
};

describe("use-settings.ts：三个出口都回滚草稿，首次失败不回滚", () => {
  it("onRejected 有两处（首次 saveFieldValue 的 / 重试器的），每处都调 rollbackRejectedDraft", () => {
    const rejected = propsNamed("onRejected");
    expect(rejected).toHaveLength(2);
    for (const p of rejected) expect(p, p).toContain("rollbackRejectedDraft(");
  });

  it("toast 的「已恢复」那一句取自回滚的类别：rollbackRejectedDraft 的返回值直接交给 withRestoredNote", () => {
    for (const p of [...propsNamed("onRejected"), ...propsNamed("onGiveUp")]) {
      expect(p, p).toMatch(/withRestoredNote\(\s*[\s\S]*?,\s*rollbackRejectedDraft\(/);
    }
  });

  it("重试器的 onGiveUp 调 rollbackRejectedDraft，且用的是它收到的 key（不是闭包里别的变量）", () => {
    const giveUp = propsNamed("onGiveUp");
    expect(giveUp).toHaveLength(1);
    expect(giveUp[0]).toMatch(/onGiveUp:\s*\(key\)\s*=>/);
    expect(giveUp[0]).toContain("rollbackRejectedDraft(key as SettingsField)");
  });

  it("重试器的 onRejected 也用它收到的 key", () => {
    const retrierRejected = propsNamed("onRejected").find((p) => /onRejected:\s*\(key,\s*status\)/.test(p));
    expect(retrierRejected, "找不到重试器的 onRejected").toBeTruthy();
    expect(retrierRejected).toContain("rollbackRejectedDraft(key as SettingsField)");
  });

  it("首次失败（5xx / 网络错误、还会自动重试）的 onFailed 不回滚；重试成功的 onRecovered 也不回滚", () => {
    for (const p of [...propsNamed("onFailed"), ...propsNamed("onRecovered")]) expect(p, p).not.toContain("rollbackRejectedDraft");
  });

  it("rollbackRejectedDraft 读的是 ref（惰性创建一次的重试器闭包要读最新的已保存值），且 ref 每次渲染同步", () => {
    expect(hookSrc).toMatch(/const settingsRef = useRef\(settings\);\s*settingsRef\.current = settings;/);
    expect(hookSrc).toMatch(/const savedSettingsRef = useRef\(savedSettings\);\s*savedSettingsRef\.current = savedSettings;/);
    const fn = /const rollbackRejectedDraft = [\s\S]*?\n  \};/.exec(hookSrc)?.[0] ?? "";
    expect(fn).toContain("savedSettingsRef.current");
    expect(fn).toContain("settingsRef.current");
    // 没有直接闭包 savedSettings / settings state（陈旧值）
    const bare = fn.replace(/savedSettingsRef|settingsRef/g, "");
    expect(bare).not.toMatch(/\bsavedSettings\b/);
    expect(bare).not.toMatch(/(^|[^.\w])settings\b/); // `.settings`（applyDraftRollback 的返回字段）不算
  });
});
