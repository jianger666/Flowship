/**
 * E2·P7b（B4）：`browser_inspect` 新 include（matched_rules / event_listeners / a11y_audit）的结果渲染。
 *
 * 纯函数、不依赖 tools.ts（避免成环）；输出的每一行都是页面数据（选择器 / 声明值 / 事件类型 / axe 选择器），
 * 由调用方（browser_inspect 的 render）整体放进 `b.untrusted(...)` 并再过一遍 `redactSensitiveText`；这里每行也先脱敏 + 限长。
 */
import { redactSensitiveText } from "./redact-text";

export interface MatchedDecl {
  name?: string;
  value?: string;
  important?: boolean;
}
export interface MatchedRule {
  selector?: string;
  origin?: string;
  source?: string;
  decls?: MatchedDecl[];
  omittedDecls?: number;
}
export interface MatchedRulesResult {
  inline?: MatchedDecl[];
  rules?: MatchedRule[];
  uaCount?: number;
  omitted?: number;
  error?: string;
}
export interface EventListenerItem {
  type?: string;
  capture?: boolean;
  once?: boolean;
  passive?: boolean;
  location?: string;
}
export interface EventListenersResult {
  listeners?: EventListenerItem[];
  total?: number;
  omitted?: number;
  error?: string;
}
export interface A11yViolation {
  id?: string;
  impact?: string;
  help?: string;
  nodes?: number;
  selectors?: string[];
}
export interface A11yAuditResult {
  version?: string;
  total?: number;
  passes?: number;
  incomplete?: number;
  violations?: A11yViolation[];
  omitted?: number;
  error?: string;
}
export interface InspectExtras {
  matchedRules?: MatchedRulesResult;
  eventListeners?: EventListenersResult;
  a11yAudit?: A11yAuditResult;
}

const clip = (s: unknown, n: number): string => {
  const red = redactSensitiveText(String(s ?? "").replace(/[\r\n]+/g, " "));
  return red.length > n ? `${red.slice(0, n - 1)}…` : red;
};

const declText = (d: MatchedDecl): string => `${clip(d.name, 80)}: ${clip(d.value, 300)}${d.important ? " !important" : ""}`;

const IMPACT_ZH: Record<string, string> = { critical: "严重", serious: "较重", moderate: "中等", minor: "轻微", unknown: "未知" };

/** 把三个新 include 的结果渲染成文字行；没有对应字段就不输出 */
export const renderInspectExtras = (r: InspectExtras | undefined): string[] => {
  const lines: string[] = [];
  const m = r?.matchedRules;
  if (m) {
    if (m.error) {
      lines.push(`匹配的 CSS 规则：获取失败——${clip(m.error, 300)}`);
    } else {
      const rules = m.rules ?? [];
      lines.push(
        `匹配的 CSS 规则（按层叠顺序，越靠后优先级越高；浏览器默认样式 ${m.uaCount ?? 0} 条已折叠${m.omitted ? `；另有 ${m.omitted} 条靠前的规则被省略` : ""}）：`,
      );
      if (m.inline && m.inline.length > 0) lines.push(`  [element.style 内联] ${m.inline.map(declText).join("; ")}`);
      if (rules.length === 0 && !(m.inline && m.inline.length > 0)) lines.push("  （没有作者样式规则命中）");
      for (const rule of rules) {
        const decls = (rule.decls ?? []).map(declText).join("; ");
        lines.push(`  [${clip(rule.origin, 20)}] ${clip(rule.selector, 200)}  ← ${clip(rule.source, 260)}`);
        lines.push(`      ${decls || "（无声明）"}${rule.omittedDecls ? `（另有 ${rule.omittedDecls} 个声明未列出）` : ""}`);
      }
    }
  }
  const e = r?.eventListeners;
  if (e) {
    if (e.error) {
      lines.push(`事件监听器：获取失败——${clip(e.error, 300)}`);
    } else {
      const list = e.listeners ?? [];
      lines.push(`事件监听器（该元素自身共 ${e.total ?? list.length} 个${e.omitted ? `，只列前 ${list.length} 个` : ""}；不含祖先 / document 上的委托监听）：`);
      if (list.length === 0) lines.push("  （没有）");
      for (const l of list) {
        lines.push(`  ${clip(l.type, 60)}｜capture=${l.capture ? "是" : "否"} once=${l.once ? "是" : "否"} passive=${l.passive ? "是" : "否"}｜${clip(l.location ?? "位置未知", 260)}`);
      }
    }
  }
  const a = r?.a11yAudit;
  if (a) {
    if (a.error) {
      lines.push(`a11y 审计：失败——${clip(a.error, 300)}`);
    } else {
      const vs = a.violations ?? [];
      lines.push(
        `a11y 审计（axe-core ${clip(a.version, 20) || "?"}，范围 = 该元素子树；违规 ${a.total ?? vs.length} 类｜通过 ${a.passes ?? 0} 项｜需人工确认 ${a.incomplete ?? 0} 项）：`,
      );
      if (vs.length === 0) lines.push("  （没有发现违规）");
      for (const v of vs) {
        const sel = (v.selectors ?? []).map((s) => clip(s, 200)).join(" ｜ ");
        lines.push(`  [${IMPACT_ZH[v.impact ?? "unknown"] ?? clip(v.impact, 12)}] ${clip(v.id, 60)}：${clip(v.help, 200)}｜${v.nodes ?? 0} 个节点${sel ? `｜例：${sel}` : ""}`);
      }
      if (a.omitted) lines.push(`  （另有 ${a.omitted} 类违规未列出：缩小范围——对更小的容器 ref 再审计）`);
    }
  }
  return lines;
};
