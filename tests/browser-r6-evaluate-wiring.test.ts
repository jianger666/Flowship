/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-function-type -- 假 electron 对象 / 被测 .mjs 无类型声明，any 是刻意的 */
/**
 * R6-39①：evaluate 授权相关的 manager 层接线（`createBrowserManager` + 假 electron + 假 CDP）。
 *
 * 此前的缺口：这几处接线在纯逻辑 / session 层的测试里都被「绕开」了——index.mjs 里把它们删掉，原有测试全绿。
 *   ① `onConfig` 的 总闸 开→关 → 撤销各会话的「仅本任务」批准 + 清掉需审批的 mock（R6-04 / R6-31）；
 *   ② `opEvaluate` 弹审批卡**之前**的接管检查（assertEvaluateNotUserControlled，R6-04：接管期间弹卡 = 让用户替 AI 批准）；
 *   ③ `opEvaluate` 批准之后走 `runApprovedEvaluate`（执行前再查接管 / 写活动日志 / 挂进 inflight 可被接管打断 / 执行后丢弃接管期间的结果）。
 * 这里不检查源码文本，而是真的驱动 manager：三处各有至少一个「删掉就红」的行为断言（变异验证见交付报告）。
 * 与纯逻辑层互补：evaluate-approval.mjs 的授权真值表见 browser-e2-p3-evaluate-approval.test.ts，mock 撤销语义见 browser-r6-mock-revoke.test.ts。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { EVALUATE_APPROVAL_EXT } from "../electron-app/browser/evaluate-approval.mjs";
import { createBrowserManager } from "../electron-app/browser/index.mjs";

const flush = async (n = 12) => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
  await new Promise<void>((r) => setImmediate(r));
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Cmd {
  method: string;
  params: Record<string, any>;
  sessionId: string | null;
}

const makeManager = (opts: { promptTimeoutMs?: number } = {}) => {
  const sent: Cmd[] = [];
  const messageHandlers: Function[] = [];
  /** `Runtime.evaluate`（用户表达式）的闸：设了就挂起，直到 release() */
  const hold: { on: boolean; release: () => void; promise: Promise<void> | null } = { on: false, release: () => {}, promise: null };
  const sendCommand = vi.fn(async (method: string, params: Record<string, any> = {}, sessionId?: string) => {
    sent.push({ method, params, sessionId: sessionId ?? null });
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "F1" } } };
    if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: "s1" };
    if (method === "Runtime.evaluate" && typeof params.expression === "string" && params.expression.startsWith("user:")) {
      if (hold.on) await hold.promise;
      return { result: { type: "number", value: 2 } };
    }
    return {};
  });
  class FakeView {
    webContents: any;
    setBounds = vi.fn();
    setVisible = vi.fn();
    setBackgroundColor = vi.fn();
    constructor() {
      this.webContents = {
        on: vi.fn(),
        setWindowOpenHandler: vi.fn(),
        setAudioMuted: vi.fn(),
        loadURL: vi.fn(async () => {}),
        getURL: () => "about:blank",
        getTitle: () => "",
        isLoading: () => false,
        isDestroyed: () => false,
        stop: vi.fn(),
        reload: vi.fn(),
        close: vi.fn(),
        session: {},
        capturePage: vi.fn(async () => ({ isEmpty: () => true })),
        navigationHistory: { canGoBack: () => false, canGoForward: () => false, goBack: vi.fn(), goForward: vi.fn() },
        debugger: {
          isAttached: () => true,
          attach: vi.fn(),
          detach: vi.fn(),
          on: (ev: string, fn: Function) => {
            if (ev === "message") messageHandlers.push(fn);
          },
          sendCommand,
        },
      };
    }
  }
  const makeWin = () => ({
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    destroy() {
      this.destroyed = true;
    },
    on: vi.fn(),
    once: vi.fn(),
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    webContents: { send: vi.fn(), isDestroyed: () => false, getZoomFactor: () => 1 },
  });
  class FakeWindow {
    constructor() {
      return makeWin() as any;
    }
  }
  const ipcMain = { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn(), removeListener: vi.fn() };
  const ses = { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), setDevicePermissionHandler: vi.fn(), on: vi.fn() };
  const manager: any = createBrowserManager({
    app: { getPath: () => "/tmp" },
    BrowserWindow: FakeWindow,
    WebContentsView: FakeView,
    session: { fromPartition: () => ses },
    ipcMain,
    getMainWindow: () => makeWin(),
    isAppUrl: () => false,
    isTrustedIpcSender: () => true,
    log: () => {},
    startPicker: () => ({ cancel() {} }),
    ...(opts.promptTimeoutMs ? { evaluatePromptTimeoutMs: opts.promptTimeoutMs } : {}),
  } as any);
  const dispatch = (op: string, args: Record<string, unknown>, taskId = "T1") => manager.dispatch(op, args, { taskId, signal: undefined });
  /** 注入一条 CDP 事件（走 tab 真实的 debugger message 监听） */
  const emit = (method: string, params: Record<string, any>) => {
    for (const h of messageHandlers) h(null, method, params, "");
  };
  let seq = 0;
  const pause = (url: string, requestId = `req-${++seq}`) => emit("Fetch.requestPaused", { requestId, networkId: `net-${seq}`, request: { url, method: "GET", headers: { Accept: "*/*" } }, resourceType: "Fetch" });
  const cmds = (method: string) => sent.filter((c) => c.method === method);
  const session = () => manager.getSession("T1");
  const sysLog = (): string[] => (session().getState().recent as Array<{ actor: string; summary?: string }>).filter((x) => x.actor === "system").map((x) => x.summary ?? "");
  const aiLog = (): string[] => (session().getState().recent as Array<{ actor: string; summary?: string }>).filter((x) => x.actor === "ai").map((x) => x.summary ?? "");
  const userEvals = () => cmds("Runtime.evaluate").filter((c) => String(c.params.expression).startsWith("user:"));
  /** 等审批卡出现 */
  const waitCard = async () => {
    for (let i = 0; i < 200 && session().prompts.list().length === 0; i += 1) await sleep(2);
    return session().prompts.list()[0] as any;
  };
  return { manager, dispatch, emit, pause, cmds, session, sysLog, aiLog, userEvals, waitCard, hold, sent };
};
type Env = ReturnType<typeof makeManager>;

