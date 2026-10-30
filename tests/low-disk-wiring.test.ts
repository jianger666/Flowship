/**
 * 低磁盘红条的接线契约（R14 B2-4c / Q15-10 页面部分）——读源码文本的契约测试
 *
 * 链路：GET /api/system/disk（route → readDiskReading）← useLowDisk（fetch + 轮询 + window 事件）← LowDiskBanner（自取数、决定画不画）
 *       ← EventStream 在事件流顶部挂一行 `<LowDiskBanner suppressed={!!storageDegraded} />`。
 * 为什么只能读源码：vitest 是 node 环境、没有 DOM、不能写 JSX，hook / 页面挂不起来（手法同 storage-degraded-wiring.test.ts）。
 * 接线断掉的典型样子——没挂上 / 挂了两遍 / 压制条件写反 / hook 的 effect 没清理 / URL 与路由文件对不上——
 * 类型检查全过得去、行为测试也看不见，红条却不出现、重复出现，或组件卸载后还在轮询。
 *
 * 写法同 storage-degraded-wiring.test.ts：契约写成检查函数「源码文本 → 违例清单」，检查前先剥注释；
 * 锚在稳定符号与调用形态上，正则容忍空白和换行；变异自检——在内存里把接线弄坏，检查函数必须报出对应那一条。
 * ⚠ 没有在真实浏览器 / Electron 里验证过挂载与轮询的实际联动。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const srcDir = path.resolve(import.meta.dirname, "..", "src");
const testsDir = import.meta.dirname;
const readSrc = (...seg: string[]): string => readFileSync(path.join(srcDir, ...seg), "utf-8");

// ============================================================ 检查工具

/**
 * 剥注释：代码 / 单双引号字符串（到行尾自动复位——JSX 文本里的撇号不会把整个文件拖进字符串态）/ 模板字符串 / 行注释 / 块注释。
 * 与 storage-degraded-wiring.test.ts / ui-convention-scan.test.ts 的同名函数同款（不能 import 测试文件：会把它的 describe 一并注册进来）。
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

/** 取 `<Tag …>` / `<Tag … />` 的开标签文本（花括号深度为 0 的 `>` 才算结束）；找不到返回 null */
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
const rulesOf = <R extends string>(vs: Array<Violation<R>>): R[] => [...new Set(vs.map((v) => v.rule))];

// ============================================================ 检查函数（源码文本 → 违例清单）

type StreamRule = "import" | "mount-once" | "suppressed" | "order" | "no-hook-in-stream";

/** event-stream.tsx：引入并只挂一处 LowDiskBanner，位置在存储降级红条之后、跳过提示之前，压制条件跟 storageDegraded，取数 hook 不进事件流 */
const checkEventStream = (raw: string): Array<Violation<StreamRule>> => {
  const src = stripComments(raw);
  const out: Array<Violation<StreamRule>> = [];
  if (!/import\s*\{[^}]*\bLowDiskBanner\b[^}]*\}\s*from\s*["']\.\/low-disk-bar["']/.test(src)) {
    out.push({ rule: "import", msg: '没从 "./low-disk-bar" import LowDiskBanner' });
  }
  const mounts = src.match(/<LowDiskBanner(?=[\s/>])/g) ?? [];
  if (mounts.length !== 1) {
    out.push({ rule: "mount-once", msg: `<LowDiskBanner> 出现 ${mounts.length} 次，应恰好 1 次（0 = 没挂上；2+ = 重复红条）` });
  }
  const tag = jsxOpeningTag(src, "LowDiskBanner");
  if (
    !tag ||
    !/\bsuppressed=\{\s*(?:!!\s*storageDegraded|Boolean\(\s*storageDegraded\s*\)|storageDegraded\s*!==?\s*null)\s*\}/.test(tag)
  ) {
    out.push({ rule: "suppressed", msg: "<LowDiskBanner> 的 suppressed 没跟 storageDegraded（降级红条出现时本条应让位）" });
  }
  const iDegraded = src.indexOf("<StorageDegradedBar");
  const iLow = src.indexOf("<LowDiskBanner");
  const iSkipped = src.indexOf("<EventsSkippedNotice");
  if (!(iDegraded >= 0 && iLow > iDegraded && iSkipped > iLow)) {
    out.push({ rule: "order", msg: "顺序应为：StorageDegradedBar → LowDiskBanner → EventsSkippedNotice（红在上、灰在下）" });
  }
  if (/\buseLowDisk\b/.test(src)) {
    out.push({ rule: "no-hook-in-stream", msg: "event-stream.tsx 里不该直接用 useLowDisk：读数状态要收在 LowDiskBanner 里，免得 5 分钟一次的状态更新重渲染整棵事件流" });
  }
  return out;
};

