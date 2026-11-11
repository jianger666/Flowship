/* eslint-disable @typescript-eslint/no-explicit-any -- 假元素 / 假 CDP 与被测 .mjs 无类型声明，any 是刻意的 */
/**
 * R6-36：读取侧的「框架」探针都要认 iframe / frame / object / embed / fencedframe，且只有 contentDocument 读得进才下钻，否则 unknown（录制则计 opaque）。
 *   ① secret-field.mjs 的 isFrameLikeTag / FRAME_TAGS / FRAME_TAG_FN_SOURCE（唯一判定源）；
 *   ② closed-shadow.mjs 的 IS_FRAME_FN / NEXT_FOCUS_OPEN_FN（CDP 复核，经 probeFocusSecretCdp；录屏每帧用它复核焦点）；
 *   ③ record-policy.mjs 的 SECRET_VISIBLE_PROBE_SOURCE（录制每帧的可见敏感框探针）。
 * 全部用 vm 在假 DOM 上真跑（与 browser-r6-s2-shadow-frame / browser-r6-s2-record-opaque 同构）。
 * 修之前：`<object>` / `<embed>` / `<fencedframe>` 被当普通元素判 safe → 里面的密码 / 验证码框 fail-closed 失效。
 * 注意：页内焦点探针 / 落点探针（ACTIVE_SECRET_PROBE_SOURCE / DROP_TARGET_SECRET_PROBE_SOURCE）与 probeDropSecretCdp / assertPointNotSecret
 * 已随「AI 可以往敏感输入框里输入」的产品决策删除，对应用例一并移除；这里只测保留的读取侧探针。
 */
import vm from "node:vm";

import { describe, expect, it } from "vitest";

import { IS_FRAME_FN, probeFocusSecretCdp } from "../electron-app/browser/closed-shadow.mjs";
import { SECRET_VISIBLE_PROBE_SOURCE, readProbeVerdict } from "../electron-app/browser/record-policy.mjs";
import { FRAME_TAGS, FRAME_TAG_FN_SOURCE, isFrameLikeTag } from "../electron-app/browser/secret-field.mjs";
import { PLAIN, PW, closedRoot, crossOriginFrame, docOf, el, hostWith, makeCdpTab, noDocFrame, nullDocFrame, readableFrame, runProbe } from "./helpers/browser-r6b-fake-dom";

/** 三种「不是 iframe / frame」的新增框架类标签 */
const NEW_TAGS = ["object", "embed", "fencedframe"] as const;

/** contentDocument 读不进的各种形态（每种标签该有的样子：object 读抛错 / null；embed / fencedframe 根本没有该属性） */
const unreadable = (tag: string) => {
  if (tag === "embed" || tag === "fencedframe") return [noDocFrame(tag)];
  return [crossOriginFrame(tag), nullDocFrame(tag)];
};

describe("R6-36 唯一判定源：isFrameLikeTag / FRAME_TAGS / FRAME_TAG_FN_SOURCE", () => {
  it("FRAME_TAGS 恰好是 iframe / frame / object / embed / fencedframe；每个（任意大小写）都判 true", () => {
    expect([...FRAME_TAGS].sort()).toEqual(["embed", "fencedframe", "frame", "iframe", "object"]);
    for (const t of FRAME_TAGS) {
      expect(isFrameLikeTag(t), t).toBe(true);
      expect(isFrameLikeTag(t.toUpperCase()), t.toUpperCase()).toBe(true);
    }
  });

  it("普通元素 / 空值不是框架类（不误伤）", () => {
    for (const t of ["div", "input", "img", "video", "canvas", "svg", "foreignobject", "iframe2", "xobject", "", null, undefined, 0]) {
      expect(isFrameLikeTag(t), String(t)).toBe(false);
    }
  });

  it("FRAME_TAG_FN_SOURCE 自包含：丢进一个空 vm 上下文也能跑，且结论与 isFrameLikeTag 一致", () => {
    const fn = vm.runInNewContext(`(${FRAME_TAG_FN_SOURCE})`);
    for (const t of [...FRAME_TAGS, "div", "INPUT", "OBJECT"]) expect(fn(t), t).toBe(isFrameLikeTag(t));
    expect(FRAME_TAG_FN_SOURCE).not.toContain("FRAME_TAGS");
  });

  it("IS_FRAME_FN（CDP 复核里问「这是框架吗」）：五种标签都 true；div / input false；tagName 读取抛错按 true（fail-closed）", () => {
    const isFrame = (self: any) => runProbe(IS_FRAME_FN, docOf(null), self);
    for (const t of FRAME_TAGS) expect(isFrame(el(t)), t).toBe(true);
    expect(isFrame(el("div"))).toBe(false);
    expect(isFrame(PLAIN())).toBe(false);
    const hostile = el("div", {}, {
      get tagName() {
        throw new Error("hostile");
      },
    });
    expect(isFrame(hostile)).toBe(true);
  });
});

