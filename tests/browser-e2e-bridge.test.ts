/**
 * 内置浏览器「跨进程」端到端测试（D 组）：真实 bridge.ts + tools.ts  ↔  真实 Electron 里的 BrowserManager。
 *
 * 为什么要有它：单测里 bridge / tools 对着假传输层、manager 直接调 dispatch，从没证明过两侧在**真实通道**上说同一种话。
 * 这里 vitest 进程扮演 server：经启动器（scripts/browser-e2e/run.mjs 的 runElectronScript，ipc:true 多开一路 Node ipc）
 * 起 scripts/browser-e2e/bridge-peer.cjs（Electron 主进程一侧，用真实 createBrowserManager + attachServerChannel），
 * 再用 createBrowserBridge 接上这条真实通道，经 getBrowserTools 取工具、像模型一样经 invokeFlowshipTool 调 handler。
 *
 * 运行方式（要起真实无头 Electron，常规 vitest 默认跳过）：
 *   FS_BROWSER_E2E=1 pnpm exec vitest run tests/browser-e2e-bridge.test.ts
 * 约束：只经启动器起 Electron；不碰 Flowship / FlowshipTest 桌面包与 8676 / 8776 / 8876；fixture 只监听 127.0.0.1 随机端口。
 *
 * 场景：a 握手 + config 推送 / b 基本链路（导航·快照·输入·点击·截图·console·network·多标签）/
 *       c 错误映射（REF_STALE、URL_BLOCKED）/ d AI 感知用户操作（含密码不泄漏）/ e 接管 → USER_CONTROL → 交还 /
 *       f ask_user_to_act 挂起与取消 / g 断线。各场景共享同一个 Electron 与同一个会话，按顺序执行。
 */
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  __setBrowserBridgeForTest,
  createBrowserBridge,
  type BridgeTransport,
  type BrowserBridge,
} from "@/lib/server/browser/bridge";
import { UNTRUSTED_REMINDER } from "@/lib/server/browser/content";
import { __resetBrowserSettingsForTest, toBrowserConfig } from "@/lib/server/browser/settings";
import { getBrowserTools } from "@/lib/server/browser/tools";
import { BrowserBridgeError } from "@/lib/server/browser/types";
import type { FlowshipToolDef, FlowshipToolResult } from "@/lib/server/flowship-tools";

import { runElectronScript } from "../scripts/browser-e2e/run.mjs";

const E2E = !!process.env.FS_BROWSER_E2E;
const PEER = path.resolve(import.meta.dirname, "../scripts/browser-e2e/bridge-peer.cjs");

const TASK = "e2e-task-1";
const TASK2 = "e2e-task-2";
const USER_PASSWORD = "UserSecret-123";
const USER_PASSWORD_2 = "Another-Secret-9";
const USER_NOTE = "hello note";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface PeerReady {
  kind: "peer-ready";
  fixtureUrl: string;
  fixtureBase: string;
  appUrl: string;
}
interface BrowserStateLite {
  controller: "idle" | "ai" | "user";
  askRequest: { message: string; since: number } | null;
  pendingUserActivity: number;
  tabs: Array<{ id: string; url: string; isActive: boolean }>;
}

