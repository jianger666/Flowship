/**
 * 增强包 E2 面板条（契约 §15.1 / §15.2）的纯逻辑：提示条（认证 / 证书 / 权限 / evaluate 授权 / 客户端证书）、
 * 网络规则横幅、断点暂停条、录制条。无 DOM、无 window，组件只管渲染，判定都能在 vitest 里直接断言。
 *
 * 安全约束：提示的 host / detail 来自页面 / 网络（realm、证书主题、权限名……），展示前一律过 clipOneLine（剥格式字符 + 限长）；
 * 凭据（auth 的用户名密码）只在组件的本地 state 里活到点击提交，不经过这里、不进状态、不进日志。
 */
import type { BrowserPromptInfo, BrowserPromptKind, BrowserState } from "@/lib/browser-bridge-types";
import { clipOneLine } from "@/lib/one-line";

export type PromptActionVariant = "default" | "outline" | "destructive";

export interface PromptActionView {
  id: string;
  label: string;
  variant: PromptActionVariant;
}

export interface PromptBarModel {
  id: string;
  kind: BrowserPromptKind;
  /** 窄面板里会被截断的标题（带主机） */
  heading: string;
  /** Tooltip 里的完整标题 */
  headingFull: string;
  /** 补充说明（每条一行；值来自页面 / 网络，已剥格式字符 + 限长） */
  lines: string[];
  /** 需要用户名 / 密码输入框（只有 auth） */
  needsCredentials: boolean;
  actions: PromptActionView[];
  /** 超时提示（「60 秒内未处理将自动取消」）；没有过期时间 = 空串 */
  timeoutHint: string;
}

export const PROMPT_KIND_LABEL: Record<BrowserPromptKind, string> = {
  auth: "网站要求登录",
  cert: "证书不受信任",
  permission: "页面请求权限",
  evaluate: "AI 请求在页面里执行脚本",
  clientcert: "网站要求客户端证书",
};

const ACTION_LABELS: Record<string, Record<string, { label: string; variant: PromptActionVariant }>> = {
  auth: {
    cancel: { label: "取消", variant: "outline" },
    submit: { label: "登录", variant: "default" },
  },
  cert: {
    deny: { label: "返回安全页面", variant: "outline" },
    // 放行范围 = 本会话 + 这个主机 + 这张证书（主进程 net-guard 的 allow-host）：写成「本次会话」比「仅本次」准确，别让用户以为只放行这一次请求
    "allow-host": { label: "本次会话继续访问", variant: "destructive" },
  },
  permission: {
    deny: { label: "拒绝", variant: "outline" },
    allow: { label: "允许（仅这次）", variant: "default" },
    "allow-session": { label: "本次会话一直允许", variant: "outline" },
  },
  evaluate: {
    deny: { label: "拒绝", variant: "outline" },
    task: { label: "仅本任务允许", variant: "default" },
    always: { label: "永久开启", variant: "outline" },
  },
  clientcert: {
    decline: { label: "不提供", variant: "outline" },
    select: { label: "选择证书", variant: "default" },
  },
};

const shortHost = (host: string): string => (host.length > 40 ? `${host.slice(0, 39)}…` : host);

/** 权限名 → 中文（认不出的原样展示，已剥格式字符） */
export const PERMISSION_LABEL: Record<string, string> = {
  geolocation: "位置信息",
  notifications: "通知",
  "clipboard-read": "读取剪贴板",
  "clipboard-sanitized-write": "写入剪贴板",
  media: "摄像头 / 麦克风",
  "background-sync": "后台同步",
  sensors: "传感器",
  midi: "MIDI 设备",
  "idle-detection": "空闲检测",
  "display-capture": "屏幕共享",
  fullscreen: "全屏",
  "pointerLock": "鼠标锁定",
};

