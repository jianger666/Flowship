/**
 * browser_* 工具定义（契约 §10）：把内置浏览器的 op 暴露给 AI。
 *
 * # 注册条件（{@link getBrowserTools}）
 * bridge 可用（桌面壳 + 握手成功）且有 taskId 且非 readOnly 才返回。
 * 否则返回 [] ——AI 根本看不到这些工具，比「调用时报不可用」省 token，也不会诱导它反复重试。
 * `browser_evaluate`（E2·A7 起）**常驻注册**：总闸没开时不再直接拒，而是由主进程弹审批卡（仅本任务 / 永久开启 / 拒绝），
 * 所以工具表里不再看 evaluateEnabled（授权判定只在主进程，见 electron-app/browser/evaluate-approval.mjs）。
 *
 * # 通用行为
 * - 所有工具都从 `ctx.taskId` 取任务（不信任模型传的任何 task_id——浏览器会话按任务隔离，不能让模型指别的任务）。
 * - 页面来的文字（快照 / 标题 / 控制台 / 网络 / 活动摘要）统一过 content.ts 包装为不可信内容。
 * - 动作类成功后附一行「页面现在：标题 + URL」；`navigated` 时提示 ref 已失效。
 * - 结果末尾若有用户新操作，自动附一段 `[用户刚才的操作]`（路径 1，见 activity.ts）。
 * - 错误以 `isError` 文本返回，文案写成模型能自修复的话。
 *
 * 这些工具和其它 Flowship 工具一样必须经 `invokeFlowshipTool` 调用（非属主轮次的白名单硬拒在那里），
 * 不要把 browser_* 加进 `NON_OWNER_TURN_ALLOWED_TOOLS`。
 */

import {
  Array as TBArray,
  Boolean as TBBoolean,
  Enum as TBEnum,
  Number as TBNumber,
  Object as TBObject,
  Optional as TBOptional,
  String as TBString,
} from "typebox/type";

// 只引类型：flowship-tools.ts 会 import 本文件，运行时不能成环
import type {
  FlowshipToolContent,
  FlowshipToolContext,
  FlowshipToolDef,
  FlowshipToolResult,
} from "../flowship-tools";
import { onWaitsCancelled } from "../session-wait";
import { appendUserActivity, fetchPendingUserActivity, TOOL_ACTIVITY_HEADER } from "./activity";
import { getBrowserBridge, isBrowserBridgeAvailable } from "./bridge";
import {
  MAX_LOG_TEXT_CHARS,
  ToolResultBuilder,
  truncateWithNote,
  UNTRUSTED_TAG,
  wrapUntrustedInline,
} from "./content";
import {
  entryFlags,
  initiatorLines,
  initiatorTail,
  listCursorLine,
  renderHarExport,
  streamFrameLines,
  type HarExportResult,
  type NetworkExtras,
  type StreamFramesInfo,
} from "./network-render";
import { keyTypesCharacter } from "./redact-args";
import { parseScreenshotArgs, parseScrollArgs, renderLegend, renderUntilStable, UNTIL_STABLE_BRIDGE_TIMEOUT_MS, type UntilStableResult } from "./screenshot-scroll-args";
import { EVALUATE_APPROVAL_WAIT_MS, WAITING_SLACK_MS } from "./approval-timeout";
import { getE2Tools } from "./tools-e2";
import { renderInspectExtras, type InspectExtras } from "./inspect-render";
import { redactSensitiveText } from "./redact-text";
import { getBrowserSettingsSync } from "./settings";
import { ensureBrowserSettingsEventsRegistered } from "./settings-events";
import { checkUploadPaths, MAX_UPLOAD_FILES, resolveUploadEnv } from "./upload-policy";
import {
  BrowserBridgeError,
  type BrowserActivityEntry,
  type BrowserOp,
  type BrowserTabInfo,
} from "./types";

/** 截图体积上限（base64 解码后的字节）：再大会撑爆上下文 / 被模型端拒收 */
export const SCREENSHOT_MAX_BYTES = 1_500_000;
const SCREENSHOT_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
const ASK_DEFAULT_TIMEOUT_MS = 1_800_000;
// WAITING_SLACK_MS（本地超时比对端自己的超时长一截，否则本地先炸、对端的 TIMEOUT 语义 matched:false 就丢了）与 EVALUATE_APPROVAL_WAIT_MS
// 现在统一在 ./approval-timeout（R6-33：perf / net-rules / debug 工具要用同一份），上面已 import

// ----------------- 停止联动 -----------------

interface StopHookState {
  installed: boolean;
  /** agent 实例 scope → taskId（Cursor 路径：run 被取消时 key 是 scope 不是 taskId） */
  scopeToTask: Map<string, string>;
  /** scope 下正在进行的浏览器请求数：没有在飞的请求就不必打扰主进程 */
  inflightByScope: Map<string, number>;
}

const STOP_HOOK_KEY = "__flowshipBrowserStopHookV1__";

const stopState = (): StopHookState => {
  const g = globalThis as unknown as Record<string, StopHookState | undefined>;
  if (!g[STOP_HOOK_KEY]) {
    g[STOP_HOOK_KEY] = { installed: false, scopeToTask: new Map(), inflightByScope: new Map() };
  }
  return g[STOP_HOOK_KEY]!;
};

/**
 * 订阅 session-wait 的「取消」广播：任务被停止 / 删除 / agent 实例被取消 → 把该任务挂起的浏览器请求取消。
 * 为什么挂在 session-wait 上：全仓所有「停」的路径（stop API、懒重启、错误收尾……）都会走 `interruptWaits(key,"cancel")`，
 * 不用再给每条路径各插一行；而 wait_for / ask_user_to_act 可能挂 30 分钟，停了不取消就会一直卡着主进程那头的 UI 条幅。
 * 幂等 + globalThis 守护：HMR / 多 bundle 只装一次。
 */
export const installBrowserStopHook = (): void => {
  const st = stopState();
  if (st.installed) return;
  st.installed = true;
  onWaitsCancelled((key) => {
    const bridge = getBrowserBridge();
    if (!bridge) return;
    if (key.startsWith("wait-scope:")) {
      const taskId = st.scopeToTask.get(key);
      st.scopeToTask.delete(key);
      if (taskId && (st.inflightByScope.get(key) ?? 0) > 0) bridge.cancel(taskId);
      st.inflightByScope.delete(key);
      return;
    }
    // taskId：只有真有挂起请求才发（cleanup 类路径会被频繁调用，别每次都给主进程发空 cancel）
    if (bridge.pendingCount(key) > 0) bridge.cancel(key);
  });
};

// ----------------- 参数解析（宽松：模型常把数字写成字符串） -----------------

class BadArgs extends Error {}

/** 截图超预算：文案自带「怎么办」，不套「参数有误」的壳 */
class ScreenshotTooLarge extends Error {
  constructor(bytes: number) {
    super(
      `截图过大（约 ${(bytes / 1_000_000).toFixed(1)}MB，超过 ${(SCREENSHOT_MAX_BYTES / 1_000_000).toFixed(1)}MB 上限），已丢弃。请不要用 full_page，或传 ref / clip 只截取局部，或改用 jpeg / webp、降低 quality、调小 max_width 或 scale，或直接用 browser_snapshot。`,
    );
  }
}

const argStr = (args: Record<string, unknown>, key: string): string | undefined => {
  const v = args[key];
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
};
const argBool = (args: Record<string, unknown>, key: string): boolean | undefined => {
  const v = args[key];
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
};
const argNum = (args: Record<string, unknown>, key: string): number | undefined => {
  const v = args[key];
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};
const reqStr = (args: Record<string, unknown>, key: string): string => {
  const v = argStr(args, key);
  if (v === undefined) throw new BadArgs(`缺少必填参数 ${key}`);
  return v;
};
/** ref：browser_snapshot 里 [e12] 那种元素编号。宽松校验（字符集 + 长度），具体存在性交给主进程 */
const reqRef = (args: Record<string, unknown>, key: string): string => {
  const v = reqStr(args, key).trim().replace(/^\[|\]$/g, "");
  if (!/^[\w.:-]{1,40}$/.test(v)) {
    throw new BadArgs(`${key} 必须是 browser_snapshot 里列出的元素编号（形如 e12），收到的是「${v.slice(0, 40)}」`);
  }
  return v;
};
const optRef = (args: Record<string, unknown>, key: string): string | undefined =>
  argStr(args, key) === undefined ? undefined : reqRef(args, key);
const argEnum = <T extends string>(
  args: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined => {
  const v = argStr(args, key);
  if (v === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(v)) {
    throw new BadArgs(`${key} 只能是 ${allowed.join(" / ")}，收到的是「${v.slice(0, 40)}」`);
  }
  return v as T;
};

// V1：修饰键参数（click / mouse 共用）。必须放在工具定义之前：clickTool 的 schema 在模块加载时就要读 MODIFIER_NAMES。
export const MODIFIER_NAMES = ["Alt", "Control", "Meta", "Shift"] as const;
type ModifierName = (typeof MODIFIER_NAMES)[number];
const MODIFIER_ALIASES: Record<string, ModifierName> = {
  alt: "Alt",
  option: "Alt",
  opt: "Alt",
  control: "Control",
  ctrl: "Control",
  meta: "Meta",
  cmd: "Meta",
  command: "Meta",
  shift: "Shift",
};

/**
 * modifiers 宽松解析：数组 / 逗号分隔字符串都收；大小写与常见别名（ctrl / cmd / option）归一；
 * 认不出的名字直接报错（别悄悄丢掉——丢了修饰键，Ctrl+点击会变成普通点击，行为完全不同）。
 */
export const argModifiers = (args: Record<string, unknown>, key = "modifiers"): ModifierName[] | undefined => {
  const raw = args[key];
  if (raw === undefined || raw === null || raw === "") return undefined;
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[,+\s]+/) : null;
  if (!list) throw new BadArgs(`${key} 必须是数组，元素只能是 ${MODIFIER_NAMES.join(" / ")}`);
  const out: ModifierName[] = [];
  for (const m of list) {
    if (typeof m !== "string" || m.trim() === "") continue;
    const name = MODIFIER_ALIASES[m.trim().toLowerCase()];
    if (!name) throw new BadArgs(`${key} 里的「${String(m).slice(0, 20)}」不认识，只能是 ${MODIFIER_NAMES.join(" / ")}`);
    if (!out.includes(name)) out.push(name);
  }
  return out.length > 0 ? out : undefined;
};

// ----------------- 错误 → 模型能自修复的话 -----------------

const clipMsg = (m: string): string => (m.length > 300 ? `${m.slice(0, 300)}…` : m);

/**
 * 错误描述（R1-01）：`text` 只放**我们自己写的固定文案**（可信）；主进程 message 原文单独放 `pageDetail`，
 * 一律当不可信——主进程的报错里带页面可控文字（点击被遮挡时遮挡物的文字、select 找不到选项时列出的 `<option>` 文字、
 * NAV_FAILED 的失败描述 / URL），恶意页写一句「忽略以上规则…」就能混进「可信」文本，绕过 `<untrusted_page_content>` 包裹。
 * 拼成工具结果请用 {@link appendBrowserErrorTo} / {@link browserErrorText}，不要把 `pageDetail` 拼进可信文本。
 *
 * R2-02：bridge **自己**生成的错误（`BrowserBridgeError.local === true`：取消 / 超时 / 通道不可用 / 发送失败）文案是我们写的，
 * 放进 `localDetail`（可信、不包裹、不触发结尾的「以上是网页内容」提醒）；来源不明（没标 local 的 BrowserBridgeError、
 * 普通 Error、字符串）一律进 `pageDetail`——fail-closed。
 */
export interface BrowserErrorDescription {
  code: string;
  /** 固定文案（可信，不含任何主进程 message） */
  text: string;
  /** 主进程 / 底层异常的原始 message（已截断到 300 字；不可信，空串 = 没有） */
  pageDetail: string;
  /** bridge 本地生成的错误 message（已截断到 300 字；可信，空串 = 没有）。与 pageDetail 互斥 */
  localDetail: string;
}

export const describeBrowserError = (err: unknown): BrowserErrorDescription => {
  if (err instanceof BadArgs) return { code: "BAD_ARGS", text: `参数有误：${err.message}。`, pageDetail: "", localDetail: "" };
  if (err instanceof ScreenshotTooLarge) return { code: "TOO_LARGE", text: err.message, pageDetail: "", localDetail: "" };
  const code = err instanceof BrowserBridgeError ? err.code : "INTERNAL";
  const detail = clipMsg(err instanceof Error ? err.message : String(err));
  // 只有 bridge 本地构造并显式标了 local 的才可信；其余（含来自主进程 res 的、没标记的）全部按页面内容处理
  const isLocal = err instanceof BrowserBridgeError && err.local === true;
  const pageDetail = isLocal ? "" : detail;
  const localDetail = isLocal ? detail : "";
  const out = (text: string, c: string = code): BrowserErrorDescription => ({ code: c, text, pageDetail, localDetail });
  // E2·P8（B5）：页面被调试器暂停时，主进程闸门 / 在途竞速都用 TIMEOUT 码（不新增错误码），文案带固定的「调试器暂停」。
  // 通用的「操作超时…可先 wait_for」会把模型带偏（暂停时 wait_for 同样失败），所以给专属提示：先 debug status / resume
  if (code === "TIMEOUT" && /调试器暂停/.test(detail)) {
    return out("页面被调试器暂停了（断点或页面里的 debugger 语句），页面脚本被冻结，其它浏览器工具暂时不能用。请用 browser_debug {action:\"status\"} 查看位置，再 resume / step_over 继续；不要反复重试原操作。");
  }
  switch (code) {
    case "UNAVAILABLE":
      return out("内置浏览器当前不可用（只有桌面端可用，或与桌面端的连接已断开）。请不要重试，改用其它方式或如实告诉用户。");
    case "NO_SESSION":
      return out("这个任务还没有浏览器会话（或已被关闭）。先调用 browser_navigate 打开一个网页。");
    case "USER_CONTROL":
      return out("用户正在接管浏览器，现在不能操作。请不要抢操作：结束本轮、或用 ask_user 问用户、或等用户交还控制权。");
    case "USER_TOOK_OVER":
      return out("操作进行中用户接管了浏览器，这一步可能没有完成。请不要继续操作：结束本轮、或用 ask_user 问用户；用户交还后先 browser_snapshot 看现状。");
    case "URL_BLOCKED":
      return out("这个网址被拦截。内置浏览器只允许访问公开的 http/https 网页，不允许本应用自身、本地文件和浏览器内部页面；请换一个公开网址。");
    case "REF_STALE":
      return out("这个 ref 已失效（页面已变化）。请先重新调用 browser_snapshot，用新快照里的 ref 再操作。");
    case "REF_NOT_FOUND":
      return out("找不到这个 ref。请先调用 browser_snapshot，只使用快照里列出的 ref（形如 e12）。");
    case "NOT_INTERACTABLE":
      return out("这个元素当前无法操作（被遮挡 / 不可见 / 已禁用）。可先 browser_scroll 把它滚进视野、关掉遮挡的弹层，或重新 browser_snapshot 后再试。");
    case "TIMEOUT":
      return out("操作超时，页面可能还在加载或没有响应。可先 browser_wait_for 等一下，再 browser_snapshot 看现状。");
    case "NAV_FAILED":
      // E2·P1（A4）：证书错误没被放行（用户拒绝 / 超时 / 非本机且设置里没开信任）：固定提示，不让 AI 反复重试或想办法绕过
      if (/ERR_CERT_/.test(detail)) {
        return out("导航失败：这个网站的 HTTPS 证书不受信任，且没有被放行（用户拒绝、超时未处理，或不是本机地址）。证书是否放行只能由用户在面板上决定，请不要重试或绕过；可以 ask_user 说明情况。");
      }
      return out("导航失败，请检查网址是否正确、网络是否可用，必要时换个网址。");
    case "TAB_NOT_FOUND":
      return out("找不到这个标签页。请先 browser_tabs {action:\"list\"} 看现有标签页。");
    case "CANCELLED":
      return out("操作已被取消（任务被停止或被用户打断）。请结束本轮，不要重试。");
    case "DISABLED":
      return out("browser_evaluate 没有开启（设置 → 内置浏览器 → 允许 AI 执行页面脚本）。请改用 browser_snapshot / 点击等其它工具，或 ask_user 请用户开启。");
    case "BAD_ARGS":
      return out("参数有误。");
    case "ACCESS_DISABLED":
      return out("这项能力当前被设置关闭（设置 → 内置浏览器）。请不要重试，改用其它方式，或 ask_user 请用户在设置里开启后再来。");
    case "DENIED":
      return out("用户拒绝了这次操作（或提示超时未处理）。请不要反复重试同一操作；确有必要时用 ask_user 说明原因再问一次。");
    case "UNSUPPORTED":
      return out("当前环境不支持这项操作（详情见下）。请改用其它方式，不要重试。");
    default:
      return out("浏览器内部出错，可重试一次；仍失败请如实告诉用户。", "INTERNAL");
  }
};

