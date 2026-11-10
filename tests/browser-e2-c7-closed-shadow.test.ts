/* eslint-disable @typescript-eslint/no-explicit-any -- 假 tab / 页面元素与被测 .mjs 无类型声明，any 是刻意的 */
/**
 * E2·P10 · C7：closed shadow root 里的敏感字段判定补强（closed-shadow.mjs）。
 *
 * 漏洞背景：页内探针只认 `el.shadowRoot`（open），closed 时 `host.shadowRoot === null`，焦点 / 落点停在 host → 判 safe。
 * 这里用 vm 在假元素上**真跑**页内函数（NEXT_FOCUS_OPEN_FN / ROOT_ACTIVE_FN / SECRET_ELEMENT_PROBE_SOURCE …），
 * 用脚本化的假 CDP 复现 `DOM.describeNode` → `DOM.resolveNode` → `Runtime.callFunctionOn` 的穿透链路。真浏览器见 scripts/browser-e2e/e2-c7-closed-shadow.cjs。
 */
import vm from "node:vm";

import { describe, expect, it } from "vitest";

import * as actions from "../electron-app/browser/actions.mjs";
import {
  MAX_SHADOW_DEPTH,
  closedRootIds,
  closedShadowTextFromTree,
  collectClosedShadowText,
  mergeVerdicts,
  probeDropSecretCdp,
  probeFocusSecretCdp,
} from "../electron-app/browser/closed-shadow.mjs";
import { createHandlers as createReadHandlers } from "../electron-app/browser/ops/read.mjs";
import { SECRET_PRESS_KEY_MESSAGE, SECRET_DROP_MESSAGE } from "../electron-app/browser/secret-field.mjs";

type El = Record<string, any>;

const win = { getComputedStyle: (e: El) => ({ webkitTextSecurity: e?.__ts ?? "", getPropertyValue: () => e?.__ts ?? "" }) };
let backendSeq = 100;

/** 普通元素 */
const el = (tag: string, attrs: Record<string, string> = {}, extra: El = {}): El => ({
  nodeType: 1,
  tagName: tag.toUpperCase(),
  type: attrs.type ?? "",
  shadowRoot: null,
  getAttribute: (n: string) => (n in attrs ? attrs[n] : null),
  ownerDocument: { defaultView: win },
  ...extra,
});
const PW = () => el("input", { type: "password" });
const PLAIN = () => el("input", { type: "text" });

/** closed shadow root：host.shadowRoot 仍是 null，只有 CDP（__closed）拿得到 */
const closedRoot = (opts: { active?: El | null; at?: El | null }) => {
  const root: El = { __id: backendSeq++, activeElement: opts.active ?? null, elementFromPoint: () => opts.at ?? null };
  return root;
};
const hostWith = (root: El, tag = "x-host") => el(tag, {}, { __closed: root });
/** open shadow root：页内函数能直接穿 */
const openHostWith = (active: El | null, at?: El | null) =>
  el("x-open", {}, { shadowRoot: { activeElement: active, elementFromPoint: () => at ?? null } });

/**
 * 脚本化的假 CDP：对象图在 JS 里，页内函数源码用 vm 真跑。
 * @param doc 页面级 document（activeElement / elementFromPoint）
 */
