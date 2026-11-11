/**
 * V1 输入类新增 op：mouse / fill_form（契约 §14.1）。
 * 对已有 op 的增强（click.modifiers / snapshot.query / wait_for 新条件）不在这里，直接改 index.mjs / actions.mjs / ax-snapshot.mjs。
 *
 * 设计要点：
 * - 两个 op 都是「动作类」，一律走 `session.runAction`（串行 / USER_CONTROL / 接管打断 / AI 归因 / 活动日志），
 *   并包在 `aiScope` 里（locate 阶段的 scrollIntoView 也会触发页内事件，必须被标成 AI，否则成了「用户滚动」）。
 * - fill_form 的逐字段动作复用 actions.mjs 里 click / type / select 的内部主体（`v1Internals`），不复制第二份。
 * - 纯逻辑（参数校验、坐标检查、文案）全部导出，单测在 tests/browser-v1-*.test.ts。
 * - 页面来的文字不可信：本文件产生的 summary / label 只含坐标、数量、ref，不含任何输入值。
 */
import { BrowserError } from "../server-channel.mjs";

export const OPS = Object.freeze(["mouse", "fill_form"]);

// ───────────────────────── 纯函数：参数校验 ─────────────────────────

export const MOUSE_ACTIONS = Object.freeze(["move", "click", "double_click", "down", "up", "wheel"]);
export const MODIFIER_NAMES = Object.freeze(["Alt", "Control", "Meta", "Shift"]);
export const MAX_FILL_FIELDS = 30;
const MAX_WHEEL_DELTA = 100_000;

/**
 * modifiers 校验：缺省 → undefined；必须是 Alt / Control / Meta / Shift 组成的数组，去重。
 * 返回 undefined 表示没有修饰键（调用方不必带该字段）。
 */
export const normalizeModifiers = (raw, bad) => {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw bad(`modifiers 必须是数组，元素只能是 ${MODIFIER_NAMES.join(" / ")}`);
  const out = [];
  for (const m of raw) {
    if (typeof m !== "string" || !MODIFIER_NAMES.includes(m)) {
      throw bad(`modifiers 只能包含 ${MODIFIER_NAMES.join(" / ")}，收到「${String(m).slice(0, 20)}」`);
    }
    if (!out.includes(m)) out.push(m);
  }
  return out.length > 0 ? out : undefined;
};

const reqNum = (args, key, bad) => {
  const v = args[key];
  if (v === undefined || v === null) throw bad(`缺少必填参数 ${key}（数字，视口 CSS 像素）`);
  if (typeof v !== "number" || !Number.isFinite(v)) throw bad(`参数 ${key} 必须是有限数字`);
  return v;
};

/** mouse 参数规整：x / y 必填且非负；wheel 至少一个 delta 非 0；button 缺省 left。 */
export const normalizeMouseArgs = (args, h) => {
  const action = h.reqEnum(args, "action", MOUSE_ACTIONS);
  const x = reqNum(args, "x", h.bad);
  const y = reqNum(args, "y", h.bad);
  if (x < 0 || y < 0) throw h.bad(`坐标不能为负：(${Math.round(x)}, ${Math.round(y)})。x / y 是视口左上角为原点的 CSS 像素`);
  const button = h.optEnum(args, "button", ["left", "right", "middle"], "left");
  const deltaX = h.optNum(args, "deltaX", { min: -MAX_WHEEL_DELTA, max: MAX_WHEEL_DELTA, dflt: 0, integer: false });
  const deltaY = h.optNum(args, "deltaY", { min: -MAX_WHEEL_DELTA, max: MAX_WHEEL_DELTA, dflt: 0, integer: false });
  if (action === "wheel" && deltaX === 0 && deltaY === 0) throw h.bad("wheel 需要 deltaX 或 deltaY（像素，正数 = 向下 / 向右滚）");
  const modifiers = normalizeModifiers(args.modifiers, h.bad);
  return h.withTab(args, { action, x, y, button, deltaX, deltaY, ...(modifiers ? { modifiers } : {}) });
};