/**
 * 把错误描述写进 builder：固定文案可信；主进程 message 一律 {@link wrapUntrustedInline}（转义伪标记、单行）
 * 并登记「需要提醒」，结尾由 builder 补固定提醒（R1-01）；bridge 本地错误的 message 原样可信、不登记提醒（R2-02）。
 */
export const appendBrowserErrorTo = (b: ToolResultBuilder, d: BrowserErrorDescription): void => {
  b.trusted(d.text);
  if (d.localDetail) b.trusted(`详情：${d.localDetail}`);
  if (d.pageDetail) b.trusted(`详情：${wrapUntrustedInline(d.pageDetail)}`).markUntrusted();
};

/** 错误 → 工具结果文本（参数解析阶段就抛错、没走到 run() 的路径用它，保证 detail 同样被包裹） */
export const browserErrorText = (err: unknown): string => {
  const b = new ToolResultBuilder();
  appendBrowserErrorTo(b, describeBrowserError(err));
  return b.build();
};

/** 这些错误下不必再去拉用户活动（没有会话 / 通道断了 / 被取消 / 参数错，拉了也是白拉） */
const NO_ACTIVITY_CODES = new Set(["UNAVAILABLE", "CANCELLED", "BAD_ARGS", "NO_SESSION", "TOO_LARGE"]);

// ----------------- 执行骨架 -----------------

type Out = FlowshipToolResult;

const errorOut = (text: string): Out => ({ content: [{ type: "text", text }], isError: true });

interface RunSpec<R> {
  op: BrowserOp;
  args: Record<string, unknown>;
  /** 本地超时；缺省 60s */
  timeoutMs?: number;
  /** 把成功结果写进 builder；返回额外内容块（如截图）。可抛 BadArgs / Error 转成错误结果 */
  render: (result: R, b: ToolResultBuilder) => FlowshipToolContent | void;
  /** 结果后面是否附带「用户刚才的操作」（user_activity / ask_user_to_act 自己就是送达通道，不附） */
  attachActivity?: boolean;
}

const PROMPT_KIND_ZH: Record<string, string> = {
  auth: "网站登录（HTTP 认证）",
  cert: "证书不受信任",
  permission: "页面权限请求",
  evaluate: "执行页面脚本的授权",
  clientcert: "客户端证书",
};

/**
 * 契约 §15.1：把主进程结果里的 `pendingPrompts`（只有 id / kind / host / tabId）写成一句固定话。
 * 只用 kind 对应的固定中文，不拼 host（host 来自页面 / 网络，不可信）；凭据、detail 根本不在这份数据里。
 * 没有 / 形状不对 → 空串。
 */
export const pendingPromptsHint = (raw: unknown): string => {
  if (!Array.isArray(raw) || raw.length === 0) return "";
  const kinds = [
    ...new Set(
      raw
        .map((p) => (p && typeof p === "object" ? (p as { kind?: unknown }).kind : undefined))
        .filter((k): k is string => typeof k === "string" && k in PROMPT_KIND_ZH)
        .map((k) => PROMPT_KIND_ZH[k]),
    ),
  ];
  if (kinds.length === 0) return "";
  return `⏳ 面板上有等待用户处理的事项：${kinds.join("、")}。已请用户处理，这些只能由用户决定——请不要重试同一操作，也不要替用户点；先结束本轮或用 ask_user 说明，处理完再继续。`;
};

const track = (ctx: FlowshipToolContext | undefined, delta: 1 | -1): void => {
  if (!ctx?.scope || !ctx.taskId) return;
  const st = stopState();
  if (delta === 1) {
    st.scopeToTask.set(ctx.scope, ctx.taskId);
    st.inflightByScope.set(ctx.scope, (st.inflightByScope.get(ctx.scope) ?? 0) + 1);
  } else {
    const n = (st.inflightByScope.get(ctx.scope) ?? 1) - 1;
    if (n <= 0) st.inflightByScope.delete(ctx.scope);
    else st.inflightByScope.set(ctx.scope, n);
  }
};

const run = async <R>(ctx: FlowshipToolContext | undefined, spec: RunSpec<R>): Promise<Out> => {
  const taskId = ctx?.taskId;
  if (!taskId) return errorOut("内置浏览器只能在任务会话里使用（当前会话没有任务信息）。");
  const bridge = getBrowserBridge();
  if (!bridge || !bridge.isAvailable()) {
    return errorOut(describeBrowserError(new BrowserBridgeError("UNAVAILABLE", "")).text);
  }
  installBrowserStopHook();

  const b = new ToolResultBuilder();
  let extra: FlowshipToolContent = [];
  let isError = false;
  let code = "";
  track(ctx, 1);
  try {
    const result = (await bridge.request(taskId, spec.op, spec.args, {
      timeoutMs: spec.timeoutMs,
      signal: ctx?.signal,
    })) as R;
    const more = spec.render(result, b);
    if (more) extra = more;
    // 契约 §15.1：主进程在结果里带了 pendingPrompts（有等待用户处理的认证 / 证书 / 权限 / 授权提示）→ 给 AI 一句固定话，别傻等、别重试
    const hint = pendingPromptsHint((result as { pendingPrompts?: unknown } | null | undefined)?.pendingPrompts);
    if (hint) b.trusted(hint);
  } catch (err) {
    const d = describeBrowserError(err);
    isError = true;
    code = d.code;
    // d.text 只有我们自己写的固定文案；主进程 message（里面可能带页面可控文字：遮挡物文字 / option 文字 /
    // 导航失败描述，≤300 字就够写一句指令）一律走不可信包装，绝不当可信文本输出（R1-01）
    appendBrowserErrorTo(b, d);
  } finally {
    track(ctx, -1);
  }

  if (spec.attachActivity !== false && !(isError && NO_ACTIVITY_CODES.has(code))) {
    const pending = await fetchPendingUserActivity(taskId);
    if (pending) {
      appendUserActivity(b, pending.entries, {
        header: TOOL_ACTIVITY_HEADER,
        page: { title: pending.title, url: pending.url },
      });
    }
  }
  const content: FlowshipToolContent = [{ type: "text", text: b.build() }, ...(isError ? [] : extra)];
  return isError ? { content, isError: true } : { content };
};

/** 包一层：参数解析抛 BadArgs 时直接转错误结果（不走 bridge） */
const guarded =
  (fn: (args: Record<string, unknown>, ctx?: FlowshipToolContext) => Promise<Out>) =>
  async (args: Record<string, unknown>, _token: string | undefined, ctx?: FlowshipToolContext): Promise<Out> => {
    try {
      return await fn(args ?? {}, ctx);
    } catch (err) {
      return errorOut(browserErrorText(err));
    }
  };

// ----------------- 结果渲染 -----------------

interface ActionResult {
  tabId?: string;
  url?: string;
  title?: string;
  navigated?: boolean;
  newTabId?: string;
  /** V5：动作进行中（或开始前）页面挂着一个 JS 对话框，页面被它阻塞（契约 §14.1） */
  dialog?: DialogInfoLike;
  /** V5：动作因为页面上已有未处理的对话框而没有执行 */
  notExecuted?: boolean;
  /** E2·P1（A4）：该页面是在证书错误被放行的情况下加载的（本机 / 自签名信任，或用户在提示条里放行）。字段内容不进文案，只用「有没有」 */
  certOverride?: { host?: string; error?: string; source?: string };
}

/** navigate / nav_history 结果里的固定一行（A4）：certOverride 在 → AI 不会把它当成一个正常的 https 站点 */
export const CERT_OVERRIDE_LINE = "证书错误已被放行（自签名 / 本机）：这个页面的 HTTPS 证书不受信任，不要在里面输入真实密码或敏感信息。";
/** navigate 的 bridge 本地超时：页面加载 30s + 认证 / 证书提示等用户处理最多 60s + 加载宽限 15s，再留余量 */
export const NAVIGATE_BRIDGE_TIMEOUT_MS = 100_000;

/** 主进程 DialogInfo 的 server 侧形状（message / defaultPrompt 来自页面，一律不可信） */
interface DialogInfoLike {
  type?: string;
  message?: string;
  defaultPrompt?: string;
  url?: string;
  since?: number;
}

const pageLine = (r: { title?: string; url?: string }): string =>
  `页面现在：${wrapUntrustedInline(`${r.title || "（无标题）"} | ${r.url ?? ""}`.slice(0, 400))}`;

const DIALOG_HOLD_SECONDS = 20;
const DIALOG_TYPE_ZH: Record<string, string> = { alert: "提示框 alert", confirm: "确认框 confirm", prompt: "输入框 prompt", beforeunload: "离开确认框 beforeunload" };

/** 对话框的一句话描述：类型 + 页面写的文字（不可信，内联包装；调用方要 markUntrusted） */
const dialogDesc = (d: DialogInfoLike): string => {
  const type = DIALOG_TYPE_ZH[String(d.type)] ?? "对话框";
  const msg = d.message ? `「${wrapUntrustedInline(String(d.message).slice(0, 500))}」` : "";
  const dflt = d.type === "prompt" && d.defaultPrompt ? `，默认值 ${wrapUntrustedInline(String(d.defaultPrompt).slice(0, 200))}` : "";
  return `${type}${msg}${dflt}`;
};

/** 兜底策略的人话（与 tab.mjs 的 #autoHandleDialog 一致：alert / beforeunload 确定，其余取消） */
const dialogFallbackZh = (type?: string): string => (type === "alert" || type === "beforeunload" ? "确定" : "取消");

/** renderAction 在结果带 dialog 时追加的提示：说清页面被什么阻塞、怎么解、不解会怎样 */
const dialogHint = (d: DialogInfoLike, notExecuted?: boolean): string =>
  `⚠ 页面弹出了${dialogDesc(d)}，页面被它阻塞。请用 browser_dialog 处理（accept = 确定 / dismiss = 取消；${DIALOG_HOLD_SECONDS} 秒内不处理会自动${dialogFallbackZh(d.type)}）。` +
  (notExecuted
    ? "注意：这次动作被页面上已有的对话框拦下，没有执行（上面「已…」的话不作数），处理对话框后需要重新做。"
    : "刚才的动作可能还没完成，处理对话框后请 browser_snapshot 确认现状。");

/** 动作类通用渲染：一句成功话 + 页面现在 + 跳转 / 新标签提示 */
const renderAction =
  (what: string) =>
  (r: ActionResult, b: ToolResultBuilder): void => {
    b.trusted(`${what}。`);
    if (r && (r.url || r.title)) b.trusted(pageLine(r)).markUntrusted();
    if (r?.navigated) b.trusted("页面已跳转，之前的 ref 已全部失效，请重新调用 browser_snapshot。");
    if (r?.newTabId) b.trusted(`操作打开了新标签页 ${r.newTabId}（可用 browser_tabs 的 select 切换过去）。`);
    if (r?.dialog) b.trusted(dialogHint(r.dialog, r.notExecuted)).markUntrusted();
  };

const tabLines = (tabs: BrowserTabInfo[] | undefined): string =>
  (tabs ?? [])
    .map((t) => `${t.id}${t.isActive ? " *" : ""}  ${t.title || "（无标题）"}  ${t.url}${t.loading ? "  [加载中]" : ""}${t.incognito ? "  [无痕]" : ""}`)
    .join("\n");

const clock = (ts: number): string => {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "--:--:--" : d.toTimeString().slice(0, 8);
};

