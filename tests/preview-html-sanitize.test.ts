/**
 * docx / xlsx 预览 HTML 净化器（S10-01）：
 * - XSS 载荷样本全部被剔除（脚本 / 事件属性 / javascript: / 实体与空白绕过 / mXSS 嵌套 / 未闭合标签）
 * - 正常 mammoth / SheetJS 风格输出（标题 / 列表 / 表格 / 链接 / 图片）原样保留
 * - 幂等：净化结果再净化不变
 */
import { describe, expect, it, vi } from "vitest";

import { sanitizePreviewHtml } from "@/lib/preview-html-sanitize";

import { cpuClock } from "./helpers/scaling-ratio";

const ALLOWED_TAG_NAMES = new Set([
  "p", "br", "hr", "div", "span", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup", "col",
  "strong", "b", "em", "i", "u", "s", "del", "ins", "mark", "small", "sub", "sup",
  "code", "pre", "blockquote", "a", "img",
]);
const ALLOWED_ATTR_NAMES = new Set([
  "href", "title", "src", "alt", "width", "height", "colspan", "rowspan", "span", "rel",
]);

/** 结构化断言：输出里每个标签都在白名单、每个属性都在白名单、没有危险子串 */
const expectSafe = (out: string) => {
  for (const m of out.matchAll(/<\/?([a-zA-Z0-9-]+)((?:\s+[a-z-]+="[^"]*")*)\s*>/g)) {
    expect(ALLOWED_TAG_NAMES.has(m[1].toLowerCase())).toBe(true);
    for (const a of m[2].matchAll(/\s+([a-z-]+)="/g)) {
      expect(ALLOWED_ATTR_NAMES.has(a[1])).toBe(true);
    }
  }
  // 去掉合法标签后，不能再残留任何 `<`（即不存在漏网 / 半截标签）
  const stripped = out.replace(/<\/?[a-zA-Z0-9-]+(?:\s+[a-z-]+="[^"]*")*\s*>/g, "");
  expect(stripped).not.toContain("<");
  expect(out).not.toMatch(/<\s*script/i);
  expect(out).not.toMatch(/\son[a-z]+\s*=/i);
  expect(out).not.toMatch(/="\s*javascript:/i);
};

describe("sanitizePreviewHtml：保留正常排版", () => {
  it("标题 / 段落 / 列表 / 强调", () => {
    const html =
      "<h1>标题</h1><p>正文 <strong>粗</strong><em>斜</em><u>下划线</u></p>" +
      "<ul><li>一</li><li>二</li></ul><ol><li>1</li></ol><blockquote>引</blockquote>";
    expect(sanitizePreviewHtml(html)).toBe(html);
  });

  it("表格（含 colspan / rowspan）原样保留", () => {
    const html =
      '<table><thead><tr><th colspan="2">头</th></tr></thead>' +
      '<tbody><tr><td rowspan="2">a</td><td>b</td></tr><tr><td>c</td></tr></tbody></table>';
    expect(sanitizePreviewHtml(html)).toBe(html);
  });

  it("SheetJS 风格整页输出：丢 html/head/meta/title 外壳与 id、保留表格内容", () => {
    const html =
      '<html><head><meta charset="utf-8"/><title>SheetJS Table Export</title></head><body>' +
      '<table id="local-file-xlsx-preview"><tr><td data-t="s" data-v="x" id="sjs-A1">x</td><td>1</td></tr></table>' +
      "</body></html>";
    const out = sanitizePreviewHtml(html);
    expect(out).toBe("<table><tr><td>x</td><td>1</td></tr></table>");
    expect(out).not.toContain("SheetJS Table Export");
  });

  it("http(s) / mailto 链接保留并补 rel", () => {
    const out = sanitizePreviewHtml(
      '<p><a href="https://example.com/a?x=1&amp;y=2">链接</a><a href="mailto:a@b.cn">m</a></p>',
    );
    expect(out).toBe(
      '<p><a href="https://example.com/a?x=1&amp;y=2" rel="noopener noreferrer">链接</a>' +
        '<a href="mailto:a@b.cn" rel="noopener noreferrer">m</a></p>',
    );
  });

  it("img：data:image base64 与 http(s) 保留，alt 保留", () => {
    const data = "data:image/png;base64,iVBORw0KGgo=";
    const out = sanitizePreviewHtml(
      `<p><img src="${data}" alt="图"/><img src="https://x.test/a.png" width="100"></p>`,
    );
    expect(out).toBe(
      `<p><img src="${data}" alt="图"><img src="https://x.test/a.png" width="100"></p>`,
    );
  });

  it("文本里的实体与孤立 < > 被安全处理", () => {
    expect(sanitizePreviewHtml("<p>a &amp; b &lt;script&gt; c</p>")).toBe(
      "<p>a &amp; b &lt;script&gt; c</p>",
    );
    expect(sanitizePreviewHtml("<p>1 < 2 > 0</p>")).toBe("<p>1 &lt; 2 &gt; 0</p>");
  });

  it("空 / 非字符串返回空串", () => {
    expect(sanitizePreviewHtml("")).toBe("");
    expect(sanitizePreviewHtml(undefined as unknown as string)).toBe("");
  });
});

describe("sanitizePreviewHtml：XSS 载荷全部剔除", () => {
  const payloads: Array<[string, string]> = [
    ["script 标签", "<p>a</p><script>alert(1)</script><p>b</p>"],
    ["大小写 + 空白 script", "<ScRiPt\n>alert(1)</sCrIpT >"],
    ["script 无闭合", "<p>x</p><script>alert(1)"],
    ["img onerror", '<img src=x onerror="alert(1)">'],
    ["img onerror 无引号", "<img src=x onerror=alert(1)>"],
    ["img 斜杠分隔属性", "<img/src=x/onerror=alert(1)>"],
    ["属性无空格紧贴", '<a href="https://a.test"onclick="alert(1)">x</a>'],
    ["svg onload", '<svg onload="alert(1)"><circle/></svg>'],
    ["svg 内嵌 script", "<svg><script>alert(1)</script></svg>"],
    ["math + style 嵌套 mXSS", "<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>"],
    ["noscript 逃逸", '<noscript><p title="</noscript><img src=x onerror=alert(1)>">'],
    ["iframe", '<iframe src="https://evil.test"></iframe>'],
    ["iframe srcdoc", '<iframe srcdoc="<script>alert(1)</script>"></iframe>'],
    ["object / embed", '<object data="x.swf"></object><embed src="x.swf">'],
    ["style 标签", "<style>body{background:url(javascript:alert(1))}</style>"],
    ["style 属性", '<p style="background:url(javascript:alert(1))">x</p>'],
    ["form + button", '<form action="https://evil.test"><button formaction="javascript:alert(1)">go</button></form>'],
    ["base / link / meta refresh", '<base href="https://evil.test/"><link rel="stylesheet" href="x.css"><meta http-equiv="refresh" content="0;url=javascript:alert(1)">'],
    ["javascript: 链接", '<a href="javascript:alert(1)">x</a>'],
    ["JaVaScRiPt: + 空白", '<a href=" \tJaVa\nScRiPt:alert(1)">x</a>'],
    ["实体编码 javascript:", '<a href="&#106;avascript&colon;alert(1)">x</a>'],
    ["十六进制实体缺分号", '<a href="&#x6A&#x61vascript:alert(1)">x</a>'],
    ["vbscript / data: html 链接", '<a href="vbscript:msgbox(1)">x</a><a href="data:text/html,<script>alert(1)</script>">y</a>'],
    ["img src javascript:", '<img src="javascript:alert(1)">'],
    ["img src data:text/html", '<img src="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">'],
    ["srcset / formaction / xlink:href", '<img srcset="javascript:alert(1) 1x" src="https://a.test/a.png"><a xlink:href="javascript:alert(1)">x</a>'],
    ["HTML 注释内藏标签", "<!--><img src=x onerror=alert(1)>-->"],
    ["条件注释 / CDATA", "<!--[if IE]><script>alert(1)</script><![endif]--><![CDATA[<script>alert(1)</script>]]>"],
    ["xml 处理指令", "<?xml version='1.0'?><script>alert(1)</script>"],
    ["半截标签（EOF）", '<p>ok</p><img src="x" onerror="alert(1)'],
    ["template / textarea / title / xmp", "<template><script>alert(1)</script></template><textarea><img onerror=alert(1)></textarea><title><img onerror=alert(1)></title><xmp><img onerror=alert(1)></xmp>"],
    ["plaintext", "<plaintext><img src=x onerror=alert(1)>"],
    ["标签名含 NUL / 反引号属性", "<scr\u0000ipt>alert(1)</scr\u0000ipt><a href=`javascript:alert(1)`>x</a>"],
    ["重复属性取第一个", '<a href="https://ok.test" href="javascript:alert(1)">x</a>'],
  ];

  it.each(payloads)("%s", (_name, payload) => {
    const out = sanitizePreviewHtml(payload);
    expectSafe(out);
    expect(out.toLowerCase()).not.toContain("alert(1)\"");
    expect(out).not.toMatch(/javascript:/i);
    expect(out).not.toMatch(/onerror/i);
    expect(out).not.toMatch(/<(iframe|object|embed|svg|math|style|form|base|link|meta)/i);
    // 幂等
    expect(sanitizePreviewHtml(out)).toBe(out);
  });

  it("script / style 的内容连同标签一起丢，不泄漏成文本", () => {
    expect(sanitizePreviewHtml("<p>a</p><script>alert(1)</script><p>b</p>")).toBe("<p>a</p><p>b</p>");
    expect(sanitizePreviewHtml("<style>p{color:red}</style><p>x</p>")).toBe("<p>x</p>");
  });

  it("javascript: 链接只丢 href、保留文本", () => {
    expect(sanitizePreviewHtml('<a href="javascript:alert(1)">点我</a>')).toBe(
      '<a rel="noopener noreferrer">点我</a>',
    );
  });

  it("img 的非法 src 被丢弃但 img 本身不带危险属性", () => {
    expect(sanitizePreviewHtml('<img src="javascript:alert(1)" onerror="x">')).toBe("<img>");
  });

  it("src 里实体编码的引号不能逃逸出属性（输出仍是只有 src 一个属性的 img）", () => {
    const out = sanitizePreviewHtml('<img src="https://a.test/x&quot; onerror=&quot;alert(1)">');
    // onerror 只是被转义后的 src 值内部文本、不是独立属性
    expect(out).toBe('<img src="https://a.test/x&quot; onerror=&quot;alert(1)">');
    expect(out.match(/<img\s+([a-z-]+)=/)?.[1]).toBe("src");
    expect(out.match(/\s[a-z-]+="/g)).toHaveLength(1);
    expect(sanitizePreviewHtml(out)).toBe(out);
  });

  it("属性值里的引号 / 尖括号输出时被转义", () => {
    const out = sanitizePreviewHtml('<img src="https://a.test/a.png" alt="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;">');
    expect(out).toBe(
      '<img src="https://a.test/a.png" alt="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;">',
    );
    expectSafe(out);
  });

  it("大文档（10 万个标签）净化结果正确、幂等（只看正确性、不看耗时）", () => {
    const html = "<p>x</p>".repeat(100_000);
    expect(sanitizePreviewHtml(html)).toBe(html);
  });
});

// ───────────────────────── 规模守卫：看「耗时比例」，不看绝对耗时 ─────────────────────────
//
// 目的是抓「退化成非线性 / 二次方」的回归，不是抓绝对速度。绝对阈值（旧：10 万标签 < 2s）会随机器 / 负载 /
// CI runner 浮动——高负载下隔离重跑 440ms 的用例，全量并发时能跑出 >2s 而误红，直接拦发版。
// 改成「输入放大 10 倍、耗时放大多少倍」：线性 ≈ 10×、二次方 ≈ 100×；同一台机器同一时刻量出的两档互相抵消了
// 机器快慢，阈值取中间偏线性一侧，给 GC / 调度抖动留足余量。

/** 输入放大倍数 */
const SCALE_FACTOR = 10;
/** 比例上限：线性约 10、二次方约 100，取 40（离线性 4×、离二次方 2.5×） */
const MAX_SCALING_RATIO = 40;
/** 小档耗时下限：机器快到小档 <0.5ms 时，别拿接近 0 的分母把比例放大成误报 */
const MIN_BASE_MS = 0.5;
/** 绝对上限只当「灾难兜底」，放宽到足以抵御 CI 慢机 / 高负载（旧阈值 2s） */
const CATASTROPHIC_MS = 20_000;

const medianOf = (xs: number[]): number =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

/**
 * 断言 fn 在输入放大 10 倍时耗时比例 < MAX_SCALING_RATIO。
 * - 先热身小档（让 JIT 稳定，避免首轮编译开销污染小档、把比例压低）；
 * - 小 / 大两档交替跑 rounds 轮、各取中位数（抵消单次 GC / 调度抖动）；
 * - now 可注入：自检时换成虚拟时钟，让「断言会不会红」不依赖真实耗时（确定性、不抖）。
 *   默认是 CPU 时间（`helpers/scaling-ratio.ts` 的 cpuClock，不数被别的进程抢占的时间）：默认用墙钟时，
 *   CPU 压力下这条线性守卫量出过「放大 10× 耗时放大 48.0×」（阈值 40，R14 Q18-04）。
 */
const expectNearLinear = (
  fn: (input: string) => unknown,
  makeInput: (n: number) => string,
  opts: { small: number; rounds: number; now?: () => number },
): { ratio: number; smallMs: number; largeMs: number } => {
  const now = opts.now ?? cpuClock;
  const smallIn = makeInput(opts.small);
  const largeIn = makeInput(opts.small * SCALE_FACTOR);
  for (let i = 0; i < 3; i++) fn(smallIn);
  const smallTimes: number[] = [];
  const largeTimes: number[] = [];
  for (let i = 0; i < opts.rounds; i++) {
    const s0 = now();
    fn(smallIn);
    smallTimes.push(now() - s0);
    const l0 = now();
    fn(largeIn);
    largeTimes.push(now() - l0);
  }
  const smallMs = Math.max(medianOf(smallTimes), MIN_BASE_MS);
  const largeMs = medianOf(largeTimes);
  const ratio = largeMs / smallMs;
  expect(
    ratio,
    `输入放大 ${SCALE_FACTOR}× 耗时放大 ${ratio.toFixed(1)}×（小档 ${smallMs.toFixed(2)}ms → 大档 ${largeMs.toFixed(2)}ms），疑似超线性`,
  ).toBeLessThan(MAX_SCALING_RATIO);
  return { ratio, smallMs, largeMs };
};

const paragraphs = (n: number): string => "<p>x</p>".repeat(n);

describe("sanitizePreviewHtml：规模守卫（耗时比例）", () => {
  it("输入放大 10 倍、耗时放大 < 40 倍（线性≈10×、二次方≈100×）；绝对耗时只设灾难兜底", () => {
    // 档位取 1 万 / 10 万个标签：小档也要大到 ≥ 几毫秒（实测 ~7ms），否则 JIT 未稳 + 计时抖动会把比例压偏；
    // 实测两档都落在线性区（每标签 ~0.6µs 持平），比例约 9~10，离 40 有 4× 余量
    const { largeMs } = expectNearLinear(sanitizePreviewHtml, paragraphs, {
      small: 10_000,
      rounds: 5,
    });
    expect(largeMs).toBeLessThan(CATASTROPHIC_MS);
  }, 120_000);

});

describe("规模守卫自检：断言本身要抓得到 O(n²)、又不误报 O(n)（虚拟时钟，确定性）", () => {
  /** 虚拟时钟：被测「函数」按声明的复杂度推进时间，不依赖真实耗时 */
  const withVirtualClock = (
    cost: (len: number) => number,
  ): { fn: (input: string) => void; now: () => number } => {
    let t = 0;
    return {
      fn: (input) => {
        t += cost(input.length);
      },
      now: () => t,
    };
  };

  it("O(n) 替身：比例 ≈ 10，守卫通过", () => {
    const { fn, now } = withVirtualClock((len) => len / 1000);
    const { ratio } = expectNearLinear(fn, paragraphs, { small: 5_000, rounds: 5, now });
    expect(ratio).toBeCloseTo(SCALE_FACTOR, 5);
  });

  it("O(n log n) 替身：比例略高于 10 但仍在阈值内，守卫不误报", () => {
    const { fn, now } = withVirtualClock((len) => (len / 1000) * Math.log2(len));
    const { ratio } = expectNearLinear(fn, paragraphs, { small: 5_000, rounds: 5, now });
    expect(ratio).toBeGreaterThan(SCALE_FACTOR);
    expect(ratio).toBeLessThan(MAX_SCALING_RATIO);
  });

  it("O(n²) 替身：比例 ≈ 100，守卫必须红", () => {
    const { fn, now } = withVirtualClock((len) => (len * len) / 1e6);
    expect(() =>
      expectNearLinear(fn, paragraphs, { small: 5_000, rounds: 5, now }),
    ).toThrow(/疑似超线性/);
  });

  it("温和的 O(n^1.8) 退化同样被抓到（比例 ≈ 63 > 40）", () => {
    const { fn, now } = withVirtualClock((len) => Math.pow(len, 1.8) / 1e4);
    expect(() =>
      expectNearLinear(fn, paragraphs, { small: 5_000, rounds: 5, now }),
    ).toThrow(/疑似超线性/);
  });

  it("默认计时源是 CPU 时间（R14 Q18-04）：不传 now 时整个过程一次都不读墙钟 performance.now", () => {
    // 上面几条都显式传了虚拟 now，覆盖不到「默认值」——默认值被改回 performance.now 的话压力下会重新偶发红，没有别的用例会发现
    const spy = vi.spyOn(performance, "now");
    try {
      expectNearLinear(
        (s) => s.length,
        (n) => "x".repeat(n),
        { small: 1_000, rounds: 2 },
      );
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect(vi.isMockFunction(performance.now)).toBe(false);
  });
});