/** fill_form 参数规整：fields 1–30 项，每项 ref + 且仅 value / checked / values 之一；submitRef 可选。 */
export const normalizeFillFormArgs = (args, h) => {
  const raw = args.fields;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_FILL_FIELDS) {
    throw h.bad(`fields 必须是 1–${MAX_FILL_FIELDS} 项组成的数组`);
  }
  const fields = raw.map((f, i) => {
    const at = (msg) => h.bad(`fields[${i}]：${msg}`);
    if (!h.isObj(f)) throw at("必须是对象 { ref, value? | checked? | values? }");
    const ref = typeof f.ref === "string" ? f.ref.trim() : "";
    if (ref === "" || ref.length > 20) throw at("缺少合法的 ref（来自最近一次 browser_snapshot，形如 e12）");
    const given = ["value", "checked", "values"].filter((k) => f[k] !== undefined && f[k] !== null);
    if (given.length !== 1) throw at("value（文本）/ checked（勾选）/ values（下拉）必须且只能给一个");
    if (given[0] === "value") {
      if (typeof f.value !== "string") throw at("value 必须是字符串");
      if (f.value.length > 50_000) throw at("value 过长（上限 50000 字符）");
      return { ref, value: f.value };
    }
    if (given[0] === "checked") {
      if (typeof f.checked !== "boolean") throw at("checked 必须是布尔值");
      return { ref, checked: f.checked };
    }
    const vs = f.values;
    if (!Array.isArray(vs) || vs.length < 1 || vs.length > 50 || !vs.every((v) => typeof v === "string" && v.length <= 500)) {
      throw at("values 必须是 1–50 个字符串组成的数组");
    }
    return { ref, values: [...vs] };
  });
  const submitRaw = h.optStr(args, "submitRef", 20);
  const submitRef = submitRaw ? submitRaw.trim() : undefined;
  return h.withTab(args, { fields, ...(submitRef ? { submitRef } : {}) });
};

export const normalize = (op, args, h) => {
  switch (op) {
    case "mouse":
      return normalizeMouseArgs(args, h);
    case "fill_form":
      return normalizeFillFormArgs(args, h);
    default:
      throw h.bad(`未实现的浏览器操作：${String(op).slice(0, 40)}`);
  }
};

// ───────────────────────── 纯函数：坐标 / 文案 / 敏感字段 ─────────────────────────

/**
 * 坐标必须落在视口内（x ∈ [0,W)，y ∈ [0,H)）；超出抛 BAD_ARGS，文案带上视口尺寸，让模型能自修复。
 * 视口宽高为 0 / 缺失（视图尚未布局）时不做上界检查——与 actions.computeTarget 的约定一致。
 */
export const checkMousePoint = (x, y, viewport) => {
  const w = Number(viewport?.width);
  const h = Number(viewport?.height);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
    throw new BrowserError("BAD_ARGS", `坐标 (${Math.round(x)}, ${Math.round(y)}) 不合法：x / y 不能为负，原点是视口左上角`);
  }
  if (w > 0 && h > 0 && (x >= w || y >= h)) {
    throw new BrowserError(
      "BAD_ARGS",
      `坐标 (${Math.round(x)}, ${Math.round(y)}) 超出视口范围：视口是 ${w}×${h} CSS 像素（x 取 0–${w - 1}，y 取 0–${h - 1}，原点在左上角）。先 browser_screenshot 确认视口尺寸与目标位置，能用 ref 的优先用 ref`,
    );
  }
};

const MODIFIER_ZH = { Control: "Ctrl", Alt: "Alt", Shift: "Shift", Meta: "Cmd" };
const modifierPrefix = (list) =>
  ["Control", "Alt", "Shift", "Meta"].filter((m) => Array.isArray(list) && list.includes(m)).map((m) => `${MODIFIER_ZH[m]}+`).join("");

