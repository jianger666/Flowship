/**
 * AX 快照（electron-app/browser/ax-snapshot.mjs）纯函数单测：契约 §3 / §4.3 snapshot。
 * 用手写假 AX 树喂 formatAxSnapshot / collectSnapshotCandidates，captureAxFrames 用假 send 驱动。
 */
import { describe, expect, it } from "vitest";

import {
  AX_TRUNCATE_NOTE,
  MAX_SECRET_PRECHECKS,
  MAX_SECRET_PROBES,
  captureAxFrames,
  collectSnapshotCandidates,
  formatAxSnapshot,
  visibilityKey,
} from "../electron-app/browser/ax-snapshot.mjs";

type NodeOpts = {
  backend?: number;
  name?: string;
  value?: string;
  children?: number[];
  parent?: number;
  ignored?: boolean;
  props?: Array<{ name: string; value: unknown }>;
};

/** 造一个 CDP AX 节点（形状对齐 Accessibility.getFullAXTree 的 nodes[]） */
const ax = (nodeId: number, role: string, o: NodeOpts = {}) => ({
  nodeId: String(nodeId),
  ...(o.parent !== undefined ? { parentId: String(o.parent) } : {}),
  ...(o.children ? { childIds: o.children.map(String) } : {}),
  ...(o.backend !== undefined ? { backendDOMNodeId: o.backend } : {}),
  ...(o.ignored ? { ignored: true } : {}),
  role: { value: role },
  name: { value: o.name ?? "" },
  ...(o.value !== undefined ? { value: { value: o.value } } : {}),
  ...(o.props ? { properties: o.props.map((p) => ({ name: p.name, value: { value: p.value } })) } : {}),
});

/** formatAxSnapshot 入参里的一帧（类型取自被测函数签名，避免测试侧另抄一份形状） */
type AxFrame = Parameters<typeof formatAxSnapshot>[0]["frames"][number];

const frame = (nodes: ReturnType<typeof ax>[], over: Partial<AxFrame> = {}): AxFrame => ({
  key: "main:F1",
  sessionId: null,
  chain: [],
  nodes,
  ...over,
});

/** 一个最普通的页面：标题 + 按钮 + 链接 + 输入框 */
const simplePage = () =>
  frame([
    ax(1, "RootWebArea", { name: "示例", children: [2, 3, 4, 5] }),
    ax(2, "heading", { backend: 102, name: "欢迎", parent: 1, props: [{ name: "level", value: 1 }] }),
    ax(3, "button", { backend: 103, name: "登录", parent: 1, children: [6] }),
    ax(6, "StaticText", { backend: 106, name: "登录", parent: 3 }),
    ax(4, "link", { backend: 104, name: "帮助", parent: 1 }),
    ax(5, "textbox", { backend: 105, name: "手机号", parent: 1, value: "138" }),
  ]);

describe("formatAxSnapshot：基本输出与 ref 编号", () => {
  it("可交互元素出行并带 ref，heading 带 level，textbox 带当前值；按钮内同名 StaticText 被折叠", () => {
    const r = formatAxSnapshot({ frames: [simplePage()] });
    expect(r.text).toContain('- heading "欢迎" [level=1] [ref=e1]');
    expect(r.text).toContain('- button "登录" [ref=e2]');
    expect(r.text).toContain('- link "帮助" [ref=e3]');
    expect(r.text).toContain('- textbox "手机号" [ref=e4]: "138"');
    // 折叠：全文只出现一次「登录」（按钮行），不再有重复的 text 行
    expect(r.text.match(/登录/g)).toHaveLength(1);
    expect(r.refCount).toBe(4);
    expect(r.truncated).toBe(false);
    expect(r.nextRef).toBe(5);
    expect(r.refs.get("e2")).toMatchObject({ role: "button", name: "登录", backendNodeId: 103, sessionId: null, frameKey: "main:F1" });
  });

  it("refStart 决定起始编号，编号单调递增且 nextRef 接得上（跨 snapshot 不复用）", () => {
    const r = formatAxSnapshot({ frames: [simplePage()], refStart: 41 });
    expect([...r.refs.keys()]).toEqual(["e41", "e42", "e43", "e44"]);
    expect(r.nextRef).toBe(45);
  });

  it("没有 backendNodeId 的元素不给 ref、也不占编号", () => {
    const f = frame([
      ax(1, "RootWebArea", { children: [2, 3] }),
      ax(2, "button", { name: "无后端节点", parent: 1 }),
      ax(3, "button", { backend: 30, name: "有后端节点", parent: 1 }),
    ]);
    const r = formatAxSnapshot({ frames: [f] });
    expect(r.text).toContain('- button "无后端节点"');
    expect(r.text).toContain('- button "有后端节点" [ref=e1]');
    expect(r.refCount).toBe(1);
  });

  it("空 frames / 空树返回空文本且 nextRef 不动", () => {
    expect(formatAxSnapshot({ frames: [] })).toEqual({ text: "", refs: new Map(), refCount: 0, truncated: false, nextRef: 1 });
    expect(formatAxSnapshot({ frames: [], refStart: 9 }).nextRef).toBe(9);
  });

  it("disabled / checked / selected 等属性以 [..] 标注", () => {
    const f = frame([
      ax(1, "RootWebArea", { children: [2, 3] }),
      ax(2, "checkbox", { backend: 20, name: "同意", parent: 1, props: [{ name: "checked", value: "true" }] }),
      ax(3, "button", { backend: 21, name: "提交", parent: 1, props: [{ name: "disabled", value: true }] }),
    ]);
    const r = formatAxSnapshot({ frames: [f] });
    expect(r.text).toContain('[checked]');
    expect(r.text).toContain('[disabled]');
  });

  it("密码类 textbox 的圆点值只显示「[已隐藏]」（兜底：没有探测信息时按全圆点判）", () => {
    const f = frame([
      ax(1, "RootWebArea", { children: [2] }),
      ax(2, "textbox", { backend: 20, name: "密码", parent: 1, value: "••••••" }),
    ]);
    const text = formatAxSnapshot({ frames: [f] }).text;
    expect(text).toContain('"[已隐藏]"');
    expect(text).not.toContain("•");
  });

  it("R1-25：frame.secretNodes 命中的节点（OTP / 卡号 / text-security 字段的明文值）只给「[已隐藏]」，没命中的照常显示", () => {
    const f = frame(
      [
        ax(1, "RootWebArea", { children: [2, 3] }),
        ax(2, "textbox", { backend: 20, name: "验证码", parent: 1, value: "123456" }),
        ax(3, "textbox", { backend: 21, name: "备注", parent: 1, value: "hello" }),
      ],
      { secretNodes: new Set([20]) } as Partial<AxFrame>,
    );
    const text = formatAxSnapshot({ frames: [f] }).text;
    expect(text).toContain('- textbox "验证码" [ref=e1]: "[已隐藏]"');
    expect(text).not.toContain("123456");
    expect(text).toContain('- textbox "备注" [ref=e2]: "hello"');
  });
});

