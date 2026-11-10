/* eslint-disable @typescript-eslint/no-explicit-any -- 假元素与被测 .mjs 无类型声明，any 是刻意的 */
/**
 * R6-39③：录制探针 SECRET_VISIBLE_PROBE_SOURCE 的 fail-closed 分支——「相交判断（getBoundingClientRect / getComputedStyle）抛错」
 * 对读不进的框架按**可见**计（opaqueVisible++，该帧丢弃），而不是按不可见放过。
 * （评审原文写作「抛错按不可见」，实际代码与本测试钉的都是「抛错按**可见**」——fail-closed 的方向；变异 M15 把 `vis = true` 改成 `vis = false` 曾经全绿。）
 */
import vm from "node:vm";

import { describe, expect, it } from "vitest";

import { SECRET_VISIBLE_PROBE_SOURCE, readProbeVerdict } from "../electron-app/browser/record-policy.mjs";

type Opts = {
  type?: string;
  contentDocument?: unknown;
  /** getBoundingClientRect 抛错 */
  rectThrows?: boolean;
  /** getComputedStyle 抛错 */
  styleThrows?: boolean;
  rect?: { left: number; top: number; width: number; height: number };
};

const rel = (tag: string, o: Opts = {}) => {
  const base: Record<string, any> = {
    tagName: tag.toUpperCase(),
    type: o.type ?? "",
    nodeType: 1,
    shadowRoot: null,
    getAttribute: (k: string) => (k === "type" ? (o.type ?? null) : null),
    getBoundingClientRect: () => {
      if (o.rectThrows) throw new Error("hostile getBoundingClientRect");
      return o.rect ?? { left: 10, top: 10, width: 100, height: 20 };
    },
    ownerDocument: {
      defaultView: {
        getComputedStyle: () => {
          if (o.styleThrows) throw new Error("hostile getComputedStyle");
          return { visibility: "visible", display: "block", webkitTextSecurity: "" };
        },
      },
    },
  };
  if ("contentDocument" in o) base.contentDocument = o.contentDocument;
  return base;
};
const rdoc = (els: any[], active: any = null) => ({ documentElement: {}, activeElement: active, querySelectorAll: () => els });
const run = (doc: any) =>
  vm.runInNewContext(SECRET_VISIBLE_PROBE_SOURCE, { document: doc, window: { innerWidth: 800, innerHeight: 600, getComputedStyle: () => ({}) }, getComputedStyle: () => ({}) });
const asRes = (value: unknown) => ({ result: { value } });

describe("R6-39③ 录制探针：相交判断抛错 → 按「可见」计 opaque（fail-closed）", () => {
  it.each([
    ["iframe", { contentDocument: null }],
    ["frame", { contentDocument: null }],
    ["object", { contentDocument: null }],
    ["embed", {}],
    ["fencedframe", {}],
  ] as const)("读不进的 <%s>：getBoundingClientRect 抛错 → opaqueVisible=1，判 unknown（不是 safe）", (tag, extra) => {
    const r = run(rdoc([rel(tag, { ...extra, rectThrows: true })]));
    expect(r).toMatchObject({ state: "safe", opaque: 1, opaqueVisible: 1 });
    expect(readProbeVerdict(asRes(r))).toBe("unknown");
  });

  it("读不进的 iframe：几何读得出但 getComputedStyle 抛错（页面把 getComputedStyle 换成抛错版本）→ 同样按可见计", () => {
    const r = run(rdoc([rel("iframe", { contentDocument: null, styleThrows: true })]));
    expect(r).toMatchObject({ state: "safe", opaque: 1, opaqueVisible: 1 });
    expect(readProbeVerdict(asRes(r))).toBe("unknown");
  });

  it("对照：几何 / 样式读得出且在视口外 → opaqueVisible=0 仍 safe（fail-closed 只在「抛错」时触发，不是对所有 opaque 一刀切）", () => {
    const r = run(rdoc([rel("iframe", { contentDocument: null, rect: { left: 0, top: 5000, width: 300, height: 200 } })]));
    expect(r).toMatchObject({ state: "safe", opaque: 1, opaqueVisible: 0 });
    expect(readProbeVerdict(asRes(r))).toBe("safe");
  });

  it("读得进的框架里的 password 框：相交判断抛错 → 整个探针 unknown（外层 catch，同样 fail-closed），不是 safe", () => {
    const frame = rel("iframe", { contentDocument: rdoc([rel("input", { type: "password", rectThrows: true })]), rect: { left: 0, top: 0, width: 300, height: 200 } });
    const r = run(rdoc([frame]));
    expect(r).toMatchObject({ state: "unknown" });
    expect(readProbeVerdict(asRes(r))).toBe("unknown");
  });

  it("同一探针的另一条 fail-closed 分支：框架嵌套超过 8 层（没探到最深处、无法判断相交）→ 计入 opaque 且按可见 → unknown；浅嵌套对照 safe", () => {
    const rect = { left: 0, top: 0, width: 300, height: 200 };
    const nest = (n: number): any => (n === 0 ? rdoc([]) : rdoc([rel("iframe", { contentDocument: nest(n - 1), rect })]));
    const deep = run(nest(12));
    expect(deep).toMatchObject({ state: "safe", opaque: 1, opaqueVisible: 1 });
    expect(readProbeVerdict(asRes(deep))).toBe("unknown");
    const shallow = run(nest(3));
    expect(shallow).toMatchObject({ state: "safe", opaque: 0, opaqueVisible: 0 });
    expect(readProbeVerdict(asRes(shallow))).toBe("safe");
  });

  it("主文档里的 password 框：相交判断抛错且不是焦点 → unknown；它是焦点（active）则不需要相交判断 → secret", () => {
    const pw = rel("input", { type: "password", rectThrows: true });
    expect(run(rdoc([pw]))).toMatchObject({ state: "unknown" });
    expect(run(rdoc([pw], pw))).toMatchObject({ state: "secret" });
  });
});