const clipEntry = (s: unknown, n = 500): string => {
  const t = String(s ?? "");
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** 页面来源的单条文本：**先脱敏后截断**（顺序不能反：先截会把凭据劈开，残留的前半段匹配不上） */
const clipRedacted = (s: unknown, n = 500): string => clipEntry(redactSensitiveText(String(s ?? "")), n);

// ----------------- 工具定义 -----------------

const REF_SCHEMA = TBString({ description: "snapshot 里的 ref，如 e12" });

const navigateTool: FlowshipToolDef = {
  name: "browser_navigate",
  label: "浏览器·打开网页",
  description:
    "在内置浏览器里打开网址，或后退 / 前进 / 刷新（用 action）。打开后用 browser_snapshot 查看页面。",
  parameters: TBObject({
    url: TBOptional(TBString()),
    action: TBOptional(TBEnum(["back", "forward", "reload"])),
  }),
  handler: guarded(async (args, ctx) => {
    const url = argStr(args, "url");
    const action = argEnum(args, "action", ["back", "forward", "reload"] as const);
    if (url && action) throw new BadArgs("url 和 action 只能给一个");
    if (!url && !action) throw new BadArgs("需要 url（打开网址）或 action（back / forward / reload）");
    if (url) {
      return run<ActionResult & { status?: number | null }>(ctx, {
        op: "navigate",
        // E2·P1：页面加载 30s + 认证 / 证书提示等用户处理最多再 60s（+ 加载宽限 15s）——桥的本地超时放宽到 100s，免得用户还在填密码这边先 TIMEOUT
        args: { url, timeoutMs: 30_000 },
        timeoutMs: NAVIGATE_BRIDGE_TIMEOUT_MS,
        render: (r, b) => {
          b.trusted(`已打开网址${r?.status ? `（HTTP ${r.status}）` : ""}。`);
          if (r) b.trusted(pageLine(r)).markUntrusted();
          if (r?.certOverride) b.trusted(CERT_OVERRIDE_LINE);
          b.trusted("页面已加载，之前的 ref 已全部失效；需要看内容请调用 browser_snapshot。");
        },
      });
    }
    return run<ActionResult>(ctx, {
      op: "nav_history",
      args: { direction: action },
      render: (r, b) => {
        const label = action === "back" ? "已后退" : action === "forward" ? "已前进" : "已刷新";
        b.trusted(`${label}。`);
        if (r) b.trusted(pageLine(r)).markUntrusted();
        if (r?.certOverride) b.trusted(CERT_OVERRIDE_LINE);
        b.trusted("之前的 ref 已全部失效，请重新调用 browser_snapshot。");
      },
    });
  }),
};

interface SnapshotResult {
  tabId?: string;
  url?: string;
  title?: string;
  text?: string;
  refCount?: number;
  truncated?: boolean;
  tabs?: BrowserTabInfo[];
  scroll?: { x: number; y: number; viewportW: number; viewportH: number; docH: number };
}

const snapshotTool: FlowshipToolDef = {
  name: "browser_snapshot",
  label: "浏览器·页面快照",
  description:
    "获取当前页面的文字快照：可交互元素带 ref 编号，后续点击 / 输入都用这个编号。操作前先调用它，页面变化后要重新调用；页面很大时用 query 只看相关元素（ref 不变）。",
  parameters: TBObject({
    viewport_only: TBOptional(TBBoolean({ description: "只返回当前视口内的元素（页面很长时用）" })),
    query: TBOptional(TBString({ description: "关键词（大小写不敏感）：只返回命中行 + 所在层级 + 前后各 2 行上下文" })),
  }),
  handler: guarded(async (args, ctx) => {
    const viewportOnly = argBool(args, "viewport_only");
    const query = argStr(args, "query")?.trim().slice(0, 200) || undefined;
    return run<SnapshotResult>(ctx, {
      op: "snapshot",
      args: { ...(viewportOnly ? { viewportOnly: true } : {}), ...(query ? { query } : {}) },
      render: (r, b) => {
        const s = r?.scroll;
        const meta = [
          `标签页 ${r?.tabId ?? "?"}`,
          `可交互元素 ${r?.refCount ?? 0} 个`,
          s ? `滚动 ${Math.round(s.y)}/${Math.round(s.docH)}px（视口 ${s.viewportW}×${s.viewportH}）` : "",
        ]
          .filter(Boolean)
          .join("｜");
        b.trusted(`页面快照｜${meta}`);
        if (r?.truncated) {
          b.trusted("（内容已被截断：可传 viewport_only=true、先滚动到目标区域再快照，或直接操作已看到的元素。）");
        }
        const head = [`标题：${r?.title ?? ""}`, `URL：${r?.url ?? ""}`];
        if ((r?.tabs?.length ?? 0) > 1) head.push("标签页（* 为当前）：", tabLines(r?.tabs));
        b.untrusted(`${head.join("\n")}\n\n${r?.text ?? ""}`, { url: r?.url });
      },
    });
  }),
};

interface ScreenshotResult {
  tabId?: string;
  mimeType?: string;
  dataBase64?: string;
  width?: number;
  height?: number;
  /** 视口 CSS 尺寸（V1）：browser_mouse 的坐标系 */
  viewportW?: number;
  viewportH?: number;
  /** E2·P5a：实际输出格式 / annotate 结果 */
  format?: string;
  annotated?: boolean;
  legend?: string[];
  annotatedCount?: number;
  annotationOmitted?: number;
}

const screenshotTool: FlowshipToolDef = {
  name: "browser_screenshot",
  label: "浏览器·截图",
  description:
    "对当前页面（或某个 ref 元素）截图，返回图片；只在需要视觉判断（布局 / 图表 / 验证码是否出现）时用，日常操作用 browser_snapshot。默认 jpeg（体积小），可用 format / quality / max_width / scale / clip / omit_background 调整，annotate=true 会在图上标出视口内可交互元素的 ref 编号并附 legend（需先 browser_snapshot）。",
  parameters: TBObject({
    ref: TBOptional(REF_SCHEMA),
    full_page: TBOptional(TBBoolean()),
    format: TBOptional(TBEnum(["png", "jpeg", "webp"], { description: "输出格式，默认 jpeg；annotate 不支持 webp" })),
    quality: TBOptional(TBNumber({ description: "1–100，仅 jpeg / webp（默认 70）" })),
    max_width: TBOptional(TBNumber({ description: "输出像素宽上限 100–4096（默认 1280；显式传 scale 时默认 4096）" })),
    scale: TBOptional(TBNumber({ description: "缩放倍数 0.1–3" })),
    clip: TBOptional(
      TBObject(
        { x: TBNumber(), y: TBNumber(), width: TBNumber(), height: TBNumber() },
        { description: "视口 CSS 像素的局部区域（原点在视口左上角，宽高 ≤8192）；与 full_page / ref / annotate 互斥" },
      ),
    ),
    omit_background: TBOptional(TBBoolean({ description: "透明背景，仅 png" })),
    annotate: TBOptional(TBBoolean({ description: "画出 ref 编号（≤80 个，只含视口内元素）；不能与 full_page / ref / clip 同用" })),
  }),
  handler: guarded(async (args, ctx) => {
    const ref = optRef(args, "ref");
    // 默认仍是 jpeg 70 / 宽 1280（体积预算见 SCREENSHOT_MAX_BYTES）；新参数的校验与互斥在 screenshot-scroll-args.ts
    const opArgs = parseScreenshotArgs(args, ref, BadArgs);
    return run<ScreenshotResult>(ctx, {
      op: "screenshot",
      args: { ...opArgs },
      render: (r, b) => {
        const data = typeof r?.dataBase64 === "string" ? r.dataBase64 : "";
        const mime = typeof r?.mimeType === "string" ? r.mimeType : "";
        if (!data || !SCREENSHOT_MIMES.has(mime)) {
          throw new Error("截图结果无效（缺少图片数据或格式不受支持）");
        }
        const bytes = Math.floor((data.length * 3) / 4);
        if (bytes > SCREENSHOT_MAX_BYTES) {
          // 抛成普通错误会变成「内部出错」；这里给能自修复的建议
          throw new ScreenshotTooLarge(bytes);
        }
        const vp =
          typeof r?.viewportW === "number" && typeof r?.viewportH === "number" && r.viewportW > 0 && r.viewportH > 0
            ? `视口 ${r.viewportW}×${r.viewportH}（browser_mouse 的坐标用这个坐标系，图片像素不等于坐标）。`
            : "";
        b.trusted(
          `截图完成：${r?.width ?? "?"}×${r?.height ?? "?"}，约 ${Math.max(1, Math.round(bytes / 1024))}KB（${mime.replace("image/", "")}，标签页 ${r?.tabId ?? "?"}）。${vp}`,
        );
        if (r?.annotated === true) {
          const n = typeof r.annotatedCount === "number" ? r.annotatedCount : (r.legend?.length ?? 0);
          const omitted = typeof r.annotationOmitted === "number" && r.annotationOmitted > 0 ? `，另有 ${r.annotationOmitted} 个较小元素未标注` : "";
          b.trusted(`已在图上标注 ${n} 个视口内的可交互元素（品红框 + 编号 = ref）${omitted}。对照 legend 用编号调用 browser_click 等工具：`);
          const legend = renderLegend(r.legend, redactSensitiveText);
          // 元素名来自页面：不可信包装 + 脱敏
          if (legend) b.untrusted(legend);
          else b.trusted("（视口内没有取到可标注元素：ref 表可能已失效，请先 browser_snapshot 再试。）");
        }
        return [{ type: "image", data, mimeType: mime }];
      },
    });
  }),
};

const clickTool: FlowshipToolDef = {
  name: "browser_click",
  label: "浏览器·点击",
  description:
    "点击 browser_snapshot 里的某个元素（ref）。可选右键 / 中键 / 双击；modifiers 可带 Control / Meta / Shift / Alt（如 Meta 或 Control+点击链接 = 在新标签页打开）。",
  parameters: TBObject({
    ref: REF_SCHEMA,
    button: TBOptional(TBEnum(["left", "right", "middle"])),
    double_click: TBOptional(TBBoolean()),
    modifiers: TBOptional(TBArray(TBEnum([...MODIFIER_NAMES]))),
  }),
  handler: guarded(async (args, ctx) => {
    const ref = reqRef(args, "ref");
    const button = argEnum(args, "button", ["left", "right", "middle"] as const);
    const dbl = argBool(args, "double_click");
    const modifiers = argModifiers(args);
    return run<ActionResult>(ctx, {
      op: "click",
      args: {
        ref,
        ...(button ? { button } : {}),
        ...(dbl ? { doubleClick: true } : {}),
        ...(modifiers ? { modifiers } : {}),
      },
      render: renderAction(`已${modifiers ? `${modifiers.join("+")}+` : ""}${dbl ? "双击" : "点击"} ${ref}`),
    });
  }),
};

const hoverTool: FlowshipToolDef = {
  name: "browser_hover",
  label: "浏览器·悬停",
  description: "把鼠标悬停到某个元素（ref）上，用于展开悬浮菜单 / 提示。",
  parameters: TBObject({ ref: REF_SCHEMA }),
  handler: guarded(async (args, ctx) => {
    const ref = reqRef(args, "ref");
    return run<ActionResult>(ctx, { op: "hover", args: { ref }, render: renderAction(`已悬停 ${ref}`) });
  }),
};

const typeTool: FlowshipToolDef = {
  name: "browser_type",
  label: "浏览器·输入文字",
  description: "向输入框（ref）输入文字，默认先清空；submit=true 输入后按回车。密码框也可以直接输入（口令用用户给你的，别猜）。",
  parameters: TBObject({
    ref: REF_SCHEMA,
    text: TBString(),
    submit: TBOptional(TBBoolean()),
    clear: TBOptional(TBBoolean()),
  }),
  handler: guarded(async (args, ctx) => {
    const ref = reqRef(args, "ref");
    // text 允许空串（清空输入框），所以不走 reqStr
    const text = typeof args.text === "string" ? args.text : undefined;
    if (text === undefined) throw new BadArgs("缺少必填参数 text");
    const submit = argBool(args, "submit");
    const clear = argBool(args, "clear");
    return run<ActionResult>(ctx, {
      op: "type",
      args: { ref, text, ...(submit ? { submit: true } : {}), ...(clear === false ? { clear: false } : {}) },
      render: renderAction(`已在 ${ref} 输入 ${text.length} 个字符${submit ? "并提交" : ""}`),
    });
  }),
};

const pressKeyTool: FlowshipToolDef = {
  name: "browser_press_key",
  label: "浏览器·按键",
  description: "按键或组合键，如 Enter、Escape、Control+a、Meta+Enter；可指定先聚焦某个元素（ref）。",
  parameters: TBObject({ key: TBString(), ref: TBOptional(REF_SCHEMA) }),
  handler: guarded(async (args, ctx) => {
    const key = reqStr(args, "key");
    const ref = optRef(args, "ref");
    return run<ActionResult>(ctx, {
      op: "press_key",
      args: { key, ...(ref ? { ref } : {}) },
      // 会打出可见字符的键（单字符 / Shift+字符）不回显：落盘的 args 已隐藏成 [已隐藏 1 字符]，结果文案再原样写出就抵消了（R2-03 ①）；
      // Enter / Tab / Control+a 这类命名键不是文本输入，保留名字让模型看得懂。判定与 redact-args 共用同一个函数
      render: renderAction(`已按键${keyTypesCharacter(key) ? "（1 个字符）" : ` ${key}`}`),
    });
  }),
};

const selectTool: FlowshipToolDef = {
  name: "browser_select",
  label: "浏览器·选择下拉项",
  description: "在下拉框（ref）里选择一个或多个选项（按选项文字或 value）。",
  parameters: TBObject({ ref: REF_SCHEMA, values: TBArray(TBString()) }),
  handler: guarded(async (args, ctx) => {
    const ref = reqRef(args, "ref");
    const raw = args.values;
    const values = (Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [])
      .filter((v): v is string => typeof v === "string")
      .slice(0, 50);
    if (values.length === 0) throw new BadArgs("values 至少要有一项");
    return run<ActionResult>(ctx, {
      op: "select",
      args: { ref, values },
      render: renderAction(`已在 ${ref} 选择 ${values.length} 项`),
    });
  }),
};

const SCROLL_DIRS = ["up", "down", "left", "right", "top", "bottom"] as const;

const scrollTool: FlowshipToolDef = {
  name: "browser_scroll",
  label: "浏览器·滚动",
  description:
    "滚动页面（或某个可滚动元素 ref）：方向 up/down/left/right/top/bottom，amount 为像素（默认约 0.8 个视口）。三种模式互斥：① direction / amount（可带 ref 指定滚动容器）；② scroll_into_view=true + ref：把元素滚到视口中央；③ until_stable（true 或 {max_steps≤30 默认 10, step_timeout_ms≤5000 默认 3000, timeout_ms 总时限≤45000}）：无限滚动页辅助，反复滚到底并等新内容加载，连续两轮没有新内容或到步数上限就停，结果给步数 / 高度前后 / 是否到底。",
  parameters: TBObject({
    ref: TBOptional(REF_SCHEMA),
    direction: TBOptional(TBEnum([...SCROLL_DIRS])),
    amount: TBOptional(TBNumber()),
    scroll_into_view: TBOptional(TBBoolean()),
    until_stable: TBOptional(
      TBObject({ max_steps: TBOptional(TBNumber()), step_timeout_ms: TBOptional(TBNumber()), timeout_ms: TBOptional(TBNumber()) }),
    ),
  }),
  handler: guarded(async (args, ctx) => {
    const ref = optRef(args, "ref");
    const direction = argEnum(args, "direction", SCROLL_DIRS);
    const amount = argNum(args, "amount");
    const opArgs = parseScrollArgs(args, { ref, direction, amount }, BadArgs, (raw) => reqRef({ "scroll_into_view.ref": raw }, "scroll_into_view.ref"));
    return run<ActionResult & { scroll?: { y: number; docH: number }; untilStable?: UntilStableResult }>(ctx, {
      op: "scroll",
      args: { ...opArgs },
      // R6-17：until_stable 主进程总时限 ≤45s，bridge 超时给 55s（> 上限 + 收尾余量）；超时后 bridge 会向主进程发 cancel{id}
      ...(opArgs.untilStable ? { timeoutMs: UNTIL_STABLE_BRIDGE_TIMEOUT_MS } : {}),
      render: (r, b) => {
        renderAction(
          opArgs.untilStable
            ? "已滚动到底并等待内容加载"
            : opArgs.scrollIntoView
              ? `已把 ${opArgs.ref} 滚动到视口中央`
              : `已滚动${direction ? `（${direction}）` : ""}`,
        )(r, b);
        if (r?.untilStable) b.trusted(renderUntilStable(r.untilStable));
        if (r?.scroll) b.trusted(`当前滚动位置 ${Math.round(r.scroll.y)}/${Math.round(r.scroll.docH)}px。`);
      },
    });
  }),
};

const dragTool: FlowshipToolDef = {
  name: "browser_drag",
  label: "浏览器·拖拽",
  description: "把一个元素（from_ref）拖到另一个元素（to_ref）上。",
  parameters: TBObject({ from_ref: REF_SCHEMA, to_ref: REF_SCHEMA }),
  handler: guarded(async (args, ctx) => {
    const fromRef = reqRef(args, "from_ref");
    const toRef = reqRef(args, "to_ref");
    return run<ActionResult>(ctx, {
      op: "drag",
      args: { fromRef, toRef },
      render: renderAction(`已把 ${fromRef} 拖到 ${toRef}`),
    });
  }),
};

const waitForTool: FlowshipToolDef = {
  name: "browser_wait_for",
  label: "浏览器·等待",
  description:
    "等待条件（六选一）：文字出现 text / 消失 text_gone、URL 含 url_contains（区分大小写）、ref_visible 可见、time_ms 纯等待（≤30000）、network_idle=true 网络空闲（无在途请求持续 0.5 秒；长连接 / 轮询页可能永远等不到）。",
  parameters: TBObject({
    text: TBOptional(TBString()),
    text_gone: TBOptional(TBString()),
    time_ms: TBOptional(TBNumber()),
    url_contains: TBOptional(TBString()),
    network_idle: TBOptional(TBBoolean()),
    ref_visible: TBOptional(REF_SCHEMA),
    timeout_ms: TBOptional(TBNumber()),
  }),
  handler: guarded(async (args, ctx) => {
    const text = argStr(args, "text");
    const textGone = argStr(args, "text_gone");
    const timeMs = argNum(args, "time_ms");
    const urlContains = argStr(args, "url_contains");
    const networkIdle = argBool(args, "network_idle") === true ? true : undefined; // false 等于没给
    const refVisible = optRef(args, "ref_visible");
    const given = [text, textGone, timeMs, urlContains, networkIdle, refVisible].filter((v) => v !== undefined).length;
    if (given !== 1) throw new BadArgs("text / text_gone / time_ms / url_contains / network_idle / ref_visible 必须且只能给一个");
    if (timeMs !== undefined && (timeMs < 0 || timeMs > 30_000)) throw new BadArgs("time_ms 范围是 0~30000");
    const timeoutMs = Math.min(Math.max(argNum(args, "timeout_ms") ?? 15_000, 1000), 120_000);
    return run<{ matched?: boolean; elapsedMs?: number }>(ctx, {
      op: "wait_for",
      args: {
        ...(text ? { text } : {}),
        ...(textGone ? { textGone } : {}),
        ...(timeMs !== undefined ? { timeMs } : {}),
        ...(urlContains ? { urlContains } : {}),
        ...(networkIdle ? { networkIdle: true } : {}),
        ...(refVisible ? { refVisible } : {}),
        timeoutMs,
      },
      timeoutMs: (timeMs ?? timeoutMs) + WAITING_SLACK_MS,
      render: (r, b) => {
        const sec = ((r?.elapsedMs ?? 0) / 1000).toFixed(1);
        if (timeMs !== undefined) b.trusted(`已等待 ${sec}s。`);
        else if (r?.matched) b.trusted(`条件已满足（等了 ${sec}s）。页面可能已变化，建议 browser_snapshot 查看。`);
        else if (networkIdle) b.trusted(`超时，网络一直没有空闲（等了 ${sec}s）：页面可能有长连接 / 轮询 / 流式请求。可改用 text / ref_visible 等具体条件，或 browser_snapshot 看现状。`);
        else b.trusted(`超时，条件没有满足（等了 ${sec}s）。可 browser_snapshot 看现状再决定。`);
      },
    });
  }),
};

const tabsTool: FlowshipToolDef = {
  name: "browser_tabs",
  label: "浏览器·标签页",
  description: "列出 / 新建（url 可选）/ 切换 / 关闭标签页；select 和 close 需要 tab_id。new 可带 incognito:true 开无痕标签页（内存 partition：不共享已有登录态，关闭即销毁）。",
  parameters: TBObject({
    action: TBEnum(["list", "new", "select", "close"]),
    tab_id: TBOptional(TBString()),
    url: TBOptional(TBString()),
    incognito: TBOptional(
      TBBoolean({
        description:
          "仅 action=new 可用：true = 无痕标签页（使用内存 partition，不共享用户已有的登录态，也看不到已有 cookie；标签页关闭即销毁其全部数据）。适合「用一个干净的身份 / 另一个账号访问」；默认（不填）用与用户共享的浏览档案。",
      }),
    ),
  }),
  handler: guarded(async (args, ctx) => {
    const action = argEnum(args, "action", ["list", "new", "select", "close"] as const);
    if (!action) throw new BadArgs("缺少必填参数 action");
    const tabId = argStr(args, "tab_id");
    const url = argStr(args, "url");
    if ((action === "select" || action === "close") && !tabId) throw new BadArgs(`${action} 需要 tab_id`);
    // incognito 要严格：argBool 对「看不懂的值」返回 undefined，若静默当没给，AI 要的无痕就悄悄变成了共享登录态的普通标签页——这是隐私方向的错
    const incognito = argBool(args, "incognito");
    if (args.incognito !== undefined && args.incognito !== null && incognito === undefined) {
      throw new BadArgs("incognito 必须是布尔值 true / false");
    }
    if (incognito === true && action !== "new") throw new BadArgs("incognito 只能和 action=new 一起用（无痕是新建标签页时的选项）");
    return run<{ tabs?: BrowserTabInfo[]; activeTabId?: string }>(ctx, {
      op: "tabs",
      args: { action, ...(tabId ? { tabId } : {}), ...(url ? { url } : {}), ...(incognito === true ? { incognito: true } : {}) },
      render: (r, b) => {
        const label = {
          list: "标签页列表",
          new: incognito === true ? "已新建无痕标签页（独立内存档案：不共享登录态，关闭即销毁）" : "已新建标签页",
          select: "已切换标签页",
          close: "已关闭标签页",
        }[action];
        b.trusted(`${label}，当前活动标签页：${r?.activeTabId ?? "无"}。${action === "list" ? "" : "切换 / 新建 / 关闭后之前的 ref 失效，请重新 browser_snapshot。"}`);
        b.untrusted(tabLines(r?.tabs) || "（没有标签页）");
      },
    });
  }),
};

/** E2·P7a B3：console 条目的结构化栈帧（line / column 沿用 CDP 的 0 起；original 是 sourcemap 还原后的 1 起位置） */
interface ConsoleStackFrame {
  functionName?: string;
  url?: string;
  line?: number;
  column?: number;
  original?: { source?: string; line?: number; column?: number; name?: string };
}

interface ConsoleEntry {
  ts: number;
  level: string;
  text: string;
  url?: string;
  line?: number;
  stack?: ConsoleStackFrame[];
}

/** 栈帧一行（页面内容：函数名 / URL 先脱敏后截断）；还原成功的帧显示原始 file:line:col。 */
const consoleStackLine = (f: ConsoleStackFrame): string => {
  const fn = f.functionName ? clipRedacted(f.functionName, 60) : "<匿名>";
  const gen = `${clipRedacted(f.url || "<inline>", 160)}:${(f.line ?? 0) + 1}:${(f.column ?? 0) + 1}`;
  if (f.original?.source) {
    const o = f.original;
    return `  at ${o.name ? clipRedacted(o.name, 60) : fn} (${clipRedacted(o.source, 200)}:${o.line ?? 0}:${o.column ?? 0}) ← 压缩后 ${gen}`;
  }
  return `  at ${fn} (${gen})`;
};

const consoleTool: FlowshipToolDef = {
  name: "browser_console",
  label: "浏览器·控制台",
  description: "读取页面控制台输出（可按 error / warning 过滤，默认最近 50 条）。sourcemap:true 附调用栈并还原到原始源码位置。",
  parameters: TBObject({
    level: TBOptional(TBEnum(["all", "error", "warning"])),
    limit: TBOptional(TBNumber()),
    clear: TBOptional(TBBoolean()),
    sourcemap: TBOptional(TBBoolean({ description: "附调用栈并经 sourcemap 还原（取不到则保留原栈）" })),
  }),
  handler: guarded(async (args, ctx) => {
    const level = argEnum(args, "level", ["all", "error", "warning"] as const);
    const limit = Math.min(Math.max(Math.floor(argNum(args, "limit") ?? 50), 1), 200);
    const clear = argBool(args, "clear");
    const sourcemap = argBool(args, "sourcemap");
    return run<{ entries?: ConsoleEntry[]; dropped?: number; sourcemap?: { resolvedFrames?: number; note?: string } }>(ctx, {
      op: "console",
      args: { ...(level ? { level } : {}), limit, ...(clear ? { clear: true } : {}), ...(sourcemap ? { sourcemap: true } : {}) },
      render: (r, b) => {
        const entries = r?.entries ?? [];
        if (entries.length === 0) {
          b.trusted("没有匹配的控制台输出。");
          return;
        }
        // 页面 console.log 出来的 token / 口令照样会进上下文并落盘：先脱敏、再截断（先截会把 JWT 劈成两段漏过匹配，R1-19）
        const lines = entries.flatMap((e) => {
          const head = `[${clock(e.ts)}][${e.level}] ${clipRedacted(e.text)}${e.url ? ` (${clipRedacted(e.url, 160)}${e.line ? `:${e.line}` : ""})` : ""}`;
          // E2·P7a B3：sourcemap:true 才有 stack（主进程不带就不渲染）；每条最多 10 帧
          const stack = sourcemap && Array.isArray(e.stack) ? e.stack.slice(0, 10).map(consoleStackLine) : [];
          return [head, ...stack];
        });
        const sm = r?.sourcemap;
        b.trusted(
          `控制台输出 ${entries.length} 条${r?.dropped ? `（更早的 ${r.dropped} 条已被丢弃）` : ""}：` +
            (sm ? `${sm.resolvedFrames ? `已用 sourcemap 还原 ${sm.resolvedFrames} 个栈帧（标「← 压缩后」的是还原结果）。` : "没有栈帧能用 sourcemap 还原，已显示原栈。"}` : ""),
        );
        b.untrusted(truncateWithNote(lines.join("\n"), MAX_LOG_TEXT_CHARS).text);
        if (sm?.note) b.untrusted(`sourcemap：${clipRedacted(sm.note, 200)}`);
      },
    });
  }),
};

interface NetworkEntry extends NetworkExtras {
  /** 条目 id（browser_network 的 request_id 用；老壳没有） */
  id?: number;
  ts: number;
  method: string;
  url: string;
  status: number | null;
  type: string;
  durationMs?: number;
  failed?: boolean;
  errorText?: string;
}

/** network_detail 的结果（主进程已脱敏头；body 里的凭据样式 server 再扫一遍） */
interface NetworkDetailResult extends NetworkExtras {
  /** E2·S3 B1：WebSocket / SSE 条目的帧 / 事件列表 */
  frames?: StreamFramesInfo;
  id?: number;
  method?: string;
  url?: string;
  status?: number | null;
  type?: string;
  durationMs?: number;
  failed?: boolean;
  errorText?: string;
  mimeType?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  bodyTruncated?: boolean;
  bodyUnavailableReason?: string;
}

const headerLines = (h: Record<string, string> | undefined): string[] =>
  // 整行（键 + 值）一起脱敏再截断：键名是判定依据（`x-api-key: abc`），分开扫会丢掉上下文
  Object.entries(h ?? {}).map(([k, v]) => `  ${clipRedacted(`${clipEntry(k, 80)}: ${String(v ?? "")}`, 580)}`);

/**
 * 一条请求的详情渲染。头 / URL / body 全是页面数据：整段先过 {@link redactSensitiveText}（Bearer / token= / password= / JWT），
 * **再**截断（先截断会把一个 JWT 劈成两段、漏过「三段」匹配），最后整体 untrusted 包装。
 */
/**
 * 可信行里只放「形状受限」的页面可控字段（R3-02 ③）：method / type 来自主进程转述页面发起的请求，HTTP method 是 token、资源类型是枚举，
 * 不符合形状就退成 "?"，不让任意文字借可信行进来；id / status / 时长只认有限数字。
 */
const safeToken = (v: unknown, maxLen: number): string =>
  typeof v === "string" && new RegExp(`^[A-Za-z][A-Za-z-]{0,${maxLen - 1}}$`).test(v) ? v : "?";
const safeInt = (v: unknown): string => (typeof v === "number" && Number.isFinite(v) ? String(Math.trunc(v)) : "");

const renderNetworkDetail = (r: NetworkDetailResult, b: ToolResultBuilder): void => {
  const duration = typeof r?.durationMs === "number" && Number.isFinite(r.durationMs) ? `｜${Math.round(r.durationMs)}ms` : "";
  b.trusted(
    `请求 #${safeInt(r?.id) || "?"} 详情｜${safeToken(r?.method, 16)} ${safeInt(r?.status) || "-"}｜${safeToken(r?.type, 24)}${duration}${r?.failed === true ? "｜失败" : ""}`,
  );
  const lines: string[] = [`URL：${clipRedacted(r?.url, 600)}`];
  if (r?.failed && r.errorText) lines.push(`失败原因：${clipRedacted(r.errorText, 200)}`);
  if (r?.mimeType) lines.push(`响应类型：${clipRedacted(r.mimeType, 100)}`);
  // E2·S3 B1：规则标记 / 缓存命中 / SW / 发起者栈
  const flags = entryFlags(r ?? {}).trim();
  if (flags) lines.push(`标记：${flags}`);
  lines.push(...initiatorLines(r?.initiator));
  lines.push("请求头：", ...headerLines(r?.requestHeaders));
  lines.push("响应头：", ...headerLines(r?.responseHeaders));
  lines.push(...streamFrameLines(r?.frames));
  if (typeof r?.requestBody === "string") lines.push("请求体：", r.requestBody);
  if (typeof r?.responseBody === "string") lines.push("响应体：", r.responseBody);
  if (r?.bodyTruncated) lines.push("（body 已按 20000 字符截断）");
  if (r?.bodyUnavailableReason) lines.push(`响应体不可用：${clipRedacted(r.bodyUnavailableReason, 300)}`);
  b.untrusted(truncateWithNote(redactSensitiveText(lines.join("\n")), MAX_LOG_TEXT_CHARS).text, { url: r?.url });
};

/**
 * include_body 看独立开关 networkBodyRead（E2·A7 起不再借用 evaluate 总闸）：专属文案，指向对应的设置项。
 * 默认开；只有用户显式关掉才拒（ACCESS_DISABLED）。
 */
const NETWORK_BODY_DISABLED =
  "读取请求 / 响应体（include_body）被关闭了：用户在 设置 → 内置浏览器 里关掉了「允许 AI 读取网络响应内容」（响应体可能含任意页面数据）。不带 include_body 仍可查看这条请求的头与状态；确有需要请 ask_user 请用户重新开启。";

const networkTool: FlowshipToolDef = {
  name: "browser_network",
  label: "浏览器·网络请求",
  description:
    "读取页面网络请求（默认最近 50 条，行首 #数字是请求 id），可按 filter / type（含 WebSocket、EventSource）/ status（404、4xx、failed）/ method / url_regex / failed_only / since_id 过滤；传 request_id 看单条详情（头 / 状态 / 发起者，WebSocket 与 SSE 条目给帧列表），加 include_body=true 读请求 / 响应体（需设置「允许 AI 读取网络响应内容」）。" +
    "action=export_har 把网络记录导出成已脱敏的 HAR 文件（写到任务目录）。",
  parameters: TBObject({
    filter: TBOptional(TBEnum(["all", "failed", "xhr"])),
    limit: TBOptional(TBNumber()),
    clear: TBOptional(TBBoolean()),
    request_id: TBOptional(TBNumber({ description: "列表里 # 后的请求 id" })),
    include_body: TBOptional(TBBoolean({ description: "与 request_id 同用；文本类，各 ≤20000 字符" })),
    frame_limit: TBOptional(TBNumber({ description: "与 request_id 同用、只对 WebSocket / SSE 条目：看最近几帧（1–200，默认 50）；帧内容需同时 include_body=true" })),
    type: TBOptional(TBString({ description: "资源类型：XHR / Fetch / Document / Script / Stylesheet / Image / WebSocket / EventSource …；逗号分隔可多选，也认 ws / sse / js / css / img" })),
    status: TBOptional(TBString({ description: "404（精确）| 4xx（一类）| failed（网络层失败：被拦截 / 连不上，没有响应；不含 4xx / 5xx）" })),
    method: TBOptional(TBString({ description: "HTTP 方法，如 POST 或 POST,PUT" })),
    url_regex: TBOptional(TBString({ description: "对（已脱敏的）URL 匹配的正则，≤100 字符、不区分大小写；不支持回溯引用 / 环视 / 嵌套量词" })),
    failed_only: TBOptional(TBBoolean({ description: "只要失败的（含 4xx / 5xx 与网络层失败）" })),
    since_id: TBOptional(TBNumber({ description: "只要 id 大于它的请求（增量轮询：用上次结果里提示的 since_id）" })),
    action: TBOptional(TBEnum(["list", "export_har"])),
    include_bodies: TBOptional(TBBoolean({ description: "只对 export_har：是否带请求 / 响应体（默认带；受设置「允许 AI 读取网络响应内容」控制）" })),
  }),
  handler: guarded(async (args, ctx) => {
    const filterArgs = parseNetworkFilterArgs(args);
    // E2·S3 B1：导出 HAR（工具数量克制：放在 browser_network 的 action 里）
    if (argEnum(args, "action", ["list", "export_har"] as const) === "export_har") {
      const bodies = argBool(args, "include_bodies");
      const limit = Math.min(Math.max(Math.floor(argNum(args, "limit") ?? 500), 1), 500);
      return run<HarExportResult>(ctx, {
        op: "net_export",
        args: { ...filterArgs, limit, ...(bodies === false ? { includeBodies: false } : {}) },
        render: (r, b) => renderHarExport(r, b, wrapUntrustedInline),
      });
    }
    // 详情分支：request_id 给了就走 network_detail（给了但不是正整数 → 参数错，别悄悄退回列表）
    if (args.request_id !== undefined && args.request_id !== null && args.request_id !== "") {
      const rid = argNum(args, "request_id");
      if (rid === undefined || !Number.isInteger(Math.floor(rid)) || Math.floor(rid) < 1) {
        throw new BadArgs("request_id 必须是 browser_network 列表里 # 后面的正整数");
      }
      const includeBody = argBool(args, "include_body") === true;
      if (includeBody && !getBrowserSettingsSync().networkBodyRead) return errorOut(NETWORK_BODY_DISABLED);
      const frameLimit = argNum(args, "frame_limit");
      return run<NetworkDetailResult>(ctx, {
        op: "network_detail",
        args: {
          id: Math.floor(rid),
          ...(includeBody ? { includeBody: true } : {}),
          ...(frameLimit !== undefined ? { frameLimit: Math.min(Math.max(Math.floor(frameLimit), 1), 200) } : {}),
        },
        render: renderNetworkDetail,
      });
    }
    const limit = Math.min(Math.max(Math.floor(argNum(args, "limit") ?? 50), 1), 200);
    const clear = argBool(args, "clear");
    return run<{ entries?: NetworkEntry[]; dropped?: number; matched?: number; hasMore?: boolean; lastId?: number }>(ctx, {
      op: "network",
      args: { ...filterArgs, limit, ...(clear ? { clear: true } : {}) },
      render: (r, b) => {
        const entries = r?.entries ?? [];
        const cursor = listCursorLine(r ?? {}, entries.length, filterArgs.sinceId !== undefined);
        if (entries.length === 0) {
          b.trusted(`没有匹配的网络请求。${cursor ? `（${cursor}）` : ""}`);
          return;
        }
        const lines = entries.map(
          (e) =>
            `${e.id !== undefined ? `#${e.id} ` : ""}[${clock(e.ts)}] ${e.method} ${e.status ?? "-"} ${clipRedacted(e.url, 300)} (${e.type}${e.durationMs !== undefined ? `, ${Math.round(e.durationMs)}ms` : ""})${entryFlags(e)}${e.failed ? ` 失败：${clipRedacted(e.errorText ?? "未知", 120)}` : ""}${initiatorTail(e)}`,
        );
        b.trusted(`网络请求 ${entries.length} 条${r?.dropped ? `（更早的 ${r.dropped} 条已被丢弃）` : ""}${cursor ? `（${cursor}）` : ""}：`);
        b.untrusted(truncateWithNote(lines.join("\n"), MAX_LOG_TEXT_CHARS).text);
      },
    });
  }),
};

/** browser_network 的 B1 过滤参数（snake_case → 主进程 camelCase）：只做形状检查，type / status / url_regex 的内容校验由主进程（net-filter.mjs）负责 */
const parseNetworkFilterArgs = (
  args: Record<string, unknown>,
): { filter?: "all" | "failed" | "xhr"; type?: string; status?: string; method?: string; urlRegex?: string; failedOnly?: true; sinceId?: number } => {
  const filter = argEnum(args, "filter", ["all", "failed", "xhr"] as const);
  const type = argStr(args, "type");
  // 状态码模型常写成数字 404
  const statusRaw = typeof args.status === "number" && Number.isFinite(args.status) ? String(Math.trunc(args.status)) : argStr(args, "status");
  const method = argStr(args, "method");
  const urlRegex = argStr(args, "url_regex");
  if (urlRegex !== undefined && urlRegex.length > 100) throw new BadArgs("url_regex 过长（上限 100 字符）");
  const sinceId = argNum(args, "since_id");
  if (sinceId !== undefined && (!Number.isInteger(Math.floor(sinceId)) || sinceId < 0)) throw new BadArgs("since_id 必须是非负整数（用上次结果里提示的值）");
  return {
    ...(filter ? { filter } : {}),
    ...(type !== undefined ? { type } : {}),
    ...(statusRaw !== undefined ? { status: statusRaw.trim() } : {}),
    ...(method !== undefined ? { method } : {}),
    ...(urlRegex !== undefined ? { urlRegex } : {}),
    ...(argBool(args, "failed_only") === true ? { failedOnly: true as const } : {}),
    ...(sinceId !== undefined ? { sinceId: Math.floor(sinceId) } : {}),
  };
};

const EVALUATE_MAX_EXPR_CHARS = 20_000;
// 主进程审批卡的等待上限 EVALUATE_APPROVAL_WAIT_MS 见 ./approval-timeout：本地超时要比它长一截，才能拿到主进程返回的 DENIED

const evaluateTool: FlowshipToolDef = {
  name: "browser_evaluate",
  label: "浏览器·执行脚本",
  description:
    "在当前页面执行一段 JavaScript 表达式并返回结果（须可 JSON 化），仅在其它工具做不到时使用。" +
    "未长期开启时首次调用会弹审批卡，被拒或超时别重试。",
  parameters: TBObject({ expression: TBString() }),
  handler: guarded(async (args, ctx) => {
    const expression = reqStr(args, "expression");
    if (expression.length > EVALUATE_MAX_EXPR_CHARS) {
      throw new BadArgs(`expression 过长（>${EVALUATE_MAX_EXPR_CHARS} 字符）`);
    }
    // E2·A7：这里不再因 evaluateEnabled 为 false 直接拒——授权判定（总闸 / 本任务已批准 / 弹审批卡）整个交给主进程，
    // 拒绝、超时、取消都以 DENIED 回来（describeBrowserError 有对应文案）。
    return run<{ type?: string; value?: unknown; exceptionText?: string }>(ctx, {
      op: "evaluate",
      args: { expression },
      timeoutMs: EVALUATE_APPROVAL_WAIT_MS + WAITING_SLACK_MS,
      render: (r, b) => {
        if (r?.exceptionText) {
          b.trusted("脚本抛出了异常：");
          b.untrusted(clipEntry(r.exceptionText, 2000));
          return;
        }
        let value: string;
        try {
          value = typeof r?.value === "string" ? r.value : (JSON.stringify(r?.value) ?? "undefined");
        } catch {
          value = String(r?.value);
        }
        b.trusted(`执行完成，结果类型：${r?.type ?? "unknown"}。`);
        b.untrusted(truncateWithNote(value, MAX_LOG_TEXT_CHARS).text);
      },
    });
  }),
};

const userActivityTool: FlowshipToolDef = {
  name: "browser_user_activity",
  label: "浏览器·用户的操作",
  description: "查看用户在内置浏览器里自上次查看以来做了什么（点击 / 输入 / 导航等）。",
  parameters: TBObject({}),
  handler: guarded(async (_args, ctx) =>
    run<{ entries?: BrowserActivityEntry[]; controller?: string }>(ctx, {
      op: "user_activity",
      args: { markSeen: true, limit: 100 },
      attachActivity: false,
      render: (r, b) => {
        const entries = (r?.entries ?? []).filter((e) => e.actor === "user" || e.actor === "system");
        if (entries.length === 0) {
          b.trusted("用户自上次查看以来没有新的操作。");
          return;
        }
        appendUserActivity(b, entries, { header: "用户的新操作：" });
      },
    }),
  ),
};

interface AskResult {
  outcome?: "done" | "skipped" | "timeout" | "cancelled";
  note?: string;
  entries?: BrowserActivityEntry[];
}

const askTool: FlowshipToolDef = {
  name: "browser_ask_user_to_act",
  label: "浏览器·请用户操作",
  description:
    "请用户亲自在浏览器里完成一步（你拿不到的账号口令、短信 / 扫码验证、人机验证、支付确认等）并阻塞等待，直到用户点「完成」或「放弃」。message 写清楚要用户做什么。",
  parameters: TBObject({ message: TBString() }),
  handler: guarded(async (args, ctx) => {
    const message = reqStr(args, "message").trim().slice(0, 500);
    return run<AskResult>(ctx, {
      op: "ask_user_to_act",
      args: { message, timeoutMs: ASK_DEFAULT_TIMEOUT_MS },
      timeoutMs: ASK_DEFAULT_TIMEOUT_MS + WAITING_SLACK_MS,
      attachActivity: false,
      render: (r, b) => {
        const note = typeof r?.note === "string" && r.note.trim() ? r.note.trim() : "";
        const entries = (r?.entries ?? []).filter((e) => e.actor === "user" || e.actor === "system");
        switch (r?.outcome) {
          case "done":
            b.trusted("用户已完成操作。");
            // note 来自 app 界面里用户亲手填的话，不来自网页，所以按可信文本给；但它依旧不是 advance_next 的授权凭据
            if (note) b.trusted(`用户留言：${note}`);
            if (entries.length > 0) appendUserActivity(b, entries, { header: TOOL_ACTIVITY_HEADER });
            b.trusted("请先 browser_snapshot 查看现状，再继续。");
            return;
          case "skipped":
            b.trusted("用户选择放弃这一步。不要再重复请求同一件事；无法继续就如实告诉用户，或用 ask_user 问他想怎么办。");
            if (note) b.trusted(`用户留言：${note}`);
            return;
          case "timeout":
            b.trusted("等待用户操作超时（用户一直没有响应）。可以结束本轮并告诉用户需要他在浏览器里完成什么。");
            return;
          default:
            b.trusted("这次请求已被取消（任务被停止或用户打断）。请结束本轮。");
        }
      },
    });
  }),
};

// 增强包 E1（契约 §14）：三个切片各自的新工具定义放在自己的区块里（区块之间互不引用）。
// ═══ V1 工具定义（browser_mouse / browser_fill_form）═══

const MOUSE_ACTIONS = ["move", "click", "double_click", "down", "up", "wheel"] as const;
type MouseAction = (typeof MOUSE_ACTIONS)[number];

/** 工具结果里「鼠标动作」的一句话（只含坐标 / 数值，没有页面文字） */
export const describeMouseDone = (
  p: { action: MouseAction; x: number; y: number; button?: string; deltaX?: number; deltaY?: number; modifiers?: string[] },
): string => {
  const at = `(${Math.round(p.x)}, ${Math.round(p.y)})`;
  const pre = p.modifiers && p.modifiers.length > 0 ? `${p.modifiers.join("+")}+` : "";
  const btn = p.button === "right" ? "右键" : p.button === "middle" ? "中键" : "";
  switch (p.action) {
    case "move":
      return `已把鼠标移动到 ${at}`;
    case "click":
      return `已${pre}${btn}点击 ${at}`;
    case "double_click":
      return `已${pre}${btn}双击 ${at}`;
    case "down":
      return `已${btn}按下鼠标 ${at}（记得再调用 action=up 抬起）`;
    case "up":
      return `已${btn}抬起鼠标 ${at}`;
    default:
      return `已在 ${at} 滚动滚轮（纵向 ${Math.round(p.deltaY ?? 0)}px，横向 ${Math.round(p.deltaX ?? 0)}px）`;
  }
};

const mouseTool: FlowshipToolDef = {
  name: "browser_mouse",
  label: "浏览器·鼠标",
  description:
    "按视口 CSS 像素坐标操作鼠标（x、y 原点在视口左上角，与 browser_screenshot 结果里的「视口 W×H」同坐标系，越界报错；wheel 用 delta_y，正数向下；拖拽 = down → move → up）。仅在 canvas / 地图等无法用 ref 的场景用，日常用 browser_click / browser_scroll。",
  parameters: TBObject({
    action: TBEnum([...MOUSE_ACTIONS]),
    x: TBNumber(),
    y: TBNumber(),
    button: TBOptional(TBEnum(["left", "right", "middle"])),
    delta_x: TBOptional(TBNumber()),
    delta_y: TBOptional(TBNumber()),
    modifiers: TBOptional(TBArray(TBEnum([...MODIFIER_NAMES]))),
  }),
  handler: guarded(async (args, ctx) => {
    const action = argEnum(args, "action", MOUSE_ACTIONS);
    if (!action) throw new BadArgs("缺少必填参数 action");
    const x = argNum(args, "x");
    const y = argNum(args, "y");
    if (x === undefined || y === undefined) throw new BadArgs("缺少必填参数 x / y（视口 CSS 像素）");
    if (x < 0 || y < 0) throw new BadArgs("x / y 不能为负，原点是视口左上角");
    const button = argEnum(args, "button", ["left", "right", "middle"] as const);
    const deltaX = argNum(args, "delta_x");
    const deltaY = argNum(args, "delta_y");
    if (action === "wheel" && !deltaX && !deltaY) throw new BadArgs("wheel 需要 delta_y（纵向，正数向下）或 delta_x");
    const modifiers = argModifiers(args);
    return run<ActionResult>(ctx, {
      op: "mouse",
      args: {
        action,
        x,
        y,
        ...(button ? { button } : {}),
        ...(deltaX !== undefined ? { deltaX } : {}),
        ...(deltaY !== undefined ? { deltaY } : {}),
        ...(modifiers ? { modifiers } : {}),
      },
      render: renderAction(describeMouseDone({ action, x, y, button, deltaX, deltaY, modifiers })),
    });
  }),
};

// ── browser_fill_form ──

export interface FillFieldInput {
  ref: string;
  value?: string;
  checked?: boolean;
  values?: string[];
}

/**
 * fields 宽松解析：数组或 JSON 字符串；每项 ref + 且仅 value / checked / values 之一。
 * value 收字符串与数字（模型常把数字写成裸数字）；checked 收布尔与 "true" / "false"；values 收数组或单个字符串。
 */
export const parseFillFields = (raw: unknown): FillFieldInput[] => {
  let list: unknown = raw;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      throw new BadArgs("fields 必须是数组 [{ref, value|checked|values}, …]");
    }
  }
  if (!Array.isArray(list) || list.length < 1 || list.length > 30) throw new BadArgs("fields 必须是 1–30 项组成的数组");
  return list.map((item, i): FillFieldInput => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new BadArgs(`fields[${i}] 必须是对象 {ref, value|checked|values}`);
    const f = item as Record<string, unknown>;
    let ref: string;
    try {
      ref = reqRef(f, "ref");
    } catch (err) {
      throw new BadArgs(`fields[${i}]：${err instanceof Error ? err.message : "ref 不合法"}`);
    }
    const hasValue = f.value !== undefined && f.value !== null;
    const hasChecked = f.checked !== undefined && f.checked !== null;
    const hasValues = f.values !== undefined && f.values !== null;
    if ([hasValue, hasChecked, hasValues].filter(Boolean).length !== 1) {
      throw new BadArgs(`fields[${i}]：value（文本）/ checked（勾选）/ values（下拉）必须且只能给一个`);
    }
    if (hasValue) {
      if (typeof f.value !== "string" && typeof f.value !== "number") throw new BadArgs(`fields[${i}]：value 必须是字符串`);
      return { ref, value: String(f.value) };
    }
    if (hasChecked) {
      const c = argBool(f, "checked");
      if (c === undefined) throw new BadArgs(`fields[${i}]：checked 必须是 true / false`);
      return { ref, checked: c };
    }
    const vs = (Array.isArray(f.values) ? f.values : typeof f.values === "string" ? [f.values] : [])
      .filter((v): v is string => typeof v === "string")
      .slice(0, 50);
    if (vs.length === 0) throw new BadArgs(`fields[${i}]：values 至少要有一项字符串`);
    return { ref, values: vs };
  });
};