describe("formatAxSnapshot：角色过滤与结构", () => {
  it("separator / InlineTextBox / listMarker 子树丢弃；none 与 ignored 当透明容器穿透", () => {
    const f = frame([
      ax(1, "RootWebArea", { children: [2, 3, 4, 5] }),
      ax(2, "separator", { backend: 20, parent: 1, children: [7] }),
      ax(7, "StaticText", { backend: 70, name: "不该出现甲", parent: 2 }),
      ax(3, "none", { parent: 1, children: [8] }),
      ax(8, "StaticText", { backend: 80, name: "透明容器里的字", parent: 3 }),
      ax(4, "generic", { parent: 1, ignored: true, children: [9] }),
      ax(9, "StaticText", { backend: 90, name: "ignored 里的字", parent: 4 }),
      ax(5, "paragraph", { parent: 1, children: [10] }),
      ax(10, "InlineTextBox", { backend: 100, name: "不该出现乙", parent: 5 }),
    ]);
    const r = formatAxSnapshot({ frames: [f] });
    expect(r.text).toContain("透明容器里的字");
    expect(r.text).toContain("ignored 里的字");
    expect(r.text).not.toContain("不该出现");
  });

  it("结构容器：有内容才保留成行，空容器整棵剪掉", () => {
    const f = frame([
      ax(1, "RootWebArea", { children: [2, 3] }),
      ax(2, "navigation", { name: "主导航", parent: 1, children: [4] }),
      ax(4, "link", { backend: 40, name: "首页", parent: 2 }),
      ax(3, "banner", { parent: 1, children: [] }),
    ]);
    const r = formatAxSnapshot({ frames: [f] });
    expect(r.text).toContain('- navigation "主导航":');
    expect(r.text).toContain('  - link "首页" [ref=e1]');
    expect(r.text).not.toContain("banner");
  });

  it("纯标点 / 无文字的 StaticText 被清掉；img 无名不输出", () => {
    const f = frame([
      ax(1, "RootWebArea", { children: [2, 3, 4] }),
      ax(2, "StaticText", { backend: 20, name: "···---", parent: 1 }),
      ax(3, "img", { backend: 21, name: "", parent: 1 }),
      ax(4, "img", { backend: 22, name: "公司 logo", parent: 1 }),
    ]);
    const r = formatAxSnapshot({ frames: [f] });
    expect(r.text).not.toContain("---");
    expect(r.text).toContain('- img "公司 logo"');
    expect(r.text.match(/img/g)).toHaveLength(1);
  });

  it("原生 select：combobox 带 ref，option 只读列在下面、selected 有标记", () => {
    const f = frame([
      ax(1, "RootWebArea", { children: [2] }),
      ax(2, "combobox", { backend: 20, name: "城市", parent: 1, children: [3] }),
      ax(3, "menulistpopup", { parent: 2, children: [4, 5] }),
      ax(4, "option", { backend: 40, name: "北京", parent: 3, props: [{ name: "selected", value: true }] }),
      ax(5, "option", { backend: 41, name: "上海", parent: 3 }),
    ]);
    const r = formatAxSnapshot({ frames: [f] });
    expect(r.text).toContain('- combobox "城市" [ref=e1]:');
    expect(r.text).toContain('- option "北京" [selected]');
    expect(r.text).toContain('- option "上海"');
    expect(r.refCount).toBe(1); // option 不给 ref
  });

  it("文本里的引号 / 换行 / 标签字符不破坏行结构（名字走 JSON 转义、空白被压平）", () => {
    const f = frame([
      ax(1, "RootWebArea", { children: [2, 3] }),
      ax(2, "button", { backend: 20, name: '点"我"\n提交\t订单', parent: 1 }),
      ax(3, "paragraph", { parent: 1, children: [4] }),
      ax(4, "StaticText", { backend: 40, name: '第一行\n第二行 <script> "引号"', parent: 3 }),
    ]);
    const r = formatAxSnapshot({ frames: [f] });
    const lines = r.text.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('点\\"我\\" 提交 订单');
    expect(lines[1]).toBe('- text: 第一行 第二行 <script> "引号"');
  });
});