type HookRule =
  | "url"
  | "no-store"
  | "timeout"
  | "timeout-ms"
  | "now"
  | "ok-check"
  | "guard"
  | "merge"
  | "visible-check"
  | "start"
  | "focus"
  | "visibility"
  | "nudge-handler"
  | "cleanup-focus"
  | "cleanup-visibility"
  | "cleanup-stop"
  | "deps";

/** use-low-disk.ts：取数请求的形态、读数合并、poller 的启停与事件监听的成对清理 */
const checkHook = (raw: string): Array<Violation<HookRule>> => {
  const src = stripComments(raw);
  const out: Array<Violation<HookRule>> = [];
  const need = (rule: HookRule, re: RegExp, msg: string): void => {
    if (!re.test(src)) out.push({ rule, msg });
  };
  need("url", /\bfetch\(\s*["']\/api\/system\/disk["']/, '没有 fetch("/api/system/disk")');
  need("no-store", /\bcache:\s*["']no-store["']/, "fetch 没带 cache: no-store（浏览器缓存会让红条在腾出空间后迟迟不消失）");
  need("timeout", /\bsignal:\s*AbortSignal\.timeout\(/, "fetch 没带 AbortSignal.timeout（请求挂住会卡死在飞标记、后续轮询全停）");
  // 超时的取值也要钉住：写成 100ms 会让慢机 / dev 冷编译路由时的首次取数被误判失败（下一次要等 5 分钟）；写成几分钟又等于没超时
  const timeoutMs = Number(/\bconst\s+FETCH_TIMEOUT_MS\s*=\s*([\d_]+)\s*;/.exec(src)?.[1]?.replace(/_/g, ""));
  if (!(timeoutMs >= 5_000 && timeoutMs <= 30_000)) {
    out.push({ rule: "timeout-ms", msg: `FETCH_TIMEOUT_MS=${String(timeoutMs)}，应在 5~30 秒之间` });
  }
  // poller 全依赖注入（不碰 Date.now），所以真实时钟只能在这里注入：恒定 / 缺失的时钟会让「聚焦补取至少隔 30 秒」的防抖永远拦截
  need("now", /\bnow:\s*(?:\(\s*\)\s*=>\s*Date\.now\(\s*\)|Date\.now)\s*,/, "没有把真实时钟注入 poller（now: () => Date.now()）：聚焦补取的 30 秒防抖会失灵");
  need("ok-check", /if\s*\(\s*!\s*res\.ok\s*\)\s*return\s+null/, "没有 res.ok 检查（非 2xx 的响应体不该当读数解析）");
  need("guard", /\bisDiskReading\(\s*\w+\s*\)/, "没有用 isDiskReading 校验响应形状（不信任服务端返回）");
  need(
    "merge",
    /\bsetReading\(\s*\(\s*(\w+)\s*\)\s*=>\s*mergeDiskReading\(\s*\1\s*,\s*\w+\s*\)\s*\)/,
    "setReading 没走 setReading(prev => mergeDiskReading(prev, next))（unknown 不能覆盖上一次的结论）",
  );
  need("visible-check", /\bisVisible:\s*\(\s*\)\s*=>\s*document\.visibilityState\s*===\s*["']visible["']/, "isVisible 没按 document.visibilityState === 'visible' 判断");
  need("start", /\bpoller\.start\(\s*\)/, "没有 poller.start()");

  // 事件处理函数：const nudge = () => poller.nudge()
  const handler = /\bconst\s+(\w+)\s*=\s*\(\s*\)\s*(?::\s*void\s*)?=>\s*(?:\{\s*)?poller\.nudge\(\s*\)/.exec(src)?.[1];
  if (!handler) {
    out.push({ rule: "nudge-handler", msg: "没有「const handler = () => poller.nudge()」形态的事件处理函数" });
  }
  const h = handler ?? "__missing__";
  need("focus", new RegExp(`\\bwindow\\.addEventListener\\(\\s*["']focus["']\\s*,\\s*${h}\\s*\\)`), "没有 window.addEventListener('focus', 处理函数)");
  need(
    "visibility",
    new RegExp(`\\bdocument\\.addEventListener\\(\\s*["']visibilitychange["']\\s*,\\s*${h}\\s*\\)`),
    "没有 document.addEventListener('visibilitychange', 处理函数)",
  );

  // 清理函数：effect 里 `return () => { … }` 之后的部分
  const cleanup = src.slice(Math.max(0, src.indexOf("return () =>")));
  const hasCleanup = src.includes("return () =>");
  if (!hasCleanup || !new RegExp(`\\bwindow\\.removeEventListener\\(\\s*["']focus["']\\s*,\\s*${h}\\s*\\)`).test(cleanup)) {
    out.push({ rule: "cleanup-focus", msg: "清理函数里没有对应的 window.removeEventListener('focus', 同一个处理函数)" });
  }
  if (!hasCleanup || !new RegExp(`\\bdocument\\.removeEventListener\\(\\s*["']visibilitychange["']\\s*,\\s*${h}\\s*\\)`).test(cleanup)) {
    out.push({ rule: "cleanup-visibility", msg: "清理函数里没有对应的 document.removeEventListener('visibilitychange', 同一个处理函数)" });
  }
  if (!hasCleanup || !/\bpoller\.stop\(\s*\)/.test(cleanup)) {
    out.push({ rule: "cleanup-stop", msg: "清理函数里没有 poller.stop()（组件卸载后还会继续轮询并 setState）" });
  }
  // effect 只挂一次：依赖数组为空
  if (!/\n\s*\},\s*\[\s*\]\s*\)\s*;/.test(src)) {
    out.push({ rule: "deps", msg: "useEffect 的依赖数组不是 []（依赖 reading 之类会让 poller 每次状态更新都重建、立刻再取一次）" });
  }
  return out;
};

type PureRule = "globals";

/** low-disk-poller.ts：全部依赖注入——不直接碰定时器 / 时钟 / DOM / fetch，假时钟单测才有意义 */
const checkPollerPure = (raw: string): Array<Violation<PureRule>> => {
  const src = stripComments(raw);
  const hit = /\b(setTimeout|setInterval|clearTimeout|clearInterval|Date\.now|performance|document|window|fetch)\b/.exec(src)?.[1];
  return hit ? [{ rule: "globals", msg: `poller 里直接用了全局 ${hit}（应经注入的 setTimer / now / isVisible / fetchReading）` }] : [];
};

type ReadOnlyRule = "writes";

/** server/disk-free.ts：只读——量盘不能在盘快满时再往里写东西（建目录 / 写探针文件都不行） */
const checkReadOnlyFs = (raw: string): Array<Violation<ReadOnlyRule>> => {
  const src = stripComments(raw);
  const hit =
    /\b(mkdir|mkdirSync|mkdtemp|writeFile|writeFileSync|appendFile|appendFileSync|copyFile|rename|rm|rmSync|rmdir|unlink|truncate|open|createWriteStream)\b/.exec(
      src,
    )?.[1];
  return hit ? [{ rule: "writes", msg: `disk-free 里出现了写操作 ${hit}` }] : [];
};

type ThresholdRule = "literal";

/** 低磁盘相关文件里不再出现阈值字面量 500 / 2048：阈值只在 lib/low-disk.ts 定义一处（与壳侧的对账在 low-disk.test.ts） */
const checkNoThresholdLiteral = (raw: string): Array<Violation<ThresholdRule>> => {
  const hit = /\b(500|2048)\b/.exec(stripComments(raw))?.[1];
  return hit ? [{ rule: "literal", msg: `出现阈值字面量 ${hit}（应引用 lib/low-disk 的常量）` }] : [];
};

/** 从 ui-convention-scan.test.ts 取 FIXED_FILES 里登记的文件列表 */
const fixedFilesOf = (raw: string): string[] => {
  // 数组以行首的 `]`（可跟 `as const`）收尾——不能按第一个 `]` 截断：文件名里可能有动态路由的 `[id]`
  const m = /const FIXED_FILES = \[([\s\S]*?)\n\](?: as const)?\s*;/.exec(stripComments(raw));
  return m ? [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!) : [];
};

// ============================================================ 真实源码零违例

const eventStreamSrc = readSrc("components", "tasks", "event-stream.tsx");
const hookSrc = readSrc("hooks", "use-low-disk.ts");
const pollerSrc = readSrc("lib", "low-disk-poller.ts");
const diskFreeSrc = readSrc("lib", "server", "disk-free.ts");

describe("接线契约 · 真实源码", () => {
  it("EventStream：LowDiskBanner 引入并只挂一处，位置与压制条件正确，取数 hook 不进事件流", () => {
    expect(checkEventStream(eventStreamSrc)).toEqual([]);
  });

  it("useLowDisk：请求形态、读数合并、poller 启停与事件监听成对清理", () => {
    expect(checkHook(hookSrc)).toEqual([]);
  });

  it("low-disk-poller：不直接碰全局定时器 / 时钟 / DOM / fetch", () => {
    expect(checkPollerPure(pollerSrc)).toEqual([]);
  });

  it("disk-free：只读，不建目录、不写文件", () => {
    expect(checkReadOnlyFs(diskFreeSrc)).toEqual([]);
  });

  it.each([
    ["components/tasks/low-disk-bar.tsx"],
    ["hooks/use-low-disk.ts"],
    ["lib/low-disk-poller.ts"],
    ["lib/server/disk-free.ts"],
    ["app/api/system/disk/route.ts"],
  ])("%s：没有阈值字面量 500 / 2048（阈值只在 lib/low-disk.ts 一处）", (rel) => {
    expect(checkNoThresholdLiteral(readSrc(...rel.split("/")))).toEqual([]);
  });

  it("hook 请求的 URL 有对应的路由文件（URL 与 app/api 目录不会悄悄对不上）", () => {
    const url = /\bfetch\(\s*["'](\/api\/[^"']+)["']/.exec(stripComments(hookSrc))?.[1];
    expect(url).toBe("/api/system/disk");
    expect(existsSync(path.join(srcDir, "app", ...url!.split("/").filter(Boolean), "route.ts"))).toBe(true);
  });

  it("全站 API 守门 middleware 仍覆盖 /api/**（新路由自动在 loopback 守卫之内，没有另开口子）", () => {
    expect(stripComments(readSrc("middleware.ts"))).toMatch(/matcher:\s*["']\/api\/:path\*["']/);
  });

  it("新组件登记在 ui-convention-scan 的 FIXED_FILES（低磁盘红条受颜色 / opacity / blur 规则扫描）", () => {
    const fixed = fixedFilesOf(readFileSync(path.join(testsDir, "ui-convention-scan.test.ts"), "utf-8"));
    const lowDiskTsx = readdirSync(path.join(srcDir, "components", "tasks")).filter((f) => /^low-disk.*\.tsx$/.test(f));
    expect(lowDiskTsx.length).toBeGreaterThan(0);
    for (const f of lowDiskTsx) expect(fixed, f).toContain(`components/tasks/${f}`);
  });
});

// ============================================================ 变异自检（契约自己不能是摆设）

describe("接线契约 · 变异自检", () => {
  const HOOK_NUDGE = "const nudge = (): void => poller.nudge();";

  it.each<[string, (s: string) => string, StreamRule]>([
    ["删掉 import", (s) => mutate(s, /import \{ LowDiskBanner \} from "\.\/low-disk-bar";\r?\n/, ""), "import"],
    ["删掉挂载", (s) => mutate(s, /[ \t]*<LowDiskBanner suppressed=\{!!storageDegraded\} \/>\r?\n/, ""), "mount-once"],
    [
      "挂两遍",
      (s) => mutate(s, "<LowDiskBanner suppressed={!!storageDegraded} />", "<LowDiskBanner suppressed={!!storageDegraded} />\n<LowDiskBanner suppressed={!!storageDegraded} />"),
      "mount-once",
    ],
    ["suppressed 写死 false", (s) => mutate(s, "suppressed={!!storageDegraded}", "suppressed={false}"), "suppressed"],
    ["suppressed 写反", (s) => mutate(s, "suppressed={!!storageDegraded}", "suppressed={!storageDegraded}"), "suppressed"],
    ["去掉 suppressed", (s) => mutate(s, " suppressed={!!storageDegraded}", ""), "suppressed"],
    [
      "挪到 EventsSkippedNotice 之后",
      (s) => {
        const removed = mutate(s, /[ \t]*<LowDiskBanner suppressed=\{!!storageDegraded\} \/>\r?\n/, "");
        return mutate(removed, "<EventsSkippedNotice count={task.eventsSkipped} />", "<EventsSkippedNotice count={task.eventsSkipped} />\n<LowDiskBanner suppressed={!!storageDegraded} />");
      },
      "order",
    ],
    ["事件流里直接用 hook", (s) => `${s}\nconst leaked = useLowDisk();\n`, "no-hook-in-stream"],
  ])("EventStream · %s → 检查函数报出对应违例", (_name, breakIt, rule) => {
    expect(rulesOf(checkEventStream(breakIt(eventStreamSrc)))).toContain(rule);
  });

  it("EventStream · 注释里残留符号不算数：真接线删了、注释还在 → 照样报", () => {
    const broken = mutate(eventStreamSrc, /[ \t]*<LowDiskBanner suppressed=\{!!storageDegraded\} \/>\r?\n/, "");
    const withComment = `// <LowDiskBanner suppressed={!!storageDegraded} />\n${broken}`;
    expect(rulesOf(checkEventStream(withComment))).toContain("mount-once");
  });

  it.each<[string, (s: string) => string, HookRule]>([
    ["URL 写错", (s) => mutate(s, '"/api/system/disk"', '"/api/system/disks"'), "url"],
    ["去掉 cache: no-store", (s) => mutate(s, /\s*cache: "no-store",/, ""), "no-store"],
    ["去掉请求超时", (s) => mutate(s, /\s*signal: AbortSignal\.timeout\(FETCH_TIMEOUT_MS\),/, ""), "timeout"],
    ["请求超时写成 100ms", (s) => mutate(s, "const FETCH_TIMEOUT_MS = 10_000;", "const FETCH_TIMEOUT_MS = 100;"), "timeout-ms"],
    ["请求超时写成 10 分钟", (s) => mutate(s, "const FETCH_TIMEOUT_MS = 10_000;", "const FETCH_TIMEOUT_MS = 600_000;"), "timeout-ms"],
    ["时钟写死 0", (s) => mutate(s, "now: () => Date.now(),", "now: () => 0,"), "now"],
    ["不注入时钟", (s) => mutate(s, /\s*now: \(\) => Date\.now\(\),/, ""), "now"],
    ["去掉 res.ok 检查", (s) => mutate(s, "if (!res.ok) return null;", ""), "ok-check"],
    ["不校验响应形状", (s) => mutate(s, "return isDiskReading(data) ? data : null;", "return data as DiskReading;"), "guard"],
    ["读数不走 merge", (s) => mutate(s, "setReading((prev) => mergeDiskReading(prev, next))", "setReading(next)"), "merge"],
    ["可见性写死", (s) => mutate(s, 'isVisible: () => document.visibilityState === "visible"', "isVisible: () => true"), "visible-check"],
    ["不 start", (s) => mutate(s, "poller.start();", ""), "start"],
    ["不监听 focus", (s) => mutate(s, 'window.addEventListener("focus", nudge);', ""), "focus"],
    ["不监听 visibilitychange", (s) => mutate(s, 'document.addEventListener("visibilitychange", nudge);', ""), "visibility"],
    ["处理函数不再 nudge", (s) => mutate(s, HOOK_NUDGE, "const nudge = (): void => undefined;"), "nudge-handler"],
    ["清理漏掉 focus", (s) => mutate(s, 'window.removeEventListener("focus", nudge);', ""), "cleanup-focus"],
    ["清理漏掉 visibilitychange", (s) => mutate(s, 'document.removeEventListener("visibilitychange", nudge);', ""), "cleanup-visibility"],
    ["清理漏掉 stop", (s) => mutate(s, "poller.stop();", ""), "cleanup-stop"],
    ["清理摘的不是同一个处理函数", (s) => mutate(s, 'window.removeEventListener("focus", nudge);', 'window.removeEventListener("focus", () => poller.nudge());'), "cleanup-focus"],
    ["依赖数组含 reading", (s) => mutate(s, /\n(\s*)\}, \[\]\);/, "\n$1}, [reading]);"), "deps"],
  ])("useLowDisk · %s → 检查函数报出对应违例", (_name, breakIt, rule) => {
    expect(rulesOf(checkHook(breakIt(hookSrc)))).toContain(rule);
  });

  it("useLowDisk · 注释里残留符号不算数：真的 poller.stop() 删了、注释里还写着 → 照样报", () => {
    const broken = mutate(hookSrc, "poller.stop();", "// poller.stop();");
    expect(rulesOf(checkHook(broken))).toContain("cleanup-stop");
  });

  it.each(["setTimeout(() => {}, 0);", "setInterval(() => {}, 1);", "clearTimeout(0);", "const t = Date.now();", "void document.hidden;", "void window.name;", "void fetch('/x');"])(
    "poller · 直接碰全局（%s）→ 报",
    (stmt) => {
      expect(rulesOf(checkPollerPure(`${pollerSrc}\n${stmt}\n`))).toEqual(["globals"]);
    },
  );

  it.each(["await mkdir('/x');", "await writeFile('/x', '');", "await rm('/x');", "await unlink('/x');", "await open('/x');"])(
    "disk-free · 出现写操作（%s）→ 报",
    (stmt) => {
      expect(rulesOf(checkReadOnlyFs(`${diskFreeSrc}\n${stmt}\n`))).toEqual(["writes"]);
    },
  );

  it.each(["const T = 500;", "const W = 2048;"])("阈值字面量（%s）→ 报", (stmt) => {
    expect(rulesOf(checkNoThresholdLiteral(`${hookSrc}\n${stmt}\n`))).toEqual(["literal"]);
  });

  it("阈值检查不误伤注释：注释里写着 500MB / 2GB 不算", () => {
    expect(checkNoThresholdLiteral(`${hookSrc}\n// 严重：< 500MB；偏低：< 2048MB\n/* 500 */\n`)).toEqual([]);
  });

  it("FIXED_FILES 解析自检：能解析出登记列表，且包含存储降级红条（证明解析器没解析成空）", () => {
    const fixed = fixedFilesOf(readFileSync(path.join(testsDir, "ui-convention-scan.test.ts"), "utf-8"));
    expect(fixed).toContain("components/tasks/storage-degraded-bar.tsx");
    expect(fixed.length).toBeGreaterThan(5);
  });

  it("FIXED_FILES 解析自检：文件名里带 [id] 的动态路由不会把数组提前截断；漏登记会被发现", () => {
    const sample = ['const FIXED_FILES = [', '  "a/b.tsx", // 注释', '  "app/tasks/[id]/page.tsx",', '  "c/d.tsx",', '] as const;'].join("\n");
    expect(fixedFilesOf(sample)).toEqual(["a/b.tsx", "app/tasks/[id]/page.tsx", "c/d.tsx"]);
    expect(fixedFilesOf(sample)).not.toContain("components/tasks/low-disk-bar.tsx");
    expect(fixedFilesOf("const nothing = 1;")).toEqual([]);
  });
});
