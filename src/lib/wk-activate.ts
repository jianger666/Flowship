/**
 * Delivery Hub REQ 激活（启动表单「激活项目」）
 *
 * 字段口径对齐团队 wk-harness `activation-command.md` + Hub 激活抽屉：
 * 飞书链接 / 项目名称从表单已有值带入，不另填；人工语义编码、需求方、计划上线日
 * 人手填；技术 Owner 从 Hub `/activation-owners` 候选里选（value=账号）。
 *
 * 本文件是纯逻辑 + 客户端 fetch（不碰 fs / Hub token），服务端落盘调用在
 * `server/wk-activate.ts`。
 */

/** Hub 前端 `demandParties.js` 码表，选项必须两边一致 */
export const DEMAND_PARTY_OPTIONS = [
  { label: "产品", value: "PM" },
  { label: "技术", value: "TECH" },
  { label: "HR", value: "HR" },
  { label: "品牌", value: "BRAND" },
  { label: "销售", value: "SALES" },
  { label: "增长", value: "GROWTH" },
  { label: "教务", value: "ACADEMIC_OPS" },
  { label: "教学", value: "TEACHING" },
  { label: "教研", value: "CURRICULUM" },
  { label: "财务", value: "FINANCE" },
  { label: "用研", value: "USER_RESEARCH" },
  { label: "客服", value: "CS" },
] as const;

export type DemandPartyCode = (typeof DEMAND_PARTY_OPTIONS)[number]["value"];

const DEMAND_PARTY_SET = new Set<string>(
  DEMAND_PARTY_OPTIONS.map((item) => item.value),
);

export const isDemandPartyCode = (raw: string): raw is DemandPartyCode =>
  DEMAND_PARTY_SET.has(raw.trim());

/** 必须是真实存在的 YYYY-MM-DD（对齐 wk-activate.py is_valid_date） */
export const isValidPlannedOnlineDate = (raw: string): boolean => {
  const text = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return false;
  const yyyy = String(parsed.getFullYear()).padStart(4, "0");
  const mm = String(parsed.getMonth() + 1).padStart(2, "0");
  const dd = String(parsed.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}` === text;
};

/** 至少含一个字母或数字，Hub 会再归一成大写 */
export const isValidSemanticCode = (raw: string): boolean =>
  /[A-Za-z0-9]/.test(raw.trim());

/** Hub `listActivationOwnerOptions`：label=显示名、value=username */
export type HubOwnerOption = { label: string; value: string };

export const parseActivationOwners = (raw: unknown): HubOwnerOption[] => {
  if (!Array.isArray(raw)) return [];
  const out: HubOwnerOption[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const value = typeof rec.value === "string" ? rec.value.trim() : "";
    const label = typeof rec.label === "string" ? rec.label.trim() : "";
    if (!value) continue;
    out.push({ label: label || value, value });
  }
  return out;
};

/** 飞书姓名对上 Hub 显示名或账号时预填 username；对不上再试唯一子串（陈禄江 ↔ 禄江） */
export const matchHubOwnerValue = (
  owners: HubOwnerOption[],
  feishuName: string | null | undefined,
): string => {
  const name = feishuName?.trim() ?? "";
  if (!name) return "";
  const exact = owners.find((o) => o.label === name || o.value === name);
  if (exact) return exact.value;
  const fuzzy = owners.filter(
    (o) => o.label.length > 0 && (name.includes(o.label) || o.label.includes(name)),
  );
  return fuzzy.length === 1 ? fuzzy[0]!.value : "";
};

export interface WkActivateInput {
  projectUrl: string;
  projectName: string;
  semanticCode: string;
  businessLine: string;
  plannedOnlineDate: string;
  /** Hub SystemUser.username，不是飞书显示名 */
  techOwner: string;
  /** 选中项的显示名，给 Hub 存档用 */
  techOwnerName?: string;
}

/** 启动表单点提交后，按字段回填到 Field.error */
export type WkActivateFieldErrors = {
  semanticCode?: string;
  businessLine?: string;
  plannedOnlineDate?: string;
  techOwner?: string;
};

export const wkActivateFieldErrors = (
  input: Partial<WkActivateInput>,
): WkActivateFieldErrors => {
  const errors: WkActivateFieldErrors = {};
  if (!isValidSemanticCode(input.semanticCode ?? "")) {
    errors.semanticCode = "请填写";
  }
  if (!isDemandPartyCode(input.businessLine ?? "")) {
    errors.businessLine = "请选择";
  }
  if (!(input.techOwner ?? "").trim()) {
    errors.techOwner = "请选择";
  }
  if (!isValidPlannedOnlineDate(input.plannedOnlineDate ?? "")) {
    errors.plannedOnlineDate = "请选择";
  }
  return errors;
};

export const validateWkActivateInput = (
  input: WkActivateInput,
): string | null => {
  if (!input.projectUrl.trim()) return "缺少飞书工作项链接";
  if (!input.projectName.trim()) return "缺少项目名称";
  if (!isValidSemanticCode(input.semanticCode)) {
    return "请填写人工语义编码";
  }
  if (!isDemandPartyCode(input.businessLine)) {
    return "请选择需求方";
  }
  if (!input.techOwner.trim()) return "请选择技术 Owner";
  if (!isValidPlannedOnlineDate(input.plannedOnlineDate)) {
    return "计划上线日必须是真实日期";
  }
  return null;
};

export interface WkActivateContext {
  /** 本机配了 Hub 地址 + Token，才露出激活勾选 */
  hubReady: boolean;
  /** 当前用户飞书姓名，用来对 Hub Owner 候选做预填 */
  ownerName: string | null;
  /** Hub 启用中的技术 Owner；空则不能勾激活 */
  owners: HubOwnerOption[];
}

export interface WkActivateResult {
  reqId: string;
  alreadyActivated: boolean;
}

const parseActivateJson = async <T>(res: Response): Promise<T> => {
  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const rec = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
    const msg =
      (typeof rec.error === "string" && rec.error) ||
      (typeof rec.message === "string" && rec.message) ||
      `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data as T;
};

export const fetchWkActivateContext = async (): Promise<WkActivateContext> => {
  const res = await fetch("/api/system/wk-activate", { cache: "no-store" });
  const ctx = await parseActivateJson<WkActivateContext>(res);
  return {
    hubReady: Boolean(ctx.hubReady),
    ownerName: ctx.ownerName ?? null,
    owners: Array.isArray(ctx.owners) ? ctx.owners : [],
  };
};

export const activateWkRequirement = async (
  input: WkActivateInput,
): Promise<WkActivateResult> => {
  const res = await fetch("/api/system/wk-activate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return parseActivateJson<WkActivateResult>(res);
};