describe("formatAxSnapshot：截断", () => {
  it("maxElements 用尽即截断：truncated=true、ref 只登记已输出的、带截断提示行", () => {
    const r = formatAxSnapshot({ frames: [simplePage()], maxElements: 2 });
    expect(r.truncated).toBe(true);
    expect(r.refCount).toBe(2);
    expect([...r.refs.keys()]).toEqual(["e1", "e2"]);
    expect(r.text).toContain("内容已截断");
    expect(r.text).not.toContain("[ref=e3]");
  });

  it("maxChars 用尽即截断且总长不超过上限", () => {
    const many = frame([
      ax(1, "RootWebArea", { children: Array.from({ length: 50 }, (_, i) => i + 2) }),
      ...Array.from({ length: 50 }, (_, i) => ax(i + 2, "button", { backend: 100 + i, name: `按钮编号${i}很长很长`, parent: 1 })),
    ]);
    const r = formatAxSnapshot({ frames: [many], maxChars: 300, maxElements: 100 });
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(300);
    expect(r.text).toContain("内容已截断");
    // 表里有的 ref 文本里必须有（先输出再登记）
    for (const ref of r.refs.keys()) expect(r.text).toContain(`[ref=${ref}]`);
  });
});

describe("formatAxSnapshot：visible 视口过滤", () => {
  it("只保留可见集合内的 ref / 文本；不可见 ref 的行丢弃", () => {
    const f = frame([
      ax(1, "RootWebArea", { children: [2, 3, 4] }),
      ax(2, "button", { backend: 20, name: "可见按钮", parent: 1 }),
      ax(3, "link", { backend: 21, name: "视口外链接", parent: 1 }),
      ax(4, "paragraph", { parent: 1, children: [5] }),
      ax(5, "StaticText", { backend: 22, name: "可见文字", parent: 4 }),
    ]);
    const visible = new Set([visibilityKey(null, 20), visibilityKey(null, 22)]);
    const r = formatAxSnapshot({ frames: [f], visible });
    expect(r.text).toContain("可见按钮");
    expect(r.text).toContain("可见文字");
    expect(r.text).not.toContain("视口外链接");
    expect(r.refCount).toBe(1);
  });

  it("visibilityKey 带会话区分同一 backendNodeId", () => {
    expect(visibilityKey(null, 12)).toBe(":12");
    expect(visibilityKey("s1", 12)).toBe("s1:12");
    expect(visibilityKey(undefined as never, 3)).toBe(":3");
  });
});

describe("formatAxSnapshot：iframe 子树拼接", () => {
  it("子 frame 内容嵌在对应 iframe 行下，ref 跨 frame 继续编号、refs 记对 sessionId 与 chain", () => {
    const main = frame([
      ax(1, "RootWebArea", { children: [2, 3] }),
      ax(2, "button", { backend: 20, name: "主页按钮", parent: 1 }),
      ax(3, "iframe", { backend: 999, name: "子框架", parent: 1 }),
    ]);
    const child = frame([ax(1, "RootWebArea", { children: [2] }), ax(2, "button", { backend: 77, name: "内嵌按钮", parent: 1 })], {
      key: "s-child:F9",
      sessionId: "s-child",
      chain: [{ sessionId: null, backendNodeId: 999 }],
      ownerSessionId: null,
      ownerBackendNodeId: 999,
    });
    const r = formatAxSnapshot({ frames: [main, child] });
    expect(r.text).toContain('- button "主页按钮" [ref=e1]');
    expect(r.text).toContain('- iframe "子框架":');
    expect(r.text).toContain('  - button "内嵌按钮" [ref=e2]');
    expect(r.refs.get("e2")).toMatchObject({ backendNodeId: 77, sessionId: "s-child", chain: [{ sessionId: null, backendNodeId: 999 }] });
  });

  it("无名且无内容的 iframe 整棵省略", () => {
    const main = frame([ax(1, "RootWebArea", { children: [2] }), ax(2, "iframe", { backend: 999, parent: 1 })]);
    expect(formatAxSnapshot({ frames: [main] }).text).toBe("");
  });
});

