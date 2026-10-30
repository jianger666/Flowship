/**
 * 把 electron-app/main.js 里顶层的 `const <name> = …` 函数切出来，在「注入依赖」的作用域里**真实执行**（给测试用）。
 *
 * main.js 是 Electron 主进程入口（一 import 就会起窗口 / 注册 IPC），不能直接 import 进 vitest，
 * 所以壳里的编排逻辑（暂存失败后的复位、server 崩溃后的处置……）只能这样测：切源码、注入替身、真跑函数体。
 * 与 tests/update-manifest-failure-kinds.test.ts 里的同名脚手架同款（那边是文件内私有的；这里抽成 helper 给后来的测试用，
 * 既有测试暂不迁移——不扩大改动面）。它比「grep 源码字符串」强在：函数体里的逻辑错误（分支写反、漏了复位）会真的红。
 *
 * 切法有三道自检，防「脚手架悄悄和 main.js 脱节」：
 *  (a) prelude 里声明的每个名字，在 main.js 里必须真有一条行首（模块级）声明——手抄的 `let x = null` 不会在 main.js 删 / 改名后继续假装存在；
 *  (b) 被切出的函数体引用到的 main.js 模块级 `let` 名字，必须由 prelude / 注入依赖 / 同批切出的函数提供——
 *      否则 sloppy 模式下对它赋值会悄悄变成隐式全局、读它才 ReferenceError；
 *  (c) 注入依赖（deps）的名字被函数体引用时，必须是 main.js 的模块级绑定（行首声明或 import）或宿主全局——
 *      否则替身会盖住「main.js 里这个依赖已被删 / 改名」。
 * 模块级判定用「行首声明」——main.js 全部模块级声明都顶格写（函数体内一律缩进）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "..", "..");
export const mainSrc = readFileSync(path.join(ROOT, "electron-app/main.js"), "utf8");

/**
 * 从 main.js 切出 `const <name> = …`（async 或同步箭头函数）到首个行首 `};` 的源码。
 * 只认行首的 `const <name> = `（不被注释 / 字符串里同名片段、或某个更长名字的子串带偏）。
 */
export const sliceMainFn = (name: string, src: string = mainSrc): string => {
  const m = new RegExp(`^const ${name} = `, "m").exec(src);
  if (!m) throw new Error(`main.js 里应有行首的 const ${name} = …`);
  const start = m.index;
  const end = src.indexOf("\n};", start);
  if (end <= start) throw new Error(`main.js 里 const ${name} 之后找不到行首的 "};"`);
  const text = src.slice(start, end + 3);
  // 自检：函数体里有字符串 / 模板的行首 `};` 会切成半截——半截的括号不配对，编译一下就会抛 SyntaxError
  try {
    new Function(text);
  } catch (e) {
    throw new Error(`sliceMainFn(${name}) 切出来的不是完整语句（被行首 "};" 截断？）：${(e as Error).message}`);
  }
  return text;
};

/**
 * 取一条**模块级单行声明**（`let|const <name> = …;`）的原文——给 prelude 用，初值与 main.js 自己的声明同源、不再手抄；
 * main.js 里没有（被删 / 改名）就直接抛错。
 */
export const mainDecl = (name: string, src: string = mainSrc): string => {
  const m = new RegExp(`^(?:let|const) ${name} = [^\\n]*;$`, "m").exec(src);
  if (!m) throw new Error(`main.js 里应有行首单行声明 let|const ${name} = …;`);
  return m[0];
};
export const mainDecls = (...names: string[]): string => names.map((n) => mainDecl(n)).join("\n");

const JS_IDENT = "[A-Za-z_$][\\w$]*";
const stripJsComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\w"'`])\/\/[^\n]*/g, "$1");
/** main.js 的 import 绑定的本地名（`import { a, b as c } from` / `import x from` / `import * as ns from`；多行花括号也认） */
const importedNames = (src: string): string[] =>
  [...src.matchAll(/^import\s+([\s\S]*?)\s+from\s+["'][^"']+["'];?/gm)].flatMap((m) => {
    const clause = m[1]!;
    const named = (/\{([\s\S]*?)\}/.exec(clause)?.[1] ?? "")
      .split(",")
      .map((p) => p.trim().split(/\s+as\s+/).pop()!.trim());
    const outside = clause.replace(/\{[\s\S]*?\}/, " ").replace(/\*\s+as\s+/, " ").split(/[\s,]+/);
    return [...named, ...outside].filter(Boolean);
  });
