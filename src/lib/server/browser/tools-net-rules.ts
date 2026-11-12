/**
 * 增强包 E2 · A5 browser_network_rules（server 工具定义）：拦截 / 改写当前标签页的网络请求（高级调试组，`browserAdvancedTools` 开关控制注册）。
 * 主进程实现在 electron-app/browser/ops/net-rules.mjs，纯逻辑（pattern / 头 / mock 校验、规则仓库、命中决策、`Fetch.requestPaused` 的恰好一次处理器）
 * 在 electron-app/browser/net-rules-engine.mjs。
 *
 * # 分工（校验两层）
 * 本文件只做「形状」检查（action 枚举、pattern 必填且不含空白、字段类型宽松归一）并把参数转成 camelCase 交给主进程；
 * 范围 / 禁止头 / 上限 20 / mock ≤1MB / Flowship origin 排除 / 用户接管暂停等**都由主进程独立判定**，server 被绕过也不会越权。
 *
 * # 凭据
 * `set_headers` 的值（可能是 token）只在「工具入参 → 主进程规则」这一条路上出现：结果文案只给头名；入参落盘前由 `redact-args.ts` 把值换成占位符；
 * 主进程的 list / 状态 / 活动日志同样只有头名。
 *
 * # 文案
 * 可信行里只有固定话术与形状受限的字段（规则 id 必须是 r+数字、动作名来自枚举、数字取有限整数）；pattern / 头名 / 路径之类的字符串一律先脱敏再截断、
 * 放进 untrusted 块。
 *
 * 积木从 `kit` 取（见 tools.ts 的 buildToolKit）；不要 import "./tools"（成环），类型用 `import type`。
 */
import { Array as TBArray, Enum as TBEnum, Number as TBNumber, Object as TBObject, Optional as TBOptional, String as TBString } from "typebox/type";
import type { FlowshipToolDef } from "../flowship-tools";
import { approvalAwareTimeoutMs } from "./approval-timeout";
import type { ToolResultBuilder } from "./content";
import { safeInt } from "./network-render";
import type { BrowserToolKit } from "./tools";

export const NET_RULE_TOOL_ACTIONS = ["block", "set_headers", "mock", "fail", "delay", "list", "clear"] as const;
export type NetRuleToolAction = (typeof NET_RULE_TOOL_ACTIONS)[number];
/** `fail` 的 error_reason：与主进程 engine 的 FAIL_REASONS 逐项一致（测试对账） */
export const NET_RULE_FAIL_REASONS = [
  "Failed",
  "Aborted",
  "TimedOut",
  "AccessDenied",
  "ConnectionClosed",
  "ConnectionReset",
  "ConnectionRefused",
  "ConnectionFailed",
  "NameNotResolved",
  "InternetDisconnected",
  "AddressUnreachable",
  "BlockedByClient",
] as const;

const ACTION_ZH: Record<string, string> = {
  block: "屏蔽",
  set_headers: "加请求头",
  mock: "模拟响应",
  fail: "制造失败",
  delay: "延迟",
};

interface RuleView {
  id?: string;
  action?: string;
  pattern?: string;
  hits?: number;
  headerNames?: string[];
  status?: number;
  contentType?: string;
  bodyBytes?: number;
  errorReason?: string;
  delayMs?: number;
}

interface NetRulesResult {
  action?: string;
  tabId?: string;
  rule?: RuleView;
  rules?: RuleView[];
  count?: number;
  limit?: number;
  paused?: boolean;
  removed?: number;
  otherTabs?: Array<{ tabId?: string; count?: number }>;
  otherTabsWithRules?: number;
}

/**
 * R14（2026-11-11 正式包闪退）：对「带请求体且跨源」的请求调 Fetch.fulfillRequest 会让 Chromium 浏览器进程崩溃，主进程对这类请求的 mock 一律改成让请求失败（不放行真请求）。
 * 两段都是固定话术（无任何外部输入）：
 *  - SHORT 并进工具描述（每轮 prompt 都带，受「≤ 2 句」与体量预算守卫约束，所以只有一小句，且不能含句号）；
 *  - LONG 是 mock 设置成功后的返回提示（不占每轮 prompt），把限制、现象、替代办法讲全，让模型在设规则时就知道、不要等点击后才撞上。
 */