describe("collectSnapshotCandidates", () => {
  it("枚举会被输出的节点（ref 类 + 文本 + img），去重且含 iframe 内的", () => {
    const cands = collectSnapshotCandidates({ frames: [simplePage()] });
    const keys = cands.map((c) => visibilityKey(c.sessionId, c.backendNodeId));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain(":103"); // 登录按钮
    expect(keys).toContain(":104"); // 链接
    expect(collectSnapshotCandidates({ frames: [] })).toEqual([]);
  });
});

describe("formatAxSnapshot：性能", () => {
  it("数千节点的大树在 1 秒内完成", () => {
    const N = 3000;
    const f = frame([
      ax(1, "RootWebArea", { children: Array.from({ length: N }, (_, i) => i + 2) }),
      ...Array.from({ length: N }, (_, i) => ax(i + 2, "button", { backend: 1000 + i, name: `按钮${i}`, parent: 1 })),
    ]);
    const t0 = performance.now();
    const r = formatAxSnapshot({ frames: [f], maxChars: 5_000_000, maxElements: N + 10 });
    const cost = performance.now() - t0;
    expect(r.refCount).toBe(N);
    expect(cost).toBeLessThan(1000);
  });
});

describe("captureAxFrames：假 send 驱动", () => {
  const treeNodes = (label: string) => [
    ax(1, "RootWebArea", { children: [2] }),
    ax(2, "button", { backend: 20, name: label, parent: 1 }),
  ];

  it("同会话子 frame：按 frameId 分别取树，并用 DOM.getFrameOwner 记所有者", async () => {
    const calls: Array<[string, Record<string, unknown>, string | null]> = [];
    const send = async (method: string, params: Record<string, unknown> = {}, sessionId: string | null = null) => {
      calls.push([method, params, sessionId]);
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { id: "F1" }, childFrames: [{ frame: { id: "F2" }, childFrames: [] }] } };
      if (method === "Accessibility.getFullAXTree") return { nodes: treeNodes(params.frameId === "F2" ? "子" : "主") };
      if (method === "DOM.getFrameOwner") return { backendNodeId: 999 };
      return {};
    };
    const frames = await captureAxFrames({ send: send as never, childSessions: [] });
    expect(frames).toHaveLength(2);
    expect(frames[0].ownerBackendNodeId).toBeUndefined(); // 主 frame 排第一且无 owner
    expect(frames[1]).toMatchObject({ ownerBackendNodeId: 999, ownerSessionId: null, key: "main:F2" });
    expect(formatAxSnapshot({ frames }).text).toContain("主");
  });

  it("跨站 OOPIF 子会话：单独取树、chain 记所有者一跳、owner 指向父会话的 iframe 节点", async () => {
    const send = async (method: string, params: Record<string, unknown> = {}, sessionId: string | null = null) => {
      void params; // 本用例只按 method / sessionId 分流
      if (method === "Page.getFrameTree")
        return sessionId === "oo1" ? { frameTree: { frame: { id: "T9" }, childFrames: [] } } : { frameTree: { frame: { id: "F1" }, childFrames: [] } };
      if (method === "Accessibility.getFullAXTree") return { nodes: treeNodes(sessionId === "oo1" ? "跨站" : "主") };
      if (method === "DOM.getFrameOwner") return { backendNodeId: 888 };
      return {};
    };
    const frames = await captureAxFrames({
      send: send as never,
      childSessions: [{ sessionId: "oo1", targetId: "T9", parentSessionId: null }],
    });
    expect(frames).toHaveLength(2);
    expect(frames[1]).toMatchObject({
      sessionId: "oo1",
      ownerSessionId: null,
      ownerBackendNodeId: 888,
      chain: [{ sessionId: null, backendNodeId: 888 }],
    });
  });

  it("会话已消失（Target closed 类错误）静默返回空；其他错误向上抛", async () => {
    const gone = async () => {
      throw new Error("Target closed");
    };
    await expect(captureAxFrames({ send: gone as never, childSessions: [] })).resolves.toEqual([]);
    const boom = async () => {
      throw new Error("协议炸了");
    };
    await expect(captureAxFrames({ send: boom as never, childSessions: [] })).rejects.toThrow("协议炸了");
  });
});

