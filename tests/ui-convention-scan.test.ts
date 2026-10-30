/**
 * ui-conventions 偏离项的回归闸（第二轮 AI 评审 §5）
 *
 * 这批修掉的偏离都是「肉眼一眼看得出、但改回去既不报类型错也不会让行为测试变红」的那种，
 * 靠 review 记不住，所以对「已修过的文件」做一次源码扫描，把规范写成会红的断言：
 *
 *   1. 不用原生 DOM `title=` 当 hover 提示（要 Tooltip；原生 title 不跟主题、不能键盘触发、延迟不可控）。
 *      区分「DOM 元素的 title 属性」与「组件自己的 title prop」——后者（`<EllipsisChip title=…>`）
 *      常常就是转手喂给 Tooltip，不算违规。
 *   2. 不用 `backdrop-blur`（浮层要实心面：不透明底 + 完整边 + shadow-sm）。
 *   3. 不用 `animate-ping`（状态点静态；同屏只留状态行那一处主动效）。
 *   4. 不写裸调色板颜色（red-500 / amber-600 / emerald-500…）与 `text-white`，走语义 token。
 *   5. 文字层级不靠整块 opacity（20–99 的中间值）。
 *
 * 范围：颜色 / opacity / blur 类规则只扫「这批修过的文件」（FIXED_FILES）——全仓库里还有尚未处理的同类写法，
 * 一并设成红灯只会让这条闸被人整个关掉。**新修一个文件就把它加进 FIXED_FILES**（ui-conventions.mdc 里也记了这条）。
 * 全仓守卫（零成本、现状已干净）：原生 DOM `title=`、`animate-pulse`（第三轮 R13-01 / R13-03）。
 *
 * 仍然留着、**不在闸里**的已声明偏离（R13-05，原先只写在会话汇报里）：
 *   settings/page.tsx 的 blur、遮罩 `-xs`、image-preview `-sm`、sessions 两处 `opacity-70`、
 *   chat-runner 重连预算没改、pi shell 非 0 退出码显示成功。
 *
 * 扫描前先剥注释：注释里解释「旧版是 animate-ping」是正常的，不该让闸红。
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const srcDir = path.resolve(import.meta.dirname, "..", "src");
const read = (rel: string): string => readFileSync(path.join(srcDir, rel), "utf-8");

/**
 * 剥注释（R13-01：旧版用一条正则，字符串里带 ` // `（例如 "a // b"）就把该行余下全吃掉，后面的违规被漏过）。
 * 手写小状态机：代码 / 单双引号字符串（到行尾自动复位——JSX 文本里的撇号不会把整个文件拖进「字符串态」）/
 * 模板字符串（可跨行）/ 行注释 / 块注释。
 */