interface FillFormResult extends ActionResult {
  results?: { ref: string; ok: boolean; error?: string }[];
  submit?: { ref: string; ok: boolean; error?: string };
}

/** fill_form 结果渲染：逐项列成败。错误详情可能含页面文字（元素名 / 选项）→ 内联包装为不可信。 */
export const renderFillForm = (r: FillFormResult, b: ToolResultBuilder, total: number): void => {
  const results = r?.results ?? [];
  const ok = results.filter((x) => x.ok).length;
  const showErr = (msg: string | undefined): string => {
    if (!msg) return "失败";
    b.markUntrusted();
    return wrapUntrustedInline(msg.slice(0, 300));
  };
  const lines = results.map((x) => (x.ok ? `- ${x.ref} ✓` : `- ${x.ref} ✗ ${showErr(x.error)}`));
  if (r?.submit) lines.push(r.submit.ok ? `- 提交 ${r.submit.ref} ✓` : `- 提交 ${r.submit.ref} ✗ ${showErr(r.submit.error)}`);
  const failed = results.length - ok;
  b.trusted(`表单填写完成：成功 ${ok}/${results.length || total} 项${failed > 0 ? `，失败 ${failed} 项（失败项请按原因处理，成功项不必重填）` : ""}。`);
  if (lines.length > 0) b.trusted(lines.join("\n"));
  if (r && (r.url || r.title)) b.trusted(pageLine(r)).markUntrusted();
  if (r?.navigated) b.trusted("页面已跳转，之前的 ref 已全部失效，请重新调用 browser_snapshot。");
  if (r?.newTabId) b.trusted(`操作打开了新标签页 ${r.newTabId}（可用 browser_tabs 的 select 切换过去）。`);
};