describe("captureAxFrames：敏感字段探测与节点上限（R1-25 / R1-29）", () => {
  const withValues = () => [
    ax(1, "RootWebArea", { children: [2, 3, 4] }),
    ax(2, "textbox", { backend: 20, name: "验证码", parent: 1, value: "123456" }),
    ax(3, "textbox", { backend: 21, name: "备注", parent: 1, value: "hello" }),
    ax(4, "textbox", { backend: 22, name: "空框", parent: 1 }), // 没有值：不需要探测
  ];

  const makeSend = (secretByBackend: Record<number, unknown>, nodes: ReturnType<typeof ax>[]) => {
    const calls: string[] = [];
    const objToBackend = new Map<string, number>();
    const send = async (method: string, params: Record<string, unknown> = {}) => {
      calls.push(method);
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "F1" }, childFrames: [] } };
      if (method === "Accessibility.getFullAXTree") return { nodes };
      if (method === "DOM.resolveNode") {
        const id = `obj-${params.backendNodeId}`;
        objToBackend.set(id, params.backendNodeId as number);
        return { object: { objectId: id } };
      }
      if (method === "Runtime.callFunctionOn") {
        const backend = objToBackend.get(params.objectId as string) as number;
        // 探针源码必须带统一判定函数（页内与主进程同源）
        expect(String(params.functionDeclaration)).toContain("isSecretInfo");
        if (!(backend in secretByBackend)) throw new Error("探针失败");
        return { result: { value: secretByBackend[backend] } };
      }
      return {};
    };
    return { send, calls };
  };

  it("只探测「带非空值的输入类节点」；命中的进 frame.secretNodes，快照里只给 [已隐藏]", async () => {
    const { send, calls } = makeSend({ 20: true, 21: false }, withValues());
    const frames = await captureAxFrames({ send: send as never, childSessions: [] });
    expect(calls.filter((c) => c === "DOM.resolveNode")).toHaveLength(2); // 空框不探
    expect([...(frames[0] as { secretNodes: Set<number> }).secretNodes]).toEqual([20]);
    const text = formatAxSnapshot({ frames }).text;
    expect(text).toContain('"验证码" [ref=e1]: "[已隐藏]"');
    expect(text).not.toContain("123456");
    expect(text).toContain('"hello"');
  });

  it("探测失败 / 节点解析不了一律 fail closed（按敏感处理），不会因为探不到就把值露出来", async () => {
    const { send } = makeSend({}, withValues()); // callFunctionOn 全部抛错
    const frames = await captureAxFrames({ send: send as never, childSessions: [] });
    const text = formatAxSnapshot({ frames }).text;
    expect(text).not.toContain("123456");
    expect(text).not.toContain("hello");
    expect(text.match(/\[已隐藏\]/g)).toHaveLength(2);
  });

  it("R10 X01：探针「没抛错但没给出明确的 false」也 fail closed——没有 objectId / 页内异常 / 返回值不是布尔，都按敏感；只有明确的 false 才露值", async () => {
    // 上面那条只覆盖了「callFunctionOn 抛错」（走 catch）。放开写入侧之后读取侧遮罩是唯一防线，
    // 这三种「不抛错、但没答案」的路径全靠 `let secret = true` 这个初值兜底，单独钉住。
    const nodes = [
      ax(1, "RootWebArea", { children: [2, 3, 4, 5, 6, 7] }),
      ax(2, "textbox", { backend: 30, name: "无objectId", parent: 1, value: "V-NO-OBJECT" }),
      ax(3, "textbox", { backend: 31, name: "页内异常", parent: 1, value: "V-EXCEPTION" }),
      ax(4, "textbox", { backend: 32, name: "字符串false", parent: 1, value: "V-STRING" }),
      ax(5, "textbox", { backend: 33, name: "数字0", parent: 1, value: "V-ZERO" }),
      ax(6, "textbox", { backend: 34, name: "缺value", parent: 1, value: "V-MISSING" }),
      ax(7, "textbox", { backend: 35, name: "明确非敏感", parent: 1, value: "V-PLAIN" }),
    ];
    const objToBackend = new Map<string, number>();
    const send = async (method: string, params: Record<string, unknown> = {}) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "F1" }, childFrames: [] } };
      if (method === "Accessibility.getFullAXTree") return { nodes };
      if (method === "DOM.resolveNode") {
        const backend = params.backendNodeId as number;
        if (backend === 30) return {}; // 节点解析不出对象
        const id = `obj-${backend}`;
        objToBackend.set(id, backend);
        return { object: { objectId: id } };
      }
      if (method === "Runtime.callFunctionOn") {
        const backend = objToBackend.get(params.objectId as string);
        // 异常时即使带着一个 false 的 value 也不能信
        if (backend === 31) return { exceptionDetails: { text: "boom" }, result: { value: false } };
        if (backend === 32) return { result: { value: "false" } };
        if (backend === 33) return { result: { value: 0 } };
        if (backend === 34) return { result: {} };
        return { result: { value: false } }; // 35：探针明确说「不是敏感字段」
      }
      return {};
    };
    const frames = await captureAxFrames({ send: send as never, childSessions: [] });
    expect([...(frames[0] as { secretNodes: Set<number> }).secretNodes].sort()).toEqual([30, 31, 32, 33, 34]);
    const text = formatAxSnapshot({ frames }).text;
    for (const leaked of ["V-NO-OBJECT", "V-EXCEPTION", "V-STRING", "V-ZERO", "V-MISSING"]) {
      expect(text, leaked).not.toContain(leaked);
    }
    expect(text.match(/\[已隐藏\]/g)).toHaveLength(5);
    expect(text).toContain('"V-PLAIN"'); // 对照：明确的 false 才露值，不是「一律遮」
  });

  it("探测数量封顶（MAX_SECRET_PROBES）：超出的部分直接按敏感处理，不再发 CDP", async () => {
    const N = MAX_SECRET_PROBES + 10;
    const nodes = [
      ax(1, "RootWebArea", { children: Array.from({ length: N }, (_, i) => i + 2) }),
      ...Array.from({ length: N }, (_, i) => ax(i + 2, "textbox", { backend: 1000 + i, name: `f${i}`, parent: 1, value: `v${i}` })),
    ];
    const secretByBackend: Record<number, boolean> = {};
    for (let i = 0; i < N; i++) secretByBackend[1000 + i] = false;
    const { send, calls } = makeSend(secretByBackend, nodes);
    const frames = await captureAxFrames({ send: send as never, childSessions: [] });
    expect(calls.filter((c) => c === "DOM.resolveNode")).toHaveLength(MAX_SECRET_PROBES);
    const secret = (frames[0] as { secretNodes: Set<number> }).secretNodes;
    expect(secret.size).toBe(10); // 探测过的都是非敏感；超出的 10 个 fail closed
    expect(secret.has(1000 + N - 1)).toBe(true);
    expect(secret.has(1000)).toBe(false);
  });

  it("R1-29：getFullAXTree 节点数超上限 → 丢尾部、frame 标 nodesTruncated，快照文本里明确注明", async () => {
    const N = 50;
    const nodes = [
      ax(1, "RootWebArea", { children: Array.from({ length: N }, (_, i) => i + 2) }),
      ...Array.from({ length: N }, (_, i) => ax(i + 2, "button", { backend: 100 + i, name: `按钮${i}`, parent: 1 })),
    ];
    const { send } = makeSend({}, nodes);
    const frames = await captureAxFrames({ send: send as never, childSessions: [], maxNodesPerTree: 11 });
    expect((frames[0] as { nodesTruncated?: boolean }).nodesTruncated).toBe(true);
    expect(frames[0].nodes).toHaveLength(11);
    const r = formatAxSnapshot({ frames });
    expect(r.truncated).toBe(true);
    expect(r.text).toContain(AX_TRUNCATE_NOTE);
    expect(r.refCount).toBe(10);
    // 没超限时不加提示
    const ok = await captureAxFrames({ send: send as never, childSessions: [] });
    expect((ok[0] as { nodesTruncated?: boolean }).nodesTruncated).toBeUndefined();
    expect(formatAxSnapshot({ frames: ok }).text).not.toContain(AX_TRUNCATE_NOTE);
  });
});