let env: Env | null = null;
afterEach(() => {
  try {
    env?.hold.release();
    env?.manager.destroy();
  } catch {
    /* 清理不抛 */
  }
  env = null;
});
const mk = (opts: { promptTimeoutMs?: number } = {}) => (env = makeManager(opts));

const HTML_MOCK = { action: "mock", pattern: "https://t.example/*", contentType: "text/html", body: "<script>fetch('/me')</script>" };
const fulfilled = (e: Env) => e.cmds("Fetch.fulfillRequest").map((c) => c.params.requestId);
const approved = (e: Env) => (e.session().getExt(EVALUATE_APPROVAL_EXT, () => ({ approved: false })) as { approved: boolean }).approved;

describe("R6-39①·① onConfig：总闸 开→关 → 撤销批准并清掉需审批的 mock", () => {
  it("总闸开着创建 html mock（免审批）→ 命中被 fulfill；总闸一关（开→关）→ 规则被清、命中不再 fulfill、list 为空、日志写「因撤销批准清除了 1 条模拟响应…总开关」", async () => {
    const e = mk();
    e.manager.onConfig({ evaluateEnabled: true });
    await e.dispatch("navigate", { url: "about:blank" });
    const added: any = await e.dispatch("net_rules", HTML_MOCK);
    expect(added.rule).toMatchObject({ action: "mock", contentType: "text/html" });
    expect(e.session().prompts.list()).toHaveLength(0); // 总闸开着：免审批
    e.pause("https://t.example/a", "a");
    await flush();
    expect(fulfilled(e)).toEqual(["a"]);

    e.manager.onConfig({ evaluateEnabled: false });
    // 同步生效：onConfig 一返回，紧接着到的请求就不会命中已摘掉的规则
    e.pause("https://t.example/b", "b");
    await flush(20);
    expect(fulfilled(e)).toEqual(["a"]);
    expect(e.cmds("Fetch.continueRequest").some((c) => c.params.requestId === "b")).toBe(true);
    const list: any = await e.dispatch("net_rules", { action: "list" });
    expect(list.count).toBe(0);
    expect(e.cmds("Fetch.disable").length).toBeGreaterThan(0);
    expect(e.sysLog().join("|")).toMatch(/因撤销批准清除了 1 条模拟响应.*总开关/);
  });

  it("「仅本任务」批准只在 开→关 时作废：false→false（任何别的设置变动带上 evaluateEnabled:false）与 false→true 都不动批准与 mock；之后 true→false 才一并撤销", async () => {
    const e = mk();
    await e.dispatch("navigate", { url: "about:blank" });
    const done = e.dispatch("net_rules", HTML_MOCK);
    const card = await e.waitCard();
    expect(card?.kind).toBe("evaluate");
    e.session().prompts.answer(card.id, { action: "task" });
    await done;
    expect(approved(e)).toBe(true);

    e.manager.onConfig({ evaluateEnabled: false, networkBodyRead: true }); // false→false：设置页每次保存都会推一遍
    expect(approved(e)).toBe(true);
    e.pause("https://t.example/1", "keep-1");
    await flush();
    expect(fulfilled(e)).toEqual(["keep-1"]);

    e.manager.onConfig({ evaluateEnabled: true }); // false→true
    expect(approved(e)).toBe(true);
    e.pause("https://t.example/2", "keep-2");
    await flush();
    expect(fulfilled(e)).toEqual(["keep-1", "keep-2"]);

    e.manager.onConfig({ evaluateEnabled: false }); // true→false：撤销
    expect(approved(e)).toBe(false);
    e.pause("https://t.example/3", "gone");
    await flush(20);
    expect(fulfilled(e)).toEqual(["keep-1", "keep-2"]);
    expect(((await e.dispatch("net_rules", { action: "list" })) as any).count).toBe(0);
  });

  it("总闸本来就是关的、会话也没有批准：onConfig({evaluateEnabled:false}) 什么都不做（不写日志、不动别的规则）", async () => {
    const e = mk();
    await e.dispatch("navigate", { url: "about:blank" });
    await e.dispatch("net_rules", { action: "mock", pattern: "https://j.example/*", contentType: "application/json", body: "{}" });
    e.manager.onConfig({ evaluateEnabled: false });
    expect(((await e.dispatch("net_rules", { action: "list" })) as any).count).toBe(1);
    expect(e.sysLog().join("|")).not.toContain("因撤销批准");
  });

  it("多会话：每个会话各自的需审批 mock 都被清（onConfig 遍历所有会话）", async () => {
    const e = mk();
    e.manager.onConfig({ evaluateEnabled: true });
    await e.dispatch("navigate", { url: "about:blank" }, "T1");
    await e.dispatch("navigate", { url: "about:blank" }, "T2");
    await e.dispatch("net_rules", HTML_MOCK, "T1");
    await e.dispatch("net_rules", { ...HTML_MOCK, pattern: "https://u.example/*" }, "T2");
    e.manager.onConfig({ evaluateEnabled: false });
    expect(((await e.dispatch("net_rules", { action: "list" }, "T1")) as any).count).toBe(0);
    expect(((await e.dispatch("net_rules", { action: "list" }, "T2")) as any).count).toBe(0);
  });
});

