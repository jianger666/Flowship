/**
 * V2：页内 read / inspect 脚本（electron-app/browser/page-read.mjs）。
 * 仓库里没有 jsdom / happy-dom，所以这里手写一棵最小假 DOM，把脚本源码 `new Function` 起来真跑一遍：
 * 脚本只依赖 nodeType / localName / childNodes / getAttribute / hasAttribute / attributes / textContent / shadowRoot /
 * cloneNode / outerHTML / getBoundingClientRect 与全局 document / getComputedStyle / window / location / URL。
 * 真浏览器里的行为（隔离世界、真实布局）由 scripts/browser-e2e/v2-smoke.cjs 覆盖。
 */
import { describe, expect, it } from "vitest";
import {
  asExpression,
  buildInspectScript,
  buildReadScript,
  DEFAULT_STYLE_PROPS,
  normalizeInclude,
  normalizeReadOptions,
  normalizeStyleProps,
} from "../electron-app/browser/page-read.mjs";

// ───────────────────────── 假 DOM ─────────────────────────

type Attrs = Record<string, string>;
interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

class FText {
  nodeType = 3;
  parentNode: FEl | null = null;
  constructor(public nodeValue: string) {}
}

class FEl {
  nodeType = 1;
  childNodes: Array<FEl | FText> = [];
  parentNode: FEl | null = null;
  shadowRoot: { childNodes: Array<FEl | FText> } | null = null;
  rect: Rect = { x: 0, y: 0, width: 100, height: 20 };
  /** cloneNode 出来的克隆体不在文档里：真浏览器里它取不到 computed style（-webkit-text-security 等全是空） */
  detached = false;
  constructor(
    public localName: string,
    public attrs: Attrs = {},
  ) {}
  getAttribute(n: string): string | null {
    return n in this.attrs ? this.attrs[n] : null;
  }
  hasAttribute(n: string): boolean {
    return n in this.attrs;
  }
  removeAttribute(n: string): void {
    delete this.attrs[n];
  }
  get attributes(): Array<{ name: string; value: string }> {
    return Object.entries(this.attrs).map(([name, value]) => ({ name, value }));
  }
  get textContent(): string {
    return this.childNodes.map((c) => (c instanceof FText ? c.nodeValue : c.textContent)).join("");
  }
  set textContent(v: string) {
    this.childNodes = v ? [new FText(v)] : [];
  }
  descendants(): FEl[] {
    const out: FEl[] = [];
    for (const c of this.childNodes) {
      if (c instanceof FEl) {
        out.push(c, ...c.descendants());
      }
    }
    return out;
  }
  // 只实现脚本用到的选择器：`*` 与 `article, main, [role="main"]`
  querySelectorAll(sel: string): FEl[] {
    const parts = sel.split(",").map((s) => s.trim());
    return this.descendants().filter((e) =>
      parts.some((p) => p === "*" || p === e.localName || (p === '[role="main"]' && e.attrs.role === "main")),
    );
  }
  cloneNode(): FEl {
    const c = new FEl(this.localName, { ...this.attrs });
    c.detached = true;
    for (const k of this.childNodes) {
      const kc = k instanceof FText ? new FText(k.nodeValue) : k.cloneNode();
      kc.parentNode = c;
      c.childNodes.push(kc);
    }
    return c;
  }
  get outerHTML(): string {
    const a = Object.entries(this.attrs)
      .map(([k, v]) => ` ${k}="${v}"`)
      .join("");
    const inner = this.childNodes.map((c) => (c instanceof FText ? c.nodeValue : c.outerHTML)).join("");
    return `<${this.localName}${a}>${inner}</${this.localName}>`;
  }
  getBoundingClientRect() {
    const r = this.rect;
    return { ...r, left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height };
  }
}

type Kid = FEl | FText | string | null | false;
const h = (tag: string, attrs: Attrs = {}, ...kids: Kid[]): FEl => {
  const el = new FEl(tag, attrs);
  for (const k of kids) {
    if (k === null || k === false) continue;
    const node = typeof k === "string" ? new FText(k) : k;
    node.parentNode = el;
    el.childNodes.push(node);
  }
  return el;
};

const parseStyle = (s: string | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const part of (s ?? "").split(";")) {
    const i = part.indexOf(":");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
};