/** 脚手架会注入、但在 main.js 里本来就是宿主全局（不是模块级绑定）的名字，(c) 不查它们 */
const HOST_GLOBALS = new Set([
  "process",
  "fetch",
  "Buffer",
  "URL",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "console",
  "globalThis",
]);

export const checkHarnessScope = (
  names: string[],
  deps: Record<string, unknown>,
  prelude: string,
  src: string = mainSrc,
): void => {
  const collect = (re: RegExp, text: string): string[] => [...text.matchAll(re)].map((m) => m[1]!);
  const mainLets = new Set(collect(new RegExp(`^let\\s+(${JS_IDENT})`, "gm"), src));
  const mainAll = new Set(
    collect(new RegExp(`^(?:let|const|var|(?:async\\s+)?function\\*?|class)\\s+(${JS_IDENT})`, "gm"), src),
  );
  const preludeNames = collect(new RegExp(`\\b(?:let|const|var)\\s+(${JS_IDENT})`, "g"), stripJsComments(prelude));
  const stale = preludeNames.filter((n) => !mainAll.has(n));
  if (stale.length > 0) {
    throw new Error(
      `脚手架 prelude 声明了 main.js 里没有（或已不是模块级）的名字：${stale.join(", ")}——手抄的声明已和 main.js 脱节`,
    );
  }
  const bodies = stripJsComments(names.map((n) => sliceMainFn(n, src)).join("\n"));
  const provided = new Set([...preludeNames, ...Object.keys(deps), ...names]);
  const unprovided = [...mainLets].filter(
    (l) => !provided.has(l) && new RegExp(`(?<![\\w$.])${l.replace(/\$/g, "\\$")}(?![\\w$])`).test(bodies),
  );
  if (unprovided.length > 0) {
    throw new Error(
      `被切出的函数引用了 main.js 的模块级 let、但脚手架没提供：${unprovided.join(", ")}——` +
        "sloppy 模式下对它赋值会悄悄变成隐式全局、读它才 ReferenceError",
    );
  }
  const mainBindings = new Set([...mainAll, ...importedNames(src)]);
  const orphanDeps = Object.keys(deps).filter(
    (d) =>
      !mainBindings.has(d) &&
      !HOST_GLOBALS.has(d) &&
      new RegExp(`(?<![\\w$.])${d.replace(/\$/g, "\\$")}(?![\\w$])`).test(bodies),
  );
  if (orphanDeps.length > 0) {
    throw new Error(
      `被切出的函数引用了注入依赖 ${orphanDeps.join(", ")}，但 main.js 里没有同名的模块级绑定（声明 / import）——` +
        "替身掩盖了 main.js 里已被删 / 改名的依赖",
    );
  }
};

/** 在注入的依赖作用域里实例化一个切出来的函数（sloppy 模式 + 显式预声明可写变量） */
export const instantiate = <T,>(
  name: string,
  deps: Record<string, unknown>,
  prelude = "",
  tail = `return ${name};`,
): T => {
  checkHarnessScope([name], deps, prelude);
  return new Function(...Object.keys(deps), `${prelude}\n${sliceMainFn(name)}\n${tail}`)(
    ...Object.values(deps),
  ) as T;
};

/**
 * 把多个函数切进**同一个**作用域（它们共享 prelude 里声明的模块级 let 变量，就像在 main.js 里一样）——
 * 端到端验证「A 函数写下的状态、B 函数读到」这类跨函数约定。
 */
export const instantiateMany = <T,>(
  names: string[],
  deps: Record<string, unknown>,
  prelude: string,
  tail: string,
): T => {
  checkHarnessScope(names, deps, prelude);
  return new Function(
    ...Object.keys(deps),
    `${prelude}\n${names.map((n) => sliceMainFn(n)).join("\n")}\n${tail}`,
  )(...Object.values(deps)) as T;
};
