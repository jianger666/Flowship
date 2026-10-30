/**
 * tests/helpers/main-slice.ts 自身的行为：三道自检 + 切半截自检 + 行首锚定
 * （R14 B2-4a 审查 P3-1：补测由审查 AI 提供原型、变更 AI 采纳落地）。
 *
 * 旧私有版的自检由 update-manifest-failure-kinds.test.ts ③i 钉着；抽成 helper 之后没有任何测试钉它——
 * 把 (a)(b)(c) 任意一道、切半截自检、行首锚定删掉，608 条相关用例仍全绿（审查 AI 变异 MS01–MS05 全部存活）。
 * helper 的 sliceMainFn / mainDecl / checkHarnessScope 都带 `src` 参数：直接喂「改过的 main.js 文本」，不碰真实 main.js。
 */
import { describe, expect, it } from "vitest";

import { checkHarnessScope, mainDecl, sliceMainFn } from "./helpers/main-slice";

const lines = (...l: string[]): string => `${l.join("\n")}\n`;

/** 一份迷你 main.js：一个 import、两个模块级 let、一个顶层函数（引用其中一个 let 与 import 进来的依赖） */
const SRC = lines(
  'import { realDep } from "./real.mjs";',
  "let counter = 0;",
  "let untouched = 1;",
  "const work = async () => {",
  "  counter += 1;",
  "  realDep();",
  "  return counter;",
  "};",
);
const deps = { realDep: () => undefined };

describe("sliceMainFn / mainDecl：切片与锚定", () => {
  it("切出 `const name = …` 到首个行首 `};`（含）", () => {
    const text = sliceMainFn("work", SRC);
    expect(text.startsWith("const work = async () => {")).toBe(true);
    expect(text.endsWith("\n};")).toBe(true);
    expect(text).toContain("counter += 1;");
    expect(text).not.toContain("let counter");
  });

  it("只认行首：注释里 / 缩进的同名片段不会把起点带偏", () => {
    const noisy = lines("// 例：const work = fake;", "  const work = nestedFake;") + SRC;
    expect(sliceMainFn("work", noisy)).toBe(sliceMainFn("work", SRC));
  });

  it("名字是更长名字的前缀时不误匹配（`work` 不命中 `workAll`）", () => {
    const src = lines("const workAll = () => {", "  return 1;", "};") + SRC;
    expect(sliceMainFn("work", src).startsWith("const work = async")).toBe(true);
  });

  it("找不到行首声明 / 找不到行首 `};` → 抛错而不是静默切出空串", () => {
    expect(() => sliceMainFn("nope", SRC)).toThrow(/应有行首的 const nope/);
    expect(() => sliceMainFn("open", lines("const open = () => {", "  return 1;"))).toThrow(/找不到行首的/);
  });

  it("切半截自检：函数体里（模板字符串）出现行首 `};` 会被截成半截 → 编译不过 → 抛「不是完整语句」", () => {
    const half = lines("const half = () => {", "  const s = `", "};", "`;", "  return s;", "};");
    expect(() => sliceMainFn("half", half)).toThrow(/不是完整语句/);
  });

  it("mainDecl：取模块级单行声明原文；没有就抛", () => {
    expect(mainDecl("counter", SRC)).toBe("let counter = 0;");
    expect(() => mainDecl("ghost", SRC)).toThrow(/应有行首单行声明/);
  });
});

describe("checkHarnessScope：三道自检各自会红", () => {
  it("基线：prelude 提供了函数体用到的 let、deps 都是 main.js 的 import → 不抛", () => {
    expect(() => checkHarnessScope(["work"], deps, "let counter = 0;", SRC)).not.toThrow();
  });

  it("(a) prelude 声明了 main.js 里没有的名字 → 抛「脱节」", () => {
    expect(() => checkHarnessScope(["work"], deps, "let counter = 0; let ghost = 1;", SRC)).toThrow(/名字：ghost——.*脱节/);
  });

  it("(b) 函数体引用了 main.js 的模块级 let、脚手架没提供 → 抛，且只点名真被引用的那个", () => {
    expect(() => checkHarnessScope(["work"], deps, "", SRC)).toThrow(/没提供：counter——/);
  });

  it("(c) 注入依赖在 main.js 里没有同名模块级绑定（也不是宿主全局）→ 抛「替身掩盖」", () => {
    const src = SRC.replace("  realDep();", "  realDep();\n  ghostDep();");
    expect(() => checkHarnessScope(["work"], { ...deps, ghostDep: () => undefined }, "let counter = 0;", src)).toThrow(
      /注入依赖 ghostDep，/,
    );
  });

  it("(c) 对照：宿主全局（如 fetch）不要求是 main.js 的模块级绑定", () => {
    const src = SRC.replace("  realDep();", "  realDep();\n  await fetch('x');");
    expect(() => checkHarnessScope(["work"], { ...deps, fetch: () => undefined }, "let counter = 0;", src)).not.toThrow();
  });
});
