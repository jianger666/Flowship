/**
 * 增强包 E2 · C2 触屏手势（tap / long_press / swipe / pinch）
 *
 * 纯逻辑（参数校验 / 事件序列规划 / 失败必取消的执行器 / 触屏模拟的临时开关）在 `../touch-kit.mjs`；本文件只管编排：
 *   locate（ref → 视口坐标，与 click 同一套：滚入视野 / 遮挡检查 / REF_STALE / NOT_INTERACTABLE）→ 视口校验 →
 *   临时开触屏模拟 → `Input.dispatchTouchEvent` → 恢复 → 动作后稳定期。
 * 一律走 `session.runAction`（队列 / AI 归因 / 接管打断 / 活动日志 actor ai 与 click 一致）。
 *
 * 红线 3：本工具没有任何文本入参，也不产生字符输入——对敏感输入框的触屏点击只会聚焦，不会让 AI 键入口令；
 * 页面隔离，所以 Flowship origin 无关（AI 永远进不了 Flowship 自己的页面，见 url-policy）。
 */
import { HELD_BUTTON_CLICK_MESSAGE, heldButtonBitsOf } from "../secret-field.mjs";
import { BrowserError } from "../server-channel.mjs";
import { describeTouch, normalizeTouchArgs, planGesture, runGesture, swipeEnd, withTouchEmulation } from "../touch-kit.mjs";
import { checkMousePoint } from "./input.mjs";

export const OPS = Object.freeze(["touch"]);

export const normalize = (op, args, h) => {
  switch (op) {
    case "touch":
      return normalizeTouchArgs(args, h);
    default:
      throw h.bad(`未实现的浏览器操作：${String(op).slice(0, 40)}`);
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} deps  index.mjs 的 createExtraHandlers 依赖（契约 §15.1：requireSession / actions …）
 */
export const createHandlers = (deps) => {
  const A = deps.actions;
  const I = A.v1Internals;

  const runTouch = (session, a, signal) =>
    session.runAction({ op: "touch", tabId: a.tabId, signal }, (ctx) =>
      I.aiScope(ctx.tab, async () => {
        const tab = ctx.tab;
        // R6-30 四轮复审 P3①：AI 还按着 browser_mouse 的键时，触摸手势（可能合成兼容鼠标事件）会在没探过的位置动鼠标——派发（含临时开触屏模拟）之前先拒
        if (heldButtonBitsOf(tab) !== 0) throw new BrowserError("BAD_ARGS", HELD_BUTTON_CLICK_MESSAGE);
        await tab.ensureCdp();
        const before = I.beforeState(tab);
        // 目标 → 视口坐标：ref 走与 click 同款的 locate（含遮挡检查：被浮层盖住的元素触摸也点不到）；坐标要落在视口内
        const m = await tab.layoutMetrics();
        const viewport = { width: m.viewportW, height: m.viewportH };
        let from;
        let target = null;
        if (a.ref) {
          target = await A.locate(tab, a.ref, ctx);
          from = { x: target.point.x, y: target.point.y };
        } else {
          checkMousePoint(a.x, a.y, viewport);
          from = { x: a.x, y: a.y };
        }
        const to = a.action === "swipe" ? swipeEnd(from, a, viewport) : null;
        // 规划在派发之前：pinch 中心离边缘太近等参数问题要在发出任何事件前就拒绝
        const steps = planGesture(a, from, { to, viewport });
        const d = describeTouch(a, from);
        const what = target ? target.label : "";
        const label = `${d.verb}${what ? ` ${what}` : ""}`;
        ctx.describe({
          kind: "click",
          summary: `${d.verb}了${what || `视口位置 ${d.detail}`}${what ? `（${d.detail}）` : ""}`,
          label,
          ...(target ? { target: I.targetOf(target.entry, a.ref) } : {}),
        });
        await I.showAction(tab, target ?? { point: from }, label, "click", ctx);
        ctx.check();
        let events = 0;
        await tab.withAiInput(() =>
          withTouchEmulation(tab, async () => {
            const r = await runGesture(
              {
                send: (params) => tab.send("Input.dispatchTouchEvent", params, null, 5000),
                sleep,
                check: () => ctx.check(),
              },
              steps,
            );
            events = r.events;
          }),
        );
        await tab.setAI(true);
        // tap 可能触发导航（链接）：与 click 同款稳定期；滑动 / 缩放的滚动 / 动画在后续帧才结束，等一拍再复位 AI 归因
        if (a.action === "tap") await I.settle(session, tab, ctx, before);
        else {
          await sleep(a.action === "swipe" ? 360 : 200);
          ctx.check();
        }
        return {
          ...I.actionResult(session, tab, ctx, before),
          gesture: {
            action: a.action,
            from: { x: Math.round(from.x), y: Math.round(from.y) },
            ...(to ? { to: { x: Math.round(to.x), y: Math.round(to.y) }, distance: Math.round(to.distance) } : {}),
            ...(a.action === "long_press" ? { durationMs: a.durationMs } : {}),
            ...(a.action === "swipe" ? { durationMs: a.durationMs } : {}),
            ...(a.action === "pinch" ? { scale: a.scale, durationMs: a.durationMs } : {}),
            events,
          },
        };
      }),
    );

  return {
    touch: async (taskId, a, signal) => {
      if (!a || typeof a !== "object") throw new BrowserError("BAD_ARGS", "touch 需要参数");
      return runTouch(deps.requireSession(taskId), a, signal);
    },
  };
};