describe.skipIf(!E2E)("内置浏览器 e2e：真实 bridge + tools ↔ 真实 Electron manager", () => {
  let handle: ReturnType<typeof runElectronScript>;
  let bridge: BrowserBridge;
  let ready: PeerReady;
  let invoke: (tool: FlowshipToolDef, args: Record<string, unknown>, ctx: { taskId: string; signal?: AbortSignal }) => Promise<FlowshipToolResult>;
  /** 全程所有工具返回的文字（最后用来断言密码从没出现过） */
  const allTexts: string[] = [];
  let peerSeq = 0;
  const peerWaiters = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  // ───────── 辅助 ─────────

  /** 发一条 peer-cmd 钩子，等它的回复 */
  const peer = <T = unknown>(cmd: string, params: Record<string, unknown> = {}, timeoutMs = 25_000): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const cmdId = ++peerSeq;
      const timer = setTimeout(() => {
        peerWaiters.delete(cmdId);
        reject(new Error(`peer-cmd ${cmd} 超时 ${timeoutMs}ms`));
      }, timeoutMs);
      peerWaiters.set(cmdId, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      handle.child.send({ v: 1, kind: "peer-cmd", cmdId, cmd, ...params });
    });

  const peerState = (taskId = TASK) => peer<BrowserStateLite | null>("state", { taskId });
  const pageEval = <T = unknown>(expression: string, taskId = TASK) => peer<T>("page-eval", { taskId, expression });

  /** 轮询直到条件成立 */
  const until = async <T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, timeoutMs = 8000, what = "条件"): Promise<T> => {
    const t0 = Date.now();
    let last: T = await fn();
    while (!ok(last)) {
      if (Date.now() - t0 > timeoutMs) throw new Error(`${what} 在 ${timeoutMs}ms 内没有成立，最后值：${JSON.stringify(last)}`);
      await sleep(100);
      last = await fn();
    }
    return last;
  };

  /** 像模型一样调一个浏览器工具（走 invokeFlowshipTool 这个唯一咽喉，ctx 带任务与取消信号） */
  const call = async (
    name: string,
    args: Record<string, unknown> = {},
    opts: { taskId?: string; signal?: AbortSignal } = {},
  ) => {
    const taskId = opts.taskId ?? TASK;
    const tool = getBrowserTools({ taskId, readOnly: false }).find((t) => t.name === name);
    if (!tool) throw new Error(`工具 ${name} 未注册（bridge 可用=${bridge.isAvailable()}）`);
    const res = await invoke(tool, args, { taskId, signal: opts.signal });
    const text = res.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    allTexts.push(text);
    return { res, text, isError: res.isError === true };
  };

  const refOf = (text: string, name: string): string => {
    for (const line of text.split("\n")) {
      if (line.includes(name)) {
        const m = /\[ref=(e\d+)\]/.exec(line);
        if (m) return m[1]!;
      }
    }
    throw new Error(`快照里找不到「${name}」的 ref：\n${text.slice(0, 1500)}`);
  };

  const snapshot = async (taskId = TASK) => {
    const r = await call("browser_snapshot", {}, { taskId });
    expect(r.isError, r.text).toBe(false);
    return r.text;
  };

  // ───────── 起 / 收 ─────────

  beforeAll(async () => {
    handle = runElectronScript({ script: PEER, timeoutSec: 240, ipc: true });
    const readyP = new Promise<PeerReady>((resolve, reject) => {
      handle.child.on("message", (m: unknown) => {
        const msg = m as Record<string, unknown> | null;
        if (!msg || typeof msg !== "object") return;
        if (msg.kind === "peer-ready") resolve(msg as unknown as PeerReady);
        if (msg.kind === "peer-reply" && typeof msg.cmdId === "number") {
          const w = peerWaiters.get(msg.cmdId);
          if (!w) return;
          peerWaiters.delete(msg.cmdId);
          if (msg.ok === true) w.resolve(msg.result);
          else w.reject(new Error(String(msg.error)));
        }
      });
      void handle.exit.then((r) => {
        reject(new Error(`bridge-peer 提前退出 code=${r.code} signal=${r.signal}\nstdout:\n${handle.stdout()}\nstderr:\n${handle.stderr()}`));
      });
    });
    ready = await Promise.race([
      readyP,
      sleep(60_000).then(() => {
        throw new Error(`等 peer-ready 超时\nstdout:\n${handle.stdout()}\nstderr:\n${handle.stderr()}`);
      }),
    ]);

    // 真实通道包成 BridgeTransport（与 bridge.ts 的 getProcessTransport 同构，只是对端是子进程）
    const child = handle.child;
    const transport: BridgeTransport = {
      send: (msg, onError) => {
        if (!child.connected) return false;
        try {
          child.send(msg as never, (err) => {
            if (err) onError?.(err);
          });
          return true;
        } catch {
          return false;
        }
      },
      onMessage: (cb) => {
        child.on("message", cb);
        return () => {
          child.off("message", cb);
        };
      },
      onDisconnect: (cb) => {
        child.on("disconnect", cb);
        return () => {
          child.off("disconnect", cb);
        };
      },
      isOpen: () => child.connected,
    };
    __resetBrowserSettingsForTest({}); // evaluate / recordInputValues 默认都关
    bridge = createBrowserBridge(transport);
    __setBrowserBridgeForTest(bridge);
    bridge.start();
    await until(() => bridge.isAvailable(), (v) => v === true, 8000, "握手");

    // 动态 import：只有真的跑 e2e 才会加载 flowship-tools 这条重链
    const mod = await import("@/lib/server/flowship-tools");
    invoke = (tool, args, ctx) => mod.invokeFlowshipTool(tool, args, undefined, ctx);
  }, 90_000);

  afterAll(async () => {
    try {
      bridge?.dispose();
    } catch {
      /* 已销毁 */
    }
    __setBrowserBridgeForTest(null);
    __resetBrowserSettingsForTest({});
    if (handle) {
      // 正常路径下 peer 已经 quit；没退的（某个用例失败提前中止）强杀，避免残留 Electron
      const raced = await Promise.race([handle.exit, sleep(300).then(() => null)]);
      if (raced === null) {
        handle.kill("SIGKILL");
        await handle.exit;
      }
    }
  }, 30_000);

  // ───────── a) 握手 + config ─────────

  it("a) 握手：hello → hello-ack 后 bridge 可用；config 推送生效后 browser_evaluate 才可用", async () => {
    expect(bridge.isAvailable()).toBe(true);
    expect(ready.fixtureUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);

    // 默认：evaluate 总闸关。E2·A7 起 browser_evaluate 常驻注册（没开时由主进程弹审批卡），其它工具都在
    let names = getBrowserTools({ taskId: TASK, readOnly: false }).map((t) => t.name);
    expect(names).toContain("browser_navigate");
    expect(names).toContain("browser_snapshot");
    expect(names).toContain("browser_ask_user_to_act");
    expect(names).toContain("browser_evaluate");
    // 无 taskId / readOnly 一律不注册
    expect(getBrowserTools({ readOnly: false })).toEqual([]);
    expect(getBrowserTools({ taskId: TASK, readOnly: true })).toEqual([]);

    // E2·A7：主进程不再因总闸关着直接 DISABLED（改为弹审批卡）；还没有会话时 evaluate 先是 NO_SESSION（真实错误码跨通道原样回来）
    expect(await peer("config")).toMatchObject({ evaluateEnabled: false });
    const noSession = await bridge.request(TASK, "evaluate", { expression: "1+1" }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(noSession).toBeInstanceOf(BrowserBridgeError);
    expect((noSession as BrowserBridgeError).code).toBe("NO_SESSION");

    // 打开设置并推送 config → 主进程收到、工具表出现 browser_evaluate
    __resetBrowserSettingsForTest({ evaluateEnabled: true });
    bridge.syncConfig(toBrowserConfig(), true);
    expect(await until(() => peer<{ evaluateEnabled: boolean }>("config"), (c) => c.evaluateEnabled === true, 4000, "主进程收到 config")).toMatchObject({
      evaluateEnabled: true,
      recordInputValues: false,
    });
    names = getBrowserTools({ taskId: TASK, readOnly: false }).map((t) => t.name);
    expect(names).toContain("browser_evaluate");
  }, 60_000);

  // ───────── b) 基本链路 ─────────

  it("b) navigate → snapshot（不可信包装 + ref）→ type / click 表单 → 页面确实收到", async () => {
    const nav = await call("browser_navigate", { url: ready.fixtureUrl });
    expect(nav.isError, nav.text).toBe(false);
    expect(nav.text).toContain("已打开网址");
    expect(nav.text).toContain("E2E Fixture");
    expect(nav.text).toContain("HTTP 200");

    const snap = await call("browser_snapshot");
    expect(snap.isError, snap.text).toBe(false);
    expect(snap.text).toContain("<untrusted_page_content");
    expect(snap.text).toContain("</untrusted_page_content>");
    expect(snap.text).toContain(UNTRUSTED_REMINDER);
    expect(snap.text).toMatch(/\[ref=e\d+\]/);
    expect(snap.text).toContain("提交");

    // 同一份快照里取全部 ref（动作不换 ref，下一次 snapshot / 导航才会让旧 ref 失效）
    const nameRef = refOf(snap.text, "姓名");
    const submitRef = refOf(snap.text, "提交");
    const typed = await call("browser_type", { ref: nameRef, text: "张三" });
    expect(typed.isError, typed.text).toBe(false);
    expect(typed.text).toContain("输入 2 个字符");
    const clicked = await call("browser_click", { ref: submitRef });
    expect(clicked.isError, clicked.text).toBe(false);
    expect(clicked.text).toContain("已点击");
    expect(clicked.text).toContain("页面现在：");

    // 独立核对：不经 AI 的 browser_evaluate，而是主进程直接在页面里求值
    expect(await pageEval("window.__submitted")).toBe("张三");
    expect(await pageEval("window.__clicks")).toBe(1);
    expect(await pageEval("document.getElementById('out').textContent")).toBe("已提交:张三");
  }, 60_000);

  it("b) screenshot 返回 image 块；evaluate / console / network / tabs 各自可用", async () => {
    const shot = await call("browser_screenshot");
    expect(shot.isError, shot.text).toBe(false);
    const img = shot.res.content.find((c) => c.type === "image") as { type: "image"; data: string; mimeType: string } | undefined;
    expect(img, "应有 image 内容块").toBeTruthy();
    expect(img!.mimeType).toBe("image/jpeg");
    expect(img!.data.length).toBeGreaterThan(1000);
    expect(shot.text).toContain("截图完成");

    const ev = await call("browser_evaluate", { expression: "document.title" });
    expect(ev.isError, ev.text).toBe(false);
    expect(ev.text).toContain("E2E Fixture");

    const con = await call("browser_console", { level: "error" });
    expect(con.isError, con.text).toBe(false);
    expect(con.text).toContain("fixture-console-error-marker");
    expect(con.text).toContain("<untrusted_page_content");

    // 页面加载时那条 fetch('/boom') 的失败事件偶发（约 1/7）没出现在 failed 过滤里，原因未查明（见报告）；
    // 这里再主动在页面里发一次必失败的请求，保证用例对「失败请求能被 browser_network 看到」的断言是确定的
    expect(await pageEval("fetch('/boom?e2e=1').then(() => 'ok', () => 'failed')")).toBe("failed");
    const net = await until(
      () => call("browser_network", { filter: "failed" }),
      (r) => r.text.includes("/boom"),
      4000,
      "failed 过滤里出现 /boom",
    );
    expect(net.isError, net.text).toBe(false);
    expect(net.text).toContain("失败");
    expect(net.text).toContain("<untrusted_page_content");

    // 新标签：target=_blank 的链接
    const snap = await snapshot();
    const blankRef = refOf(snap, "新窗口打开");
    const opened = await call("browser_click", { ref: blankRef });
    expect(opened.isError, opened.text).toBe(false);
    expect(opened.text).toContain("新标签页 t2");

    const list = await call("browser_tabs", { action: "list" });
    expect(list.isError, list.text).toBe(false);
    expect(list.text).toContain("t1");
    expect(list.text).toContain("t2");
    expect(list.text).toContain("/page3");
    expect(list.text).toContain("当前活动标签页：t2");

    // 切回 t1 并关掉 t2，后面的场景都在 t1 上做
    const sel = await call("browser_tabs", { action: "select", tab_id: "t1" });
    expect(sel.isError, sel.text).toBe(false);
    const closed = await call("browser_tabs", { action: "close", tab_id: "t2" });
    expect(closed.isError, closed.text).toBe(false);
    const st = await peerState();
    expect(st?.tabs.map((t) => t.id)).toEqual(["t1"]);
  }, 90_000);

  // ───────── c) 错误映射 ─────────

  it("c) 导航后旧 ref → isError 且提示重新 snapshot；非法 URL → URL_BLOCKED 文案", async () => {
    const snap = await snapshot();
    const staleRef = refOf(snap, "提交");
    const linkRef = refOf(snap, "去第二页");
    const go = await call("browser_click", { ref: linkRef });
    expect(go.isError, go.text).toBe(false);
    expect(go.text).toContain("页面已跳转");
    expect(go.text).toContain("Page2");

    const stale = await call("browser_click", { ref: staleRef });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain("ref 已失效");
    expect(stale.text).toContain("重新调用 browser_snapshot");

    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "http://127.0.0.1:9/"]) {
      const blocked = await call("browser_navigate", { url });
      expect(blocked.isError, `${url} 应被拦：${blocked.text}`).toBe(true);
      expect(blocked.text).toContain("这个网址被拦截");
      expect(blocked.text).toContain("请换一个公开网址");
    }
    // 被拦的导航没有真的导航：仍停在 page2
    expect(await pageEval("location.pathname")).toBe("/page2");

    // 回到 fixture 首页供后面的场景用
    const back = await call("browser_navigate", { action: "back" });
    expect(back.isError, back.text).toBe(false);
    const again = await call("browser_navigate", { url: ready.fixtureUrl });
    expect(again.isError, again.text).toBe(false);
  }, 60_000);

  // ───────── h) 其余工具的参数 / 结果形状 ─────────

  it("h) 其余动作工具两侧形状一致：select / hover / press_key / scroll / drag / wait_for / evaluate", async () => {
    const snap = await snapshot();
    const nameRef = refOf(snap, "姓名");
    const submitRef = refOf(snap, "提交");

    const sel = await call("browser_select", { ref: refOf(snap, "城市"), values: ["上海"] });
    expect(sel.isError, sel.text).toBe(false);
    expect(await pageEval("document.getElementById('city').value")).toBe("sh");

    const hov = await call("browser_hover", { ref: refOf(snap, "悬停区") });
    expect(hov.isError, hov.text).toBe(false);
    expect(hov.text).toContain("已悬停");

    // press_key：先输入再 Control+a / Backspace 清空（带 ref 聚焦）
    expect((await call("browser_type", { ref: nameRef, text: "abc" })).isError).toBe(false);
    const sa = await call("browser_press_key", { key: "Control+a", ref: nameRef });
    expect(sa.isError, sa.text).toBe(false);
    const bs = await call("browser_press_key", { key: "Backspace" });
    expect(bs.isError, bs.text).toBe(false);
    expect(await pageEval("document.getElementById('name').value")).toBe("");

    const drag = await call("browser_drag", { from_ref: refOf(snap, "拖块"), to_ref: refOf(snap, "放置区") });
    expect(drag.isError, drag.text).toBe(false);
    expect(drag.text).toContain("已把");

    const down = await call("browser_scroll", { direction: "bottom" });
    expect(down.isError, down.text).toBe(false);
    expect(down.text).toContain("当前滚动位置");
    expect(Number(await pageEval("window.scrollY"))).toBeGreaterThan(100);
    const up = await call("browser_scroll", { direction: "top" });
    expect(up.isError, up.text).toBe(false);
    expect(await pageEval("window.scrollY")).toBe(0);

    // wait_for：命中 / 纯等待 / 超时（matched:false 不是错误）/ 消失
    expect((await call("browser_click", { ref: submitRef })).isError).toBe(false);
    const hit = await call("browser_wait_for", { text: "已提交" });
    expect(hit.isError, hit.text).toBe(false);
    expect(hit.text).toContain("条件已满足");
    const pure = await call("browser_wait_for", { time_ms: 200 });
    expect(pure.isError, pure.text).toBe(false);
    expect(pure.text).toContain("已等待");
    const miss = await call("browser_wait_for", { text: "永远不会出现的文字-xyz", timeout_ms: 1000 });
    expect(miss.isError, miss.text).toBe(false);
    expect(miss.text).toContain("超时，条件没有满足");
    const gone = await call("browser_wait_for", { text_gone: "永远不会出现的文字-xyz" });
    expect(gone.isError, gone.text).toBe(false);
    expect(gone.text).toContain("条件已满足");

    // evaluate：对象结果 JSON 化；页面抛异常不算工具错误，而是给出 exceptionText
    const obj = await call("browser_evaluate", { expression: "({ a: 1, b: [2, 3] })" });
    expect(obj.isError, obj.text).toBe(false);
    expect(obj.text).toContain('"a":1');
    const thrown = await call("browser_evaluate", { expression: "(function(){ throw new Error('boom-e2e') })()" });
    expect(thrown.isError, thrown.text).toBe(false);
    expect(thrown.text).toContain("脚本抛出了异常");
    expect(thrown.text).toContain("boom-e2e");
  }, 90_000);

  // ───────── d) AI 知道用户做了什么 ─────────

  it("d) 用户点击 / 输入（含密码框）→ browser_user_activity 看得到摘要，密码内容不出现在任何返回文本里", async () => {
    // AI 动作后有 8 秒宽限（输入被锁），等它回 idle 才是「用户在空闲态操作」
    await peer("wait-idle", { taskId: TASK, timeoutMs: 15_000 });

    await peer("user-click", { taskId: TASK, selector: "#submit" });
    await peer("user-type", { taskId: TASK, selector: "#note", text: USER_NOTE });
    await peer("user-type", { taskId: TASK, selector: "#pwd", text: USER_PASSWORD });
    // 先证明用户输入真的进了页面（否则下面「密码没泄漏」的断言就是空转）
    expect(await pageEval("document.getElementById('pwd').value")).toBe(USER_PASSWORD);
    expect(await pageEval("document.getElementById('note').value")).toBe(USER_NOTE);

    // 页内录制器 → 主进程活动日志有延迟（输入合并窗口 1.5s），等 pending 出现
    await until(() => peerState(), (s) => (s?.pendingUserActivity ?? 0) >= 2, 8000, "用户操作进了活动日志");

    const act = await call("browser_user_activity");
    expect(act.isError, act.text).toBe(false);
    expect(act.text).toContain("用户的新操作");
    expect(act.text).toContain("点击了按钮「提交」");
    expect(act.text).toContain("「备注」");
    expect(act.text).toContain("「密码」");
    expect(act.text).toContain("内容已隐藏");
    expect(act.text).toContain("<untrusted_page_content");
    // 隐私：密码与（recordInputValues 关闭时）普通输入值都不得出现
    expect(act.text).not.toContain(USER_PASSWORD);
    expect(act.text).not.toContain(USER_NOTE);
    expect(act.text).toMatch(/输入了 \d+ 个字符/);

    // 游标已推进：再问一次没有新操作
    const again = await call("browser_user_activity");
    expect(again.text).toContain("没有新的操作");

    // 路径 1：用户又点了一下，AI 下一次调任意浏览器工具时结果末尾自动附带 [用户刚才的操作]
    await peer("user-click", { taskId: TASK, selector: "#submit" });
    await until(() => peerState(), (s) => (s?.pendingUserActivity ?? 0) >= 1, 5000, "第二次点击进了日志");
    const snap = await call("browser_snapshot");
    expect(snap.isError, snap.text).toBe(false);
    expect(snap.text).toContain("[用户刚才的操作]");
    expect(snap.text).toContain("点击了按钮「提交」");

    // 全程没有任何返回文本含密码
    expect(allTexts.filter((t) => t.includes(USER_PASSWORD) || t.includes(USER_PASSWORD_2))).toEqual([]);
  }, 90_000);

  it("d) recordInputValues 经 config 推送打开后：普通输入值进摘要，密码框依旧永不记值", async () => {
    // d) 里 AI 只做了感知操作，controller 仍是 idle，用户可以直接继续操作
    expect((await peerState())?.controller).toBe("idle");
    __resetBrowserSettingsForTest({ evaluateEnabled: true, recordInputValues: true });
    bridge.syncConfig(toBrowserConfig(), true);
    await until(() => peer<{ recordInputValues: boolean }>("config"), (c) => c.recordInputValues === true, 4000, "主进程收到 recordInputValues");
    await sleep(500); // 主进程要把新配置重新下发到各 tab 的页内脚本

    await peer("user-type", { taskId: TASK, selector: "#note", text: "visible-note" });
    await peer("user-type", { taskId: TASK, selector: "#pwd", text: USER_PASSWORD_2 });
    expect(await pageEval("document.getElementById('pwd').value")).toBe(USER_PASSWORD + USER_PASSWORD_2);
    await until(() => peerState(), (s) => (s?.pendingUserActivity ?? 0) >= 2, 8000, "用户操作进了活动日志");

    const act = await call("browser_user_activity");
    expect(act.isError, act.text).toBe(false);
    expect(act.text).toContain("visible-note");
    expect(act.text).toContain("内容已隐藏");
    expect(act.text).not.toContain(USER_PASSWORD_2);
    expect(act.text).not.toContain(USER_PASSWORD);

    // 还原默认（后面的用例按「不记输入值」的默认行为写）
    __resetBrowserSettingsForTest({ evaluateEnabled: true });
    bridge.syncConfig(toBrowserConfig(), true);
    await until(() => peer<{ recordInputValues: boolean }>("config"), (c) => c.recordInputValues === false, 4000, "主进程收到 recordInputValues=false");
  }, 60_000);

  // ───────── e) 接管与交还 ─────────

  it("e) 接管 → AI 动作 USER_CONTROL；交还 → bridge 收到 handback { note, entries }，AI 恢复操作", async () => {
    const snap = await snapshot(); // 感知类在接管期间照常可用
    const submitRef = refOf(snap, "提交");

    const handbacks: Array<{ taskId: string; data: Record<string, unknown> }> = [];
    const off = bridge.onEvent("handback", (e) => {
      handbacks.push(e);
    });
    try {
      expect(await peer("takeover", { taskId: TASK })).toBe("user");
      expect((await peerState())?.controller).toBe("user");

      const blocked = await call("browser_click", { ref: submitRef });
      expect(blocked.isError).toBe(true);
      expect(blocked.text).toContain("用户正在接管浏览器");
      expect(blocked.text).toContain("不要抢操作");
      // 「用户接管了浏览器」这条系统条目随这次失败结果一起送达了 AI（路径 1），所以不会再出现在交还的 entries 里
      expect(blocked.text).toContain("[用户刚才的操作]");
      expect(blocked.text).toContain("用户接管了浏览器");

      // 感知类仍可用
      const still = await call("browser_snapshot");
      expect(still.isError, still.text).toBe(false);

      // 接管期间用户自己点一下，交还时应出现在 entries 里
      await peer("user-click", { taskId: TASK, selector: "#submit" });
      await until(() => peerState(), (s) => (s?.pendingUserActivity ?? 0) >= 1, 5000, "接管期间的点击进了日志");

      expect(await peer("handback", { taskId: TASK, note: "我已经填好了" })).toBe("idle");
      await until(() => handbacks.length, (n) => n >= 1, 4000, "收到 handback 事件");
      const evt = handbacks[0]!;
      expect(evt.taskId).toBe(TASK);
      expect(evt.data.note).toBe("我已经填好了");
      const entries = evt.data.entries as Array<{ actor: string; summary: string; kind: string }>;
      expect(Array.isArray(entries)).toBe(true);
      expect(entries.length).toBeGreaterThanOrEqual(1);
      expect(entries.every((e) => e.actor === "user" || e.actor === "system")).toBe(true);
      expect(entries.some((e) => e.actor === "user" && /点击了按钮「提交」/.test(e.summary))).toBe(true);
      // 游标语义：entries = 自上次送达以来的用户 / 系统条目；接管那条已随上面失败的 click 送达过，不重复
      expect(entries.some((e) => e.kind === "takeover")).toBe(false);
      expect((await peerState())?.controller).toBe("idle");

      // server 侧真实的 handback 解析器吃下主进程发来的真实 data：条目一条没被当成「结构不合格」丢掉
      const { parseHandbackData, buildHandbackAgentContext } = await import("@/lib/server/browser/handback");
      const parsed = parseHandbackData(evt.data);
      expect(parsed.note).toBe("我已经填好了");
      expect(parsed.entries.length).toBe(entries.length);
      expect(buildHandbackAgentContext(parsed)).toContain("点击了按钮「提交」");

      // 交还后 AI 动作恢复（接管前拿的 ref 仍可用：交还不换页面）
      const snap2 = await snapshot();
      const ok = await call("browser_click", { ref: refOf(snap2, "提交") });
      expect(ok.isError, ok.text).toBe(false);
      expect(ok.text).toContain("已点击");
    } finally {
      off();
    }
  }, 60_000);

  it("e) AI 动作进行中用户接管 → USER_TOOK_OVER 文案；取消进行中的 wait_for → CANCELLED", async () => {
    // 慢页面让 navigate 在途 4 秒；等 controller 变 ai 后用户接管
    const nav = call("browser_navigate", { url: `${ready.fixtureBase}/slow` });
    await until(() => peerState(), (s) => s?.controller === "ai", 5000, "navigate 在途时 controller=ai");
    expect(await peer("takeover", { taskId: TASK })).toBe("user");
    const r = await nav;
    expect(r.isError).toBe(true);
    expect(r.text).toContain("操作进行中用户接管了浏览器");
    // 交还事件要被消费掉：没有处理器时 bridge 会把 evt 缓存、等下一个处理器注册再补发（会串到后面用例里）
    const got: unknown[] = [];
    const off = bridge.onEvent("handback", (e) => {
      got.push(e);
    });
    try {
      expect(await peer("handback", { taskId: TASK })).toBe("idle");
      await until(() => got.length, (n) => n >= 1, 4000, "收到 handback 事件");
    } finally {
      off();
    }

    // 等待型 op 被 AbortSignal 取消：本地立刻以 CANCELLED 结束（并通知主进程别再等）
    const ctrl = new AbortController();
    const w = call("browser_wait_for", { text: "永远不会出现的文字-abc", timeout_ms: 60_000 }, { signal: ctrl.signal });
    await until(() => bridge.pendingCount(TASK), (n) => n >= 1, 3000, "wait_for 挂起");
    ctrl.abort();
    const wr = await w;
    expect(wr.isError).toBe(true);
    expect(wr.text).toContain("操作已被取消");
    expect(bridge.pendingCount(TASK)).toBe(0);
  }, 60_000);

  // ───────── f) ask_user_to_act ─────────

  it("f) ask_user_to_act 挂起；AbortSignal 取消 → CANCELLED，主进程会话回 idle、askRequest 清空", async () => {
    const ctrl = new AbortController();
    const p = call("browser_ask_user_to_act", { message: "请在页面上登录" }, { signal: ctrl.signal });

    const st = await until(() => peerState(), (s) => s?.askRequest != null, 6000, "主进程出现 askRequest");
    expect(st!.askRequest!.message).toBe("请在页面上登录");
    expect(st!.controller).toBe("user");
    expect(bridge.pendingCount(TASK)).toBe(1);
    // 仍然挂着，没有返回
    expect(await Promise.race([p, sleep(400).then(() => "pending" as const)])).toBe("pending");

    ctrl.abort();
    const r = await p;
    expect(r.isError).toBe(true);
    expect(r.text).toContain("操作已被取消");
    expect(bridge.pendingCount(TASK)).toBe(0);

    // bridge 把 cancel 发给了主进程：会话回 idle、askRequest 清空
    const after = await until(() => peerState(), (s) => s?.askRequest === null, 5000, "主进程 askRequest 被清掉");
    expect(after!.controller).toBe("idle");
    expect(after!.askRequest).toBeNull();
  }, 60_000);

  it("f) ask_user_to_act：用户点「完成 / 放弃」→ outcome 与 note 跨通道原样回来，且不发 handback 事件", async () => {
    const handbacks: unknown[] = [];
    const off = bridge.onEvent("handback", (e) => {
      handbacks.push(e);
    });
    try {
      const done = call("browser_ask_user_to_act", { message: "请输入验证码" });
      await until(() => peerState(), (s) => s?.askRequest != null, 6000, "出现 askRequest");
      expect(await peer("answer-ask", { taskId: TASK, outcome: "done", note: "验证码已填" })).toBe("idle");
      const d = await done;
      expect(d.isError, d.text).toBe(false);
      expect(d.text).toContain("用户已完成操作");
      expect(d.text).toContain("用户留言：验证码已填");
      expect((await peerState())?.askRequest).toBeNull();

      const skipped = call("browser_ask_user_to_act", { message: "请扫码" });
      await until(() => peerState(), (s) => s?.askRequest != null, 6000, "再次出现 askRequest");
      await peer("answer-ask", { taskId: TASK, outcome: "skipped" });
      const s = await skipped;
      expect(s.isError, s.text).toBe(false);
      expect(s.text).toContain("用户选择放弃");

      await sleep(300);
      expect(handbacks).toEqual([]); // ask 的「完成 / 放弃」不发 handback（避免双重送达）
    } finally {
      off();
    }
  }, 60_000);

  // ───────── 会话生命周期：NO_SESSION / close_session ─────────

  it("NO_SESSION 文案；close_session → session_closed 事件，会话消失", async () => {
    const none = await call("browser_click", { ref: "e1" }, { taskId: "e2e-no-session" });
    expect(none.isError).toBe(true);
    expect(none.text).toContain("还没有浏览器会话");

    const closedP = new Promise<string>((resolve) => {
      const off = bridge.onSessionClosed((t) => {
        off();
        resolve(t);
      });
    });
    bridge.closeSession(TASK);
    expect(await Promise.race([closedP, sleep(5000).then(() => "timeout")])).toBe(TASK);
    const status = (await bridge.request(TASK, "status", {})) as { exists: boolean };
    expect(status.exists).toBe(false);
    expect(await peerState()).toBeNull();
  }, 30_000);

  // ───────── g) 断线 ─────────

  it("g) peer 退出 → bridge 变不可用，挂起请求以 CANCELLED 拒绝，之后工具返回「不可用」文案", async () => {
    // 同一个 task 上用 bridge.request 直接拿错误码；另一个 task 上走工具拿文案（同一会话的 ask 会互相顶替，所以分开）
    const direct = bridge.request(TASK, "ask_user_to_act", { message: "断线测试 A", timeoutMs: 60_000 }, { timeoutMs: 120_000 }).then(
      () => null,
      (e: unknown) => e,
    );
    const viaTool = call("browser_ask_user_to_act", { message: "断线测试 B" }, { taskId: TASK2 });
    await until(() => bridge.pendingCount(), (n) => n === 2, 6000, "两个请求都挂起");
    expect((await peerState(TASK2))?.askRequest?.message).toBe("断线测试 B");

    const exitP = handle.exit;
    await peer("quit");

    const err = await direct;
    expect(err).toBeInstanceOf(BrowserBridgeError);
    expect((err as BrowserBridgeError).code).toBe("CANCELLED");
    const r = await viaTool;
    expect(r.isError).toBe(true);
    expect(r.text).toContain("操作已被取消");

    await until(() => bridge.isAvailable(), (v) => v === false, 4000, "bridge 变不可用");
    expect(bridge.pendingCount()).toBe(0);
    expect(getBrowserTools({ taskId: TASK, readOnly: false })).toEqual([]);
    // 工具已不在表里，bridge 级别的请求直接 UNAVAILABLE
    const late = await bridge.request(TASK, "status", {}).then(
      () => null,
      (e: unknown) => e,
    );
    expect((late as BrowserBridgeError).code).toBe("UNAVAILABLE");

    const exit = await exitP;
    // 连 signal 一起比：code 为 null 时能直接看到是被哪个信号终止（崩溃 / 被杀），而不是只看到「null 不等于 0」
    expect({ code: exit.code, signal: exit.signal }).toEqual({ code: 0, signal: null });

    // 收尾：全程任何工具返回都没出现过用户输入的密码
    expect(allTexts.filter((t) => t.includes(USER_PASSWORD) || t.includes(USER_PASSWORD_2))).toEqual([]);
  }, 60_000);
});