const makeTab = (doc: El, fail: Partial<Record<string, boolean>> = {}) => {
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
  const run = (fn: string, self: any, args: unknown[] = []) =>
    vm.runInContext(`(${fn}).call(__self, ...__args)`, Object.assign(ctx, { __self: self, __args: args }));
  const asRemote = (v: any) => (v ? { subtype: "node", objectId: reg(v) } : { subtype: "null", value: null });
  const tab: any = {
    calls,
    released: 0,
    send: async (method: string, params: any = {}) => {
      calls.push(method);
      if (fail[method]) throw new Error(`boom:${method}`);
      switch (method) {
        case "Runtime.evaluate":
          return { result: asRemote(doc.activeElement) };
        case "DOM.resolveNode": {
          if (typeof params.backendNodeId === "number" && rootsByBackend.has(params.backendNodeId)) {
            return { object: { objectId: reg(rootsByBackend.get(params.backendNodeId)) } };
          }
          // entry 的 backendNodeId：给一个挂在 doc 上的普通元素（this.ownerDocument 回落到 document）
          return { object: { objectId: reg(el("div", {}, { ownerDocument: doc })) } };
        }
        case "DOM.describeNode": {
          const e = objs.get(params.objectId);
          const roots: any[] = [];
          if (e?.__closed) {
            rootsByBackend.set(e.__closed.__id, e.__closed);
            roots.push({ shadowRootType: "closed", backendNodeId: e.__closed.__id });
          }
          if (e?.shadowRoot) roots.push({ shadowRootType: "open", backendNodeId: 1 });
          return { node: { shadowRoots: roots } };
        }
        case "Runtime.callFunctionOn": {
          const self = objs.get(params.objectId);
          const args = (params.arguments ?? []).map((a: any) => a.value);
          const r = run(String(params.functionDeclaration), self, args);
          if (params.returnByValue === false) return { result: asRemote(r) };
          return { result: { value: r } };
        }
        case "Runtime.releaseObjectGroup":
          tab.released++;
          return {};
        default:
          return {};
      }
    },
  };
  return tab;
};

describe("closedRootIds / mergeVerdicts（纯函数）", () => {
  it("只挑 closed 的 shadow root；open / 脏数据 / 非整数 id 全忽略", () => {
    expect(
      closedRootIds({
        node: {
          shadowRoots: [
            { shadowRootType: "open", backendNodeId: 1 },
            { shadowRootType: "closed", backendNodeId: 2 },
            { shadowRootType: "closed", backendNodeId: "3" },
            { shadowRootType: "user-agent", backendNodeId: 4 },
            null,
          ],
        },
      }),
    ).toEqual([2]);
    expect(closedRootIds(undefined)).toEqual([]);
    expect(closedRootIds({ node: {} })).toEqual([]);
    expect(closedRootIds({ node: { shadowRoots: "x" } })).toEqual([]);
  });

  it("合并只升级不降级：任一 secret → secret；都 safe 才 safe；其余 unknown", () => {
    expect(mergeVerdicts("safe", "secret")).toBe("secret");
    expect(mergeVerdicts("secret", "safe")).toBe("secret");
    expect(mergeVerdicts("secret", "unknown")).toBe("secret");
    expect(mergeVerdicts("safe", "safe")).toBe("safe");
    expect(mergeVerdicts("safe", "unknown")).toBe("unknown");
    expect(mergeVerdicts("unknown", "safe")).toBe("unknown");
    expect(mergeVerdicts("safe", undefined)).toBe("unknown");
    expect(mergeVerdicts(undefined, "safe")).toBe("unknown");
  });
});