describe("R6-36 CDP 复核（closed-shadow.mjs）：probeFocusSecretCdp", () => {
  it.each(NEW_TAGS)("焦点在 closed root 内的 <%s>（读不进）→ unknown", async (tag) => {
    for (const frame of unreadable(tag)) {
      expect(await probeFocusSecretCdp(makeCdpTab(docOf(hostWith(closedRoot({ active: frame })))), null), tag).toBe("unknown");
    }
  });

  it.each(NEW_TAGS)("焦点直接在 <%s> 上（不在 closed root 里）→ unknown（修之前 NEXT_FOCUS_OPEN_FN 不认、最后拿框架元素自己判 safe）", async (tag) => {
    for (const frame of unreadable(tag)) {
      expect(await probeFocusSecretCdp(makeCdpTab(docOf(frame)), null), tag).toBe("unknown");
    }
  });

  it("可读的 <object>（焦点在里面）：password → secret，普通框 → safe（NEXT_FOCUS_OPEN_FN 真的下钻了，而不是一律 unknown）", async () => {
    expect(await probeFocusSecretCdp(makeCdpTab(docOf(readableFrame(PW(), "object"))), null)).toBe("secret");
    expect(await probeFocusSecretCdp(makeCdpTab(docOf(readableFrame(PLAIN(), "object"))), null)).toBe("safe");
    expect(await probeFocusSecretCdp(makeCdpTab(docOf(hostWith(closedRoot({ active: readableFrame(PW(), "object") })))), null)).toBe("secret");
  });
});

// ───────────────────────── ③ 录制探针 ─────────────────────────

/** 录制探针用的假元素：带几何 / 样式；contentDocument 缺省 = 没有该属性（embed / fencedframe 的真实形态） */
const rel = (tag: string, o: Record<string, any> = {}) => {
  const base: Record<string, any> = {
    tagName: tag.toUpperCase(),
    type: o.type ?? "",
    nodeType: 1,
    shadowRoot: null,
    getAttribute: (k: string) => (k === "type" ? (o.type ?? null) : null),
    getBoundingClientRect: () => o.rect ?? { left: 10, top: 10, width: 100, height: 20 },
    ownerDocument: { defaultView: { getComputedStyle: () => ({ visibility: o.visibility ?? "visible", display: o.display ?? "block", webkitTextSecurity: "" }) } },
  };
  if ("contentDocument" in o) base.contentDocument = o.contentDocument;
  return base;
};
const rdoc = (els: any[], active: any = null) => ({ documentElement: {}, activeElement: active, querySelectorAll: () => els });
const runRecord = (doc: any) =>
  vm.runInNewContext(SECRET_VISIBLE_PROBE_SOURCE, { document: doc, window: { innerWidth: 800, innerHeight: 600, getComputedStyle: () => ({}) }, getComputedStyle: () => ({}) });
const asRes = (value: unknown) => ({ result: { value } });

describe("R6-36 录制探针 SECRET_VISIBLE_PROBE_SOURCE", () => {
  it.each(NEW_TAGS)("视口内读不进的 <%s> → opaqueVisible=1，readProbeVerdict 判 unknown（修之前 opaque=0、判 safe → 该帧照常写盘）", (tag) => {
    const contentDocs = tag === "object" ? [{ contentDocument: null }, { contentDocument: undefined }] : [{}];
    for (const extra of contentDocs) {
      const r = runRecord(rdoc([rel(tag, extra), rel("input", { type: "text" })]));
      expect(r, tag).toMatchObject({ state: "safe", opaque: 1, opaqueVisible: 1 });
      expect(readProbeVerdict(asRes(r)), tag).toBe("unknown");
    }
  });

  it.each(NEW_TAGS)("读不进的 <%s> 在视口外 / display:none / visibility:hidden / 零尺寸：opaque 计数但不算可见 → 仍 safe（不误伤）", (tag) => {
    for (const o of [
      { rect: { left: 0, top: 5000, width: 300, height: 200 } },
      { rect: { left: 2000, top: 0, width: 300, height: 200 } },
      { display: "none" },
      { visibility: "hidden" },
      { rect: { left: 0, top: 0, width: 0, height: 0 } },
    ]) {
      const r = runRecord(rdoc([rel(tag, o)]));
      expect(r, `${tag} ${JSON.stringify(o)}`).toMatchObject({ state: "safe", opaque: 1, opaqueVisible: 0 });
      expect(readProbeVerdict(asRes(r))).toBe("safe");
    }
  });

  it("可读的 <object>（有 documentElement）：照常下钻——里面 password → secret；普通框 → safe 且不计 opaque", () => {
    const inner = (els: any[]) => rel("object", { contentDocument: rdoc(els), rect: { left: 0, top: 0, width: 300, height: 200 } });
    const pw = runRecord(rdoc([inner([rel("input", { type: "password" })])]));
    expect(pw.state).toBe("secret");
    expect(readProbeVerdict(asRes(pw))).toBe("secret");
    const plain = runRecord(rdoc([inner([rel("input", { type: "text" })])]));
    expect(plain).toMatchObject({ state: "safe", opaque: 0, opaqueVisible: 0 });
    expect(readProbeVerdict(asRes(plain))).toBe("safe");
  });

  it("嵌套：可读 iframe 里套一个读不进的 <embed> → 仍计 opaqueVisible（iframe 的偏移被累加后相交判断照常）", () => {
    const frame = rel("iframe", { contentDocument: rdoc([rel("embed")]), rect: { left: 0, top: 0, width: 300, height: 200 } });
    const r = runRecord(rdoc([frame]));
    expect(r).toMatchObject({ state: "safe", opaque: 1, opaqueVisible: 1 });
    expect(readProbeVerdict(asRes(r))).toBe("unknown");
  });

  it("对照（旧行为不变）：读不进的 iframe 在视口内 → unknown；没有任何框架类元素 → safe", () => {
    expect(readProbeVerdict(asRes(runRecord(rdoc([rel("iframe", { contentDocument: null })]))))).toBe("unknown");
    expect(readProbeVerdict(asRes(runRecord(rdoc([rel("input", { type: "text" }), rel("div")]))))).toBe("safe");
  });
});

