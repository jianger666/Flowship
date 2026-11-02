/**
 * 契约：md-revision 的 parser 与 artifact-revision-view 的渲染共用 revision-syntax-plugins.ts（cjk + math）。
 *
 * 为什么要钉：哨兵是塞进 markdown 源码的带内信号，parse 侧（切块 / 配对 / 复验）必须和渲染侧用同一套语法扩展，
 * 否则渲染端多出来的语法（math 公式 / cjk 强调边界）对 parse 侧是盲区——公式里被塞进哨兵，
 * 渲染端 KaTeX 报错并把私有区字符泄漏到页面（真实渲染链路实测）。
 * 两侧各写各的最容易在以后「顺手改一边」时悄悄漂移，所以三层钉住：源码引用 / 共用表结构 / 行为。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import remarkGfm from "remark-gfm";
import { defaultRemarkPlugins } from "streamdown";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  REVISION_PARSE_REMARK_PLUGINS,
  REVISION_SYNTAX_PLUGINS,
} from "../src/lib/revision-syntax-plugins";

const read = (rel: string) => readFileSync(resolve(__dirname, "..", rel), "utf8");

/** 去掉注释再做源码断言——注释里提到 remark-gfm / math 不算接线 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const MATH_OLD = "质能 $$E = mc^2$$ 成立";
const MATH_NEW = "质能 $$E = mc^3$$ 成立";

describe("源码接线：两侧都引用共用表，不各自直接依赖语法插件", () => {
  const mdRevision = stripComments(read("src/lib/md-revision.ts"));
  const view = stripComments(read("src/components/tasks/artifact-revision-view.tsx"));

  it("md-revision.ts：parser 与 parseMergedWithRevisionPlugin 都 .use(REVISION_PARSE_REMARK_PLUGINS)", () => {
    expect(mdRevision).toMatch(
      /import\s*\{\s*REVISION_PARSE_REMARK_PLUGINS\s*\}\s*from\s*"\.\/revision-syntax-plugins"/,
    );
    expect(mdRevision.match(/\.use\(REVISION_PARSE_REMARK_PLUGINS\)/g) ?? []).toHaveLength(2);
  });

  it("md-revision.ts 不再直接 import remark-gfm / @streamdown/*（直接依赖 = 绕开共用表）", () => {
    expect(mdRevision).not.toMatch(/from\s*"remark-gfm"/);
    expect(mdRevision).not.toMatch(/from\s*"@streamdown\//);
  });

  it("artifact-revision-view.tsx：PLUGINS 展开共用的 REVISION_SYNTAX_PLUGINS", () => {
    expect(view).toMatch(
      /import\s*\{\s*REVISION_SYNTAX_PLUGINS\s*\}\s*from\s*"@\/lib\/revision-syntax-plugins"/,
    );
    expect(view).toMatch(/const PLUGINS = \{[^}]*\.\.\.REVISION_SYNTAX_PLUGINS[^}]*\}/);
  });

  it("artifact-revision-view.tsx 不直接 import @streamdown/math / @streamdown/cjk", () => {
    expect(view).not.toMatch(/from\s*"@streamdown\/math"/);
    expect(view).not.toMatch(/from\s*"@streamdown\/cjk"/);
  });
});

describe("源码接线：artifact-revision-view.tsx 的 JSX 把共用表 / 渲染链 / ins·del 组件真正接到 <Streamdown> 上", () => {
  // 这一组钉的是生产组件本身（revision-render-chain.test.ts 的 renderView 是测试自己拼的 props，改坏组件它不会红）
  const view = stripComments(read("src/components/tasks/artifact-revision-view.tsx"));
  const streamdownJsx = /<Streamdown\b[\s\S]*?>/.exec(view)?.[0] ?? "";

  it("找得到 <Streamdown …> 的开标签（文件结构没被改乱）", () => {
    expect(streamdownJsx).not.toBe("");
  });

  it("<Streamdown> 的 plugins / remarkPlugins / rehypePlugins / components 分别接到 PLUGINS / remarkPlugins / REVISION_REHYPE_PLUGINS / components", () => {
    expect(streamdownJsx).toMatch(/\bplugins=\{PLUGINS\}/);
    expect(streamdownJsx).toMatch(/\bremarkPlugins=\{remarkPlugins\}/);
    expect(streamdownJsx).toMatch(/\brehypePlugins=\{REVISION_REHYPE_PLUGINS\}/);
    expect(streamdownJsx).toMatch(/\bcomponents=\{components\}/);
  });

  it("remarkPlugins 走 createRevisionRemarkPlugins(blockMarks, { sentinels: !leakFallback })——插件顺序（哨兵 → 块标注 → 代码引用）与降级时不消费哨兵都靠它", () => {
    expect(view).toMatch(
      /import\s*\{\s*createRevisionRemarkPlugins\s*\}\s*from\s*"@\/lib\/revision-render-chain"/,
    );
    expect(view).toMatch(
      /const remarkPlugins = useMemo\(\s*\(\)\s*=>\s*createRevisionRemarkPlugins\(\s*blockMarks,\s*\{\s*sentinels:\s*!leakFallback\s*\}\s*\)/,
    );
    expect(view).toMatch(/const leakFallback = revisionView\.stats\.leakFallback === true/);
  });

  it("rehypePlugins 来自 revision-rehype-plugins 的 REVISION_REHYPE_PLUGINS；ins / del 映射到 RevisionIns / RevisionDel（且在 baseComponents 之后，不被覆盖）", () => {
    expect(view).toMatch(/import\s*\{[^}]*\bREVISION_REHYPE_PLUGINS\b[^}]*\}\s*from\s*"@\/lib\/revision-rehype-plugins"/);
    expect(view).toMatch(/import\s*\{[^}]*\bRevisionIns\b[^}]*\}\s*from\s*"@\/lib\/revision-rehype-plugins"/);
    expect(view).toMatch(/import\s*\{[^}]*\bRevisionDel\b[^}]*\}\s*from\s*"@\/lib\/revision-rehype-plugins"/);
    expect(view).toMatch(/\.\.\.baseComponents,\s*ins:\s*RevisionIns,\s*del:\s*RevisionDel,/);
  });
});

describe("共用表结构：parse 侧插件表 = Streamdown 内部对 cjk / math 的拼装", () => {
  it("REVISION_SYNTAX_PLUGINS 含 cjk + math", () => {
    expect(Object.keys(REVISION_SYNTAX_PLUGINS).sort()).toEqual(["cjk", "math"]);
  });

  it("parse 表按 cjkBefore → 默认(gfm…) → cjkAfter → math 的顺序，且每一项都在", () => {
    const table = REVISION_PARSE_REMARK_PLUGINS;
    const { cjk, math } = REVISION_SYNTAX_PLUGINS;
    const defaults = Object.values(defaultRemarkPlugins);
    const idx = (p: unknown) => table.indexOf(p as never);

    expect(cjk.remarkPluginsBefore.length).toBeGreaterThan(0);
    for (const p of [...cjk.remarkPluginsBefore, ...defaults, ...cjk.remarkPluginsAfter]) {
      expect(idx(p), "共用表缺插件").toBeGreaterThanOrEqual(0);
    }
    expect(idx(math.remarkPlugin)).toBeGreaterThanOrEqual(0);

    expect(Math.max(...cjk.remarkPluginsBefore.map(idx))).toBeLessThan(
      Math.min(...defaults.map(idx)),
    );
    expect(Math.max(...defaults.map(idx))).toBeLessThan(
      Math.min(...cjk.remarkPluginsAfter.map(idx)),
    );
    expect(Math.max(...cjk.remarkPluginsAfter.map(idx))).toBeLessThan(idx(math.remarkPlugin));
  });
});

describe("行为：共用表真正影响 md-revision 的切块 / 复验", () => {
  afterEach(() => {
    vi.doUnmock("../src/lib/revision-syntax-plugins");
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("共用表（含 math）下：公式改动不让哨兵进公式源码，也不触发复验降级", async () => {
    vi.resetModules();
    const { buildRevisionView } = await import("../src/lib/md-revision");
    const view = buildRevisionView(MATH_OLD, MATH_NEW);
    expect(view.stats.leakFallback).toBeUndefined();
    expect(view.mergedMd).not.toMatch(/\$\$[^$]*[\uE000-\uE003][^$]*\$\$/);
  });

  it("灵敏度：把共用表还原成只有 gfm（旧口径）→ 同一输入的哨兵进了公式源码，而且 guard 也看不见（上一条会红的方式）", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.resetModules();
    vi.doMock("../src/lib/revision-syntax-plugins", async (importOriginal) => {
      const orig =
        await importOriginal<typeof import("../src/lib/revision-syntax-plugins")>();
      return { ...orig, REVISION_PARSE_REMARK_PLUGINS: [remarkGfm] };
    });
    const { buildRevisionView } = await import("../src/lib/md-revision");
    const view = buildRevisionView(MATH_OLD, MATH_NEW);
    // 只有 gfm 时 parse 侧把公式当普通文本 → 合并串里哨兵落进 `$$…$$`；渲染侧（含 math）会把它当公式源码 → KaTeX 报错 + 泄漏。
    // 更糟的是 guard 复验与逐块验收共用同一个 parser，同样看不见公式，不会降级——
    // 这正是「必须共用表」的原因：表一旦漂移，guard 也一起失明。上面「共用表」那条断言在这个口径下必红。
    expect(view.stats.leakFallback).toBeUndefined();
    expect(view.mergedMd).toMatch(/\$\$[^$]*[\uE000-\uE003][^$]*\$\$/);
  });
});
