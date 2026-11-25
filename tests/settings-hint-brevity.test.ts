/**
 * 设置行的 hint / detail 一律是「一句话 / 几句补充」（ui-conventions「设置类页面」），扫的是**文案数据本身**。
 *
 * 背景（2026-11-24 用户：「设置页太乱了……一大串一大串的字去掉」）：浏览器卡、飞书桥接块的说明一行一大段，读不下去。
 * 约定：hint 只写一句，放不下的背景 / 边界 / 风险细节进 SettingRow 的 `detail`（名称后的 ⓘ）或折叠区。
 *
 * 为什么改成扫数据（S-4）：以前这条测试只扫 src/components/**\/*.tsx 里单行的 `hint="…"` 字面量，而浏览器卡整张都是
 * `{...rowCopy(COPY.x)}` 展开，一条都扫不到；detail 也完全没扫；注释写「约 40 字」实际放行 60 字、现存最长更是 51/52 字。
 * 现在扫四处，数字统一在 tests/helpers/settings-copy-limits.ts：
 *   ① BROWSER_SETTING_COPY（浏览器卡全部 hint / detail）；
 *   ② FEISHU_ROW_COPY（飞书块三个选项行，已从 JSX 里提成可导入的常量）；
 *   ③ 其余组件里仍写成字面量的 `hint="…"` / `detail="…"`（旧的源码扫描保留，兜住没提成数据的卡）；
 *   ④ 其余组件里 `hint={…}` 的 JSX / 常量写法（R20-13 补）：tests/helpers/jsx-static-text.ts 取表达式里**写死的静态文字**来量
 *      ——以前这一类整个漏扫，实际漏过「解锁组件（可选）」一行（约 72 字）和两条装配失败态的说明（87 / 75 字）。
 * 并有「合成超长样本必须被判红」的自检：证明扫描器本身有效，不是永远绿。
 *
 * 边界：④ 只量静态文字——`{变量}` / 条件渲染的状态提示（warning / role=status 那些）是运行时才有的，不算那一句 hint；
 * 别处 import 进来的字符串常量、三元 / `||` 兜底写法量不到（扫描器自检里列了）。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { FEISHU_ROW_COPY } from "@/components/settings/feishu-bridge-block";
import { BROWSER_SETTING_COPY } from "@/lib/browser-settings-copy";
import { extractJsxHints, jsxStaticText, stringConstants } from "./helpers/jsx-static-text";
import { DETAIL_MAX, findOverLimit, HINT_MAX, type CopyItem } from "./helpers/settings-copy-limits";

const ROOT = path.resolve(import.meta.dirname, "../src/components");

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return p.endsWith(".tsx") ? [p] : [];
  });

const dataItems = (source: string, data: Record<string, { hint: string; detail?: string }>): CopyItem[] =>
  Object.entries(data).map(([key, v]) => ({ source: `${source}.${key}`, hint: v.hint, detail: v.detail }));

const browserItems = dataItems("browser", BROWSER_SETTING_COPY);
const feishuItems = dataItems("feishu", FEISHU_ROW_COPY);

/** 组件源码里单行的 hint="…" / detail="…" 字面量 */
const literalItems: CopyItem[] = walk(ROOT).flatMap((file) => {
  const src = readFileSync(file, "utf8");
  const rel = path.relative(ROOT, file);
  return [
    ...[...src.matchAll(/\bhint="([^"]*)"/g)].map((m): CopyItem => ({ source: `${rel}#hint`, hint: m[1]! })),
    ...[...src.matchAll(/\bdetail="([^"]*)"/g)].map((m): CopyItem => ({ source: `${rel}#detail`, detail: m[1]! })),
  ];
});

/** 组件源码里 `hint={…}`（JSX / 字符串常量写法）的静态可见文字（R20-13） */
const jsxScan = walk(ROOT).flatMap((file) => {
  const src = readFileSync(file, "utf8");
  const rel = path.relative(ROOT, file);
  return extractJsxHints(src).map((h) => ({ ...h, rel, line: src.slice(0, h.index).split("\n").length }));
});
const jsxItems: CopyItem[] = jsxScan
  .filter((h) => h.text !== null && h.text.length > 0)
  .map((h): CopyItem => ({ source: `${h.rel}:${h.line}#jsx-hint`, hint: h.text! }));