const computed = (el: FEl) => {
  const st: Record<string, string> = el.detached ? {} : parseStyle(el.attrs.style);
  return {
    display: st.display ?? "block",
    visibility: st.visibility ?? "visible",
    getPropertyValue: (p: string) => st[p] ?? (p === "display" ? "block" : ""),
  };
};

const makeDoc = (body: FEl, baseURI = "https://example.com/dir/page") => {
  const html = h("html", {}, body);
  return {
    baseURI,
    body,
    documentElement: html,
    querySelectorAll: (sel: string) => html.querySelectorAll(sel),
  };
};

/** 把脚本源码在假环境里执行；self = this（元素）或 null */
const run = (script: string, body: FEl, self: FEl | null = null, baseURI?: string): Record<string, unknown> => {
  const doc = makeDoc(body, baseURI);
  const fn = new Function(
    "document",
    "getComputedStyle",
    "location",
    "window",
    "self",
    `return (${script}).call(self);`,
  );
  return fn(doc, computed, { href: doc.baseURI }, { innerWidth: 1280, innerHeight: 800 }, self) as Record<string, unknown>;
};

const readMd = (body: FEl, opts: Record<string, unknown> = {}, self: FEl | null = null) =>
  run(buildReadScript({ format: "markdown", maxChars: 30_000, mainContent: false, ...opts }), body, self);

// ───────────────────────── read ─────────────────────────