const fillFormTool: FlowshipToolDef = {
  name: "browser_fill_form",
  label: "浏览器·填写表单",
  description:
    "一次填多个表单字段（≤30）：文本 value、勾选 checked（状态不同才点）、原生下拉 values；submit_ref 可选（全部成功才点）；逐项返回成败。登录表单里的账号 / 密码框也可以直接填（口令用用户给你的，别猜；手里没有的凭据、短信验证码请用 browser_ask_user_to_act）。",
  parameters: TBObject({
    fields: TBArray(
      TBObject({
        ref: REF_SCHEMA,
        value: TBOptional(TBString({ description: "会先清空再输入" })),
        checked: TBOptional(TBBoolean({ description: "目标状态" })),
        values: TBOptional(TBArray(TBString(), { description: "选项文字或 value" })),
      }),
    ),
    submit_ref: TBOptional(REF_SCHEMA),
  }),
  handler: guarded(async (args, ctx) => {
    const fields = parseFillFields(args.fields);
    const submitRef = optRef(args, "submit_ref");
    return run<FillFormResult>(ctx, {
      op: "fill_form",
      args: { fields, ...(submitRef ? { submitRef } : {}) },
      render: (r, b) => renderFillForm(r, b, fields.length),
    });
  }),
};

// ═══ /V1 ═══