describe("设置行文案数据：一句话 hint + 有限的 detail", () => {
  it("扫到了数据（别让扫描空转）：浏览器卡 9 项、飞书块 3 项、字面量若干", () => {
    expect(browserItems).toHaveLength(9);
    expect(feishuItems).toHaveLength(3);
    expect(browserItems.some((i) => i.source === "browser.evaluate" && (i.detail ?? "").length > 0)).toBe(true);
    expect(feishuItems.some((i) => i.source === "feishu.nonOwnerGuard" && (i.hint ?? "").length > 0)).toBe(true);
    expect(literalItems.filter((i) => i.hint !== undefined).length).toBeGreaterThan(5);
  });

  it(`浏览器卡：每条 hint ≤ ${HINT_MAX} 字、不换行，detail ≤ ${DETAIL_MAX} 字`, () => {
    expect(findOverLimit(browserItems)).toEqual([]);
  });

  it(`飞书块三个选项行：hint ≤ ${HINT_MAX} 字、detail ≤ ${DETAIL_MAX} 字`, () => {
    expect(findOverLimit(feishuItems)).toEqual([]);
  });

  it(`其余组件里的字面量 hint / detail 同一个上限（${HINT_MAX} / ${DETAIL_MAX}）`, () => {
    expect(findOverLimit(literalItems)).toEqual([]);
  });

  it(`R20-13 其余组件里 JSX / 常量写法的 hint（hint={<>…</>} / hint={常量}）：静态可见文字同一个上限（${HINT_MAX}）`, () => {
    expect(findOverLimit(jsxItems)).toEqual([]);
  });

  it("R20-13 JSX 扫描没有空转：量到了「解锁组件」一行、两个「锁屏时也能用」的说明（含 {常量} 解析）、装配失败态的两条常量说明", () => {
    const texts = jsxItems.map((i) => i.hint ?? "");
    // 解锁组件（可选）：JSX 片段里的静态文字
    expect(texts.some((t) => t.startsWith("有些应用锁屏时画不出界面"))).toBe(true);
    // Windows 的「锁屏时也能用」：hint 里是 {WINDOWS_LOCKED_DESC}（同文件字符串常量），要被解析出来
    expect(texts.some((t) => t.startsWith("电脑锁屏时，AI 可以继续操作你锁屏前已经打开的应用"))).toBe(true);
    // macOS 的「锁屏时也能用」：JSX 里写死的文字
    expect(texts.some((t) => t.startsWith("电脑锁屏时，AI 会用你保存的开机密码自动解锁"))).toBe(true);
    // 装配失败态：hint={常量名}
    expect(texts.some((t) => t.startsWith("这项设置还开着，但「电脑操作」现在用不了"))).toBe(true);
    expect(texts.some((t) => t.startsWith("「电脑操作」这次没能初始化"))).toBe(true);
    // 量到的条数有下限（2026-11-24 实测 7 条非空；跳过的是三元 / 兜底 / 别处 import 的常量 / 纯动态，它们量不到，见头注释的边界）
    expect(jsxItems.length).toBeGreaterThanOrEqual(7);
  });

  it("上限数字本身被钉住：想调大要改这里并在评审里说理由（HINT_MAX = 68、DETAIL_MAX = 140，见 settings-copy-limits.ts 的来历）", () => {
    // 原来这里有一条「最长的 hint / detail 离上限至少留 5% 余量」：它让实际可用的上限变成 64 / 133，低于声明的 68 / 140，
    // 同一份数字两个口径（findOverLimit 放行 65~68 字、余量那条却判红）。R20-13 去掉余量条，上限就是声明的这两个数；
    // 「别悄悄被撑满」改由钉数字来管：上限不动，现有文案就只能在上限内改。
    expect(HINT_MAX).toBe(68);
    expect(DETAIL_MAX).toBe(140);
    // 数据里的最长一条仍在上限内（findOverLimit 上面已经逐条判了；这里只是让「离上限多远」能在失败信息里看到）
    const all = [...browserItems, ...feishuItems, ...jsxItems];
    const longestHint = Math.max(...all.map((i) => (i.hint ?? "").length));
    const longestDetail = Math.max(...all.map((i) => (i.detail ?? "").length));
    expect(longestHint, "现存最长 hint").toBeLessThanOrEqual(HINT_MAX);
    expect(longestDetail, "现存最长 detail").toBeLessThanOrEqual(DETAIL_MAX);
  });
});

describe("扫描器自检：合成的超长 / 含换行样本必须被判红", () => {
  it("hint 比上限多 1 个字 → 红；恰好等于上限 → 绿", () => {
    expect(findOverLimit([{ source: "合成", hint: "字".repeat(HINT_MAX + 1) }])).toHaveLength(1);
    expect(findOverLimit([{ source: "合成", hint: "字".repeat(HINT_MAX) }])).toEqual([]);
  });

  it("detail 比上限多 1 个字 → 红；恰好等于上限 → 绿", () => {
    expect(findOverLimit([{ source: "合成", detail: "字".repeat(DETAIL_MAX + 1) }])).toHaveLength(1);
    expect(findOverLimit([{ source: "合成", detail: "字".repeat(DETAIL_MAX) }])).toEqual([]);
  });

  it("hint 里有换行 → 红", () => {
    expect(findOverLimit([{ source: "合成", hint: "第一句\n第二句" }])).toHaveLength(1);
  });

  it("把合成的超长 hint 混进真实数据里，整批扫描也红（扫描走的是真实路径，不是只在空数组上绿）", () => {
    const bad = findOverLimit([...browserItems, { source: "合成", hint: "长".repeat(HINT_MAX + 10) }]);
    // 只数合成的那条（真实数据若同时有超长的，由上面的专门用例报，不在这里串扰）
    expect(bad.filter((b) => b.includes("合成"))).toHaveLength(1);
  });
});