/** mouse 动作的人话描述（活动日志 / 覆盖层标签）。只含坐标与数值，不含页面文字。 */
export const describeMouseAction = (a) => {
  const at = `(${Math.round(a.x)}, ${Math.round(a.y)})`;
  const pre = modifierPrefix(a.modifiers);
  const btn = a.button === "right" ? "右键" : a.button === "middle" ? "中键" : "";
  switch (a.action) {
    case "move":
      return { kind: "click", summary: `鼠标移动到 ${at}`, label: `移动鼠标 ${at}` };
    case "click":
      return { kind: "click", summary: `${pre}鼠标${btn}点击 ${at}`, label: `${pre}${btn}点击 ${at}` };
    case "double_click":
      return { kind: "click", summary: `${pre}鼠标${btn}双击 ${at}`, label: `${pre}${btn}双击 ${at}` };
    case "down":
      return { kind: "click", summary: `${pre}鼠标${btn}按下 ${at}`, label: `${pre}${btn}按下 ${at}` };
    case "up":
      return { kind: "click", summary: `${pre}鼠标${btn}抬起 ${at}`, label: `${pre}${btn}抬起 ${at}` };
    default: {
      const dx = Math.round(a.deltaX ?? 0);
      const dy = Math.round(a.deltaY ?? 0);
      const parts = [dy ? `纵向 ${dy > 0 ? "+" : ""}${dy}` : "", dx ? `横向 ${dx > 0 ? "+" : ""}${dx}` : ""].filter(Boolean).join("、");
      return { kind: "scroll", summary: `${pre}鼠标滚轮 ${at} ${parts}px`, label: `${pre}滚轮 ${at}` };
    }
  }
};

/** fill_form 的活动日志摘要：只写数量，不写任何字段值。 */
export const describeFillForm = (total, okCount, submit) => {
  const failed = total - okCount;
  const tail = failed > 0 ? `，失败 ${failed} 项` : "";
  const sub = submit === "ok" ? "，并点击了提交" : submit === "skipped" ? "，因有失败项已跳过提交" : submit === "failed" ? "，提交点击失败" : "";
  return `填写了表单 ${okCount}/${total} 项${tail}${sub}`;
};

/** 这些错误意味着整个动作被打断 / 会话没了：不能当作「单字段失败」吞掉继续填 */
const FATAL_CODES = new Set(["USER_TOOK_OVER", "USER_CONTROL", "CANCELLED", "NO_SESSION", "TAB_NOT_FOUND"]);
export const isFatalFillError = (err, signal) => signal?.aborted === true || (err instanceof BrowserError && FATAL_CODES.has(err.code));

const errMessage = (err) => String(err?.message ?? err).slice(0, 400);

// ───────────────────────── handler ─────────────────────────

/**
 * tab → 当前按下的鼠标键位（down / up 跨调用保持，move 时才能带着 buttons，页面拖拽逻辑才认）。
 * R1-28：状态带「按下的位置 / 时间 / 当时的导航计数」，才能在动作被取消 / 出错 / 过期（导航、超时）时补发 mouseReleased 并清掉，
 * 不会让后续调用带着一个早已不存在的按下态。
 */
const pressedState = new WeakMap(); // tab → { bits, x, y, at, nav }
/**
 * 按下态的**空闲**超时：距离最近一次 down / up / move / wheel 超过它就当 AI 忘了抬起（模型一次思考 + 工具往返远小于它）。
 * R2-08：以前只在 down / up 时刷新，AI 用 down + 多次 move 画画超过 2 分钟会被强制 release；现在 move / wheel 也续期。
 */
export const HELD_BUTTON_TTL_MS = 120_000;
const BUTTON_BITS = { left: 1, right: 2, middle: 4 };
const BUTTON_NAMES = [
  ["left", 1],
  ["right", 2],
  ["middle", 4],
];

/** 当前有效的按下掩码；已过期（超时 / 导航提交过）的状态视为没有，并返回 stale 让调用方补发 release */
export const peekHeldButtons = (tab, now = Date.now()) => {
  const st = pressedState.get(tab);
  if (!st || !st.bits) return { bits: 0, stale: null };
  const expired = now - st.at > HELD_BUTTON_TTL_MS || (tab.navCommitted ?? 0) !== st.nav;
  return expired ? { bits: 0, stale: st } : { bits: st.bits, stale: null };
};