const MOCK_LIMIT_SHORT = "mock 不能用于跨源且带请求体（POST / PUT / PATCH）的请求，会被直接拒绝，需要时改用 browser_evaluate 替换页面里的 fetch / XHR 或 mock 同源接口";
const MOCK_LIMIT_LONG =
  "【mock 的限制】跨源且带请求体（POST / PUT / PATCH）的请求不能 mock：命中时会被直接拒绝——请求失败（页面看到网络错误）、不会放行到真实后端，browser_network 里该请求带「mock被安全拒绝」标记（原因：Chromium 对这类请求做 mock 会让整个浏览器进程崩溃）。" +
  "同源请求、GET / DELETE、不带请求体的请求不受影响。需要模拟这类接口时：用 browser_evaluate 在页面里替换 fetch / XMLHttpRequest（它受审批控制：总闸没开时会弹审批卡让用户决定，被拒就别绕路），或改 mock 同源接口。";

/** block / fail 命中「跨源且带请求体」的请求时同样走安全拒绝：请求照样失败，只是失败原因显示为 ERR_UNSAFE_PORT。固定话术，只拼进 block / fail 设置成功的提示 */
const BLOCK_FAIL_UNSAFE_PORT_NOTE =
  "对跨源且带请求体（POST / PUT / PATCH）的请求，系统用安全方式让它在本机立刻失败（不外发），browser_network 里这类请求的失败原因会显示为 net::ERR_UNSAFE_PORT——这是正常的拒绝，不是真实网络故障。";

const RULE_ID_RE = /^r\d{1,6}$/;
const safeRuleId = (v: unknown): string => (typeof v === "string" && RULE_ID_RE.test(v) ? v : "?");
const safeAction = (v: unknown): string => (typeof v === "string" && v in ACTION_ZH ? v : "?");

/** 模型给的 headers 可能是数组 / 对象 / JSON 字符串：形状对就原样交给主进程校验，其余在这里就拒 */
const parseHeadersArg = (raw: unknown, BadArgs: new (m?: string) => Error): unknown => {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw === "string" || (typeof raw === "object" && raw !== null)) return raw;
  throw new BadArgs("headers 必须是 [{name, value}] 数组或 {头名: 值} 对象");
};