// ═══ V2 工具定义（browser_read / browser_inspect / browser_save）═══

/** server 侧给 max_chars 的上限：整条结果另有 MAX_TOOL_RESULT_CHARS（60000）总上限，再大只会被截掉 */
export const READ_MAX_CHARS_SERVER = 50_000;
export const READ_MAX_CHARS_DEFAULT = 30_000;
const INSPECT_INCLUDE_VALUES = ["box", "styles", "attrs", "html", "matched_rules", "event_listeners", "a11y_audit"] as const;
const SAVE_KIND_VALUES = ["pdf", "screenshot", "html"] as const;

/** 宽松取字符串列表：数组或「逗号 / 空白分隔」的字符串都认（模型常把数组写成一个字符串） */
const argStrList = (args: Record<string, unknown>, key: string, max: number): string[] | undefined => {
  const v = args[key];
  const raw: unknown[] | undefined = Array.isArray(v)
    ? v
    : typeof v === "string" && v.trim() !== ""
      ? v.split(/[\s,]+/)
      : undefined;
  if (!raw) return undefined;
  return raw
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, max);
};

/** 体积的人话写法（V3 区块也有一个 formatBytes；区块之间互不引用，所以这里自备） */
const sizeText = (n: unknown): string => {
  const v = typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(1)} MB`;
};

interface ReadResult {
  tabId?: string;
  url?: string;
  title?: string;
  format?: string;
  text?: string;
  length?: number;
  truncated?: boolean;
  root?: string;
  totalLength?: number;
}

const READ_ROOT_LABEL: Record<string, string> = {
  article: "正文（article）",
  main: "正文（main）",
  element: "指定的元素",
  body: "整个页面",
};

const readTool: FlowshipToolDef = {
  name: "browser_read",
  label: "浏览器·阅读页面",
  description:
    "把页面（或某个 ref 元素）读成 markdown / 纯文本（标题、段落、列表、表格、代码块、绝对 URL 链接），默认只读正文区域（article / main）。读文章 / 文档 / 表格用它；要点击或输入用 browser_snapshot 拿 ref。",
  parameters: TBObject({
    ref: TBOptional(TBString({ description: "只读这个元素（browser_snapshot 里的编号，如 e12）；缺省读整页正文" })),
    format: TBOptional(TBEnum(["markdown", "text"])),
    max_chars: TBOptional(TBNumber({ description: `最多返回多少字符，缺省 ${READ_MAX_CHARS_DEFAULT}，上限 ${READ_MAX_CHARS_SERVER}` })),
    main_content: TBOptional(TBBoolean({ description: "缺省 true：优先读 article / main 正文；false 读整个页面" })),
  }),
  handler: guarded(async (args, ctx) => {
    const ref = optRef(args, "ref");
    const format = argEnum(args, "format", ["markdown", "text"] as const);
    const maxRaw = argNum(args, "max_chars");
    const maxChars = maxRaw === undefined ? undefined : Math.min(Math.max(Math.round(maxRaw), 1000), READ_MAX_CHARS_SERVER);
    const mainContent = argBool(args, "main_content");
    return run<ReadResult>(ctx, {
      op: "read",
      args: {
        ...(ref ? { ref } : {}),
        ...(format ? { format } : {}),
        ...(maxChars !== undefined ? { maxChars } : {}),
        ...(mainContent !== undefined ? { mainContent } : {}),
      },
      render: (r, b) => {
        const text = String(r?.text ?? "");
        const scope = READ_ROOT_LABEL[r?.root ?? "body"] ?? "整个页面";
        const total = typeof r?.totalLength === "number" ? r.totalLength : text.length;
        b.trusted(`页面阅读｜标签页 ${r?.tabId ?? "?"}｜${r?.format ?? "markdown"}｜范围：${scope}｜${text.length} 字符`);
        if (r?.truncated) {
          b.trusted(`（内容已被截断：全文约 ${total} 字符。可传 ref 只读某一块、调大 max_chars，或先 browser_scroll 到目标区域再读。）`);
        }
        if (text.trim() === "") b.trusted("（这个范围里没有读到可见文字。可换 main_content=false、指定 ref，或用 browser_snapshot 看看页面结构。）");
        b.untrusted(`标题：${r?.title ?? ""}\nURL：${r?.url ?? ""}\n\n${text}`, { url: r?.url, maxChars: 55_000 });
      },
    });
  }),
};

interface InspectBox {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  inViewport?: boolean;
  visible?: boolean;
}

interface InspectResult {
  tabId?: string;
  ref?: string;
  tag?: string;
  role?: string;
  name?: string;
  box?: InspectBox;
  attrs?: Record<string, string>;
  styles?: Record<string, string>;
  html?: string;
  /** html 为空串的原因（页内探针无法确认其中的输入框都已脱敏时主动置空，出于安全不返回 HTML） */
  htmlNote?: string;
  /** E2·P7b：matched_rules / event_listeners / a11y_audit 的结果（每项失败只在该项里带 error） */
  matchedRules?: InspectExtras["matchedRules"];
  eventListeners?: InspectExtras["eventListeners"];
  a11yAudit?: InspectExtras["a11yAudit"];
}

const yesNo = (v: unknown): string => (v ? "是" : "否");

const inspectTool: FlowshipToolDef = {
  name: "browser_inspect",
  label: "浏览器·检查元素",
  description:
    "检查某个元素（ref 来自 browser_snapshot）：盒模型、计算样式、HTML 属性、outerHTML，还能看命中的 CSS 规则 / 事件监听器 / 无障碍审计。前端调试、核对样式 / 布局时用；读内容用 browser_read。",
  parameters: TBObject({
    ref: REF_SCHEMA,
    include: TBOptional(
      TBArray(TBEnum(["box", "styles", "attrs", "html", "matched_rules", "event_listeners", "a11y_audit"]), {
        description:
          "缺省 box + styles + attrs；html 给 outerHTML（≤4000 字符；无法确认其中的输入框都已脱敏时为空并附说明）；matched_rules 命中的 CSS 规则（≤30 条）；event_listeners 自身监听器位置；a11y_audit 元素子树 axe 审计（范围大则慢）",
      }),
    ),
    style_props: TBOptional(TBArray(TBString(), { description: "要看的 CSS 属性名（≤30 个，如 font-size、flex-direction）；缺省给一组常用属性" })),
  }),
  handler: guarded(async (args, ctx) => {
    const ref = reqRef(args, "ref");
    const include = argStrList(args, "include", 8);
    if (include) {
      for (const v of include) {
        if (!(INSPECT_INCLUDE_VALUES as readonly string[]).includes(v)) {
          throw new BadArgs(`include 只能是 ${INSPECT_INCLUDE_VALUES.join(" / ")}，收到的是「${v.slice(0, 40)}」`);
        }
      }
    }
    const styleProps = argStrList(args, "style_props", 30);
    return run<InspectResult>(ctx, {
      op: "inspect",
      args: {
        ref,
        ...(include && include.length > 0 ? { include: [...new Set(include)] } : {}),
        ...(styleProps && styleProps.length > 0 ? { styleProps } : {}),
      },
      render: (r, b) => {
        const lines: string[] = [`标签：<${r?.tag ?? "?"}>${r?.role ? `  角色：${r.role}` : ""}${r?.name ? `  名称：${r.name}` : ""}`];
        const box = r?.box;
        if (box) {
          lines.push(
            `盒模型（视口坐标，CSS 像素）：x=${box.x} y=${box.y} 宽=${box.width} 高=${box.height}｜在视口内：${yesNo(box.inViewport)}｜可见：${yesNo(box.visible)}`,
          );
        }
        if (r?.attrs) {
          const entries = Object.entries(r.attrs);
          lines.push("属性：", ...(entries.length > 0 ? entries.map(([k, v]) => clipRedacted(`  ${clipEntry(k, 80)}="${String(v ?? "")}"`, 400)) : ["  （无）"]));
        }
        if (r?.styles) {
          lines.push("计算样式：", ...Object.entries(r.styles).map(([k, v]) => clipRedacted(`  ${clipEntry(k, 80)}: ${String(v ?? "") || "（空）"}`, 400)));
        }
        if (typeof r?.html === "string") {
          lines.push("HTML：", r.html);
          // html 为空不一定是元素没内容：被安全策略置空时带原因，免得模型当成「没有 HTML」去反复重试
          if (r.html === "" && typeof r.htmlNote === "string" && r.htmlNote) lines.push(`（HTML 为空：${clipEntry(r.htmlNote, 300)}）`);
        }
        // E2·P7b：matched_rules / event_listeners / a11y_audit（选择器、声明值、事件类型都是页面数据，同在 untrusted 块里）
        lines.push(...renderInspectExtras(r));
        b.trusted(`元素检查｜${r?.ref ?? ref}`);
        // 属性值 / 样式值 / HTML 全是页面数据；data-token=… 这类凭据样式再扫一遍
        b.untrusted(truncateWithNote(redactSensitiveText(lines.join("\n")), MAX_LOG_TEXT_CHARS).text);
      },
    });
  }),
};

interface SaveResult {
  tabId?: string;
  kind?: string;
  path?: string;
  bytes?: number;
}

const SAVE_KIND_LABEL: Record<string, string> = { pdf: "PDF", screenshot: "整页截图（png）", html: "HTML" };

const saveTool: FlowshipToolDef = {
  name: "browser_save",
  label: "浏览器·保存页面",
  description:
    "把当前页面存到用户本机下载目录的 Flowship-browser 子目录（路径由系统决定、不能指定）：kind=pdf（可调 landscape / scale / page_ranges / paper_format / margins / print_background / header / footer）/ screenshot（png，full_page 默认整页）/ html。需要把页面留档或交给用户时用。",
  parameters: TBObject({
    kind: TBEnum(["pdf", "screenshot", "html"]),
    full_page: TBOptional(TBBoolean({ description: "仅 screenshot：是否整页（缺省 true）" })),
    name_hint: TBOptional(TBString({ description: "文件名提示（会被清洗，只留字母数字中文和 ._- 空格）" })),
    // ── E2·C5：仅 kind=pdf（主进程 pdf-options.mjs 是权威校验，这里只做形状检查）──
    landscape: TBOptional(TBBoolean({ description: "仅 pdf：横向（缺省竖向）" })),
    scale: TBOptional(TBNumber({ description: "仅 pdf：缩放 0.1–2（缺省 1）" })),
    page_ranges: TBOptional(TBString({ description: "仅 pdf：页码范围，如 \"1-3,5\"（页码从 1 开始，缺省全部）" })),
    paper_format: TBOptional(TBString({ description: "仅 pdf：纸张 letter / legal / tabloid / a0–a6（缺省沿用页面 CSS 的 @page，没有则 Letter）" })),
    margins: TBOptional(TBObject({
      top: TBOptional(TBNumber()),
      right: TBOptional(TBNumber()),
      bottom: TBOptional(TBNumber()),
      left: TBOptional(TBNumber()),
    }, { description: "仅 pdf：页边距，单位英寸，每边 0–3" })),
    print_background: TBOptional(TBBoolean({ description: "仅 pdf：打印背景色 / 图（缺省 true）" })),
    header: TBOptional(TBString({ description: "仅 pdf：页眉，纯文字，可含 <span class=\"title|url|date|pageNumber|totalPages\"></span> 占位；其它标签会被剥掉（≤ 2000 字符）" })),
    footer: TBOptional(TBString({ description: "仅 pdf：页脚，规则同 header" })),
  }),
  handler: guarded(async (args, ctx) => {
    const kind = argEnum(args, "kind", SAVE_KIND_VALUES);
    if (!kind) throw new BadArgs("缺少必填参数 kind（pdf / screenshot / html）");
    const fullPage = argBool(args, "full_page");
    const nameHint = argStr(args, "name_hint")?.trim().slice(0, 200);
    // E2·C5：pdf 打印选项（形状检查 + snake→camel；取值范围 / 模板清洗由主进程 pdf-options.mjs 权威校验）
    const pdfArgs: Record<string, unknown> = {};
    for (const [snake, camel, type] of [
      ["landscape", "landscape", "boolean"],
      ["scale", "scale", "number"],
      ["page_ranges", "pageRanges", "string"],
      ["paper_format", "paperFormat", "string"],
      ["margins", "margins", "object"],
      ["print_background", "printBackground", "boolean"],
      ["header", "header", "string"],
      ["footer", "footer", "string"],
    ] as const) {
      const v = args[snake];
      if (v === undefined || v === null) continue;
      if (type === "object" ? typeof v !== "object" || Array.isArray(v) : typeof v !== type) {
        throw new BadArgs(`参数 ${snake} 类型不对（应为 ${type === "object" ? "对象" : type === "boolean" ? "布尔值" : type === "number" ? "数字" : "字符串"}）`);
      }
      pdfArgs[camel] = v;
    }
    if (kind !== "pdf" && Object.keys(pdfArgs).length > 0) {
      throw new BadArgs("landscape / scale / page_ranges / paper_format / margins / print_background / header / footer 只在 kind=pdf 时可用");
    }
    return run<SaveResult>(ctx, {
      op: "save",
      args: { kind, ...(fullPage !== undefined ? { fullPage } : {}), ...(nameHint ? { nameHint } : {}), ...pdfArgs },
      timeoutMs: 90_000,
      render: (r, b) => {
        b.trusted(`已保存页面为 ${SAVE_KIND_LABEL[r?.kind ?? kind] ?? kind}｜${sizeText(r?.bytes)}。`);
        // 文件名里可能带页面标题（经清洗但仍是页面可控文字）：路径用不可信内联包起来
        b.trusted(`保存路径：${wrapUntrustedInline(String(r?.path ?? ""))}`).markUntrusted();
        b.trusted("这是用户本机上的文件：可用其它工具读取，或在回复里把路径告诉用户。");
      },
    });
  }),
};
// ═══ /V2 ═══

// ═══ V3 工具定义（browser_upload / browser_downloads）═══

/** 体积的人话写法：12 B / 3.4 KB / 1.2 MB */
export const formatBytes = (n: unknown): string => {
  const v = typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0;
  if (v < 1024) return `${Math.round(v)} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(1)} MB`;
};

/**
 * paths 宽松解析：模型常把单个路径写成字符串、或把数组写成 JSON 字符串。
 * 只做「形状」整理（去空白、1–10 个字符串）；路径是否允许由 upload-policy 判断。
 */
export const parseUploadPaths = (v: unknown): string[] => {
  let raw: unknown = v;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (t.startsWith("[")) {
      try {
        raw = JSON.parse(t);
      } catch {
        raw = [t];
      }
    } else {
      raw = [t];
    }
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new BadArgs(`缺少必填参数 paths（1–${MAX_UPLOAD_FILES} 个本机文件的绝对路径组成的数组）`);
  }
  if (raw.length > MAX_UPLOAD_FILES) throw new BadArgs(`paths 最多 ${MAX_UPLOAD_FILES} 个，收到 ${raw.length} 个；请分批上传`);
  const out: string[] = [];
  for (const p of raw) {
    if (typeof p !== "string" || p.trim() === "") throw new BadArgs("paths 里每一项都必须是非空的绝对路径字符串");
    out.push(p.trim());
  }
  return out;
};

interface UploadResult extends ActionResult {
  files?: Array<{ name: string; size: number }>;
}

const uploadTool: FlowshipToolDef = {
  name: "browser_upload",
  label: "浏览器·上传文件",
  description:
    "把本机文件上传到页面：ref 是 type=file 的输入框，或点击后会弹出文件选择框的按钮（先 browser_snapshot 拿 ref）；paths 是 1–10 个绝对路径。只允许任务工作目录 / 系统临时目录 / 下载目录里的文件，密钥与凭据类文件一律拒绝。",
  parameters: TBObject({
    ref: REF_SCHEMA,
    paths: TBArray(TBString(), { description: "要上传的文件的绝对路径（1–10 个）" }),
  }),
  handler: guarded(async (args, ctx) => {
    const ref = reqRef(args, "ref");
    const paths = parseUploadPaths(args.paths);
    const taskId = ctx?.taskId;
    if (!taskId) return errorOut("内置浏览器只能在任务会话里使用（当前会话没有任务信息）。");
    // 路径先在 server 侧过白名单 + 黑名单：被拒就不发给主进程（页面是不可信的，文件字节不能随便交出去）
    const verdict = await checkUploadPaths(paths, await resolveUploadEnv(taskId));
    if (!verdict.ok) {
      // 拒绝文案是我们写的，但里面嵌的磁盘文件名 / realpath 可由页面决定（R2-02）：策略层已把它们内联包成不可信，
      // 这里只在确实出现了包裹时才补结尾的固定提醒（纯固定文案的拒绝——数量 / 黑名单目录——不挂提醒）
      const b = new ToolResultBuilder().trusted(verdict.message);
      if (verdict.message.includes(`<${UNTRUSTED_TAG}`)) b.markUntrusted();
      return errorOut(b.build());
    }
    return run<UploadResult>(ctx, {
      op: "upload",
      // 交给主进程的是 realpath 之后的路径（它还会再校验一遍黑名单）
      args: { ref, paths: verdict.files.map((f) => f.path) },
      render: (r, b) => {
        const files = Array.isArray(r?.files) && r.files.length > 0 ? r.files : verdict.files;
        // 文件名是磁盘上的名字（可由页面决定，如下载目录里的文件）：内联包成不可信（R2-02）
        const list = files.map((f) => `${wrapUntrustedInline(String(f.name ?? "").slice(0, 200))}（${formatBytes(f.size)}）`).join("、");
        renderAction(`已把 ${files.length} 个文件放进 ${ref}：${list}`)(r, b);
        b.markUntrusted();
        b.trusted("多数页面还需要再点「提交 / 上传」之类的按钮才会真正发送，请 browser_snapshot 查看页面现状。");
      },
    });
  }),
};

export interface DownloadEntry {
  id: number;
  fileName: string;
  path: string;
  state: "progressing" | "completed" | "cancelled" | "interrupted";
  receivedBytes: number;
  totalBytes: number;
}

const DOWNLOAD_STATE_ZH: Record<DownloadEntry["state"], string> = {
  progressing: "下载中",
  completed: "已完成",
  cancelled: "已取消",
  interrupted: "已中断",
};

/** 一条下载的一行描述：#id 文件名 | 状态 | 大小 | 本机路径。文件名来自页面的下载响应，调用方要放进不可信块 */
export const renderDownloadLine = (d: DownloadEntry): string => {
  const pct =
    d.state === "progressing" && d.totalBytes > 0 ? `（${Math.min(100, Math.floor((d.receivedBytes / d.totalBytes) * 100))}%）` : "";
  const size = d.state === "completed" || d.totalBytes <= 0 ? formatBytes(d.receivedBytes) : `${formatBytes(d.receivedBytes)} / ${formatBytes(d.totalBytes)}`;
  return `#${d.id} ${clipEntry(d.fileName, 120)} | ${DOWNLOAD_STATE_ZH[d.state] ?? d.state}${pct} | ${size} | ${clipEntry(d.path, 300)}`;
};