describe("V2 page-read：read 脚本（markdown）", () => {
  it("脚本源码本身能解析（函数表达式 + asExpression 包装）", () => {
    const src = buildReadScript({});
    expect(src.startsWith("function () {")).toBe(true);
    expect(() => new Function(`return (${src});`)).not.toThrow();
    expect(asExpression(src)).toBe(`(${src}).call(null)`);
    const insp = buildInspectScript({});
    expect(() => new Function(`return (${insp});`)).not.toThrow();
  });

  it("标题 / 段落 / 强调 / br 转 markdown", () => {
    const body = h(
      "body",
      {},
      h("h1", {}, "主标题"),
      h("p", {}, "第一段 ", h("strong", {}, "加粗"), " 与 ", h("em", {}, "斜体"), "。"),
      h("h3", {}, "小节"),
      h("p", {}, "行一", h("br"), "行二"),
    );
    const r = readMd(body);
    expect(r.text).toBe("# 主标题\n\n第一段 **加粗** 与 *斜体*。\n\n### 小节\n\n行一\n行二");
    expect(r.truncated).toBe(false);
    expect(r.root).toBe("body");
  });

  it("链接：相对地址补成绝对 URL；只留 http(s) 与 mailto；javascript: / 页内锚点只保留文字", () => {
    const body = h(
      "body",
      {},
      h(
        "p",
        {},
        h("a", { href: "/docs/a?x=1" }, "文档"),
        " | ",
        h("a", { href: "mailto:a@b.co" }, "邮件"),
        " | ",
        h("a", { href: "javascript:alert(1)" }, "危险"),
        " | ",
        h("a", { href: "#top" }, "锚点"),
        " | ",
        h("a", { href: "java\nscript:alert(1)" }, "拆开的危险"),
        " | ",
        h("a", { href: "data:text/html,<b>x" }, "数据"),
      ),
    );
    const t = String(readMd(body).text);
    expect(t).toContain("[文档](https://example.com/docs/a?x=1)");
    expect(t).toContain("[邮件](mailto:a@b.co)");
    expect(t).toContain("危险");
    expect(t).not.toMatch(/javascript/i);
    expect(t).not.toContain("data:text");
    expect(t).toContain("锚点");
    expect(t).not.toContain("#top");
    expect(t).toContain("拆开的危险");
  });

  it("链接 URL 里的括号 / 空格被转义，不会提前结束 markdown 链接", () => {
    const body = h("body", {}, h("p", {}, h("a", { href: "https://x.test/a_(b) c" }, "怪链接")));
    expect(readMd(body).text).toBe("[怪链接](https://x.test/a_%28b%29%20c)");
  });

  it("包着块级内容的链接（卡片）折成一行；纯图片链接用 alt", () => {
    const body = h(
      "body",
      {},
      h("a", { href: "https://x.test/c" }, h("div", {}, "卡片标题"), h("div", {}, "卡片描述")),
      h("a", { href: "https://x.test/i" }, h("img", { alt: "产品图", src: "https://x.test/secret.png" })),
    );
    const t = String(readMd(body).text);
    expect(t).toContain("[卡片标题 卡片描述](https://x.test/c)");
    expect(t).toContain("[[图片：产品图]](https://x.test/i)");
    expect(t).not.toContain("secret.png");
  });

  it("图片只留 alt、不带 src；没有 alt 的图片整个丢掉", () => {
    const body = h(
      "body",
      {},
      h("p", {}, "前", h("img", { alt: "示意图", src: "data:image/png;base64,AAAA" }), "后", h("img", { src: "https://x.test/p.gif" })),
    );
    const t = String(readMd(body).text);
    expect(t).toBe("前[图片：示意图]后");
    expect(t).not.toContain("base64");
    expect(t).not.toContain("p.gif");
  });

  it("列表：无序 / 有序 / 嵌套缩进 / start", () => {
    const body = h(
      "body",
      {},
      h("ul", {}, h("li", {}, "苹果"), h("li", {}, "水果", h("ul", {}, h("li", {}, "香蕉"), h("li", {}, "梨"))), h("li", {}, "")),
      h("ol", { start: "3" }, h("li", {}, "第三"), h("li", {}, "第四", h("ol", {}, h("li", {}, "子一")))),
    );
    expect(readMd(body).text).toBe("- 苹果\n- 水果\n  - 香蕉\n  - 梨\n\n3. 第三\n4. 第四\n   1. 子一");
  });

  it("表格转 markdown 表：首行作表头、| 被转义、colspan 补空、没有 thead 也成表", () => {
    const body = h(
      "body",
      {},
      h(
        "table",
        {},
        h("caption", {}, "价格表"),
        h("tr", {}, h("th", {}, "名称"), h("th", {}, "价格")),
        h("tr", {}, h("td", {}, "a|b"), h("td", {}, "10")),
        h("tr", {}, h("td", { colspan: "2" }, "合计")),
      ),
    );
    expect(readMd(body).text).toBe("**价格表**\n\n| 名称 | 价格 |\n| --- | --- |\n| a\\|b | 10 |\n| 合计 |   |");
  });

  it("thead / tbody 结构的表格同样可读，隐藏的行不出现", () => {
    const body = h(
      "body",
      {},
      h(
        "table",
        {},
        h("thead", {}, h("tr", {}, h("th", {}, "A"), h("th", {}, "B"))),
        h("tbody", {}, h("tr", {}, h("td", {}, "1"), h("td", {}, "2")), h("tr", { style: "display:none" }, h("td", {}, "x"), h("td", {}, "y"))),
      ),
    );
    expect(readMd(body).text).toBe("| A | B |\n| --- | --- |\n| 1 | 2 |");
  });

  it("pre / code：围栏带语言；代码里有 ``` 时围栏自动加长；行内 code；高亮 span 被展开", () => {
    const body = h(
      "body",
      {},
      h("pre", { class: "x" }, h("code", { class: "language-js" }, h("span", {}, "const a"), " = 1;\n", h("span", {}, "console.log(a)"))),
      h("pre", {}, "示例：\n```\nfoo\n```\n"),
      h("p", {}, "用 ", h("code", {}, "npm i"), " 安装，含反引号的 ", h("code", {}, "a`b"), "。"),
    );
    const t = String(readMd(body).text);
    expect(t).toContain("```js\nconst a = 1;\nconsole.log(a)\n```");
    expect(t).toContain("````\n示例：\n```\nfoo\n```\n````");
    expect(t).toContain("用 `npm i` 安装");
    expect(t).toContain("``a`b``");
  });

  it("blockquote / hr", () => {
    const body = h("body", {}, h("blockquote", {}, h("p", {}, "引文一"), h("p", {}, "引文二")), h("hr"), h("p", {}, "尾"));
    expect(readMd(body).text).toBe("> 引文一\n>\n> 引文二\n\n---\n\n尾");
  });

  it("跳过 script / style / noscript / hidden / aria-hidden / display:none / visibility:hidden", () => {
    const body = h(
      "body",
      {},
      h("p", {}, "可见"),
      h("script", {}, "var secret = 1"),
      h("style", {}, ".a{color:red}"),
      h("noscript", {}, "请开启 JS"),
      h("p", { hidden: "" }, "hidden属性"),
      h("p", { "aria-hidden": "true" }, "装饰"),
      h("div", { style: "display:none" }, h("p", {}, "不显示")),
      h("p", { style: "visibility:hidden" }, "看不见"),
      h("template", {}, "模板"),
      h("iframe", {}, "帧"),
      h("svg", {}, "矢量"),
    );
    expect(readMd(body).text).toBe("可见");
  });

  it("表单控件的值一概不读：password / textarea / select 都不出现", () => {
    const body = h(
      "body",
      {},
      h("p", {}, "登录"),
      h("input", { type: "password", value: "hunter2" }),
      h("input", { type: "text", value: "alice" }),
      h("textarea", {}, "备注里的秘密"),
      h("select", {}, h("option", {}, "选项甲")),
      h("button", {}, "提交"),
    );
    const t = String(readMd(body).text);
    expect(t).toBe("登录\n\n提交");
    expect(t).not.toContain("hunter2");
    expect(t).not.toContain("秘密");
  });

  it("markdown 转义：* [ ] ` 与行首的 # > - 数字.；snake_case 中间的下划线不动", () => {
    const body = h(
      "body",
      {},
      h("p", {}, "a*b [c] `d` snake_case _lead trail_"),
      h("p", {}, "# 不是标题"),
      h("p", {}, "> 不是引用"),
      h("p", {}, "1. 不是列表"),
      h("p", {}, "- 不是列表项"),
    );
    const t = String(readMd(body).text);
    expect(t).toContain("a\\*b \\[c\\] \\`d\\` snake_case \\_lead trail\\_");
    expect(t).toContain("\\# 不是标题");
    expect(t).toContain("\\> 不是引用");
    expect(t).toContain("1\\. 不是列表");
    expect(t).toContain("\\- 不是列表项");
  });

  it("format=text：无 markdown 标记、链接只留文字、表格用制表符", () => {
    const body = h(
      "body",
      {},
      h("h2", {}, "标题"),
      h("p", {}, "见 ", h("a", { href: "https://x.test/p" }, "链接"), " 与 ", h("strong", {}, "重点")),
      h("table", {}, h("tr", {}, h("th", {}, "A"), h("th", {}, "B")), h("tr", {}, h("td", {}, "1"), h("td", {}, "2"))),
      h("ul", {}, h("li", {}, "项")),
    );
    const r = run(buildReadScript({ format: "text", mainContent: false }), body);
    expect(r.text).toBe("标题\n\n见 链接 与 重点\n\nA\tB\n1\t2\n\n- 项");
  });

  it("open shadow root 里的内容会被读到（slot 取 light DOM 内容）", () => {
    const host = h("x-card", {}, h("span", {}, "槽内文字"));
    const slot = h("slot");
    (slot as unknown as { assignedNodes: () => unknown[] }).assignedNodes = () => host.childNodes;
    host.shadowRoot = { childNodes: [h("p", {}, "壳内标题"), slot] };
    const r = readMd(h("body", {}, host));
    expect(r.text).toBe("壳内标题\n\n槽内文字");
  });

  it("mainContent：优先 article / main，取文本最长者", () => {
    const long = "正文".repeat(60);
    const body = h(
      "body",
      {},
      h("nav", {}, "导航"),
      h("article", {}, h("p", {}, "短文".repeat(50))),
      h("main", {}, h("p", {}, long)),
      h("footer", {}, "页脚"),
    );
    const r = readMd(body, { mainContent: true });
    expect(r.text).toBe(long);
    expect(r.root).toBe("main");
    // 关掉 mainContent 读整个 body
    const all = readMd(body, { mainContent: false });
    expect(String(all.text)).toContain("导航");
    expect(String(all.text)).toContain("页脚");
    expect(all.root).toBe("body");
  });

  it("mainContent：只有很短的 article（侧栏卡片）时退回 body；隐藏的 article 不算", () => {
    const body = h(
      "body",
      {},
      h("article", {}, "一条评论"),
      h("article", { style: "display:none" }, "隐".repeat(200)),
      h("p", {}, "页面主体的内容在这里"),
    );
    const r = readMd(body, { mainContent: true });
    expect(r.root).toBe("body");
    expect(String(r.text)).toContain("页面主体的内容在这里");
    expect(String(r.text)).toContain("一条评论");
    expect(String(r.text)).not.toContain("隐");
  });

  it("this 是元素（ref 读取）：只读该元素，即便它自己是隐藏的也读", () => {
    const target = h("div", { id: "box", style: "display:none" }, h("h2", {}, "局部"), h("p", {}, "局部内容"));
    const body = h("body", {}, h("p", {}, "页面其它"), target);
    const r = readMd(body, {}, target);
    expect(r.root).toBe("element");
    expect(r.text).toBe("## 局部\n\n局部内容");
  });

  it("超长内容在 maxChars 处截断（优先在换行处），truncated=true，给出整文长度", () => {
    const paras = Array.from({ length: 400 }, (_, i) => h("p", {}, `段落${i} ${"字".repeat(20)}`));
    const r = readMd(h("body", {}, ...paras), { maxChars: 1000 });
    const text = String(r.text);
    expect(text.length).toBeLessThanOrEqual(1000);
    expect(text.length).toBeGreaterThan(800);
    expect(r.truncated).toBe(true);
    expect(Number(r.totalLength)).toBeGreaterThan(1000);
    expect(text.endsWith("字")).toBe(true); // 在段落边界收尾，没有切到半个段落
  });

  it("空页面：返回空文本而不是报错", () => {
    const r = readMd(h("body"));
    expect(r.text).toBe("");
    expect(r.truncated).toBe(false);
  });

  it("异常在脚本内被接住，返回 { error } 而不是抛出", () => {
    const bad = h("body", {}, h("p", {}, "x"));
    bad.getAttribute = () => {
      throw new Error("炸了");
    };
    // getAttribute 抛错被 attr() 兜住，读取仍能完成
    expect(readMd(bad).text).toBe("x");
  });
});