// ───────────────────────── R2-12：secret 探测的预算按风险分配，超限要注明 ─────────────────────────

describe("R2-12 captureAxFrames：探测预算（预检免探 / 风险优先 / 超限注明）", () => {
  type Described = { nodeName: string; attributes?: string[] } | undefined;
  type SendOpts = {
    /** 完整探测的结果（backendNodeId → 是否敏感），缺省当非敏感 */
    secretByBackend?: Record<number, boolean>;
    /** DOM.describeNode 的 node（backendNodeId → node）；undefined 表示返回 {}（不支持 / 没信息） */
    describe?: (backend: number) => Described;
    describeThrows?: boolean;
  };
  const makeSend = (nodes: ReturnType<typeof ax>[], opts: SendOpts = {}) => {
    const calls: Array<{ method: string; backend?: number }> = [];
    const objToBackend = new Map<string, number>();
    const send = async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, backend: params.backendNodeId as number | undefined });
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "F1" }, childFrames: [] } };
      if (method === "Accessibility.getFullAXTree") return { nodes };
      if (method === "DOM.describeNode") {
        if (opts.describeThrows) throw new Error("DOM.describeNode 不支持");
        const node = opts.describe?.(params.backendNodeId as number);
        return node ? { node } : {};
      }
      if (method === "DOM.resolveNode") {
        const id = `obj-${params.backendNodeId}`;
        objToBackend.set(id, params.backendNodeId as number);
        return { object: { objectId: id } };
      }
      if (method === "Runtime.callFunctionOn") {
        const backend = objToBackend.get(params.objectId as string) as number;
        return { result: { value: opts.secretByBackend?.[backend] === true } };
      }
      return {};
    };
    return { send, calls, probed: () => calls.filter((c) => c.method === "DOM.resolveNode").map((c) => c.backend as number) };
  };
  const tree = (specs: Array<{ role: string; backend: number; name: string; value: string }>) => [
    ax(1, "RootWebArea", { children: specs.map((_, i) => i + 2) }),
    ...specs.map((s, i) => ax(i + 2, s.role, { backend: s.backend, name: s.name, parent: 1, value: s.value })),
  ];
  const BIG = { maxChars: 2_000_000, maxElements: 5000 };
  const SELECT: Described = { nodeName: "SELECT", attributes: ["id", "x"] };
  const noteOf = (text: string) => text.split("\n").find((l) => l.includes("值已隐藏")) ?? "";

  it("① ④ 超过上限数量的带值 select（预检确认底层是 <select>）：靠后的值照常可见，一个都不走完整探测、不占预算、没有说明行", async () => {
    const N = MAX_SECRET_PROBES + 100;
    const specs = [
      ...Array.from({ length: N }, (_, i) => ({ role: "combobox", backend: 1000 + i, name: `下拉${i}`, value: `选项值${i}` })),
      { role: "textbox", backend: 90000, name: "备注", value: "普通备注" },
    ];
    const { send, probed } = makeSend(tree(specs), { describe: (b) => (b >= 1000 && b < 1000 + N ? SELECT : undefined) });
    const frames = await captureAxFrames({ send: send as never, childSessions: [] });
    const r = formatAxSnapshot({ frames, ...BIG });
    expect(r.text).toContain(`"下拉${N - 1}" [ref=e${N}]: "选项值${N - 1}"`); // 最靠后的一个
    expect(r.text).toContain('"备注"');
    expect(r.text).toContain('"普通备注"');
    expect(r.text).not.toContain("[已隐藏]");
    expect(r.text).not.toContain("值已隐藏");
    expect(probed()).toEqual([90000]); // 只有文本框走了完整探测
    expect((frames[0] as { secretUnchecked?: number }).secretUnchecked).toBeUndefined();
  });

  it("① 上限抬高（R2-12：150 → 约 400）：300 个带值文本框（都必须完整探测）一个都不被「超限」整体藏掉，没有说明行", async () => {
    expect(MAX_SECRET_PROBES).toBeGreaterThanOrEqual(400);
    const N = 300;
    const specs = Array.from({ length: N }, (_, i) => ({ role: "textbox", backend: 1000 + i, name: `字段${i}`, value: `内容${i}` }));
    const { send, probed } = makeSend(tree(specs));
    const frames = await captureAxFrames({ send: send as never, childSessions: [] });
    const r = formatAxSnapshot({ frames, ...BIG });
    expect(probed()).toHaveLength(N);
    expect(r.text).toContain(`"内容${N - 1}"`);
    expect(r.text).not.toContain("[已隐藏]");
    expect(r.text).not.toContain("值已隐藏");
  });

  it("④ 免探只认「底层是 <select> / <input type=range>」：role 被改成 combobox 的 password input、<input type=number>、自定义 div 都照常完整探测，敏感的照样藏", async () => {
    const specs = [
      { role: "combobox", backend: 1, name: "伪装的密码框", value: "hunter2" },
      { role: "combobox", backend: 2, name: "城市", value: "北京" },
      { role: "spinbutton", backend: 3, name: "卡号", value: "4111111111111111" },
      { role: "slider", backend: 4, name: "音量", value: "70" },
      { role: "combobox", backend: 5, name: "自定义下拉", value: "自定义值" },
      { role: "slider", backend: 6, name: "大写 RANGE", value: "30" },
    ];
    const described: Record<number, Described> = {
      1: { nodeName: "INPUT", attributes: ["type", "password", "role", "combobox"] },
      2: SELECT,
      3: { nodeName: "INPUT", attributes: ["class", "pin", "type", "number"] },
      4: { nodeName: "INPUT", attributes: ["type", "range"] },
      5: { nodeName: "DIV", attributes: ["role", "combobox"] },
      6: { nodeName: "INPUT", attributes: ["type", " RANGE "] },
    };
    const { send, probed } = makeSend(tree(specs), { describe: (b) => described[b], secretByBackend: { 1: true, 3: true } });
    const frames = await captureAxFrames({ send: send as never, childSessions: [] });
    const text = formatAxSnapshot({ frames }).text;
    expect([...probed()].sort((a, b) => a - b)).toEqual([1, 3, 5]);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("4111111111111111");
    expect(text).toContain('"伪装的密码框" [ref=e1]: "[已隐藏]"');
    expect(text).toContain('"北京"');
    expect(text).toContain('"70"');
    expect(text).toContain('"30"');
    expect(text).toContain('"自定义值"');
  });

  it("④ 预检失败（DOM.describeNode 抛错 / 返回空）→ 不影响正确性：全部退回完整探测，探测说敏感的照样藏", async () => {
    const specs = Array.from({ length: 5 }, (_, i) => ({ role: "combobox", backend: 10 + i, name: `下拉${i}`, value: `值${i}` }));
    for (const opts of [{ describeThrows: true }, {}] as SendOpts[]) {
      const { send, probed } = makeSend(tree(specs), { ...opts, secretByBackend: { 12: true } });
      const frames = await captureAxFrames({ send: send as never, childSessions: [] });
      const text = formatAxSnapshot({ frames }).text;
      expect(probed()).toEqual([10, 11, 12, 13, 14]);
      expect(text).toContain('"值0"');
      expect(text).toContain('"值4"');
      expect(text).not.toContain("值2");
    }
  });

  it("② 完整探测按风险排序：文档靠后的 textbox 排在前面的 combobox 之前；预算被占满时被挤掉的是 combobox，且值隐藏 + 注明个数", async () => {
    const C = MAX_SECRET_PROBES + 5;
    const specs = [
      ...Array.from({ length: C }, (_, i) => ({ role: "combobox", backend: 1000 + i, name: `自定义${i}`, value: `c${i}` })),
      ...Array.from({ length: 5 }, (_, i) => ({ role: "textbox", backend: 50000 + i, name: `文本${i}`, value: `t${i}` })),
    ];
    // 预检不可用（describe 抛错）→ 全部 combobox 都得完整探测，才能看出排序的作用
    const { send, probed } = makeSend(tree(specs), { describeThrows: true });
    const frames = await captureAxFrames({ send: send as never, childSessions: [] });
    const text = formatAxSnapshot({ frames, ...BIG }).text;
    const p = probed();
    expect(p).toHaveLength(MAX_SECRET_PROBES);
    for (let i = 0; i < 5; i++) expect(p).toContain(50000 + i); // 文档最靠后的 5 个文本框都探了
    for (let i = 0; i < 5; i++) expect(text).toContain(`"t${i}"`); // 非敏感 → 值可见（没被预算挤掉）
    // 挤掉的是排在最后的 10 个 combobox（C - (MAX - 5)）
    const probedCombos = MAX_SECRET_PROBES - 5;
    expect(text).toContain(`"c${probedCombos - 1}"`);
    expect(text).not.toContain(`"c${probedCombos}"`);
    expect(text).not.toContain(`"c${C - 1}"`);
    expect(text).toContain(`"自定义${C - 1}" [ref=e${C}]: "[已隐藏]"`);
    expect((frames[0] as { secretUnchecked?: number }).secretUnchecked).toBe(10);
    expect(noteOf(text)).toContain("另有 10 个");
  });

  it("② 预检发现底层是 input / textarea 的 combobox（role 被改写）升到文本框同级：文档再靠后也先探", async () => {
    const C = MAX_SECRET_PROBES + 5;
    const specs = Array.from({ length: C }, (_, i) => ({ role: "combobox", backend: 1000 + i, name: `框${i}`, value: `v${i}` }));
    const lateInputs = new Set(Array.from({ length: 5 }, (_, i) => 1000 + C - 1 - i));
    const { send, probed } = makeSend(tree(specs), {
      describe: (b) => (lateInputs.has(b) ? { nodeName: "INPUT", attributes: ["type", "text"] } : { nodeName: "DIV" }),
    });
    const frames = await captureAxFrames({ send: send as never, childSessions: [] });
    const text = formatAxSnapshot({ frames, ...BIG }).text;
    for (const b of lateInputs) expect(probed()).toContain(b);
    for (const b of lateInputs) expect(text).toContain(`"v${b - 1000}"`); // 探过且非敏感 → 可见
    expect((frames[0] as { secretUnchecked?: number }).secretUnchecked).toBe(5);
  });

  it("③ 超限的节点仍然 fail-closed（值不出现），并在快照末尾注明个数；带 query 过滤时说明行同样在", async () => {
    const N = MAX_SECRET_PROBES + 7;
    const specs = Array.from({ length: N }, (_, i) => ({ role: "textbox", backend: 1000 + i, name: `f${i}`, value: `value-${i}` }));
    const { send, probed } = makeSend(tree(specs));
    const frames = await captureAxFrames({ send: send as never, childSessions: [] });
    expect(probed()).toHaveLength(MAX_SECRET_PROBES);
    const r = formatAxSnapshot({ frames, ...BIG });
    // 超限的最后 7 个：值被隐藏，且不是靠探测判出来的
    for (let i = N - 7; i < N; i++) expect(r.text).not.toContain(`value-${i}`);
    expect(r.text).toContain(`"value-${MAX_SECRET_PROBES - 1}"`);
    expect(noteOf(r.text)).toContain("另有 7 个");
    expect(noteOf(r.text)).toContain("不是页面没有值");
    // 说明行在最后一行，且不被当成「内容截断」
    expect(r.text.trimEnd().split("\n").pop()).toBe(noteOf(r.text));
    expect(r.truncated).toBe(false);

    const q = formatAxSnapshot({ frames, ...BIG, query: "f5" });
    expect(noteOf(q.text)).toContain("另有 7 个");
  });

  it("③ 没超限不加说明；多个 frame 的超限个数累加", () => {
    const f1 = frame(tree([{ role: "textbox", backend: 1, name: "a", value: "x" }]), { secretUnchecked: 3 });
    const f2 = frame(tree([{ role: "textbox", backend: 2, name: "b", value: "y" }]), { key: "main:F2", ownerBackendNodeId: 99, secretUnchecked: 4 } as Partial<AxFrame>);
    const none = formatAxSnapshot({ frames: [frame(tree([{ role: "textbox", backend: 1, name: "a", value: "x" }]))] });
    expect(none.text).not.toContain("值已隐藏");
    expect(noteOf(formatAxSnapshot({ frames: [f1, f2] }).text)).toContain("另有 7 个");
  });

  it("预检数量封顶（MAX_SECRET_PRECHECKS）：超出的不预检、直接排进完整探测队列", async () => {
    const N = MAX_SECRET_PRECHECKS + 3;
    const specs = Array.from({ length: N }, (_, i) => ({ role: "combobox", backend: 1000 + i, name: `s${i}`, value: `o${i}` }));
    const { send, calls, probed } = makeSend(tree(specs), { describe: () => SELECT });
    const frames = await captureAxFrames({ send: send as never, childSessions: [] });
    expect(calls.filter((c) => c.method === "DOM.describeNode")).toHaveLength(MAX_SECRET_PRECHECKS);
    expect(probed()).toEqual([1000 + MAX_SECRET_PRECHECKS, 1001 + MAX_SECRET_PRECHECKS, 1002 + MAX_SECRET_PRECHECKS]);
    const text = formatAxSnapshot({ frames, ...BIG }).text;
    expect(text).toContain(`"o${N - 1}"`);
  });
});