export const createNetRulesTools = (kit: BrowserToolKit): FlowshipToolDef[] => {
  const { run, guarded, BadArgs, argStr, argNum, argEnum, clipRedacted, getSettings } = kit;

  /** 规则一行（放进 untrusted 块）：只有 pattern（已在主进程脱敏、这里再脱敏一遍）、头名、数字与枚举 */
  const ruleLine = (v: RuleView): string => {
    const detail: string[] = [];
    if (v.action === "set_headers" && Array.isArray(v.headerNames)) detail.push(`头 ${v.headerNames.map((n) => clipRedacted(n, 60)).join("、")}（值已隐藏）`);
    if (v.action === "mock") {
      detail.push(`状态 ${safeInt(v.status) || "?"}`);
      if (v.contentType) detail.push(clipRedacted(v.contentType, 80));
      if (typeof v.bodyBytes === "number") detail.push(`body ${safeInt(v.bodyBytes)} 字节`);
      if (Array.isArray(v.headerNames) && v.headerNames.length > 0) detail.push(`响应头 ${v.headerNames.map((n) => clipRedacted(n, 60)).join("、")}`);
    }
    if (v.action === "fail" && v.errorReason) detail.push(`原因 ${clipRedacted(v.errorReason, 40)}`);
    if (v.action === "delay") detail.push(`${safeInt(v.delayMs) || "?"}ms`);
    return `${safeRuleId(v.id)} ${ACTION_ZH[safeAction(v.action)] ?? "?"} ${clipRedacted(v.pattern, 300)}${detail.length > 0 ? ` | ${detail.join(" | ")}` : ""} | 已命中 ${safeInt(v.hits) || 0} 次`;
  };

  const render = (r: NetRulesResult, b: ToolResultBuilder): void => {
    if (r?.action === "list") {
      const rules = Array.isArray(r.rules) ? r.rules : [];
      b.trusted(
        `本标签页的网络规则：${rules.length}/${safeInt(r.limit) || 20} 条${r.paused ? "；用户正在接管浏览器，规则已暂停（不生效），交还给你后自动恢复" : ""}。` +
          (rules.length === 0 ? "（没有规则）" : ""),
      );
      if (rules.length > 0) b.untrusted(rules.map(ruleLine).join("\n"));
      const others = (Array.isArray(r.otherTabs) ? r.otherTabs : []).filter((o) => typeof o?.tabId === "string" && /^[\w.:-]{1,40}$/.test(o.tabId));
      if (others.length > 0) b.trusted(`其它标签页也有规则：${others.map((o) => `${o.tabId}（${safeInt(o.count)} 条）`).join("、")}（用 tab_id 指定后再 list / clear）。`);
      return;
    }
    if (r?.action === "clear") {
      b.trusted(
        `已清除 ${safeInt(r.removed) || 0} 条网络规则，本标签页还剩 ${safeInt(r.count) || 0} 条。` +
          ((r.otherTabsWithRules ?? 0) > 0 ? `另有 ${safeInt(r.otherTabsWithRules)} 个标签页还有规则（用 tab_id 指定后清除）。` : "") +
          ((r.count ?? 0) === 0 ? "页面的请求拦截已关闭。" : ""),
      );
      return;
    }
    const v = r?.rule ?? {};
    const action = safeAction(r?.action);
    b.trusted(
      `已设置网络规则 ${safeRuleId(v.id)}（${ACTION_ZH[action] ?? "?"}）：本标签页现有 ${safeInt(r?.count) || 1}/${safeInt(r?.limit) || 20} 条。` +
        "只对这个标签页生效，标签页关闭 / clear / 会话结束就失效；用户接管浏览器期间自动暂停，交还后恢复；Flowship 自身页面永远不受影响。" +
        (action === "set_headers" ? "头的值不会出现在任何输出里。" : "") +
        (action === "mock" ? "跨域请求会自动回显 Origin 作为 Access-Control-Allow-Origin，CORS 预检由系统代答。" + MOCK_LIMIT_LONG : "") +
        (action === "block" || action === "fail" ? BLOCK_FAIL_UNSAFE_PORT_NOTE : "") +
        "被处理的请求在 browser_network 里带 ⚑ 标记；规则对已经发出的请求不生效，需要重新触发。",
    );
    b.untrusted(ruleLine(v));
  };

  const netRulesTool: FlowshipToolDef = {
    name: "browser_network_rules",
    label: "浏览器·网络规则",
    description:
      "拦截 / 改写当前标签页的网络请求（高级调试）：action=block 屏蔽、set_headers 加请求头、mock 返回假响应、fail 制造失败、delay 延迟，list 查看、clear 清除（可带 rule_id）；pattern 用 * 通配匹配整个 URL（以 http(s):// 或 * 开头、不能含空格）。" +
      `每个标签页最多 20 条、不落盘、用户接管时自动暂停，请求头的值不会出现在任何输出里，Flowship 自身页面永不受影响，被处理的请求在 browser_network 里带 ⚑ 标记；${MOCK_LIMIT_SHORT}。`,
    parameters: TBObject({
      action: TBEnum([...NET_RULE_TOOL_ACTIONS]),
      pattern: TBOptional(
        TBString({ description: "block / set_headers / mock / fail / delay 必填：匹配整个 URL 的通配，* = 任意字符，如 *://api.example.com/v1/* 或 https://x.com/*.png；不含空格，≤500 字符" }),
      ),
      headers: TBOptional(
        TBArray(TBObject({ name: TBString(), value: TBString() }), {
          description:
            "set_headers 必填：要加 / 覆盖的请求头 [{name, value}]（也认 {头名: 值}）；mock 时是额外的响应头。禁改 Host / Content-Length / Transfer-Encoding / Connection / Cookie / Proxy-* / Sec-* 等；值不会出现在任何输出里",
        }),
      ),
      status: TBOptional(TBNumber({ description: "mock：状态码 200–599，默认 200" })),
      body: TBOptional(TBString({ description: "mock：响应体（≤1MB；对象会自动 JSON 序列化）" })),
      content_type: TBOptional(TBString({ description: "mock：Content-Type，缺省按 body 猜（JSON / 纯文本）" })),
      error_reason: TBOptional(TBEnum([...NET_RULE_FAIL_REASONS])),
      delay_ms: TBOptional(TBNumber({ description: "delay 必填：延迟毫秒数 1–30000" })),
      rule_id: TBOptional(TBString({ description: "clear：只删这一条（list 里的 r1 / r2 …）；缺省清空本标签页全部规则" })),
      tab_id: TBOptional(TBString()),
    }),
    handler: guarded(async (args, ctx) => {
      const action = argEnum(args, "action", NET_RULE_TOOL_ACTIONS);
      if (!action) throw new BadArgs(`缺少必填参数 action（${NET_RULE_TOOL_ACTIONS.join(" / ")}）`);
      const tabId = argStr(args, "tab_id");
      const opArgs: Record<string, unknown> = { action, ...(tabId !== undefined ? { tabId } : {}) };

      if (action === "list") return run<NetRulesResult>(ctx, { op: "net_rules", args: opArgs, render });
      if (action === "clear") {
        const ruleId = argStr(args, "rule_id");
        if (ruleId !== undefined && !RULE_ID_RE.test(ruleId)) throw new BadArgs("rule_id 必须是 browser_network_rules list 里的编号（r1 / r2 …）");
        return run<NetRulesResult>(ctx, { op: "net_rules", args: { ...opArgs, ...(ruleId !== undefined ? { ruleId } : {}) }, render });
      }

      // 形状检查（范围 / 禁止头 / 上限 / 多余参数由主进程判）
      const pattern = argStr(args, "pattern");
      if (pattern === undefined) {
        throw new BadArgs("缺少必填参数 pattern：匹配整个 URL 的通配（* = 任意字符），如 *://api.example.com/v1/* ；以 http:// / https:// 或 * 开头");
      }
      if (/[\s\u0000-\u001f\u007f]/.test(pattern)) throw new BadArgs("pattern 不能含空格 / 换行（URL 里的空格要写成 %20；检查首尾是否多了空白）");
      if (pattern.length > 500) throw new BadArgs("pattern 过长（上限 500 字符）");
      opArgs.pattern = pattern;

      const headers = parseHeadersArg(args.headers, BadArgs);
      if (action === "set_headers" && headers === undefined) throw new BadArgs("set_headers 需要 headers：[{name, value}] 或 {头名: 值}");
      if (headers !== undefined) opArgs.headers = headers;

      const status = argNum(args, "status");
      if (status !== undefined) opArgs.status = Math.floor(status);
      if (args.body !== undefined && args.body !== null) {
        // 模型常把 JSON body 直接写成对象：替它序列化，别让一个类型问题挡住 mock
        opArgs.body = typeof args.body === "string" ? args.body : typeof args.body === "object" ? JSON.stringify(args.body) : String(args.body);
      }
      const contentType = argStr(args, "content_type");
      if (contentType !== undefined) opArgs.contentType = contentType;
      const reason = argEnum(args, "error_reason", NET_RULE_FAIL_REASONS);
      if (reason !== undefined) opArgs.errorReason = reason;
      const delay = argNum(args, "delay_ms");
      if (action === "delay" && delay === undefined) throw new BadArgs("delay 需要 delay_ms（1–30000 毫秒）");
      if (delay !== undefined) opArgs.delayMs = Math.floor(delay);

      // R6-33：mock 的有效 Content-Type 不在免审批白名单里（html / js / svg / xml / css / pdf …）时，主进程会弹 evaluate 审批（最长等 120s），
      // 本地超时不能是默认的 60s。server 不复刻主进程的类型判定（会漂移；嗅探默认值、headers 里的 Content-Type 都要算），所以 mock 一律按「可能弹审批」处理：
      // 总闸开着 → 默认超时；否则审批 120s + 创建规则 15s + slack 15s。block / set_headers / fail / delay 永不弹审批，保持默认
      const timeoutMs = action === "mock" ? approvalAwareTimeoutMs({ evaluateEnabled: getSettings().evaluateEnabled }) : undefined;
      return run<NetRulesResult>(ctx, { op: "net_rules", args: opArgs, render, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
    }),
  };
  return [netRulesTool];
};