const downloadsTool: FlowshipToolDef = {
  name: "browser_downloads",
  label: "浏览器·下载",
  description:
    "查看浏览器的下载记录（action=list），或点了下载按钮后等下载结束（action=wait：等 since_id 之后的下载全部结束，不给就等当前在途的）。文件存在本机下载目录，结果里给路径。",
  parameters: TBObject({
    action: TBEnum(["list", "wait"]),
    since_id: TBOptional(TBNumber({ description: "只关心 id 大于它的下载（取自上次结果里的 #id）" })),
    timeout_ms: TBOptional(TBNumber({ description: "wait 的最长等待毫秒数，默认 30000，范围 1000–300000" })),
  }),
  handler: guarded(async (args, ctx) => {
    const action = argEnum(args, "action", ["list", "wait"] as const);
    if (!action) throw new BadArgs("缺少必填参数 action（list / wait）");
    const sinceRaw = argNum(args, "since_id");
    const sinceId = sinceRaw === undefined ? undefined : Math.max(0, Math.floor(sinceRaw));
    const timeoutMs = Math.min(Math.max(Math.floor(argNum(args, "timeout_ms") ?? 30_000), 1000), 300_000);
    return run<{ downloads?: DownloadEntry[]; timedOut?: boolean }>(ctx, {
      op: "downloads",
      args: action === "list" ? { action } : { action, ...(sinceId !== undefined ? { sinceId } : {}), timeoutMs },
      // 本地超时要比主进程自己的 timeoutMs 长一截，才能拿到它返回的 timedOut:true
      ...(action === "wait" ? { timeoutMs: timeoutMs + WAITING_SLACK_MS } : {}),
      render: (r, b) => {
        const list = Array.isArray(r?.downloads) ? r.downloads : [];
        const maxId = list.reduce((m, d) => Math.max(m, d.id), 0);
        const lines = list.map(renderDownloadLine);
        if (list.length === 0) {
          b.trusted(
            action === "list"
              ? "还没有任何下载记录。"
              : "没有正在进行的下载（也没有 since_id 之后的新下载）。小文件可能已经下完了：用 action=list 看记录；list 里也没有的话，说明刚才的点击没有触发下载（也可能页面是在新标签页里直接打开了文件）。",
          );
          return;
        }
        if (action === "list") {
          b.trusted(`共 ${list.length} 条下载记录（最新在前）：`);
        } else if (r?.timedOut) {
          b.trusted(`等待超时，仍有下载没有结束（可稍后再 browser_downloads wait，或 list 看进度）：`);
        } else {
          b.trusted("下载已全部结束：");
        }
        b.untrusted(truncateWithNote(lines.join("\n"), MAX_LOG_TEXT_CHARS).text);
        b.trusted(
          `路径是本机文件，可用读文件类工具查看，或在回复里告诉用户。只想等之后新出现的下载时，下次传 since_id=${maxId}。`,
        );
      },
    });
  }),
};
// ═══ /V3 ═══

// ═══ V5 工具定义（browser_dialog / browser_emulate）═══

const DIALOG_ACTIONS = ["status", "accept", "dismiss"] as const;