describe("probeFocusSecretCdp：焦点在 closed shadow root 里", () => {
  it("closed 里的 password 拿到焦点 → secret（漏洞原型：页内探针停在 host 判 safe）", async () => {
    const host = hostWith(closedRoot({ active: PW() }));
    expect(await probeFocusSecretCdp(makeTab({ activeElement: host }), null)).toBe("secret");
  });

  it("closed 里的普通输入框 / 带 text-security 遮罩的 text 框 / cc-* 自动完成", async () => {
    expect(await probeFocusSecretCdp(makeTab({ activeElement: hostWith(closedRoot({ active: PLAIN() })) }), null)).toBe("safe");
    const masked = el("input", { type: "text" }, { __ts: "disc" });
    expect(await probeFocusSecretCdp(makeTab({ activeElement: hostWith(closedRoot({ active: masked })) }), null)).toBe("secret");
    const card = el("input", { type: "text", autocomplete: "cc-number" });
    expect(await probeFocusSecretCdp(makeTab({ activeElement: hostWith(closedRoot({ active: card })) }), null)).toBe("secret");
  });

  it("closed 嵌套 closed（密码框在最内层）→ secret；最内层是普通框 → safe", async () => {
    const inner = hostWith(closedRoot({ active: PW() }), "x-inner");
    const outer = hostWith(closedRoot({ active: inner }), "x-outer");
    expect(await probeFocusSecretCdp(makeTab({ activeElement: outer }), null)).toBe("secret");
    const inner2 = hostWith(closedRoot({ active: PLAIN() }), "x-inner");
    expect(await probeFocusSecretCdp(makeTab({ activeElement: hostWith(closedRoot({ active: inner2 })) }), null)).toBe("safe");
  });

  it("open 里套 closed、closed 里套 open 都能穿透", async () => {
    const closedInOpen = openHostWith(hostWith(closedRoot({ active: PW() })));
    expect(await probeFocusSecretCdp(makeTab({ activeElement: closedInOpen }), null)).toBe("secret");
    const openInClosed = hostWith(closedRoot({ active: openHostWith(PW()) }));
    expect(await probeFocusSecretCdp(makeTab({ activeElement: openInClosed }), null)).toBe("secret");
  });

  it("焦点在 host 自己（closed root 里没有焦点元素）→ 判 host 自己；document 没有焦点元素 → safe", async () => {
    expect(await probeFocusSecretCdp(makeTab({ activeElement: hostWith(closedRoot({ active: null })) }), null)).toBe("safe");
    expect(await probeFocusSecretCdp(makeTab({ activeElement: null }), null)).toBe("safe");
  });

  it("有 ref（entry）：从该元素所在 document 的 activeElement 起走", async () => {
    const host = hostWith(closedRoot({ active: PW() }));
    expect(await probeFocusSecretCdp(makeTab({ activeElement: host }), { backendNodeId: 7, sessionId: "S1" })).toBe("secret");
  });

  it("任何一步 CDP 失败 → unknown（fail-closed）；仍然 releaseObjectGroup", async () => {
    const host = hostWith(closedRoot({ active: PLAIN() }));
    for (const m of ["Runtime.evaluate", "DOM.describeNode", "DOM.resolveNode", "Runtime.callFunctionOn"]) {
      const tab = makeTab({ activeElement: host }, { [m]: true });
      expect(await probeFocusSecretCdp(tab, null), m).toBe("unknown");
      expect(tab.released, m).toBe(1);
    }
  });

  it("closed 层数上限：深度 ≤ 上限能判，超限 → unknown（宁可拒绝）", async () => {
    const chain = (depth: number, leaf: El) => {
      let cur = leaf;
      for (let i = 0; i < depth; i++) cur = hostWith(closedRoot({ active: cur }), `x-${i}`);
      return cur;
    };
    expect(await probeFocusSecretCdp(makeTab({ activeElement: chain(MAX_SHADOW_DEPTH - 1, PW()) }), null)).toBe("secret");
    expect(await probeFocusSecretCdp(makeTab({ activeElement: chain(MAX_SHADOW_DEPTH + 2, PW()) }), null)).toBe("unknown");
    expect(await probeFocusSecretCdp(makeTab({ activeElement: chain(MAX_SHADOW_DEPTH + 2, PLAIN()) }), null)).toBe("unknown");
  });

  it("恶意页面：把 type 访问器改成会抛 → 终判按 secret（SECRET_ELEMENT_PROBE 的 uncertain 口径）", async () => {
    const hostile = el("input", { type: "text" });
    Object.defineProperty(hostile, "type", {
      get() {
        throw new Error("nope");
      },
    });
    expect(await probeFocusSecretCdp(makeTab({ activeElement: hostWith(closedRoot({ active: hostile })) }), null)).toBe("secret");
  });
});