describe("V2 page-read：参数规整（纯函数）", () => {
  it("normalizeReadOptions：夹紧 maxChars、format 回落 markdown、mainContent 默认 true", () => {
    expect(normalizeReadOptions({})).toEqual({ format: "markdown", maxChars: 30_000, mainContent: true });
    expect(normalizeReadOptions({ maxChars: 10 }).maxChars).toBe(1000);
    expect(normalizeReadOptions({ maxChars: 9e9 }).maxChars).toBe(200_000);
    expect(normalizeReadOptions({ maxChars: Number.NaN }).maxChars).toBe(30_000);
    expect(normalizeReadOptions({ format: "text", mainContent: false })).toEqual({ format: "text", maxChars: 30_000, mainContent: false });
    expect(normalizeReadOptions({ format: "html" }).format).toBe("markdown");
  });

  it("normalizeStyleProps：只认合法 CSS 属性名 / 自定义属性，去重、转小写、≤30", () => {
    expect(normalizeStyleProps(["Font-Size", "font-size", "--brand", "a;b", "x y", "", 5, "color"])).toEqual(["font-size", "--brand", "color"]);
    expect(normalizeStyleProps(Array.from({ length: 50 }, (_, i) => `p${i}`))).toHaveLength(30);
    expect(normalizeStyleProps("color")).toEqual([]);
    expect(normalizeStyleProps(undefined)).toEqual([]);
  });

  it("normalizeInclude：未知项丢弃、空 → 默认三项", () => {
    expect(normalizeInclude(undefined)).toEqual(["box", "styles", "attrs"]);
    expect(normalizeInclude(["html", "bogus", "html"])).toEqual(["html"]);
    expect(normalizeInclude(["bogus"])).toEqual(["box", "styles", "attrs"]);
  });
});