const dialogTool: FlowshipToolDef = {
  name: "browser_dialog",
  label: "浏览器·对话框",
  description:
    "处理页面弹出的 alert / confirm / beforeunload 对话框：action=status 查看是否有挂起的，accept 确定，dismiss 取消。动作工具的结果里提示「页面弹出了…」时必须用它处理，否则页面一直被阻塞（20 秒后自动处置）。",
  parameters: TBObject({
    action: TBOptional(TBEnum([...DIALOG_ACTIONS])),
    prompt_text: TBOptional(TBString({ description: "prompt 对话框 accept 时填入的文字" })),
  }),
  handler: guarded(async (args, ctx) => {
    const action = argEnum(args, "action", DIALOG_ACTIONS) ?? "status";
    // 不用 argStr：它把空串当「没给」，而 prompt 允许确定一个空输入
    const rawPrompt = args.prompt_text;
    const promptText = typeof rawPrompt === "string" ? rawPrompt : undefined;
    return run<{ pending?: DialogInfoLike | null; handled?: boolean }>(ctx, {
      op: "dialog",
      args: { action, ...(promptText !== undefined ? { promptText } : {}) },
      render: (r, b) => {
        const pending = r?.pending ?? null;
        if (action === "status") {
          if (!pending) {
            b.trusted("当前没有挂起的对话框。");
            return;
          }
          b.trusted(
            `页面有一个未处理的${dialogDesc(pending)}。用 browser_dialog accept / dismiss 处理；${DIALOG_HOLD_SECONDS} 秒内不处理会自动${dialogFallbackZh(pending.type)}。`,
          ).markUntrusted();
          return;
        }
        if (!r?.handled) {
          b.trusted("当前没有挂起的对话框（可能已被用户处理，或超时已自动处置）。可以 browser_snapshot 看看页面现状。");
          return;
        }
        b.trusted(`已${action === "accept" ? "确定" : "取消"}对话框，页面已继续运行。`);
        if (pending) b.trusted(`页面随后又弹出了${dialogDesc(pending)}，需要再次处理。`).markUntrusted();
        else b.trusted("页面状态可能已变化，必要时 browser_snapshot 确认。");
      },
    });
  }),
};

const EMULATE_DEVICES = ["iPhone 15", "iPhone SE", "Pixel 8", "iPad", "Galaxy S23", "Desktop 1440", "Desktop 1920"];
const EMULATE_NETWORKS = ["none", "slow3g", "fast3g", "4g"] as const;

/** emulate 的参数解析（宽松：数字可写成字符串）；返回给主进程的 camelCase 参数。至少要有一项，否则 BadArgs。 */
export const parseEmulateArgs = (args: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  const reset = argBool(args, "reset");
  if (reset !== undefined) out.reset = reset;
  const device = argStr(args, "device");
  if (device !== undefined) out.device = device;
  for (const [snake, camel] of [
    ["width", "width"],
    ["height", "height"],
    ["device_scale_factor", "deviceScaleFactor"],
    ["cpu_throttle", "cpuThrottle"],
  ] as const) {
    const n = argNum(args, snake);
    if (n !== undefined) out[camel] = n;
  }
  const mobile = argBool(args, "mobile");
  if (mobile !== undefined) out.mobile = mobile;
  const userAgent = argStr(args, "user_agent");
  if (userAgent !== undefined) out.userAgent = userAgent;
  const colorScheme = argEnum(args, "color_scheme", ["light", "dark"] as const);
  if (colorScheme !== undefined) out.colorScheme = colorScheme;
  const reducedMotion = argBool(args, "reduced_motion");
  if (reducedMotion !== undefined) out.reducedMotion = reducedMotion;
  const offline = argBool(args, "offline");
  if (offline !== undefined) out.offline = offline;
  const network = argEnum(args, "network", EMULATE_NETWORKS);
  if (network !== undefined) out.network = network;
  const geo = args.geolocation;
  if (geo !== undefined && geo !== null) {
    if (typeof geo !== "object" || Array.isArray(geo)) throw new BadArgs("geolocation 必须是对象 { latitude, longitude, accuracy? }");
    const g = geo as Record<string, unknown>;
    const latitude = argNum(g, "latitude");
    const longitude = argNum(g, "longitude");
    if (latitude === undefined || longitude === undefined) throw new BadArgs("geolocation 需要数字类型的 latitude 与 longitude");
    const accuracy = argNum(g, "accuracy");
    out.geolocation = { latitude, longitude, ...(accuracy !== undefined ? { accuracy } : {}) };
  }
  const timezone = argStr(args, "timezone");
  if (timezone !== undefined) out.timezone = timezone;
  const locale = argStr(args, "locale");
  if (locale !== undefined) out.locale = locale;
  parseEmulateE2Args(args, out);
  if (Object.keys(out).length === 0) {
    throw new BadArgs(`至少要给一个模拟项（device / width / color_scheme / network …），或 reset=true 清空全部模拟。device 可选：${EMULATE_DEVICES.join("、")}`);
  }
  return out;
};

// ── E2·P5b（C1）：browser_emulate 新增项（vision_deficiency / forced_colors / prefers_contrast / media / disable_cache / disable_javascript / touch / orientation / safe_area） ──
const EMULATE_VISION = ["none", "blurredVision", "reducedContrast", "achromatopsia", "deuteranopia", "protanopia", "tritanopia"] as const;
const EMULATE_FORCED_COLORS = ["active", "none"] as const;
const EMULATE_CONTRAST = ["more", "less", "no-preference", "custom"] as const;

const parseEmulateE2Args = (args: Record<string, unknown>, out: Record<string, unknown>): void => {
  const vision = argEnum(args, "vision_deficiency", EMULATE_VISION);
  if (vision !== undefined) out.visionDeficiency = vision;
  const forced = argEnum(args, "forced_colors", EMULATE_FORCED_COLORS);
  if (forced !== undefined) out.forcedColors = forced;
  const contrast = argEnum(args, "prefers_contrast", EMULATE_CONTRAST);
  if (contrast !== undefined) out.prefersContrast = contrast;
  // media：空串 = 恢复默认。argStr 把空串当「没给」，所以单独识别并传 null 给主进程
  if (typeof args.media === "string") {
    const m = args.media.trim().toLowerCase();
    if (m === "") out.media = null;
    else if (m === "print" || m === "screen") out.media = m;
    else throw new BadArgs(`media 只能是 print / screen（空字符串 = 恢复默认），收到「${m.slice(0, 20)}」`);
  }
  for (const [snake, camel] of [
    ["disable_cache", "disableCache"],
    ["disable_javascript", "disableJavascript"],
    ["touch", "touch"],
  ] as const) {
    const b = argBool(args, snake);
    if (b !== undefined) out[camel] = b;
  }
  const readObj = (key: string, fields: readonly string[]): Record<string, number> | undefined => {
    const v = args[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "object" || Array.isArray(v)) throw new BadArgs(`${key} 必须是对象 { ${fields.join(", ")} }`);
    const rec = v as Record<string, unknown>;
    const o: Record<string, number> = {};
    for (const f of fields) {
      const n = argNum(rec, f);
      if (n !== undefined) o[f] = n;
      else if (rec[f] !== undefined && rec[f] !== null && rec[f] !== "") throw new BadArgs(`${key}.${f} 必须是数字`);
    }
    if (Object.keys(o).length === 0) throw new BadArgs(`${key} 至少要给 ${fields.join(" / ")} 之一`);
    return o;
  };
  const orientation = readObj("orientation", ["alpha", "beta", "gamma"]);
  if (orientation) out.orientation = orientation;
  const safeArea = readObj("safe_area", ["top", "right", "bottom", "left"]);
  if (safeArea) out.safeArea = safeArea;
};

const emulateTool: FlowshipToolDef = {
  name: "browser_emulate",
  label: "浏览器·设备模拟",
  description: `模拟设备 / 环境（作用于当前标签页，多次调用叠加，reset=true 清空），测响应式布局 / 暗色 / 弱网 / 无障碍 / 打印样式。device 预设：${EMULATE_DEVICES.join("、")}；disable_javascript 会让页面脚本全停，用完务必 reset。`,
  parameters: TBObject({
    reset: TBOptional(TBBoolean()),
    device: TBOptional(TBString()),
    width: TBOptional(TBNumber({ description: "200-4000" })),
    height: TBOptional(TBNumber({ description: "200-4000" })),
    device_scale_factor: TBOptional(TBNumber({ description: "1-4" })),
    mobile: TBOptional(TBBoolean()),
    user_agent: TBOptional(TBString()),
    color_scheme: TBOptional(TBEnum(["light", "dark"])),
    reduced_motion: TBOptional(TBBoolean()),
    offline: TBOptional(TBBoolean()),
    network: TBOptional(TBEnum([...EMULATE_NETWORKS])),
    cpu_throttle: TBOptional(TBNumber({ description: "降速倍数 1-20" })),
    geolocation: TBOptional(
      TBObject({ latitude: TBNumber(), longitude: TBNumber(), accuracy: TBOptional(TBNumber()) }),
    ),
    timezone: TBOptional(TBString({ description: "IANA，如 Asia/Shanghai" })),
    locale: TBOptional(TBString({ description: "如 zh-CN" })),
    vision_deficiency: TBOptional(TBEnum([...EMULATE_VISION], { description: "色盲 / 模糊；none 取消" })),
    forced_colors: TBOptional(TBEnum([...EMULATE_FORCED_COLORS])),
    prefers_contrast: TBOptional(TBEnum([...EMULATE_CONTRAST])),
    media: TBOptional(TBString({ description: "print / screen；空串恢复" })),
    disable_cache: TBOptional(TBBoolean()),
    disable_javascript: TBOptional(TBBoolean({ description: "用完请 reset" })),
    touch: TBOptional(TBBoolean({ description: "强制开 / 关触屏" })),
    orientation: TBOptional(
      TBObject({ alpha: TBOptional(TBNumber()), beta: TBOptional(TBNumber()), gamma: TBOptional(TBNumber()) }, { description: "设备方向，度：α0-360 β±180 γ±90" }),
    ),
    safe_area: TBOptional(
      TBObject({ top: TBOptional(TBNumber()), right: TBOptional(TBNumber()), bottom: TBOptional(TBNumber()), left: TBOptional(TBNumber()) }, { description: "安全区 px 0-1000" }),
    ),
  }),
  handler: guarded(async (args, ctx) => {
    const emuArgs = parseEmulateArgs(args);
    return run<{ applied?: string[]; emulation?: string | null }>(ctx, {
      op: "emulate",
      args: emuArgs,
      render: (r, b) => {
        const applied = Array.isArray(r?.applied) ? r.applied : [];
        b.trusted(`已应用设备模拟：${applied.length > 0 ? applied.join("；") : "（无变化）"}。`);
        b.trusted(r?.emulation ? `当前模拟：${r.emulation}。` : "当前没有任何模拟（已是浏览器原始环境）。");
        b.trusted("页面可能已按新环境重排，需要看效果请 browser_snapshot / browser_screenshot；UA 变化对已加载的页面请求需刷新后才体现。");
        // E2·P5b：禁用 JS 是高后果开关——页面脚本全停（页内交互 / 前端渲染的内容都不再更新），模型最容易「设了就忘」
        if (r?.emulation && /禁用 JS/.test(r.emulation)) {
          b.trusted("注意：JavaScript 当前处于禁用状态，页面脚本全部停止；测完请调用 browser_emulate reset=true（或 disable_javascript=false）恢复，用户在面板上点「重置模拟」也能恢复。");
        }
        // orientation 要先有 sensors 权限：未授权时页面的 deviceorientation 只会收到值为 null 的事件（P1 的权限策略默认拒绝 sensors）
        if (r?.emulation && /方向|orientation/i.test(r.emulation)) {
          b.trusted("提示：设备方向事件需要页面拥有 sensors 权限，否则页面只会收到值为空的事件；需要时先 browser_permissions grant sensors（要开启「页面权限」开关），或让用户在提示条里允许。");
        }
      },
    });
  }),
};

// ═══ /V5 ═══

const BASE_TOOLS: FlowshipToolDef[] = [
  navigateTool,
  snapshotTool,
  screenshotTool,
  clickTool,
  hoverTool,
  typeTool,
  pressKeyTool,
  selectTool,
  scrollTool,
  dragTool,
  waitForTool,
  tabsTool,
  consoleTool,
  networkTool,
  userActivityTool,
  askTool,
  mouseTool,
  fillFormTool,
  readTool,
  inspectTool,
  saveTool,
  uploadTool,
  downloadsTool,
  dialogTool,
  emulateTool,
];

export const BROWSER_TOOL_NAMES: readonly string[] = [...BASE_TOOLS.map((t) => t.name), evaluateTool.name];

/**
 * 当前会话该注册哪些浏览器工具。
 * 条件：bridge 可用 + 有 taskId + 非只读（readOnly / 受限答疑没有「替用户操作网页」的资格；属主一次性 agent 带 callerToken、有 taskId，同样会挂——有意保留，见 tests/one-shot-system-tools.test.ts）。
 */
/**
 * 契约 §15.1：增强包 E2 的工具模块（`tools-*.ts`）通过这份 kit 复用本文件的内部积木——它们不能 import 本文件
 * （本文件 import 它们，运行时会成环），所以由这里把积木打包成对象交过去；模块里只 `import type { BrowserToolKit } from "./tools"`（类型，擦除）。
 * 缺什么积木就往这里加一项（小改动，别在模块里复制一份）。
 */
const buildToolKit = () => ({
  run,
  guarded,
  errorOut,
  BadArgs,
  argStr,
  argBool,
  argNum,
  argEnum,
  reqStr,
  reqRef,
  optRef,
  renderAction,
  pageLine,
  clipRedacted,
  clipEntry,
  tabLines,
  clock,
  ToolResultBuilder,
  wrapUntrustedInline,
  truncateWithNote,
  redactSensitiveText,
  describeBrowserError,
  getSettings: getBrowserSettingsSync,
  REF_SCHEMA,
});
export type BrowserToolKit = ReturnType<typeof buildToolKit>;
export type { Out as BrowserToolOut, RunSpec as BrowserRunSpec };

export const getBrowserTools = (opts: { taskId?: string; readOnly?: boolean }): FlowshipToolDef[] => {
  if (!opts.taskId || opts.readOnly) return [];
  if (!isBrowserBridgeAvailable()) return [];
  installBrowserStopHook();
  // E2·A7：主进程「永久开启 evaluate」的 settings_set 事件由 settings-events.ts 处理；会话创建必经这里，按 bridge 实例幂等
  try {
    ensureBrowserSettingsEventsRegistered();
  } catch (err) {
    console.warn("[browser] 设置事件处理器注册失败（忽略）：", err instanceof Error ? err.message : err);
  }
  const settings = getBrowserSettingsSync();
  // browser_evaluate 常驻注册（A7）：总闸没开时由主进程弹审批卡，不再靠工具表隐藏；browserAdvancedTools 关闭时也照常注册
  const tools = [...BASE_TOOLS, evaluateTool];
  // 增强包 E2：核心组始终注册（各工具在 handler / 主进程里再按设置闸门拦），高级调试组由 browserAdvancedTools 控制（对新会话生效）
  tools.push(...getE2Tools(buildToolKit(), { advanced: settings.advancedTools }));
  return tools;
};