describe("R6-39①·② opEvaluate：弹审批卡之前的接管检查", () => {
  it("用户接管期间：evaluate 直接 USER_CONTROL，一张审批卡都不弹（弹了等于让用户替 AI 批准）", async () => {
    const e = mk({ promptTimeoutMs: 80 }); // 万一检查被删：卡片 80ms 超时 → DENIED，测试红而不是挂起
    await e.dispatch("navigate", { url: "about:blank" });
    const session = e.session();
    const request = vi.spyOn(session.prompts, "request");
    session.takeover();
    await expect(e.dispatch("evaluate", { expression: "user:1+1" })).rejects.toMatchObject({ code: "USER_CONTROL" });
    expect(request).not.toHaveBeenCalled();
    expect(session.prompts.list()).toHaveLength(0);
    expect(e.userEvals()).toHaveLength(0);
  });

  it("对照：没接管 + 总闸关 → 确实会弹 evaluate 审批卡（上一条的「没弹卡」不是因为这条路径本来就不弹）", async () => {
    const e = mk({ promptTimeoutMs: 5_000 });
    await e.dispatch("navigate", { url: "about:blank" });
    const p = e.dispatch("evaluate", { expression: "user:1+1" }).then(
      () => "OK",
      (err: any) => String(err?.code ?? err),
    );
    const card = await e.waitCard();
    expect(card?.kind).toBe("evaluate");
    e.session().prompts.answer(card.id, { action: "deny" });
    expect(await p).toBe("DENIED");
    expect(e.userEvals()).toHaveLength(0);
  });
});