export const stripComments = (s: string): string => {
  let out = "";
  let i = 0;
  let mode: "code" | "'" | '"' | "`" = "code";
  while (i < s.length) {
    const c = s[i]!;
    const n = s[i + 1];
    if (mode === "code") {
      if (c === "/" && n === "/") {
        // 行注释：`://`（URL）不算——代码态下前一个字符是冒号就当普通字符
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
    // 字符串态
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
 * 组件 prop 里最终会展开到 DOM 的那几个（`<Button title="x">` 渲染出来就是 <button title="x">）。
 * 其余大写标签的 `title` 视为组件自己的 prop（常常转手喂 Tooltip），放过。
 */
const DOM_PASSTHROUGH_COMPONENTS = new Set([
  "Button",
  "Input",
  "Textarea",
  "Label",
  "Badge",
  "PopoverTrigger",
]);

/**
 * 找出带原生 `title=` 的标签。
 * 做法（R13-01：旧版取 `title=` 之前最近的 `<标签`，被属性值里的 `<X/>` 抢走）：
 * 正向扫每个 `<Tag`，按大括号深度 / 引号跳过属性值，只在**顶层属性**里找 `title=`；
 * 小写标签（DOM 元素）与 DOM_PASSTHROUGH_COMPONENTS 里的大写标签算违规。
 */
export const nativeTitleAttrs = (src: string): string[] => {
  const hits: string[] = [];
  const tagRe = /<([A-Za-z][\w.]*)(?=[\s/>])/g;
  for (let m = tagRe.exec(src); m; m = tagRe.exec(src)) {
    const name = m[1]!;
    let i = m.index + m[0].length;
    let depth = 0;
    let quote: string | null = null;
    let found = false;
    for (; i < src.length; i++) {
      const c = src[i]!;
      if (quote) {
        if (c === quote) quote = null;
        continue;
      }
      if (depth === 0) {
        if (c === '"' || c === "'") {
          quote = c;
          continue;
        }
        if (c === ">") break;
        if (c === "{") {
          depth = 1;
          continue;
        }
        if (/\s/.test(src[i - 1] ?? "") && src.startsWith("title=", i)) found = true;
      } else if (c === "{") depth++;
      else if (c === "}") depth--;
    }
    if (!found) continue;
    if (/^[a-z]/.test(name) || DOM_PASSTHROUGH_COMPONENTS.has(name)) {
      hits.push(`<${name} … title=`);
    }
  }
  return hits;
};

/**
 * `animate-pulse`（持续动画）命中；带 motion-reduce:animate-none 的同 class 串放过（光标 / 骨架自己停动画）。
 * 先定位 token、再向两侧找最近的引号取「同一个 class 串」——不用 `[^"]*X[^"]*` 这种带前导通配的正则
 * （没有引号的大文件上是 O(n²)，全仓扫描会超时）。
 */
export const pulseHits = (src: string): string[] => {
  const out: string[] = [];
  const re = /\banimate-pulse\b/g;
  const isQuote = (c: string) => c === '"' || c === "'" || c === "`";
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let a = m.index;
    while (a > 0 && !isQuote(src[a - 1]!)) a--;
    let b = m.index + m[0].length;
    while (b < src.length && !isQuote(src[b]!)) b++;
    const cls = src.slice(a, b);
    if (!/motion-reduce:animate-none/.test(cls)) out.push(cls);
  }
  return out;
};

/** 这批修过的文件（相对 src/）。新修一个文件就加进来（见文件头） */
const FIXED_FILES = [
  "components/tasks/chat-queue-banner.tsx",
  "components/tasks/talk-queue-banner.tsx",
  "components/tasks/event-stream.tsx",
  "components/tasks/advance-dialog.tsx",
  "app/sessions/page.tsx",
  "components/schedules/schedule-row.tsx",
  "components/tasks/task-changes-panel.tsx",
  "components/tasks/action-timeline.tsx",
  "components/tasks/batch-plan-table.tsx",
  "components/tasks/branch-switcher.tsx",
  // R14 Q3-01：头部 MR 链接条（v1.7.1 误删后补回的叶子组件）
  "components/tasks/task-mr-links.tsx",
  // R14 B2-2：存储降级红条（新叶子组件，事件流顶部常驻；颜色只走 destructive 语义 token）
  "components/tasks/storage-degraded-bar.tsx",
  // R14 B2-3：「有记录读不出来」灰条（新叶子组件，叠在红条之下；只走 muted 语义 token）
  "components/tasks/events-skipped-notice.tsx",
  // R14 B2-4c：低磁盘预警红条（新叶子组件 + 取数容器，叠在存储降级红条旁；颜色只走 destructive 语义 token）
  "components/tasks/low-disk-bar.tsx",
  // R14 B6-3：已归档会话灰条（新叶子组件，详情页顶部；只走 muted 语义 token，不用整块 opacity）
  "components/tasks/archived-bar.tsx",
  "components/tasks/requirement-group-dialog.tsx",
  "components/conversation-composer.tsx",
  "components/composer-editor.tsx",
  "components/tasks/task-launch-form.tsx",
  "components/tasks/stream-announcer.tsx",
  "components/tasks/stream-outline-rail.tsx",
  // 代码改动面板（task-changes-panel 拆出来的新组件）
  "components/tasks/changes/changes-sheet.tsx",
  "components/tasks/changes/diff-minimap.tsx",
  "components/tasks/changes/diff-table.tsx",
  "components/tasks/changes/diff-viewer.tsx",
  "components/tasks/changes/file-list.tsx",
  "components/tasks/changes/scope-toolbar.tsx",
  "components/tasks/changes/shared.tsx",
] as const;

/**
 * 允许保留原生 `title=` 的文件 → 必须写理由（目前没有）。
 * 新增条目前先想想能不能换 Tooltip：确实不能（比如 <iframe title> 这类 a11y 必填属性）才进白名单。
 */
const NATIVE_TITLE_ALLOWED: Record<string, string> = {
  "components/ui/local-file-preview-body.tsx": "<iframe title> 是 a11y 必填属性（读屏用来命名框架），不是 hover 提示",
};

/** 允许裸 animate-pulse 的文件 → 必须写理由（光标 live-thinking-tail 自己带 motion-reduce，不在这里） */
const PULSE_ALLOWED: Record<string, string> = {
  "components/tasks/branch-switcher.tsx": "分支列表加载中的骨架占位（globals.css 的 reduced-motion 块已登记 .animate-pulse 静止态）",
};

const PALETTE_NAMES =
  "red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone";
// 前缀补全（R13-01）：渐变 from/via/to、outline、divide、shadow、decoration、accent、caret、方向性 border-l/t/r/b/x/y/s/e
const RAW_PALETTE = new RegExp(
  `\\b(?:bg|text|border(?:-[xytblrse])?|ring|fill|stroke|from|via|to|outline|divide|shadow|decoration|accent|caret)-(?:${PALETTE_NAMES})-\\d{2,3}\\b`,
);
const RAW_WHITE_BLACK = /\b(?:bg|text|border|ring|fill|stroke)-(?:white|black)\b/;
// 20~99 的中间 opacity（opacity-0 / opacity-100 是 hover 显隐、允许）。
// 变体前缀只放过「交互状态」家族：disabled（含 peer-/group-/aria-）与 hover / focus / focus-within / focus-visible
// （含 group-hover/名字: 这种命名 group）——这些是显隐 / 失活态，不是文字层级。
// R13-01：旧版 `(?<![\w:-])` 一刀放过**所有**变体前缀，`dark:opacity-60` / `md:opacity-70` 漏网。
const STATE_VARIANT = /(?:^|:)(?:(?:peer|group|aria|data)-)?(?:disabled|hover|focus|focus-within|focus-visible)(?:\/[\w-]+)?:/;
export const midOpacityHits = (src: string): string[] =>
  [...src.matchAll(/(?<![\w/-])((?:[\w/-]+:)*)opacity-(?:[2-9]\d)\b/g)]
    .filter((m) => !STATE_VARIANT.test(m[1] ?? ""))
    .map((m) => m[0]);

describe("扫描器自检（别让闸自己是个摆设）", () => {
  it("命中：DOM 元素上的 title（单行 / 多行 / 表达式）", () => {
    expect(nativeTitleAttrs('<button type="button" title="删除">x</button>')).toHaveLength(1);
    expect(
      nativeTitleAttrs('<span\n  className="a"\n  title={unavailable ? "占用扫描完成后可用" : undefined}\n>'),
    ).toHaveLength(1);
    expect(nativeTitleAttrs('<PopoverTrigger render={<button title="x" />} />')).toHaveLength(1);
  });

  it("放过：组件自己的 title prop（会转手喂 Tooltip）", () => {
    expect(nativeTitleAttrs('<EllipsisChip title="已折叠" />')).toHaveLength(0);
    expect(nativeTitleAttrs("<EllipsisChip\n  title={cond ? 'a' : 'b'}\n/>")).toHaveLength(0);
    expect(nativeTitleAttrs('<Tooltip content={b.title}><span>{b.title}</span></Tooltip>')).toHaveLength(0);
  });

  it("剥注释：注释里点名旧写法不算命中，真代码里的才算", () => {
    const src = [
      "// 旧版 animate-ping、backdrop-blur",
      "/* bg-amber-500 */",
      'const a = "animate-ping";',
    ].join("\n");
    const bare = stripComments(src);
    expect(bare).not.toContain("backdrop-blur");
    expect(bare).not.toContain("bg-amber-500");
    expect(bare).toContain("animate-ping");
  });
});

describe("已修文件：不回到 ui-conventions 禁止的写法", () => {
  const sources = FIXED_FILES.map((f): [string, string] => [f, stripComments(read(f))]);

  it("文件都存在、都读得到（改名 / 删除时要同步这张清单）", () => {
    for (const [f, src] of sources) expect(src.length, f).toBeGreaterThan(0);
  });

  it("没有原生 DOM title=（hover 提示一律 Tooltip）", () => {
    for (const [f, src] of sources) {
      if (f in NATIVE_TITLE_ALLOWED) continue;
      expect(nativeTitleAttrs(src), f).toEqual([]);
    }
  });

  it("白名单每一项都写了理由", () => {
    for (const [f, why] of Object.entries(NATIVE_TITLE_ALLOWED)) {
      expect(why.trim().length, f).toBeGreaterThan(5);
    }
  });

  it("没有 backdrop-blur（浮层是实心面）", () => {
    for (const [f, src] of sources) expect(src, f).not.toMatch(/backdrop-blur/);
  });

  it("没有 animate-ping（状态点静态）", () => {
    for (const [f, src] of sources) expect(src, f).not.toMatch(/animate-ping/);
  });

  it("没有裸调色板颜色、没有 text-white（走 --success / --warning / --info / --destructive / --brand token）", () => {
    for (const [f, src] of sources) {
      expect(src, f).not.toMatch(RAW_PALETTE);
      expect(src, f).not.toMatch(RAW_WHITE_BLACK);
    }
  });

  it("层级不靠整块 opacity：这几个文件里没有 20–99 的中间 opacity", () => {
    // event-stream.tsx / task-launch-form.tsx 等大文件里还有别的、不在这批范围的 opacity，
    // 它们的岛 / 局部另有专门断言（见下）
    for (const f of [
      "components/tasks/action-timeline.tsx",
      "components/tasks/batch-plan-table.tsx",
      "components/tasks/task-changes-panel.tsx",
      "components/tasks/changes/changes-sheet.tsx",
      "components/tasks/changes/diff-minimap.tsx",
      "components/tasks/changes/diff-table.tsx",
      "components/tasks/changes/diff-viewer.tsx",
      "components/tasks/changes/file-list.tsx",
      "components/tasks/changes/scope-toolbar.tsx",
      "components/tasks/changes/shared.tsx",
      "components/composer-editor.tsx",
      "components/conversation-composer.tsx",
      // 排队条两份不在此列：里面只剩一个装饰性箭头图标的 opacity-70（图标不是文字层级，alpha 属装饰）
    ]) {
      expect(midOpacityHits(stripComments(read(f))), f).toEqual([]);
    }
  });
});

describe("局部断言", () => {
  const stream = stripComments(read("components/tasks/event-stream.tsx"));

  it("V13-12：输入岛失活态不再整岛 opacity（连 placeholder 一起压到 3.45:1）", () => {
    const i = stream.indexOf("<ConversationComposer");
    expect(i).toBeGreaterThan(-1);
    const island = stream.slice(i, stream.indexOf("/>", stream.indexOf("className={cn(", i)) + 2);
    expect(island).not.toMatch(/\bopacity-/);
    expect(island).toContain("border-border/60 bg-muted/30 shadow-none");
  });

  it("三个浮层（回到最新 / 搜索条 / 搜索范围提示）都是不透明底", () => {
    for (const marker of [
      '"absolute bottom-3 right-3 z-10 rounded-full bg-background text-xs shadow-md dark:bg-background dark:hover:bg-muted"',
      '"absolute right-3 top-2 z-20 rounded-lg border border-border bg-background shadow-sm"',
      '"absolute right-3 top-12 z-20 max-w-[min(28rem,calc(100%-1.5rem))] rounded-md border border-border bg-background px-2 py-0.5 shadow-sm"',
    ]) {
      expect(stream).toContain(marker);
    }
  });

  it("群问答 tab 的状态点是静态的：回答中那颗不再 animate-pulse，且点本身 role=img + aria-label", () => {
    const i = stream.indexOf("群里有提问正在回答");
    expect(i).toBeGreaterThan(-1);
    const dot = stream.slice(i - 200, i + 300);
    expect(dot).toContain('role="img"');
    expect(dot).toContain("bg-info");
    expect(dot).not.toContain("animate-pulse");
  });

  it("停止键文字走 text-primary-foreground（深色下白字只有 2.89:1）", () => {
    const composer = stripComments(read("components/conversation-composer.tsx"));
    expect(composer).toContain("text-primary-foreground");
  });
});

describe("R13-01 扫描器加固自检（旧版放过的写法现在要红）", () => {
  it("组件 prop 会展开到 DOM 的：<Button title> / <Input title> 命中；别的大写组件仍放过", () => {
    expect(nativeTitleAttrs('<Button title="x">a</Button>')).toHaveLength(1);
    expect(nativeTitleAttrs('<Input title="x" />')).toHaveLength(1);
    expect(nativeTitleAttrs('<EllipsisChip title="x" />')).toHaveLength(0);
  });

  it("owner 取标签自己的顶层属性，不被属性值里的 <X/> 抢走", () => {
    expect(nativeTitleAttrs('<button icon={<X />} title="x">')).toEqual(["<button … title="]);
    // title 在嵌套的组件上（属性值里的另一个标签）不算外层 button 的
    expect(nativeTitleAttrs('<button icon={<Icon title="t" />}>')).toHaveLength(0);
    expect(nativeTitleAttrs('<button onClick={() => a > b} title="x">')).toHaveLength(1);
  });

  it("剥注释：字符串里带 ` // ` 不吞掉该行余下的违规；URL 里的 // 不当注释", () => {
    const src = 'const a = "x // y"; const b = "animate-ping"; // 真注释 animate-ping';
    const bare = stripComments(src);
    expect(bare).toContain('"animate-ping"');
    expect(bare).not.toContain("真注释");
    expect(stripComments('const u = "https://a.b/c"; const d = 1;')).toContain("const d = 1;");
    expect(stripComments("a /* x */ b // c\nd")).toBe("a  b \nd");
    // JSX 文本里的撇号不会把后面的行拖进字符串态
    expect(stripComments("<p>don't</p>\nconst z = 1; // c")).toContain("const z = 1;");
  });

  it("opacity：任意变体前缀都命中（dark: / hover: / md:），只放过 disabled 家族与 0 / 100", () => {
    expect(midOpacityHits('"dark:opacity-60"')).toHaveLength(1);
    expect(midOpacityHits('"opacity-70 md:opacity-80"')).toHaveLength(2);
    expect(
      midOpacityHits(
        '"disabled:opacity-50 peer-disabled:opacity-60 opacity-0 hover:opacity-100 group-hover/chip:opacity-60 group-focus-within/chip:opacity-70"',
      ),
    ).toEqual([]);
  });

  it("调色板：渐变 / 方向性 border / outline 等前缀 + bg-white / text-black 都命中", () => {
    for (const c of ["from-red-500", "to-blue-600", "border-l-red-500", "border-x-amber-300", "outline-sky-500", "divide-gray-200", "shadow-rose-500", "bg-white", "text-black", "text-white"]) {
      expect(RAW_PALETTE.test(c) || RAW_WHITE_BLACK.test(c), c).toBe(true);
    }
    for (const c of ["bg-brand", "text-destructive", "border-border", "from-background", "bg-white/0"]) {
      // bg-white/0 仍算 bg-white（透明度写法也是裸色）：此处只断言语义 token 不误报
      if (c === "bg-white/0") continue;
      expect(RAW_PALETTE.test(c) || RAW_WHITE_BLACK.test(c), c).toBe(false);
    }
  });

  it("animate-pulse：裸的命中；带 motion-reduce:animate-none 的同 class 串放过", () => {
    expect(pulseHits('className="size-2 animate-pulse rounded-full"')).toHaveLength(1);
    expect(pulseHits('className="h-3 w-0.5 animate-pulse motion-reduce:animate-none"')).toEqual([]);
  });
});

/** 递归列出 src 下全部 .ts / .tsx */
const listSrcFiles = (dir: string, out: string[] = []): string[] => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listSrcFiles(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
};

describe("全仓守卫（R13-01 / R13-03：成本为零、现状已干净，别让它长回来）", () => {
  const files = listSrcFiles(srcDir).map((abs): [string, string] => [
    path.relative(srcDir, abs).split(path.sep).join("/"),
    stripComments(readFileSync(abs, "utf-8")),
  ]);

  it("全仓没有原生 DOM title=（ui-conventions「Hover 提示不用原生 title」是唯一的全局规则）", () => {
    const offenders = files
      .filter(([f]) => !(f in NATIVE_TITLE_ALLOWED))
      .flatMap(([f, src]) => nativeTitleAttrs(src).map((h) => `${f}: ${h}`));
    expect(offenders).toEqual([]);
  });

  it("全仓没有裸 animate-pulse（状态点静态）；光标 / 骨架自己带 motion-reduce:animate-none 或在白名单里", () => {
    const offenders = files
      .filter(([f]) => !(f in PULSE_ALLOWED))
      .flatMap(([f, src]) => pulseHits(src).map((h) => `${f}: ${h.trim().slice(0, 60)}`));
    expect(offenders).toEqual([]);
    for (const [f, why] of Object.entries(PULSE_ALLOWED)) expect(why.trim().length, f).toBeGreaterThan(5);
  });

  it("R13-03 的四处偏离不回来：点 / 图标都静态", () => {
    for (const f of [
      "components/tasks/task-list-item.tsx",
      "components/tasks/workspace-actions.tsx",
      "components/tasks/event-stream/rows.tsx",
      "components/tasks/event-stream.tsx",
    ]) {
      expect(pulseHits(stripComments(read(f))), f).toEqual([]);
    }
  });

  it("R13-04：未读角标不写死 text-white（暗色 destructive 底上只有 2.89:1）", () => {
    const bell = stripComments(read("components/mr-inbox/mr-inbox-bell.tsx"));
    expect(bell).not.toMatch(RAW_WHITE_BLACK);
    expect(bell).toContain("text-primary-foreground");
  });

  it("R13-02：Combobox / Picker 的 title 走 Tooltip，不再落到原生 <button title>", () => {
    const picker = stripComments(read("components/ui/picker.tsx"));
    expect(nativeTitleAttrs(picker)).toEqual([]);
    expect(picker).toMatch(/<Tooltip content=\{title\}>/);
  });
});