export const describePrompt = (p: BrowserPromptInfo | null | undefined): PromptBarModel | null => {
  if (!p || typeof p !== "object" || typeof p.id !== "string") return null;
  const kind = p.kind in PROMPT_KIND_LABEL ? p.kind : null;
  if (!kind) return null;
  const host = clipOneLine(typeof p.host === "string" ? p.host : "", 120);
  const detail = p.detail && typeof p.detail === "object" ? p.detail : {};
  const lines: string[] = [];
  const get = (k: string): string => (typeof detail[k] === "string" ? clipOneLine(detail[k], 160) : "");
  if (kind === "auth") {
    const realm = get("realm");
    if (realm) lines.push(`站点声明：${realm}`);
    if (get("proxy") === "true") lines.push("这是代理服务器的认证");
    lines.push("账号和密码只交给网站，不会经过 AI，也不会被记录");
  } else if (kind === "cert") {
    const err = get("error");
    if (err) lines.push(`错误：${err}`);
    const subject = get("subject");
    if (subject) lines.push(`证书主题：${subject}`);
    const issuer = get("issuer");
    if (issuer) lines.push(`颁发者：${issuer}`);
    lines.push("继续访问意味着这次连接可能被窃听或篡改，只在你信任这个站点时才继续");
  } else if (kind === "permission") {
    const perm = get("permission");
    lines.push(`请求：${PERMISSION_LABEL[perm] ?? perm}`);
    const origin = get("origin");
    if (origin) lines.push(`来源：${origin}`);
  } else if (kind === "evaluate") {
    const what = get("summary");
    if (what) lines.push(`脚本摘要：${what}`);
    lines.push("允许后 AI 可以在网页里运行任意 JavaScript：能读写页面上的一切内容");
    // R6-04：这里只展示了第一段脚本；「仅本任务」之后本任务的后续脚本不再询问，要让用户知情（执行记录在活动日志里）
    lines.push("选「仅本任务允许」后，本任务之后的脚本不再询问（每次执行都会记入活动日志）；「永久开启」等于打开设置里的总开关");
  } else if (kind === "clientcert") {
    const subject = get("subject");
    if (subject) lines.push(`证书主题：${subject}`);
    const issuer = get("issuer");
    if (issuer) lines.push(`颁发者：${issuer}`);
    lines.push("该网站要求提供客户端证书；Flowship 不会替你自动选择");
  }
  const labels = ACTION_LABELS[kind];
  const actions: PromptActionView[] = (Array.isArray(p.actions) ? p.actions : [])
    .filter((id): id is string => typeof id === "string")
    .map((id) => ({ id, label: labels?.[id]?.label ?? id, variant: labels?.[id]?.variant ?? "outline" }));
  const total = Number.isFinite(p.expiresAt) && Number.isFinite(p.since) ? Math.round((p.expiresAt - p.since) / 1000) : 0;
  const fallback = actions[0]?.label ?? "取消";
  return {
    id: p.id,
    kind,
    heading: `${PROMPT_KIND_LABEL[kind]}${host ? `：${shortHost(host)}` : ""}`,
    headingFull: `${PROMPT_KIND_LABEL[kind]}${host ? `：${host}` : ""}`,
    lines,
    needsCredentials: kind === "auth",
    actions,
    timeoutHint: total > 0 ? `${total} 秒内未处理将自动「${fallback}」` : "",
  };
};

/**
 * 提示条（新提示）出现后按钮的「防误点」延迟（R6-20）：页面自己导航会取消它的权限提示，
 * 排在后面的 evaluate / 证书 / 认证提示会立刻顶到同一个屏幕位置——用户正伸手点上一条的「拒绝」时，
 * 可能点到这条的「允许」。延迟期间按钮置灰，且以提示 id 为 key 重新计时（换提示即重置）。
 */
export const PROMPT_ARM_DELAY_MS = 500;

/** 一次最多画几条提示（其余排队：回答完一条才显示下一条，别把面板挤满） */
export const MAX_VISIBLE_PROMPTS = 1;

export const visiblePrompts = (prompts: BrowserPromptInfo[] | null | undefined): BrowserPromptInfo[] =>
  (Array.isArray(prompts) ? prompts : []).slice(0, MAX_VISIBLE_PROMPTS);

export const queuedPromptCount = (prompts: BrowserPromptInfo[] | null | undefined): number =>
  Math.max(0, (Array.isArray(prompts) ? prompts.length : 0) - MAX_VISIBLE_PROMPTS);

// ───────────────────────── 网络规则横幅 / 断点条 / 录制条 ─────────────────────────

export interface NetRulesBannerModel {
  text: string;
  paused: boolean;
}

export const describeNetRulesBanner = (r: BrowserState["netRules"]): NetRulesBannerModel | null => {
  if (!r || typeof r !== "object" || !(r.count > 0)) return null;
  const n = Math.round(r.count);
  return {
    paused: r.paused === true,
    text: r.paused
      ? `AI 设置了 ${n} 条网络规则（你接管期间已暂停，交还后恢复）`
      : `AI 设置了 ${n} 条网络规则，正在影响这个页面的请求`,
  };
};

export interface DebugBarModel {
  text: string;
}

export const describeDebugBar = (d: BrowserState["debug"]): DebugBarModel | null => {
  if (!d || typeof d !== "object" || d.paused !== true) return null;
  const where = d.url ? `${clipOneLine(d.url, 80)}${typeof d.line === "number" ? `:${Math.round(d.line)}` : ""}` : "";
  const reason = d.reason ? clipOneLine(d.reason, 60) : "断点";
  return { text: `页面已在调试器中暂停（${reason}${where ? `，${where}` : ""}），页面脚本被冻结` };
};

export interface RecordingBarModel {
  text: string;
}

export const describeRecordingBar = (r: BrowserState["recording"]): RecordingBarModel | null => {
  if (!r || typeof r !== "object" || !(r.frames >= 0) || !Number.isFinite(r.startedAt)) return null;
  return { text: `正在录制页面（已 ${Math.round(r.frames)} 帧）` };
};