describe("R6-39①·③ opEvaluate：批准之后必须走 runApprovedEvaluate", () => {
  it("总闸开着：免审批执行并返回结果，同时写一条 AI 活动日志（脱敏后的表达式开头 + 字数 + 批准方式）——绕过它时时间线上就看不见这次脚本", async () => {
    const e = mk();
    e.manager.onConfig({ evaluateEnabled: true });
    await e.dispatch("navigate", { url: "about:blank" });
    const r: any = await e.dispatch("evaluate", { expression: "user:1+1" });
    expect(r).toMatchObject({ type: "number", value: 2 });
    expect(e.userEvals()).toHaveLength(1);
    const log = e.aiLog().join("|");
    expect(log).toMatch(/执行了页面脚本（.*，共 8 字）：user:1\+1/);
  });

  it("审批通过的瞬间用户已接管：批准后再查一次 → USER_CONTROL，脚本没有执行（Runtime.evaluate 一次都没发）", async () => {
    const e = mk({ promptTimeoutMs: 5_000 });
    await e.dispatch("navigate", { url: "about:blank" });
    const p = e.dispatch("evaluate", { expression: "user:late" }).then(
      (v: unknown) => ({ ok: true as const, v }),
      (err: any) => ({ ok: false as const, code: String(err?.code ?? err) }),
    );
    const card = await e.waitCard();
    e.session().takeover(); // 用户在审批卡弹着的时候点了「接管」
    e.session().prompts.answer(card.id, { action: "task" });
    expect(await p).toEqual({ ok: false, code: "USER_CONTROL" });
    expect(e.userEvals()).toHaveLength(0);
    expect(e.aiLog().join("|")).not.toContain("执行了页面脚本");
  });

  it("脚本执行期间用户接管：执行被打断 → USER_TOOK_OVER（结果丢弃）；脚本是被挂进 inflight 才能被这样打断", async () => {
    const e = mk();
    e.manager.onConfig({ evaluateEnabled: true });
    await e.dispatch("navigate", { url: "about:blank" });
    e.hold.on = true;
    e.hold.promise = new Promise<void>((r) => (e.hold.release = r));
    const p = e.dispatch("evaluate", { expression: "user:slow" }).then(
      (v: unknown) => ({ ok: true as const, v }),
      (err: any) => ({ ok: false as const, code: String(err?.code ?? err) }),
    );
    for (let i = 0; i < 200 && e.userEvals().length === 0; i += 1) await sleep(2);
    expect(e.userEvals()).toHaveLength(1); // 脚本已发出、正在页面里跑
    e.session().takeover();
    expect(await p).toEqual({ ok: false, code: "USER_TOOK_OVER" });
    e.hold.release();
  });

  it("脚本跑完时用户恰好已接管（来不及打断）：结果丢弃，不把用户刚输入的内容返回给 AI → USER_TOOK_OVER", async () => {
    const e = mk();
    e.manager.onConfig({ evaluateEnabled: true });
    await e.dispatch("navigate", { url: "about:blank" });
    const session = e.session();
    // 让 Runtime.evaluate 返回的同时把控制权切到 user，但不触发 inflight 的 abort（直接改 controller，模拟「执行完成」与「接管」几乎同时）
    e.hold.on = true;
    e.hold.promise = new Promise<void>((r) => (e.hold.release = r));
    const p = e.dispatch("evaluate", { expression: "user:race" }).then(
      (v: unknown) => ({ ok: true as const, v }),
      (err: any) => ({ ok: false as const, code: String(err?.code ?? err) }),
    );
    for (let i = 0; i < 200 && e.userEvals().length === 0; i += 1) await sleep(2);
    session.controller = "user";
    e.hold.release();
    expect(await p).toEqual({ ok: false, code: "USER_TOOK_OVER" });
  });
});