describe("probeDropSecretCdp：拖放落点在 closed shadow root 里", () => {
  const entry = { backendNodeId: 9, sessionId: null };

  it("落点处 host 压着 closed 里的密码框 → secret；普通框 → safe", async () => {
    const hostPw = hostWith(closedRoot({ at: PW() }));
    expect(await probeDropSecretCdp(makeTab({ elementFromPoint: () => hostPw }), entry, 5, 5)).toBe("secret");
    const hostPlain = hostWith(closedRoot({ at: PLAIN() }));
    expect(await probeDropSecretCdp(makeTab({ elementFromPoint: () => hostPlain }), entry, 5, 5)).toBe("safe");
  });

  it("closed 嵌套 closed / open 套 closed", async () => {
    const nested = hostWith(closedRoot({ at: hostWith(closedRoot({ at: PW() })) }));
    expect(await probeDropSecretCdp(makeTab({ elementFromPoint: () => nested }), entry, 1, 1)).toBe("secret");
    const mixed = openHostWith(hostWith(closedRoot({ at: PW() })), undefined);
    (mixed.shadowRoot as any).elementFromPoint = () => hostWith(closedRoot({ at: PW() }));
    expect(await probeDropSecretCdp(makeTab({ elementFromPoint: () => mixed }), entry, 1, 1)).toBe("secret");
  });

  it("落点探不到元素 / CDP 出错 / 层数耗尽 → unknown（与页内探针同口径）", async () => {
    expect(await probeDropSecretCdp(makeTab({ elementFromPoint: () => null }), entry, 5, 5)).toBe("unknown");
    const host = hostWith(closedRoot({ at: PLAIN() }));
    expect(await probeDropSecretCdp(makeTab({ elementFromPoint: () => host }, { "DOM.describeNode": true }), entry, 5, 5)).toBe("unknown");
    let deep: El = PW();
    for (let i = 0; i < MAX_SHADOW_DEPTH + 2; i++) deep = hostWith(closedRoot({ at: deep }));
    expect(await probeDropSecretCdp(makeTab({ elementFromPoint: () => deep }), entry, 5, 5)).toBe("unknown");
  });
});

describe("actions 接线：assertFocusNotSecret / drag 落点会调 closed 复核", () => {
  it("无 ref：页内探针 safe（停在 host）+ CDP 复核 secret → 抛 BAD_ARGS（SECRET_PRESS_KEY_MESSAGE）", async () => {
    // 页内 ACTIVE_SECRET_PROBE 在 vm 里跑：host.shadowRoot === null → 停在 host → safe；复核再穿 closed 发现密码框
    const host = hostWith(closedRoot({ active: PW() }));
    const tab = makeTab({ activeElement: host });
    const realSend = tab.send;
    // Runtime.evaluate：returnByValue:false（复核取引用）走假 CDP；returnByValue:true（页内探针）在 vm 里跑表达式
    tab.send = async (method: string, params: any = {}) => {
      if (method === "Runtime.evaluate" && params.returnByValue === true) {
        const ctx = vm.createContext({ window: win, document: { activeElement: host }, getComputedStyle: win.getComputedStyle });
        return { result: { value: vm.runInContext(params.expression, ctx) } };
      }
      return realSend(method, params);
    };
    await expect(actions.assertFocusNotSecret(tab, null, undefined)).rejects.toMatchObject({ code: "BAD_ARGS", message: SECRET_PRESS_KEY_MESSAGE });
    expect(tab.calls).toContain("DOM.describeNode");
  });

  it("无 ref：closed 里是普通框 → 放行；复核异常 → 拒绝（unknown 文案）", async () => {
    const mk = (fail: Partial<Record<string, boolean>>, active: El) => {
      const host = hostWith(closedRoot({ active }));
      const tab = makeTab({ activeElement: host }, fail);
      const realSend = tab.send;
      tab.send = async (method: string, params: any = {}) => {
        if (method === "Runtime.evaluate" && params.returnByValue === true) {
          const ctx = vm.createContext({ window: win, document: { activeElement: host }, getComputedStyle: win.getComputedStyle });
          return { result: { value: vm.runInContext(params.expression, ctx) } };
        }
        return realSend(method, params);
      };
      return tab;
    };
    await expect(actions.assertFocusNotSecret(mk({}, PLAIN()), null, undefined)).resolves.toBeUndefined();
    await expect(actions.assertFocusNotSecret(mk({ "DOM.describeNode": true }, PLAIN()), null, undefined)).rejects.toMatchObject({ code: "BAD_ARGS" });
  });

  it("文案钉死：SECRET_DROP_MESSAGE 仍指向 browser_ask_user_to_act（drag 复核复用同一条）", () => {
    expect(SECRET_DROP_MESSAGE).toContain("browser_ask_user_to_act");
  });
});

