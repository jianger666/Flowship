/* eslint-disable @typescript-eslint/no-explicit-any -- 假元素 / 假 CDP 与被测 .mjs 无类型声明，any 是刻意的 */
/**
 * R6 第二轮（R6-30 / R6-36）共用的假 DOM + 脚本化假 CDP。
 * 与 tests/browser-r6-s2-shadow-frame.test.ts 里的同构：页内函数 / 表达式源码用 vm 真跑，假 CDP 复现
 * `DOM.describeNode` → `DOM.resolveNode` → `Runtime.callFunctionOn / evaluate` 的穿透链路。
 */
import vm from "node:vm";

export type El = Record<string, any>;

export const win = { getComputedStyle: (e: El) => ({ webkitTextSecurity: e?.__ts ?? "", getPropertyValue: () => e?.__ts ?? "" }) };
let backendSeq = 9000;

export const el = (tag: string, attrs: Record<string, string> = {}, extra: El = {}): El => {
  const base: El = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    type: attrs.type ?? "",
    shadowRoot: null,
    getAttribute: (n: string) => (n in attrs ? attrs[n] : null),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 20 }),
    ownerDocument: { defaultView: win },
  };
  // 用属性描述符拷贝：extra 里的 getter（模拟「读 contentDocument / tagName 就抛」的页面）不能在构造时被求值
  return Object.defineProperties(base, Object.getOwnPropertyDescriptors(extra));
};
export const PW = () => el("input", { type: "password" });
export const PLAIN = () => el("input", { type: "text" });

export const closedRoot = (opts: { active?: El | null; at?: El | null }) => ({ __id: backendSeq++, activeElement: opts.active ?? null, elementFromPoint: () => opts.at ?? null });
export const hostWith = (root: El) => el("x-host", {}, { __closed: root });

/** 同站、contentDocument 读得进的框架类元素（iframe / frame / object 都有 contentDocument） */
export const readableFrame = (inner: El | null, tag = "iframe") => el(tag, {}, { contentDocument: { activeElement: inner, elementFromPoint: () => inner } });
/** 跨域 / 沙箱：contentDocument 读取抛错（与真浏览器 SecurityError 同形） */
export const crossOriginFrame = (tag = "iframe") =>
  el(tag, {}, {
    get contentDocument() {
      throw new Error("SecurityError: Blocked a frame from accessing a cross-origin frame.");
    },
  });
/** contentDocument 为 null（沙箱无 allow-same-origin / object 渲染的是插件、图片） */
export const nullDocFrame = (tag = "iframe") => el(tag, {}, { contentDocument: null });
/** 根本没有 contentDocument 属性（`<embed>` / `<fencedframe>` 在 Chromium 里就是这样） */
export const noDocFrame = (tag: "embed" | "fencedframe") => el(tag);

export const docOf = (active: El | null, at: (x: number, y: number) => El | null = () => null): El => {
  const d: El = { activeElement: active, elementFromPoint: at, defaultView: win };
  d.documentElement = el("html", {}, { ownerDocument: d });
  return d;
};

/** 脚本化假 CDP tab：对象图在 JS 里，页内函数 / 表达式源码用 vm 真跑 */
export const makeCdpTab = (doc: El) => {
  const objs = new Map<string, any>();
  const rootsByBackend = new Map<number, El>();
  const calls: string[] = [];
  let n = 0;
  const reg = (v: any) => {
    const id = `o${n++}`;
    objs.set(id, v);
    return id;
  };
  const ctx = vm.createContext({ window: win, document: doc, getComputedStyle: win.getComputedStyle });
  const run = (fn: string, self: any, args: unknown[] = []) => vm.runInContext(`(${fn}).call(__self, ...__args)`, Object.assign(ctx, { __self: self, __args: args }));
  const asRemote = (v: any) => (v ? { subtype: "node", objectId: reg(v) } : { subtype: "null", value: null });
  const tab: any = {
    calls,
    send: async (method: string, params: any = {}) => {
      calls.push(method);
      switch (method) {
        case "Runtime.evaluate": {
          const r = vm.runInContext(String(params.expression), ctx);
          return params.returnByValue ? { result: { value: r } } : { result: asRemote(r) };
        }
        case "DOM.resolveNode": {
          if (typeof params.backendNodeId === "number" && rootsByBackend.has(params.backendNodeId)) {
            return { object: { objectId: reg(rootsByBackend.get(params.backendNodeId)) } };
          }
          return { object: { objectId: reg(el("div", {}, { ownerDocument: doc })) } };
        }
        case "DOM.describeNode": {
          const e = objs.get(params.objectId);
          const roots: any[] = [];
          if (e?.__closed) {
            rootsByBackend.set(e.__closed.__id, e.__closed);
            roots.push({ shadowRootType: "closed", backendNodeId: e.__closed.__id });
          }
          return { node: { shadowRoots: roots } };
        }
        case "Runtime.callFunctionOn": {
          const self = objs.get(params.objectId);
          const args = (params.arguments ?? []).map((a: any) => a.value);
          const r = run(String(params.functionDeclaration), self, args);
          return params.returnByValue === false ? { result: asRemote(r) } : { result: { value: r } };
        }
        default:
          return {};
      }
    },
  };
  return tab;
};

/** 在 vm 里跑一个页内探针源码（this = self）；document / window 由 doc 提供 */
export const runProbe = (source: string, doc: El, self: any = null, args: unknown[] = []) => {
  const ctx = vm.createContext({ window: { ...win, innerWidth: 800, innerHeight: 600 }, document: doc, getComputedStyle: win.getComputedStyle });
  return vm.runInContext(`(${source}).call(__self, ...__args)`, Object.assign(ctx, { __self: self, __args: args }));
};