describe("R20-13 JSX 静态文字提取器自检（tests/helpers/jsx-static-text.ts）：认什么、不认什么", () => {
  const text = (expr: string, src = "") => jsxStaticText(expr, stringConstants(src));

  it("字符串 / 模板字面量：取内容，模板里的 ${…} 丢掉；字面量后面跟了别的东西（拼接 / 兜底）不量", () => {
    expect(text('"一句话"')).toBe("一句话");
    expect(text("`第 ${n} 行`")).toBe("第 行");
    expect(text('"a" + b')).toBeNull();
    expect(text('x || "兜底"')).toBeNull();
  });

  it("JSX 片段：标签丢掉、顶层文字留下、空白折叠；标签两侧不粘连", () => {
    expect(text("<>\n  第一句。\n  第二句。\n</>")).toBe("第一句。 第二句。");
    expect(text("<>前<br />后</>")).toBe("前 后");
    expect(text('<span className="mt-1 block">里面的字</span>')).toBe("里面的字");
  });

  it("属性里带 > 的表达式不会把标签提前截断", () => {
    expect(text('<>文字 <b className={cn(a > b ? "x" : "y")}>粗体</b> 结尾</>')).toBe("文字 粗体 结尾");
  });

  it("{\"…\"} 字符串表达式取内容；{变量} / 条件渲染的状态提示整个丢掉（运行时才有，不算那一句 hint）", () => {
    expect(text('<>占位符 {"{storyId}"} 结尾</>')).toBe("占位符 {storyId} 结尾");
    expect(text("<>基础说明{warn && <span role=\"status\">警告：很长很长的一段运行时提示</span>}</>")).toBe("基础说明");
    expect(text("<>基础说明{note}</>")).toBe("基础说明");
  });

  it("{常量名} / hint={常量名}：同文件 const NAME = \"…\"; 的内容被解析进来；解析不了（别处 import / 拼接）→ 丢掉 / null", () => {
    const src = 'const DESC =\n  "常量里的一句话";\nconst CONCAT = "a" + "b";';
    expect(text("DESC", src)).toBe("常量里的一句话");
    expect(text("<>前缀。{DESC}</>", src)).toBe("前缀。常量里的一句话");
    expect(text("CONCAT", src)).toBeNull();
    expect(text("IMPORTED", src)).toBeNull();
    expect(text("<>前缀。{IMPORTED}</>", src)).toBe("前缀。");
  });

  it("不是字面量 / 常量 / JSX 的写法（三元 / 调用 / 属性访问）→ null（不量）", () => {
    expect(text("desktop ? COPY.a.hint : COPY.b.hint")).toBeNull();
    expect(text("status.note?.trim() || \"兜底\"")).toBeNull();
    expect(text("cond ? <A /> : undefined")).toBeNull();
    expect(text("")).toBeNull();
  });

  it("表达式里的注释、字符串里的花括号 / 引号不会让配对错位", () => {
    const src = [
      "<Row",
      "  hint={",
      "    <>",
      "      静态文字。",
      "      {cond && ( // 这里有个注释，里面有「引号」和 } 花括号",
      '        <span className="x">{"带 } 的字符串"}</span>',
      "      )}",
      "    </>",
      "  }",
      '  control={<Switch aria-label="x" />}',
      "/>",
    ].join("\n");
    const hints = extractJsxHints(src);
    expect(hints).toHaveLength(1);
    expect(hints[0]!.text).toBe("静态文字。");
  });

  it("合成的超长 JSX hint 被判红（整条扫描链：源码 → 静态文字 → findOverLimit）", () => {
    const long = "字".repeat(HINT_MAX + 1);
    const src = `<SettingRow label="x" hint={<>${long}{dyn}</>} control={null} />`;
    const items = extractJsxHints(src).map((h): CopyItem => ({ source: "合成#jsx-hint", hint: h.text! }));
    expect(items).toHaveLength(1);
    expect(findOverLimit(items)).toHaveLength(1);
    // 恰好等于上限 → 绿
    const ok = `<SettingRow label="x" hint={<>${"字".repeat(HINT_MAX)}</>} control={null} />`;
    expect(findOverLimit(extractJsxHints(ok).map((h): CopyItem => ({ source: "合成", hint: h.text! })))).toEqual([]);
    // 常量写法同样被量到
    const viaConst = `const LONG = "${long}";\n<SettingRow label="x" hint={LONG} control={null} />`;
    expect(findOverLimit(extractJsxHints(viaConst).map((h): CopyItem => ({ source: "合成", hint: h.text! })))).toHaveLength(1);
  });
});