// ───────────────────────── R6-30 二轮复审④：XHTML 带命名空间前缀的框架元素 ─────────────────────────

/**
 * XHTML 文档里 `<h:iframe>` 是真 iframe：`tagName` 是 `H:IFRAME`，只有 `localName` 是 `iframe`。
 * 修之前探针都按 `tagName` 判框架 → 当普通元素判 safe；改成 `localName || tagName`（现存的读取侧探针：IS_FRAME_FN / NEXT_FOCUS_OPEN_FN / 录制探针）。
 * （HTML 文档里同名的 `<h:iframe>` 是未知元素，localName 就是 `h:iframe`——不是框架，对照用例钉住「没有去前缀」。）
 */
const withLocalName = <T extends Record<string, any>>(e: T, localName: string): T => Object.defineProperty(e, "localName", { value: localName, configurable: true });
const prefixed = (frame: Record<string, any>, localName = "iframe") => {
  Object.defineProperty(frame, "tagName", { value: `H:${localName.toUpperCase()}`, configurable: true });
  return withLocalName(frame, localName);
};

describe("R6-30 ④：带命名空间前缀的框架元素不能被当普通元素判 safe", () => {
  it("IS_FRAME_FN / NEXT_FOCUS_OPEN_FN（CDP 复核）：<h:iframe>、<h:object> 都按框架处理", async () => {
    expect(runProbe(IS_FRAME_FN, docOf(null), prefixed(el("iframe")))).toBe(true);
    expect(runProbe(IS_FRAME_FN, docOf(null), prefixed(el("object"), "object"))).toBe(true);
    expect(await probeFocusSecretCdp(makeCdpTab(docOf(prefixed(crossOriginFrame()))), null)).toBe("unknown");
    expect(await probeFocusSecretCdp(makeCdpTab(docOf(hostWith(closedRoot({ active: prefixed(nullDocFrame()) })))), null)).toBe("unknown");
    expect(await probeFocusSecretCdp(makeCdpTab(docOf(prefixed(readableFrame(PW())))), null)).toBe("secret");
  });

  it("录制探针：视口内读不进的 <h:iframe> → opaqueVisible=1，判 unknown", () => {
    const frame = withLocalName({ ...rel("iframe", { contentDocument: null }), tagName: "H:IFRAME" }, "iframe");
    const r = runRecord(rdoc([frame, rel("input", { type: "text" })]));
    expect(r).toMatchObject({ state: "safe", opaque: 1, opaqueVisible: 1 });
    expect(readProbeVerdict(asRes(r))).toBe("unknown");
  });

  it("对照（精确判断、没有去前缀）：HTML 里的未知元素 <h:iframe>（localName 就是 h:iframe）不是框架；无 localName 的旧形态回落 tagName", async () => {
    const hostile = el("h:iframe", {}, { localName: "h:iframe", contentDocument: null });
    expect(await probeFocusSecretCdp(makeCdpTab(docOf(hostile)), null)).toBe("safe");
    expect(runProbe(IS_FRAME_FN, docOf(null), hostile)).toBe(false);
    // 老的假元素没有 localName：回落到 tagName，iframe 照旧被认出
    expect(runProbe(IS_FRAME_FN, docOf(null), el("iframe"))).toBe(true);
  });
});