// ───────────────────────── closed shadow 里的文字（wait_for text / read） ─────────────────────────

const txt = (v: string) => ({ nodeType: 3, nodeName: "#text", nodeValue: v });
const elNode = (name: string, children: any[] = [], shadowRoots: any[] = []) => ({ nodeType: 1, nodeName: name.toUpperCase(), children, shadowRoots });
const sroot = (type: "open" | "closed", children: any[]) => ({ nodeType: 11, nodeName: "#document-fragment", shadowRootType: type, children });

describe("closedShadowTextFromTree：只采 closed root 内的文字", () => {
  it("closed 内的文字被采；light DOM 与 open root 内的不重复采（页内脚本已覆盖）", () => {
    const tree = elNode("html", [
      elNode("body", [
        txt("外层文字"),
        elNode("x-open", [], [sroot("open", [txt("开放文字")])]),
        elNode("x-closed", [], [sroot("closed", [elNode("p", [txt("  闭合   文字\n第二行 ")])])]),
      ]),
    ]);
    expect(closedShadowTextFromTree(tree)).toEqual({ text: "闭合 文字 第二行", truncated: false });
  });

  it("closed 套 open / closed 套 closed 都算 closed 内；跳过 script / style / textarea / select / input 等", () => {
    const tree = elNode("body", [
      elNode("x-a", [], [sroot("closed", [elNode("x-b", [], [sroot("open", [txt("甲")])]), elNode("x-c", [], [sroot("closed", [txt("乙")])])])]),
      elNode("x-d", [], [
        sroot("closed", [
          elNode("script", [txt("var secret = 1")]),
          elNode("style", [txt(".a{}")]),
          elNode("textarea", [txt("文本域默认内容")]),
          elNode("select", [elNode("option", [txt("选项一")])]),
          elNode("noscript", [txt("无脚本")]),
          elNode("template", [txt("模板")]),
          txt("可见"),
        ]),
      ]),
    ]);
    const { text } = closedShadowTextFromTree(tree);
    expect(text.split("\n").sort()).toEqual(["乙", "可见", "甲"]);
    expect(text).not.toMatch(/secret|文本域|选项|无脚本|模板/);
  });

  it("节点数 / 字符数预算：超了截断并标 truncated；超深嵌套（迭代遍历）不爆调用栈", () => {
    const wide = elNode("x", [], [sroot("closed", Array.from({ length: 50 }, (_, i) => txt(`文字${i}`)))]);
    expect(closedShadowTextFromTree(wide, { maxNodes: 10 }).truncated).toBe(true);
    const byChars = closedShadowTextFromTree(wide, { maxChars: 30 });
    expect(byChars.truncated).toBe(true);
    expect(byChars.text.length).toBeLessThanOrEqual(30);
    let deep: any = txt("最深");
    for (let i = 0; i < 50_000; i++) deep = elNode("div", [deep]);
    const r = closedShadowTextFromTree(elNode("x", [], [sroot("closed", [deep])]), { maxNodes: 1_000_000 });
    expect(r.text).toBe("最深");
  });

  it("脏数据（null / 非对象 / 缺字段）不抛", () => {
    expect(closedShadowTextFromTree(null)).toEqual({ text: "", truncated: false });
    expect(closedShadowTextFromTree({ nodeType: 1, nodeName: "DIV", children: [null, 3, "x", { nodeType: 3 }], shadowRoots: "bad" })).toEqual({ text: "", truncated: false });
  });

  it("collectClosedShadowText：getDocument 带 pierce；失败返回空串（不影响 wait_for / read）", async () => {
    const calls: any[] = [];
    const ok: any = {
      send: async (m: string, p: any) => {
        calls.push({ m, p });
        return { root: elNode("body", [elNode("x", [], [sroot("closed", [txt("你好")])])]) };
      },
    };
    expect(await collectClosedShadowText(ok)).toBe("你好");
    expect(calls[0]).toMatchObject({ m: "DOM.getDocument", p: { depth: -1, pierce: true } });
    const bad: any = { send: async () => Promise.reject(new Error("x")) };
    expect(await collectClosedShadowText(bad)).toBe("");
  });
});

