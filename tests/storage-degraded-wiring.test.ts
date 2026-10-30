/**
 * 存储降级的前端接线契约（R14 B2-2 / Q9-01 = Q15-02）——读源码文本的契约测试
 *
 * 链路：SSE `storage_degraded` 帧 → task-store 解析 → useTaskWatch 透传 → 宿主（ChatView / 任务详情页）持有 state
 *       → EventStream（经 SmoothEventStream 透传）在事件流顶部渲染 StorageDegradedBar。
 * 为什么只能读源码：vitest 是 node 环境、没有 DOM、不能写 JSX，hook / 页面挂不起来（手法同 background-subagents.test.ts 的 E 段、
 * restricted-run-signal.test.ts 的接线契约）。接线断掉的典型样子——回调没传下去 / prop 漏传 / 切任务没清空 / 去重丢了——
 * 类型检查全过得去、行为测试也看不见，红条却不出现或串到别的任务上。
 *
 * 写法（别写成「源码改个空格就红」，也别写成「删了接线还绿」）：
 *   - 契约写成检查函数「源码文本 → 违例清单」；检查前先剥注释——这几个文件的注释里到处是 StorageDegradedBar /
 *     setStorageDegraded(null) 这些符号名，不剥的话「真接线删了、注释还在」会假绿；
 *   - 锚在稳定符号（函数名 / prop 名 / 回调名）与调用形态上，正则容忍空白和换行；不钉行号、不钉注释文字、不钉属性顺序；
 *   - JSX 标签用 jsxOpeningTag 按花括号深度取：page / chat-view 的事件流标签里有内嵌的 <Foo /> 与箭头函数，
 *     `indexOf("/>")` 会把标签提前截断，一调属性顺序就假红 / 假绿；
 *   - 变异自检：不能改 src，就在内存里把接线弄坏（删调用 / 漏传 / 写反 / 去依赖 / 挪位置），检查函数必须报出对应那一条——
 *     契约自己不能是摆设。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const srcDir = path.resolve(import.meta.dirname, "..", "src");
const readSrc = (...seg: string[]): string => readFileSync(path.join(srcDir, ...seg), "utf-8");

// ============================================================ 检查工具

/**
 * 剥注释：代码 / 单双引号字符串（到行尾自动复位——JSX 文本里的撇号不会把整个文件拖进字符串态）/ 模板字符串 / 行注释 / 块注释。
 * 与 ui-convention-scan.test.ts 的同名函数同款（不能 import 它：import 一个测试文件会把它的 describe 一并注册进来）。
 */
const stripComments = (s: string): string => {
  let out = "";
  let i = 0;
  let mode: "code" | "'" | '"' | "`" = "code";
  while (i < s.length) {
    const c = s[i]!;
    const n = s[i + 1];
    if (mode === "code") {
      if (c === "/" && n === "/") {
        // `://`（URL）不是注释
        if (i > 0 && s[i - 1] === ":") {
          out += c;
          i++;
          continue;
        }
        while (i < s.length && s[i] !== "\n") i++;
        continue;
      }
      if (c === "/" && n === "*") {
        const end = s.indexOf("*/", i + 2);
        i = end < 0 ? s.length : end + 2;
        continue;
      }
      if (c === "'" || c === '"' || c === "`") mode = c;
      out += c;
      i++;
      continue;
    }
    if (c === "\\") {
      out += c + (n ?? "");
      i += 2;
      continue;
    }
    if (c === mode || (c === "\n" && mode !== "`")) mode = "code";
    out += c;
    i++;
  }
  return out;
};

/**
 * 取 `<Tag …>` / `<Tag … />` 的开标签文本；找不到返回 null（调用方据此报违例，别拿空串去测）。
 * 从 `<Tag` 往后逐字符扫：花括号里（属性值的箭头函数 `=>`、内嵌 JSX 的 `/>`）和字符串里的 `>` 都不算结束，
 * 只有花括号深度为 0 的 `>` 才是标签结尾。
 */
const jsxOpeningTag = (src: string, tag: string): string | null => {
  const m = new RegExp(`<${tag}(?=[\\s/>])`).exec(src);
  if (!m) return null;
  let depth = 0;
  let quote: string | null = null;
  for (let i = m.index + m[0].length; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return src.slice(m.index, i + 1);
  }
  return null;
};