// ───────────────────────── inspect ─────────────────────────

const inspect = (el: FEl, opts: Record<string, unknown> = {}) => {
  const body = h("body", {}, el);
  return run(buildInspectScript(opts), body, el);
};

describe("V2 page-read：inspect 脚本", () => {
  it("默认给 box / styles / attrs：盒模型 + 15 个常用样式 + 属性", () => {
    const el = h("button", { id: "go", class: "btn primary", style: "display:inline-block;color:red" }, "提交");
    el.rect = { x: 10.123, y: 780, width: 80.55, height: 30 };
    const r = inspect(el) as {
      tag: string;
      box: Record<string, unknown>;
      attrs: Record<string, string>;
      styles: Record<string, string>;
      html?: string;
    };
    expect(r.tag).toBe("button");
    expect(r.box).toEqual({ x: 10.1, y: 780, width: 80.6, height: 30, inViewport: true, visible: true });
    expect(r.attrs.id).toBe("go");
    expect(r.attrs.class).toBe("btn primary");
    expect(Object.keys(r.styles)).toEqual([...DEFAULT_STYLE_PROPS]);
    expect(r.styles.color).toBe("red");
    expect(r.html).toBeUndefined();
  });

  it("box：视口外 / display:none / 零尺寸的判定", () => {
    const below = h("div", {});
    below.rect = { x: 0, y: 900, width: 50, height: 50 };
    expect((inspect(below) as { box: { inViewport: boolean; visible: boolean } }).box).toMatchObject({ inViewport: false, visible: true });

    const hidden = h("div", { style: "display:none" });
    hidden.rect = { x: 0, y: 0, width: 0, height: 0 };
    expect((inspect(hidden) as { box: { inViewport: boolean; visible: boolean } }).box).toMatchObject({ inViewport: false, visible: false });

    const invis = h("div", { style: "visibility:hidden" });
    expect((inspect(invis) as { box: { visible: boolean } }).box.visible).toBe(false);
  });

  it("attrs：on* 属性不给；password 的 value 不给（含 autocomplete=one-time-code）；普通 input 的 value 照给；单值 ≤300", () => {
    const pwd = h("input", { type: "password", value: "hunter2", onclick: "steal()", onfocus: "x()", name: "pw" });
    const a1 = (inspect(pwd) as { attrs: Record<string, string> }).attrs;
    expect(a1).toEqual({ type: "password", name: "pw" });

    const otp = h("input", { type: "text", autocomplete: "one-time-code", value: "123456" });
    expect((inspect(otp) as { attrs: Record<string, string> }).attrs.value).toBeUndefined();

    const plain = h("input", { type: "text", value: "alice", "data-x": "y".repeat(500) });
    const a3 = (inspect(plain) as { attrs: Record<string, string> }).attrs;
    expect(a3.value).toBe("alice");
    expect(a3["data-x"]).toHaveLength(300);
    expect(a3["data-x"].endsWith("…")).toBe(true);
  });

  it("styles：自定义 styleProps（含自定义属性）；单值 ≤300", () => {
    const el = h("div", { style: "flex-direction:column;--brand:#f00;font-family:" + "a".repeat(400) });
    const r = inspect(el, { include: ["styles"], styleProps: ["flex-direction", "--brand", "font-family", "not valid!"] }) as {
      styles: Record<string, string>;
      box?: unknown;
      attrs?: unknown;
    };
    expect(Object.keys(r.styles)).toEqual(["flex-direction", "--brand", "font-family"]);
    expect(r.styles["flex-direction"]).toBe("column");
    expect(r.styles["--brand"]).toBe("#f00");
    expect(r.styles["font-family"]).toHaveLength(300);
    expect(r.box).toBeUndefined();
    expect(r.attrs).toBeUndefined();
  });

  it("html：克隆后清洗——on* 属性、script 内容、password 的 value 都不在；不修改原节点；≤4000", () => {
    const pwd = h("input", { type: "password", value: "hunter2", onchange: "x()" });
    const el = h("form", { onsubmit: "evil()" }, h("script", {}, "document.cookie"), pwd, h("p", {}, "ok"));
    const r = inspect(el, { include: ["html"] }) as { html: string };
    expect(r.html).toContain("<form>");
    expect(r.html).toContain("ok");
    expect(r.html).not.toContain("evil");
    expect(r.html).not.toContain("document.cookie");
    expect(r.html).not.toContain("hunter2");
    expect(r.html).not.toContain("onchange");
    // 原节点没被动过
    expect(pwd.attrs.value).toBe("hunter2");
    expect(el.attrs.onsubmit).toBe("evil()");

    const big = h("div", {}, "x".repeat(9000));
    const rb = inspect(big, { include: ["html"] }) as { html: string };
    expect(rb.html).toHaveLength(4000);
    expect(rb.html.endsWith("…")).toBe(true);
  });

  it("R1-29：input[type=hidden]（CSRF token 等）的 value 在 attrs 与 html 两处都不给；普通 input 照给", () => {
    const hidden = h("input", { type: "hidden", name: "csrf", value: "CSRF-TOKEN-123" });
    const a = (inspect(hidden) as { attrs: Record<string, string> }).attrs;
    expect(a).toEqual({ type: "hidden", name: "csrf" });

    const plain = h("input", { type: "text", value: "alice" });
    const form = h("form", {}, hidden, plain, h("input", { type: "HIDDEN", name: "sid", value: "SID-456" }));
    const r = inspect(form, { include: ["html"] }) as { html: string };
    expect(r.html).not.toContain("CSRF-TOKEN-123");
    expect(r.html).not.toContain("SID-456");
    expect(r.html).toContain('name="csrf"');
    expect(r.html).toContain("alice");
    // 原节点没被动过
    expect(hidden.attrs.value).toBe("CSRF-TOKEN-123");
  });

  it("R1-25：cc-* 与 -webkit-text-security 遮罩字段的 value 同样不给（attrs 与 html；text-security 在原节点上判）", () => {
    const card = h("input", { type: "text", autocomplete: "cc-exp", value: "12/30" });
    expect((inspect(card) as { attrs: Record<string, string> }).attrs.value).toBeUndefined();
    const masked = h("input", { type: "text", value: "MASKED-VALUE", style: "-webkit-text-security:disc" });
    expect((inspect(masked) as { attrs: Record<string, string> }).attrs.value).toBeUndefined();
    const area = h("textarea", { value: "AREA-VALUE", style: "-webkit-text-security:square" });
    const form = h("form", {}, masked, card, area);
    const html = (inspect(form, { include: ["html"] }) as { html: string }).html;
    for (const secret of ["MASKED-VALUE", "12/30", "AREA-VALUE"]) expect(html).not.toContain(secret);
  });

  it("目标不是元素：返回 { error }", () => {
    const body = h("body");
    const r = run(buildInspectScript({}), body, null);
    expect(r.error).toMatch(/不是元素/);
  });

  it("R1-29 复审：敏感 textarea（autocomplete / text-security）的正文也不进 html；普通 textarea 的默认文本照给", () => {
    const otpArea = h("textarea", { autocomplete: "one-time-code" }, "OTP-BODY");
    const maskedArea = h("textarea", { style: "-webkit-text-security:disc" }, "MASKED-BODY");
    const plainArea = h("textarea", { name: "bio" }, "默认简介");
    const form = h("form", {}, otpArea, maskedArea, plainArea);
    const r = inspect(form, { include: ["html"] }) as { html: string; htmlNote?: string };
    expect(r.html).not.toContain("OTP-BODY");
    expect(r.html).not.toContain("MASKED-BODY");
    expect(r.html).toContain("默认简介");
    expect(r.htmlNote).toBeUndefined();
    // 原节点没被动
    expect(otpArea.textContent).toBe("OTP-BODY");
  });

  // 克隆与原树对不上（页面把 cloneNode 改坏 / 并发改了 DOM）：克隆体取不到 computed style，用它降级判定会漏掉 CSS 遮罩的字段
  const mismatchedForm = () => {
    const masked = h("input", { type: "text", name: "pin", value: "MASKED-PIN", style: "-webkit-text-security:disc" });
    const hidden = h("input", { type: "hidden", name: "csrf", value: "CSRF-TOKEN-XYZ" });
    const form = h("form", {}, masked, hidden, h("p", {}, "正文"));
    const realClone = form.cloneNode.bind(form);
    form.cloneNode = () => {
      const c = realClone();
      c.childNodes.push(h("span", {}, "多出来的节点"));
      return c;
    };
    return form;
  };

  it("R1-29 复审：克隆与原树配对失败 → html 整段置空并给 htmlNote，不降级判定（按克隆体判会漏 CSS 遮罩的 value）", () => {
    const r = inspect(mismatchedForm(), { include: ["html"] }) as { html: string; htmlNote?: string };
    expect(r.html).toBe("");
    expect(r.htmlNote).toMatch(/已隐藏/);
    expect(JSON.stringify(r)).not.toMatch(/MASKED-PIN|CSRF-TOKEN-XYZ|正文/);
    // 对照：同一棵树配对正常时 html 有内容、没有 htmlNote
    const ok = inspect(h("form", {}, h("p", {}, "正文")), { include: ["html"] }) as { html: string; htmlNote?: string };
    expect(ok.html).toContain("正文");
    expect(ok.htmlNote).toBeUndefined();
  });

  it("R1-29 复审：配对失败只影响 html——box / attrs / styles 照常给，attrs 里敏感 value 照样不给", () => {
    const r = inspect(mismatchedForm(), { include: ["box", "attrs", "html"] }) as { html: string; box: unknown; attrs: Record<string, string> };
    expect(r.box).toBeTruthy();
    expect(r.attrs).toBeTruthy();
    expect(r.html).toBe("");
    const pin = h("input", { type: "text", value: "MASKED-PIN", style: "-webkit-text-security:disc" });
    expect((inspect(pin, { include: ["attrs"] }) as { attrs: Record<string, string> }).attrs.value).toBeUndefined();
  });
});