describe("ops/read：整页读取追加 closed shadow 文字", () => {
  const mk = (closed: string | Error, root = "body", mainText = "主体") => {
    const tab: any = {
      id: "t1",
      url: "https://a.test/",
      title: "T",
      mainFrameId: "F1",
      ensureCdp: async () => {},
      resolveRef: () => ({ backendNodeId: 9, sessionId: null }),
      send: async (m: string) => {
        if (m === "Page.createIsolatedWorld") return { executionContextId: 5 };
        if (m === "Runtime.evaluate") return { result: { value: { text: mainText, truncated: false, root, totalLength: mainText.length } } };
        if (m === "DOM.resolveNode") return { object: { objectId: "o1" } };
        if (m === "Runtime.callFunctionOn") return { result: { value: { text: "元素文字", truncated: false, root: "element", totalLength: 4 } } };
        return {};
      },
      closedShadowText: async () => {
        if (closed instanceof Error) throw closed;
        return closed;
      },
    };
    const session: any = { getTab: () => tab, activityLog: { addAI: () => {} } };
    const callOnNode = async () => ({ text: "元素文字", truncated: false, root: "element", totalLength: 4 });
    return createReadHandlers({
      requireSession: () => session,
      getConfig: () => ({}),
      abortable: (p: Promise<unknown>) => p,
      scheduleState: () => {},
      app: { getPath: () => "/tmp" },
      actions: { callOnNode },
      log: () => {},
    } as any);
  };

  it("root=body 且无 ref：末尾追加一段并注明来源；totalLength 同步增加", async () => {
    const r: any = await mk("闭合文字").read("task", { format: "text", maxChars: 30_000, mainContent: false }, undefined);
    expect(r.text.startsWith("主体")).toBe(true);
    expect(r.text).toContain("closed shadow DOM");
    expect(r.text.endsWith("闭合文字")).toBe(true);
    expect(r.totalLength).toBeGreaterThan(r.length - 1);
    expect(r.truncated).toBe(false);
  });

  it("读的是 main / article（mainContent 摘取）或带 ref：不追加", async () => {
    const a: any = await mk("闭合文字", "main").read("task", { format: "text", maxChars: 30_000, mainContent: true }, undefined);
    expect(a.text).toBe("主体");
    const b: any = await mk("闭合文字").read("task", { ref: "e5", format: "text", maxChars: 30_000, mainContent: true }, undefined);
    expect(b.text).not.toContain("闭合文字");
  });

  it("closed 取文字失败 / 为空：读取结果原样返回", async () => {
    expect(((await mk(new Error("boom")).read("task", { format: "text", maxChars: 30_000, mainContent: false }, undefined)) as any).text).toBe("主体");
    expect(((await mk("").read("task", { format: "text", maxChars: 30_000, mainContent: false }, undefined)) as any).text).toBe("主体");
  });

  it("maxChars 预算：追加后总长不超上限并标 truncated", async () => {
    const r: any = await mk("闭".repeat(5000)).read("task", { format: "text", maxChars: 1000, mainContent: false }, undefined);
    expect(r.text.length).toBeLessThanOrEqual(1000);
    expect(r.truncated).toBe(true);
  });
});