/** 把 from 替换成 to，并断言确实改到了东西（变异没命中 = 自检是空操作，直接让测试失败） */
const mutate = (src: string, from: string | RegExp, to: string): string => {
  const out = src.replace(from, to);
  expect(out, `变异没命中：${String(from)}`).not.toBe(src);
  return out;
};

interface Violation<R extends string> {
  rule: R;
  msg: string;
}
const msgsOf = <R extends string>(vs: Array<Violation<R>>, ...rules: R[]): string[] =>
  vs.filter((v) => rules.includes(v.rule)).map((v) => v.msg);
const rulesOf = <R extends string>(vs: Array<Violation<R>>): R[] => [...new Set(vs.map((v) => v.rule))];

// ============================================================ 检查函数（源码文本 → 违例清单）

type HookRule = "declare" | "forward";

/** use-task-watch.ts：选项里声明 onStorageDegraded，并在 sseCallbacks 里带 cancelled 门透传 */
const checkHook = (raw: string): Array<Violation<HookRule>> => {
  const src = stripComments(raw);
  const out: Array<Violation<HookRule>> = [];
  if (
    !/\bonStorageDegraded\?\s*:\s*\(\s*\w+\s*:\s*StorageDegradedState\s*\|\s*null\s*\)\s*=>\s*void\b/.test(src)
  ) {
    out.push({ rule: "declare", msg: "选项里没声明 onStorageDegraded?: (state: StorageDegradedState | null) => void" });
  }
  // onStorageDegraded: (x) => { if (cancelled) return; callbacksRef.current.onStorageDegraded?.(x); }
  // 反向引用 \1：转发的必须就是收到的那个参数
  const forward =
    /\bonStorageDegraded:\s*\(\s*(\w+)\s*\)\s*=>\s*\{\s*if\s*\(\s*cancelled\s*\)\s*(?:\{\s*return;?\s*\}|return;?)\s*callbacksRef\.current\.onStorageDegraded\?\.\(\s*\1\s*,?\s*\)\s*;?\s*\}/;
  if (!forward.test(src)) {
    out.push({
      rule: "forward",
      msg: "sseCallbacks 里没有「先过 cancelled 门、再 callbacksRef.current.onStorageDegraded?.(参数)」的透传",
    });
  }
  return out;
};

type HostRule = "import" | "state" | "wired" | "dedupe" | "reset" | "reset-effect" | "writes" | "pass-prop";