export const createHandlers = (deps) => {
  const I = deps.actions.v1Internals;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 按住期间的 move / wheel / 其它键的 click：续期、更新「将来补 release 的位置」（没有按下态时什么都不做） */
  const touchHeld = (tab, x, y) => {
    const st = pressedState.get(tab);
    if (!st || !st.bits) return;
    pressedState.set(tab, { ...st, x, y, at: Date.now() });
  };

  /** 在最后位置逐键 release；失败一律吞掉 */
  const sendRelease = async (tab, st) => {
    let left = st.bits;
    for (const [name, b] of BUTTON_NAMES) {
      if (!(left & b)) continue;
      left &= ~b;
      await I.mouse(tab, { type: "mouseReleased", x: st.x, y: st.y, button: name, buttons: left, clickCount: 1 }).catch(() => {});
    }
  };

  /**
   * 补发 mouseReleased 并清状态（先清再发：即使发送失败，状态也不再残留；并发的第二个调用看不到状态，什么都不发）。失败一律吞掉。
   * `ask_user_to_act` / 用户接管 / 任务取消 / 动作出错 / 空闲 120s 过期补发，都走这里：在最后位置把按着的键逐个松开。
   * `withAiInput` 只围着真正的派发（出错时直接再发一次：release 本身也吞错）。
   */
  const releaseHeld = async (tab, st = pressedState.get(tab)) => {
    pressedState.delete(tab);
    if (!st || !st.bits) return;
    const send = () => sendRelease(tab, st);
    await tab.withAiInput(send).catch(() => send());
  };

  /**
   * 给 tab 挂一个「释放 AI 按下的鼠标键」的入口（R2-08）：session 在用户接管 / ask_user_to_act / 任务被取消时调用。
   * down 成功返回后，如果此刻没有在途的 mouse op，按下态只能靠这个入口清掉，否则用户接管后页面里还留着 AI 按下的键。
   * 幂等；没有按下态时无操作；失败一律吞掉。
   */
  const ensureReleaser = (tab) => {
    if (typeof tab.releaseHeldButtons === "function") return;
    tab.releaseHeldButtons = async () => {
      const st = pressedState.get(tab);
      if (!st || !st.bits) return;
      await releaseHeld(tab, st);
    };
  };

  const runMouse = (session, a, signal) =>
    session.runAction({ op: "mouse", tabId: a.tabId, signal }, (ctx) =>
      I.aiScope(ctx.tab, async () => {
        const tab = ctx.tab;
        let dispatching = false;
        try {
          return await runMouseBody(session, ctx, tab, a, () => {
            dispatching = true;
          });
        } catch (err) {
          // 被取消 / 用户接管 / 会话没了，或者已经开始派发输入后出错：按下态不可信，补发 release 并清状态。
          // 只是参数不合法（坐标越界等，还没派发任何事件）不动已有的按下态——那是上一次合法 down 留下的。
          if (dispatching || isFatalFillError(err, ctx.signal) || signal?.aborted === true) {
            await releaseHeld(tab);
          }
          throw err;
        }
      }),
    );

  const runMouseBody = async (session, ctx, tab, a, markDispatching) => {
        await tab.ensureCdp();
        // 视口尺寸取当前 layout metrics：坐标超界要在派发任何事件之前就拒绝
        const m = await tab.layoutMetrics();
        checkMousePoint(a.x, a.y, { width: m.viewportW, height: m.viewportH });
        const before = I.beforeState(tab);
        const d = describeMouseAction(a);
        ctx.describe({ kind: d.kind, summary: d.summary, label: d.label });
        const point = { x: a.x, y: a.y };
        // 页内 AI 光标：与 click 同款覆盖层，只给点（没有元素 rect）
        await I.showAction(tab, { point }, d.label, a.action === "wheel" ? "scroll" : "click", ctx);
        ctx.check();
        const mods = deps.actions.modifierBits(a.modifiers);
        const bit = BUTTON_BITS[a.button] ?? 1;
        let settleNav = false;
        // 过期的按下态（导航后 / 超时）先补发 release 清掉，不带进这次动作
        const peeked = peekHeldButtons(tab);
        if (peeked.stale) await releaseHeld(tab, peeked.stale);
        await tab.withAiInput(async () => {
          markDispatching();
          const heldBits = () => peekHeldButtons(tab).bits;
          switch (a.action) {
            case "move": {
              const held = heldBits();
              if (!held) {
                // 先从旁边划过来再落点：mouseenter / mouseover 型菜单需要真实轨迹（与 hover 一致）
                await I.mouse(tab, { type: "mouseMoved", x: Math.max(0, a.x - 6), y: Math.max(0, a.y - 6), button: "none", buttons: 0, modifiers: mods });
              }
              await I.mouse(tab, { type: "mouseMoved", x: a.x, y: a.y, button: held ? (held & 1 ? "left" : held & 2 ? "right" : "middle") : "none", buttons: held, modifiers: mods });
              if (held) touchHeld(tab, a.x, a.y);
              break;
            }
            case "click":
            case "double_click": {
              settleNav = true;
              await I.mouseClickAt(tab, point, { button: a.button, clickCount: a.action === "double_click" ? 2 : 1, modifiers: mods });
              // R6-30 二轮复审②：click 自己就是一次 press + release，会把同一个键的按下态结束掉——不清的话 pressedState 留着旧值，
              // 之后的 move 会带着 buttons:1。别的键仍按着就保留它们（并按这次落点更新位置）。
              const rest = heldBits() & ~bit;
              if (rest) {
                pressedState.set(tab, { ...pressedState.get(tab), bits: rest });
                touchHeld(tab, a.x, a.y);
              } else {
                pressedState.delete(tab);
              }
              break;
            }
            case "down": {
              const held = heldBits();
              await I.mouse(tab, { type: "mouseMoved", x: a.x, y: a.y, button: "none", buttons: held, modifiers: mods });
              // 先登记再派发：mousePressed 发出后即便超时 / 被取消，catch 里也知道要补 release（对没按下的键发 release 无害）
              pressedState.set(tab, { bits: held | bit, x: a.x, y: a.y, at: Date.now(), nav: tab.navCommitted ?? 0 });
              ensureReleaser(tab);
              await I.mouse(tab, { type: "mousePressed", x: a.x, y: a.y, button: a.button, buttons: held | bit, clickCount: 1, modifiers: mods });
              break;
            }
            case "up": {
              const left = heldBits() & ~bit;
              await I.mouse(tab, { type: "mouseReleased", x: a.x, y: a.y, button: a.button, buttons: left, clickCount: 1, modifiers: mods });
              if (left) {
                const cur = pressedState.get(tab);
                pressedState.set(tab, { ...cur, bits: left, x: a.x, y: a.y, at: Date.now(), nav: tab.navCommitted ?? 0 });
              } else pressedState.delete(tab);
              break;
            }
            default:
              // wheel：先把指针放到位（让该处元素成为滚动目标），再发 mouseWheel
              await I.mouse(tab, { type: "mouseMoved", x: a.x, y: a.y, button: "none", buttons: heldBits(), modifiers: mods });
              await I.mouse(tab, { type: "mouseWheel", x: a.x, y: a.y, deltaX: a.deltaX ?? 0, deltaY: a.deltaY ?? 0, modifiers: mods });
              if (heldBits()) touchHeld(tab, a.x, a.y);
              break;
          }
        });
        await tab.setAI(true);
        if (settleNav) {
          await I.settle(session, tab, ctx, before);
        } else {
          // 滚轮的 scroll 事件在后续帧才发（可能带平滑滚动）：等它发完再复位 AI flag，否则会被记成「用户滚动」
          await sleep(a.action === "wheel" ? 320 : 140);
          ctx.check();
        }
        return I.actionResult(session, tab, ctx, before);
  };

  /** 单个字段：文本 / 勾选 / 下拉。失败抛错，由调用方记成该项 ok:false。 */
  const fillOne = async (session, sub, f) => {
    const tab = sub.tab;
    const entry = tab.resolveRef(f.ref);
    if (f.value !== undefined) {
      await I.typeBody(session, sub, { ref: f.ref, text: f.value, clear: true, submit: false }, { quick: true });
      return;
    }
    if (f.values !== undefined) {
      await I.selectBody(session, sub, { ref: f.ref, values: f.values });
      return;
    }
    // checked：先读当前状态，不同才点（点一下会翻转，盲点会把已勾的勾掉）
    const st = await I.callOnNode(tab, entry, f.ref, I.CHECKED_STATE_FN);
    if (!st || st.kind === "other") {
      throw new BrowserError("BAD_ARGS", `元素 ${f.ref} 不是复选框 / 单选框 / 开关，没有勾选状态。文本框请改用 value，下拉请用 values`);
    }
    if (st.disabled) throw new BrowserError("NOT_INTERACTABLE", `元素 ${f.ref} 已禁用，无法改变勾选状态`);
    if (st.checked === f.checked) return;
    if (st.kind === "radio" && f.checked === false) {
      throw new BrowserError("BAD_ARGS", `元素 ${f.ref} 是单选框，不能直接取消选中；请改选同组的另一项`);
    }
    await I.clickBody(session, sub, { ref: f.ref }, { quick: true });
    const after = await I.callOnNode(tab, entry, f.ref, I.CHECKED_STATE_FN).catch(() => null);
    if (after && after.checked !== f.checked) {
      throw new BrowserError("NOT_INTERACTABLE", `点击后元素 ${f.ref} 的勾选状态没有改变（可能被页面脚本拦截或被遮挡）`);
    }
  };

  const runFillForm = (session, a, signal) =>
    session.runAction({ op: "fill_form", tabId: a.tabId, signal }, (ctx) =>
      I.aiScope(ctx.tab, async () => {
        const tab = ctx.tab;
        await tab.ensureCdp();
        const before = I.beforeState(tab);
        const total = a.fields.length;
        ctx.describe({ kind: "type", summary: `填写表单 ${total} 项`, label: `填写表单 ${total} 项` });
        // 子 ctx：逐项动作的 describe 只刷新「AI 正在做什么」标签，最终那条活动日志由本 op 统一写（只写数量，不写值）
        const sub = { ...ctx, describe: (d) => ctx.describe({ kind: "type", summary: `填写表单 ${total} 项`, label: d.label }) };
        const results = [];
        for (const f of a.fields) {
          try {
            ctx.check();
            await fillOne(session, sub, f);
            results.push({ ref: f.ref, ok: true });
          } catch (err) {
            if (isFatalFillError(err, ctx.signal)) throw err;
            results.push({ ref: f.ref, ok: false, error: errMessage(err) });
          }
        }
        const okCount = results.filter((r) => r.ok).length;
        let submit;
        let submitState;
        if (a.submitRef) {
          if (okCount < total) {
            // 表单没填全就提交可能触发校验报错 / 锁账号：不提交，交给 AI 先处理失败项
            submitState = "skipped";
            submit = { ref: a.submitRef, ok: false, error: `有 ${total - okCount} 项填写失败，已跳过提交。请先处理失败项，再用 browser_click 点提交` };
          } else {
            try {
              await I.clickBody(session, sub, { ref: a.submitRef });
              submitState = "ok";
              submit = { ref: a.submitRef, ok: true };
            } catch (err) {
              if (isFatalFillError(err, ctx.signal)) throw err;
              submitState = "failed";
              submit = { ref: a.submitRef, ok: false, error: errMessage(err) };
            }
          }
        }
        ctx.describe({ kind: submitState === "ok" ? "submit" : "type", summary: describeFillForm(total, okCount, submitState), label: `填写表单 ${total} 项` });
        await tab.setAI(true);
        await sleep(60);
        ctx.check();
        return { ...I.actionResult(session, tab, ctx, before), results, ...(submit ? { submit } : {}) };
      }),
    );

  return {
    mouse: (taskId, a, signal) => runMouse(deps.requireSession(taskId), a, signal),
    fill_form: (taskId, a, signal) => runFillForm(deps.requireSession(taskId), a, signal),
  };
};