/** 宿主（chat-view.tsx / app/tasks/[id]/page.tsx）：持有 state、去重、切任务清空、传给事件流；streamTag = 该宿主渲染的事件流组件 */
const checkHost = (raw: string, streamTag: "EventStream" | "SmoothEventStream"): Array<Violation<HostRule>> => {
  const src = stripComments(raw);
  const out: Array<Violation<HostRule>> = [];

  if (!/import\s*\{[^}]*\bsameStorageDegraded\b[^}]*\}\s*from\s*["']@\/lib\/storage-degraded["']/.test(src)) {
    out.push({ rule: "import", msg: "没从 @/lib/storage-degraded import sameStorageDegraded" });
  }
  if (
    !/const\s*\[\s*storageDegraded\s*,\s*setStorageDegraded\s*\]\s*=\s*useState<\s*StorageDegradedState\s*\|\s*null\s*>\(\s*null\s*\)/.test(
      src,
    )
  ) {
    out.push({ rule: "state", msg: "没持有 storageDegraded state（useState<StorageDegradedState | null>(null)）" });
  }

  // onStorageDegraded: (state) => setStorageDegraded((prev) => sameStorageDegraded(prev, state) ? prev : state)
  // 反向引用：参数名可以变，但必须是「相同 → 留旧引用 prev、不同 → 换新值 state」，省一次整页重渲。
  // 容忍 Prettier 的两种形态：三元外面包不包括号、参数列表带不带尾逗号
  const dedupe =
    /\bonStorageDegraded:\s*\(\s*(\w+)\s*\)\s*=>\s*setStorageDegraded\(\s*\(\s*(\w+)\s*\)\s*=>\s*\(?\s*sameStorageDegraded\(\s*\2\s*,\s*\1\s*,?\s*\)\s*\?\s*\2\s*:\s*\1\s*\)?\s*,?\s*\)/;
  if (!dedupe.test(src)) {
    out.push({
      rule: "dedupe",
      msg: "onStorageDegraded 回调没有「sameStorageDegraded(prev, state) ? prev : state」的去重",
    });
  }
  // 这个回调必须是 useTaskWatch(…) 的选项：它前面最近的 use*( 调用就是它所属的 hook（hook 不嵌套）
  const cbAt = src.search(/\bonStorageDegraded:\s*\(/);
  if (cbAt >= 0) {
    const owner = [...src.slice(0, cbAt).matchAll(/\buse[A-Z]\w*\(/g)].at(-1)?.[0];
    if (owner !== "useTaskWatch(") {
      out.push({ rule: "wired", msg: `onStorageDegraded 不在 useTaskWatch 的选项里（所属 hook：${owner ?? "无"}）` });
    }
  }

  // 切任务清空：恰好一处 setStorageDegraded(null)——红条只该被服务端的恢复帧（经 SSE 回调）或切任务清掉，
  // 别处（比如 run 收尾的 onDone）也清 = 磁盘还满着、红条却没了
  const resets = [...src.matchAll(/\bsetStorageDegraded\(\s*null\s*\)/g)].length;
  if (resets !== 1) {
    out.push({ rule: "reset", msg: `setStorageDegraded(null) 应恰好 1 处（切任务清空），实际 ${resets} 处` });
  }
  // 这一处必须在「依赖里有任务 id」的 useEffect 里：它前面最近的 use*( 调用就是它所属的 hook（hook 不嵌套）
  const resetAt = src.search(/\bsetStorageDegraded\(\s*null\s*\)/);
  if (resetAt >= 0) {
    const owner = [...src.slice(0, resetAt).matchAll(/\buse[A-Z]\w*\(/g)].at(-1)?.[0];
    if (owner !== "useEffect(" && owner !== "useLayoutEffect(") {
      out.push({
        rule: "reset-effect",
        msg: `切任务清空不在 useEffect 里（所属 hook：${owner ?? "无"}）——切任务时不会自动执行`,
      });
    }
    const deps = /\}\s*,\s*\[([^\]]*)\]\s*\)/.exec(src.slice(resetAt))?.[1] ?? "";
    if (!/\b(?:id|taskId)\b/.test(deps)) {
      out.push({ rule: "reset-effect", msg: `切任务清空所在 effect 的依赖里没有任务 id（依赖：[${deps.trim()}]）` });
    }
  }

  // 写入点只有两种：清空 setStorageDegraded(null)、SSE 回调里的函数式更新 setStorageDegraded((prev) => …)；
  // 第三种（如直接 setStorageDegraded(state)）会绕过去重
  const all = [...src.matchAll(/\bsetStorageDegraded\(/g)].length;
  const updaters = [...src.matchAll(/\bsetStorageDegraded\(\s*\(\s*\w+\s*\)\s*=>/g)].length;
  if (all !== resets + updaters) {
    out.push({
      rule: "writes",
      msg: `setStorageDegraded 共 ${all} 处调用，其中清空 ${resets}、函数式更新 ${updaters}，其余是绕过去重的直接写入`,
    });
  }

  const tag = jsxOpeningTag(src, streamTag);
  if (tag === null) {
    out.push({ rule: "pass-prop", msg: `找不到 <${streamTag} 标签` });
  } else if (!/\bstorageDegraded=\{storageDegraded\}/.test(tag)) {
    out.push({ rule: "pass-prop", msg: `<${streamTag} 没传 storageDegraded={storageDegraded}` });
  }
  return out;
};

type StreamRule = "import" | "prop" | "render" | "outside-list";

/** 虚拟列表的 JSX 标签（不是 `useRef<VirtuosoHandle>` 这种类型参数） */
const VIRTUOSO_TAG = /<Virtuoso(?=[\s/>])/;

/** event-stream.tsx：Props 里声明 storageDegraded；非空时渲染 StorageDegradedBar，且在虚拟列表之外 */
const checkEventStream = (raw: string): Array<Violation<StreamRule>> => {
  const src = stripComments(raw);
  const out: Array<Violation<StreamRule>> = [];
  if (!/import\s*\{\s*StorageDegradedBar\s*\}\s*from\s*["']\.\/storage-degraded-bar["']/.test(src)) {
    out.push({ rule: "import", msg: ' 没 import { StorageDegradedBar } from "./storage-degraded-bar"' });
  }
  if (!/\bstorageDegraded\?\s*:\s*StorageDegradedState\s*\|\s*null\s*;/.test(src)) {
    out.push({ rule: "prop", msg: "Props 里没有 storageDegraded?: StorageDegradedState | null" });
  }
  // {storageDegraded ? <StorageDegradedBar state={storageDegraded} /> : null}（&& 写法也认）：非空才画、state 传的就是它。
  // 条件前不许有 `!`（写反了就是「没降级时画红条、降级时反而不画」）：用负向后行排除 `!storageDegraded ? …`。
  // JSX 被 Prettier 断行时会写成 `? (\n <StorageDegradedBar … />\n) : null`，所以 `<` 前允许一个 `(`
  const render =
    /(?<![!\w.])storageDegraded\s*(?:\?|&&)\s*\(?\s*<StorageDegradedBar\b[^>]*\bstate=\{storageDegraded\}[^>]*\/>/.exec(src);
  if (!render) {
    out.push({ rule: "render", msg: "没有「storageDegraded 非空时渲染 <StorageDegradedBar state={storageDegraded} />」" });
  } else {
    // 红条是 role="alert"：画进虚拟列表里会随滚动反复挂载、读屏反复播报（ui-conventions「事件流 v2」）。
    // 它该在 Virtuoso 容器之外、之前。标签要带边界匹配：`useRef<VirtuosoHandle | null>` 也以 `<Virtuoso` 打头
    const list = src.search(VIRTUOSO_TAG);
    if (list >= 0 && render.index > list) {
      out.push({ rule: "outside-list", msg: "红条渲染在虚拟列表（<Virtuoso）之后 / 里面" });
    }
  }
  return out;
};

type SmoothRule = "rest-spread" | "jsx-spread" | "no-drop" | "props-derived";

/** smooth-event-stream.tsx：新 prop 靠 ...streamProps 透传，不逐个枚举 */
const checkSmooth = (raw: string): Array<Violation<SmoothRule>> => {
  const src = stripComments(raw);
  const out: Array<Violation<SmoothRule>> = [];
  const withoutJsxSpread = src.replace(/\{\s*\.\.\.streamProps\s*\}/g, "");
  if (!/\.\.\.streamProps\b/.test(withoutJsxSpread)) {
    out.push({ rule: "rest-spread", msg: "组件参数解构里没有剩余参数 ...streamProps" });
  }
  const tag = jsxOpeningTag(src, "EventStream");
  if (tag === null) {
    out.push({ rule: "jsx-spread", msg: "找不到 <EventStream 标签" });
  } else {
    if (!/\{\s*\.\.\.streamProps\s*\}/.test(tag)) {
      out.push({ rule: "jsx-spread", msg: "<EventStream 没展开 {...streamProps}（新 prop 会被丢）" });
    }
    // 解构里单独取走 storageDegraded 的话，必须在标签上重新传——取走不传 = 把 prop 吞了
    if (/\bstorageDegraded\b/.test(src) && !/\bstorageDegraded=\{/.test(tag)) {
      out.push({ rule: "no-drop", msg: "提到了 storageDegraded（被单独取走）却没在 <EventStream 上重新传" });
    }
  }
  // Props 类型派生自 EventStream：EventStream 新增 prop 时这里自动带上，不另手写一份
  if (!/ComponentProps<\s*typeof\s+EventStream\s*>/.test(src)) {
    out.push({ rule: "props-derived", msg: "Props 不再从 ComponentProps<typeof EventStream> 派生（新 prop 会漏）" });
  }
  return out;
};

// ============================================================ 检查工具自检

describe("检查工具自检（别让契约自己是个摆设）", () => {
  it("stripComments：注释里的符号不算数；字符串里的 // 不吞掉同行后面的代码", () => {
    const src = [
      "// setStorageDegraded(null)",
      "/* <StorageDegradedBar state={x} /> */",
      '{/* 见 <StorageDegradedBar /> */}',
      'const u = "https://a.b/c"; setStorageDegraded(null);',
      'const s = "a // b"; keep();',
    ].join("\n");
    const out = stripComments(src);
    expect(out).not.toContain("<StorageDegradedBar");
    expect(out.match(/setStorageDegraded\(null\)/g)).toHaveLength(1);
    expect(out).toContain("keep();");
  });

  it("jsxOpeningTag：属性值里内嵌的 <Foo /> / 箭头函数 => / 字符串里的 > 都不会把标签提前截断", () => {
    const host = '<Host a={<Inner x="1" />} onTap={() => go()} b="x > y" storageDegraded={sd} />';
    expect(jsxOpeningTag(`${host} <Other />`, "Host")).toBe(host);
    // 前缀相同的另一个组件不会被认成它
    expect(jsxOpeningTag("<HostBar a={1} />", "Host")).toBeNull();
    expect(jsxOpeningTag("<Other />", "Host")).toBeNull();
  });
});

// ============================================================ use-task-watch

describe("use-task-watch.ts：声明并透传 onStorageDegraded（cancelled 后不调）", () => {
  const raw = readSrc("hooks", "use-task-watch.ts");
  const violations = checkHook(raw);

  it("选项里声明 onStorageDegraded?: (state: StorageDegradedState | null) => void", () => {
    expect(msgsOf(violations, "declare")).toEqual([]);
  });

  it("sseCallbacks 转发：先过 cancelled 门（卸载 / 切任务后迟到的帧不能再改宿主 state）、再调 callbacksRef.current.onStorageDegraded?.(state)", () => {
    expect(msgsOf(violations, "forward")).toEqual([]);
  });

  it("格式漂移不该让契约红：if 写成花括号形式、转发调用拆成多行带尾逗号", () => {
    const drifted = mutate(
      mutate(
        raw,
        /(onStorageDegraded:\s*\(state\)\s*=>\s*\{\s*)if \(cancelled\) return;/,
        "$1if (cancelled) {\n              return;\n            }",
      ),
      /callbacksRef\.current\.onStorageDegraded\?\.\(state\);/,
      "callbacksRef.current.onStorageDegraded?.(\n              state,\n            );",
    );
    expect(checkHook(drifted)).toEqual([]);
  });

  const FWD = /onStorageDegraded:\s*\(state\)\s*=>\s*\{/;
  it.each<{ name: string; rule: HookRule; apply: (s: string) => string }>([
    {
      name: "删掉选项里的声明",
      rule: "declare",
      apply: (s) => mutate(s, /\bonStorageDegraded\?:\s*\(state:\s*StorageDegradedState\s*\|\s*null\)\s*=>\s*void;/, ""),
    },
    {
      name: "去掉 cancelled 门",
      rule: "forward",
      apply: (s) => mutate(s, new RegExp(`(${FWD.source}\\s*)if \\(cancelled\\) return;\\s*`), "$1"),
    },
    {
      name: "不再调用 callbacksRef.current.onStorageDegraded",
      rule: "forward",
      apply: (s) => mutate(s, /callbacksRef\.current\.onStorageDegraded\?\.\(state\);/, ""),
    },
    {
      name: "转发时丢了参数",
      rule: "forward",
      apply: (s) => mutate(s, /callbacksRef\.current\.onStorageDegraded\?\.\(state\)/, "callbacksRef.current.onStorageDegraded?.()"),
    },
    {
      name: "整个转发块被删",
      rule: "forward",
      apply: (s) => mutate(s, /onStorageDegraded:\s*\(state\)\s*=>\s*\{[^}]*\},?/, ""),
    },
  ])("自检：$name → 基线不报、变异后必报 $rule", ({ rule, apply }) => {
    // 先证明基线（真实源码）本身不违例，否则「变异后也报」什么都说明不了
    expect(rulesOf(checkHook(raw)), "基线本就违例，自检没有意义").not.toContain(rule);
    expect(rulesOf(checkHook(apply(raw)))).toContain(rule);
  });
});

// ============================================================ 宿主：chat-view / 任务详情页

interface Host {
  name: string;
  seg: string[];
  tag: "EventStream" | "SmoothEventStream";
}
const HOSTS: Host[] = [
  { name: "chat-view.tsx（→ <EventStream）", seg: ["components", "tasks", "chat-view.tsx"], tag: "EventStream" },
  { name: "app/tasks/[id]/page.tsx（→ <SmoothEventStream）", seg: ["app", "tasks", "[id]", "page.tsx"], tag: "SmoothEventStream" },
];

describe.each(HOSTS)("宿主 $name", ({ seg, tag }) => {
  const raw = readSrc(...seg);
  const violations = checkHost(raw, tag);

  it("从 @/lib/storage-degraded 取 sameStorageDegraded，并持有 storageDegraded state（useState<StorageDegradedState | null>(null)）", () => {
    expect(msgsOf(violations, "import", "state")).toEqual([]);
  });

  it("onStorageDegraded 是 useTaskWatch 的选项，回调里用 sameStorageDegraded 去重：相同留旧引用（不 setState）、不同才换成新值", () => {
    expect(msgsOf(violations, "wired", "dedupe")).toEqual([]);
  });

  it("切任务时清空：setStorageDegraded(null) 恰好一处，且在依赖里有任务 id 的 useEffect 里（上个任务的红条不能串到新任务）", () => {
    expect(msgsOf(violations, "reset", "reset-effect")).toEqual([]);
  });

  it("写入点只有两种（SSE 回调里的去重更新 / 切任务清空）：没有绕过去重的直接 setStorageDegraded(x)", () => {
    expect(msgsOf(violations, "writes")).toEqual([]);
  });

  it(`把 storageDegraded 传给事件流（<${tag} storageDegraded={storageDegraded} …/>）`, () => {
    expect(msgsOf(violations, "pass-prop")).toEqual([]);
  });

  const DEDUPE_CALL =
    /setStorageDegraded\(\s*\(\s*\w+\s*\)\s*=>\s*sameStorageDegraded\(\s*\w+\s*,\s*\w+\s*\)\s*\?\s*\w+\s*:\s*\w+\s*,?\s*\)/;
  const RESET = /\bsetStorageDegraded\(\s*null\s*\);?/;
  const DEDUPE_CB =
    /\bonStorageDegraded:\s*\(\s*\w+\s*\)\s*=>\s*setStorageDegraded\(\s*\(\s*\w+\s*\)\s*=>\s*sameStorageDegraded\([^)]*\)\s*\?\s*\w+\s*:\s*\w+\s*,?\s*\)/;

  it("格式漂移不该让契约红：回调写成单行带括号 + 参数改名、storageDegraded 属性挪到标签最前、注释里再提 setStorageDegraded(null)", () => {
    let drifted = mutate(
      raw,
      DEDUPE_CB,
      "onStorageDegraded: (next) => setStorageDegraded((cur) => (sameStorageDegraded(cur, next) ? cur : next))",
    );
    // 属性顺序：删掉原处，插到标签的第一个属性位置
    drifted = mutate(drifted, /\bstorageDegraded=\{storageDegraded\}/, "");
    drifted = mutate(drifted, new RegExp(`<${tag}(?=[\\s/>])`), `<${tag} storageDegraded={storageDegraded}`);
    // 注释里提到的符号不该被计数（没剥注释的话，清空就成了 2 处）
    drifted = mutate(
      drifted,
      RESET,
      "// 旧写法：setStorageDegraded(null) 也曾出现在 onDone 里\n    setStorageDegraded(null);",
    );
    expect(checkHost(drifted, tag)).toEqual([]);
  });

  it.each<{ name: string; rule: HostRule; apply: (s: string) => string }>([
    { name: "删掉切任务清空 setStorageDegraded(null)", rule: "reset", apply: (s) => mutate(s, RESET, "") },
    {
      name: "清空多了一处（比如在 run 收尾的 onDone 里也清）",
      rule: "reset",
      apply: (s) => mutate(s, RESET, "setStorageDegraded(null);\n    setStorageDegraded(null);"),
    },
    {
      name: "清空所在 hook 换成 useCallback（切任务时不再自动执行）",
      rule: "reset-effect",
      apply: (s) => {
        const at = s.search(RESET);
        const effectAt = s.slice(0, at).lastIndexOf("useEffect(");
        expect(effectAt, "清空前面找不到 useEffect(").toBeGreaterThan(-1);
        return `${s.slice(0, effectAt)}useCallback(${s.slice(effectAt + "useEffect(".length)}`;
      },
    },
    {
      name: "清空所在 effect 的依赖里没了任务 id",
      rule: "reset-effect",
      apply: (s) => {
        const at = s.search(RESET);
        const tail = s
          .slice(at)
          .replace(/(\}\s*,\s*\[)([^\]]*)(\]\s*\))/, (_m, a: string, deps: string, b: string) =>
            `${a}${deps.replace(/\b(?:task\.)?id\b,?\s*/g, "")}${b}`,
          );
        const out = s.slice(0, at) + tail;
        expect(out, "去依赖的变异没命中").not.toBe(s);
        return out;
      },
    },
    {
      name: "回调去重丢了：直接 setStorageDegraded(state)",
      rule: "dedupe",
      apply: (s) => mutate(s, DEDUPE_CALL, "setStorageDegraded(state)"),
    },
    {
      name: "去重三元写反：相同却换成新值",
      rule: "dedupe",
      apply: (s) => mutate(s, /(sameStorageDegraded\(\s*\w+\s*,\s*\w+\s*\)\s*\?\s*)(\w+)(\s*:\s*)(\w+)/, "$1$4$3$2"),
    },
    {
      name: "多了一处绕过去重的直接写入",
      rule: "writes",
      apply: (s) => mutate(s, RESET, "setStorageDegraded(null);\n    setStorageDegraded(somethingElse);"),
    },
    {
      name: "整个 onStorageDegraded 回调被删（SSE 帧再也到不了 state）",
      rule: "dedupe",
      apply: (s) => mutate(s, DEDUPE_CB, ""),
    },
    {
      name: "回调不在 useTaskWatch 的选项里（写到了别的 hook 的对象上）",
      rule: "wired",
      apply: (s) => mutate(s, /\buseTaskWatch\(/, "useSomethingElse("),
    },
    {
      name: "漏传 storageDegraded 给事件流",
      rule: "pass-prop",
      apply: (s) => mutate(s, /\bstorageDegraded=\{storageDegraded\}/, ""),
    },
    {
      name: "传了 null 占位而不是真 state（红条永远不显示）",
      rule: "pass-prop",
      apply: (s) => mutate(s, /\bstorageDegraded=\{storageDegraded\}/, "storageDegraded={null}"),
    },
    {
      name: "不再 import sameStorageDegraded",
      rule: "import",
      apply: (s) => mutate(s, /\bsameStorageDegraded,\s*/, ""),
    },
    {
      name: "不再持有 state",
      rule: "state",
      apply: (s) => mutate(s, /const\s*\[\s*storageDegraded\s*,\s*setStorageDegraded\s*\]\s*=\s*useState<[^>]*>\(\s*null\s*\);?/, ""),
    },
  ])("自检：$name → 基线不报、变异后必报 $rule", ({ rule, apply }) => {
    expect(rulesOf(checkHost(raw, tag)), "基线本就违例，自检没有意义").not.toContain(rule);
    expect(rulesOf(checkHost(apply(raw), tag))).toContain(rule);
  });
});

// ============================================================ EventStream：非空时渲染红条

describe("event-stream.tsx：storageDegraded 非空时渲染 StorageDegradedBar", () => {
  const raw = readSrc("components", "tasks", "event-stream.tsx");
  const violations = checkEventStream(raw);

  it("import StorageDegradedBar，Props 里声明 storageDegraded?: StorageDegradedState | null", () => {
    expect(msgsOf(violations, "import", "prop")).toEqual([]);
  });

  it("非空时渲染 <StorageDegradedBar state={storageDegraded} />（null 不画；chat / task 两种形态共用同一处）", () => {
    expect(msgsOf(violations, "render")).toEqual([]);
  });

  it("红条在虚拟列表（<Virtuoso）之外：role=alert 画进列表会随滚动反复挂载、读屏反复播报", () => {
    expect(msgsOf(violations, "outside-list")).toEqual([]);
  });

  const RENDER = /\{\s*storageDegraded\s*\?\s*(<StorageDegradedBar[^>]*\/>)\s*:\s*null\s*\}/;

  it("格式漂移不该让契约红：JSX 被断行并加括号 / 改用 && 写法", () => {
    const wrapped = mutate(
      raw,
      RENDER,
      "{storageDegraded ? (\n        <StorageDegradedBar\n          state={storageDegraded}\n        />\n      ) : null}",
    );
    expect(checkEventStream(wrapped)).toEqual([]);
    const andForm = mutate(raw, RENDER, "{storageDegraded && <StorageDegradedBar state={storageDegraded} />}");
    expect(checkEventStream(andForm)).toEqual([]);
  });

  it.each<{ name: string; rule: StreamRule; apply: (s: string) => string }>([
    { name: "删掉红条的渲染（注释里还提着它也一样）", rule: "render", apply: (s) => mutate(s, RENDER, "") },
    { name: "去掉非空判断、无条件渲染", rule: "render", apply: (s) => mutate(s, RENDER, "$1") },
    {
      name: "条件写反（!storageDegraded 时才画红条）",
      rule: "render",
      apply: (s) => mutate(s, RENDER, "{!storageDegraded ? $1 : null}"),
    },
    {
      name: "渲染时没把 storageDegraded 传给 state",
      rule: "render",
      apply: (s) => mutate(s, /<StorageDegradedBar\s+state=\{storageDegraded\}/, "<StorageDegradedBar state={undefined}"),
    },
    {
      name: "红条挪进虚拟列表里（<Virtuoso 之后）",
      rule: "outside-list",
      apply: (s) =>
        mutate(
          mutate(s, RENDER, ""),
          VIRTUOSO_TAG,
          "<Virtuoso data-x={storageDegraded ? <StorageDegradedBar state={storageDegraded} /> : null}",
        ),
    },
    {
      name: "不再 import StorageDegradedBar",
      rule: "import",
      apply: (s) => mutate(s, /import\s*\{\s*StorageDegradedBar\s*\}\s*from\s*"\.\/storage-degraded-bar";?/, ""),
    },
    {
      name: "Props 里删掉 storageDegraded 声明",
      rule: "prop",
      apply: (s) => mutate(s, /\bstorageDegraded\?:\s*StorageDegradedState\s*\|\s*null;/, ""),
    },
  ])("自检：$name → 基线不报、变异后必报 $rule", ({ rule, apply }) => {
    expect(rulesOf(checkEventStream(raw)), "基线本就违例，自检没有意义").not.toContain(rule);
    expect(rulesOf(checkEventStream(apply(raw)))).toContain(rule);
  });
});

// ============================================================ SmoothEventStream：靠 ...streamProps 透传

describe("smooth-event-stream.tsx：新 prop 靠 ...streamProps 透传，没有逐个枚举丢掉", () => {
  const raw = readSrc("components", "tasks", "smooth-event-stream.tsx");
  const violations = checkSmooth(raw);

  it("参数解构用剩余参数 ...streamProps，并在 <EventStream 上展开 {...streamProps}", () => {
    expect(msgsOf(violations, "rest-spread", "jsx-spread")).toEqual([]);
  });

  it("没有把 storageDegraded 单独取走又不重传；Props 派生自 ComponentProps<typeof EventStream>（EventStream 加 prop 这里自动带上）", () => {
    expect(msgsOf(violations, "no-drop", "props-derived")).toEqual([]);
  });

  it.each<{ name: string; rule: SmoothRule; apply: (s: string) => string }>([
    {
      name: "删掉 <EventStream 上的 {...streamProps} 展开",
      rule: "jsx-spread",
      apply: (s) => mutate(s, /\{\s*\.\.\.streamProps\s*\}/, ""),
    },
    {
      name: "参数解构不再用剩余参数",
      rule: "rest-spread",
      apply: (s) => mutate(s, /\n(\s*)\.\.\.streamProps\n/, "\n"),
    },
    {
      name: "解构里单独取走 storageDegraded 却不重传",
      rule: "no-drop",
      apply: (s) => mutate(s, /\n(\s*)\.\.\.streamProps\n/, "\n$1storageDegraded,\n$1...streamProps\n"),
    },
    {
      name: "Props 不再派生自 EventStream（手写白名单）",
      rule: "props-derived",
      apply: (s) => mutate(s, /ComponentProps<\s*typeof\s+EventStream\s*>/, "Record<string, never>"),
    },
  ])("自检：$name → 基线不报、变异后必报 $rule", ({ rule, apply }) => {
    expect(rulesOf(checkSmooth(raw)), "基线本就违例，自检没有意义").not.toContain(rule);
    expect(rulesOf(checkSmooth(apply(raw)))).toContain(rule);
  });
});
