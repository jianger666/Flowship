/**
 * 收件箱纯函数（前后端 / 单测共用）
 *
 * 一期：MR 链接提取 / URL 去重 / 已读清理 / 节点过滤 / GitLab 解析
 * 二期：bug MQL 解析 / 状态白名单 / bug URL / 角色分组显隐 / 改bug 指令预填
 */

/** 测试节点名（宽松包含匹配；多命中时取最短名，优先精确「测试」） */
export const NODE_NAME_TEST = "测试";

/** 已读标记最长保留天数（唯一清理规则） */
export const MR_INBOX_SEEN_MAX_AGE_DAYS = 90;
export const MR_INBOX_SEEN_MAX_AGE_MS =
  MR_INBOX_SEEN_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

/** 扫描结果内存缓存 TTL（2026-07-15 用户拍板 10 分钟 → 5 分钟：默认空间收敛后单轮扫描只 ~2s、扫得起） */
export const MR_INBOX_CACHE_TTL_MS = 5 * 60 * 1000;

/** 前端前台轮询间隔（与缓存 TTL 对齐） */
export const MR_INBOX_POLL_INTERVAL_MS = 5 * 60 * 1000;

/** 工作项节点（过滤用最小字段） */
export interface MrInboxNode {
  name: string;
  /** finished / done / doing / not_started … */
  status?: string;
}

/** 从评论文本抠出的 MR 候选（去重前） */
export interface MrUrlCandidate {
  mrUrl: string;
  /** 评论时间 ms（解析失败时 0） */
  atMs: number;
  /** 原始评论文本（截断前） */
  commentContent: string;
  commentId?: string;
}

/**
 * 节点是否已完成。
 * 实测 meegle `basic.status` 完成态是 `finished`；旧文档也写过 `done`——两边都认。
 */
export const isNodeStatusDone = (status: string | undefined): boolean => {
  const s = (status ?? "").trim().toLowerCase();
  return (
    s === "done" ||
    s === "finished" ||
    s === "complete" ||
    s === "completed"
  );
};

/**
 * 按节点名常量找节点：精确匹配优先；否则包含匹配，多命中取最短名
 *（避免「测试」误命中「测试案例评审」「提测及冒烟测试」等更长名——最短通常是目标节点本身）。
 */
export const findNodeByNamePattern = <T extends MrInboxNode>(
  nodes: T[],
  pattern: string,
): T | undefined => {
  const needle = pattern.trim();
  if (!needle) return undefined;
  const exact = nodes.find((n) => n.name.trim() === needle);
  if (exact) return exact;
  const hits = nodes.filter((n) => n.name.includes(needle));
  if (hits.length === 0) return undefined;
  return [...hits].sort((a, b) => a.name.length - b.name.length)[0];
};

/**
 * 提测收件箱准入：节点「测试」未完成这一条（2026-07-14 用户拍板单条件、
 * 不再要求「提测及冒烟测试」已完成的前置）。缺「测试」节点 → 不进收件箱。
 */
export const isWorkitemReadyForQaInbox = (nodes: MrInboxNode[]): boolean => {
  const test = findNodeByNamePattern(nodes, NODE_NAME_TEST);
  if (!test) return false;
  return !isNodeStatusDone(test.status);
};

/**
 * GitLab MR 详情摘要（待测 MR 组 / 待回归 bug 关联 MR 共用、单一来源）。
 * 字段对齐 gitlab-client getMR 的展示子集。
 */
export interface MrInboxMrDetail {
  title: string;
  sourceBranch: string;
  targetBranch: string;
  state: string;
  detailedMergeStatus: string;
  hasConflicts: boolean;
  mergeable: boolean;
}

/**
 * 剥掉 bug 条目上的 MR 关联字段（mrUrl / mr / mrError）——合并不等于回归通过、
 * bug 行本身保留。server 缓存（BugInboxItem）与客户端 state（BugInboxEntry）
 * 共用单一源，别在两边各手写一份字段重建。
 */
export const stripBugMrFields = <
  T extends { mrUrl?: string; mr?: MrInboxMrDetail | null; mrError?: string },
>(
  it: T,
): T => {
  const rest = { ...it };
  delete rest.mrUrl;
  delete rest.mr;
  delete rest.mrError;
  return rest;
};

/**
 * 从工作项评论列表挑「关联 MR」：最新评论里最新出现的那一个。
 * - 评论按 createdAtMs 倒序扫，命中第一条含 MR 的评论即停
 * - 同评论内多条 MR 取 extract 结果末位（= 文本中最后出现、已对本段去重）
 * - 无 MR → undefined（调用方当「无关联」）
 */
export const pickLatestMrUrlFromComments = (
  comments: ReadonlyArray<{ content: string; createdAtMs: number }>,
): string | undefined => {
  const sorted = [...comments].sort((a, b) => b.createdAtMs - a.createdAtMs);
  for (const c of sorted) {
    const urls = extractMrUrlsFromText(c.content);
    if (urls.length === 0) continue;
    return urls[urls.length - 1];
  }
  return undefined;
};

/**
 * 从文本挖 GitLab MR 链接（宽松：任意 host，路径含 `/-/merge_requests/<iid>`）。
 * 同一串里可能重复出现（markdown 链 `[url](url)`）——返回前先对本段去重保序。
 */
export const extractMrUrlsFromText = (text: string): string[] => {
  if (!text) return [];
  // 允许 URL 后跟 ) ] " ' 等收尾符，捕获组不含它们
  const re =
    /https?:\/\/[^\s<>"'）】\]]+?\/-\/merge_requests\/\d+/gi;
  const found: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0].replace(/[.,;:!?]+$/, "");
    const parsed = parseGitlabMrUrl(raw);
    const key = parsed?.canonicalUrl ?? raw;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(parsed?.canonicalUrl ?? raw);
  }
  return found;
};

/**
 * GitLab API host 形态校验：拒空、路径片段、userinfo（含 `@`）等畸形，
 * 防止评论植入 `https://user:pass@evil/...` 把 PAT 打到攻击者端点。
 * （gitlab-client buildBaseUrl 侧也应有同等闸门；此处给解析 / allowlist 共用。）
 */
export const isSafeGitlabHost = (host: string): boolean => {
  const h = host.trim();
  if (!h) return false;
  // `/`：路径渗入 host；`@` / 含 userinfo 形态：凭证外泄面
  if (h.includes("/") || h.includes("\\") || h.includes("@")) return false;
  // 显式拒绝 userinfo 残留（user:pass@host 已被 @ 拦住；再拦以 ":" 开头等畸形）
  if (h.startsWith(":") || h.endsWith(":")) return false;
  return true;
};

/**
 * 是否允许对某 host 带 gitToken 出站（安全形态 + 在已配置仓库 remote 推导的 allowlist 内）。
 */
export const shouldAttachGitlabToken = (
  host: string,
  allowedHosts: ReadonlySet<string>,
): boolean => {
  if (!isSafeGitlabHost(host)) return false;
  return allowedHosts.has(host.trim().toLowerCase());
};

/**
 * 解析 GitLab MR web URL → host / projectPath / iid。
 * 例：`https://gitlab.example.com/group/repo/-/merge_requests/12`
 */
export const parseGitlabMrUrl = (
  url: string,
): {
  host: string;
  projectPath: string;
  iid: number;
  canonicalUrl: string;
} | null => {
  const trimmed = url.trim();
  const m = trimmed.match(
    /^(https?):\/\/([^/?#]+)\/(.+?)\/-\/merge_requests\/(\d+)\/?(?:[?#].*)?$/i,
  );
  if (!m) return null;
  const protocol = m[1]!.toLowerCase();
  const host = m[2]!;
  if (!isSafeGitlabHost(host)) return null;
  const projectPath = m[3]!.replace(/\/+$/, "");
  const iid = Number(m[4]);
  if (!projectPath || !Number.isFinite(iid) || iid <= 0) return null;
  return {
    host,
    projectPath,
    iid,
    canonicalUrl: `${protocol}://${host}/${projectPath}/-/merge_requests/${iid}`,
  };
};

/**
 * 已读 key 归一：MR URL → canonical；bug / 其它 URL 原样（parse 认不出就回落 raw）。
 * 单条 / 批量 /seen 共用，避免两套 key 漂移。
 */
export const normalizeInboxSeenUrl = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  return parseGitlabMrUrl(trimmed)?.canonicalUrl ?? trimmed;
};

/**
 * 按 MR URL 去重：同一 URL 多条评论保留最新 atMs 那条。
 * 泛型：扫描器传带工作项信息的扩展类型、去重后原样保留附加字段。
 */
export const dedupeMrCandidatesByUrl = <T extends MrUrlCandidate>(
  candidates: T[],
): T[] => {
  const map = new Map<string, T>();
  for (const c of candidates) {
    const parsed = parseGitlabMrUrl(c.mrUrl);
    const key = parsed?.canonicalUrl ?? c.mrUrl;
    const normalized: T = { ...c, mrUrl: key };
    const prev = map.get(key);
    if (!prev || normalized.atMs >= prev.atMs) {
      map.set(key, normalized);
    }
  }
  return [...map.values()].sort((a, b) => b.atMs - a.atMs);
};

/**
 * 清理已读标记：丢掉超过 maxAgeMs 的条目（默认 90 天）。
 * 返回新对象；若无变化返回原引用（调用方可 `===` 判断要不要写盘）。
 */
export const pruneSeenMap = (
  seen: Record<string, number>,
  nowMs: number = Date.now(),
  maxAgeMs: number = MR_INBOX_SEEN_MAX_AGE_MS,
): Record<string, number> => {
  let changed = false;
  const out: Record<string, number> = {};
  for (const [url, at] of Object.entries(seen)) {
    // 未来时间戳（时钟回拨 / 脏数据）用 `now - at > maxAge` 恒 false、会永不清——一并丢弃
    if (typeof at !== "number" || !Number.isFinite(at) || at > nowMs) {
      changed = true;
      continue;
    }
    if (nowMs - at > maxAgeMs) {
      changed = true;
      continue;
    }
    out[url] = at;
  }
  return changed ? out : seen;
};

/** 评论文本截成面板摘要（去 HTML 注释 / 压空白） */
export const truncateCommentSnippet = (
  content: string,
  maxLen = 120,
): string => {
  const cleaned = content
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, maxLen - 1)}…`;
};

/** 未读 badge 文案：超 99 显示 99+ */
export const formatUnreadBadge = (n: number): string => {
  if (n <= 0) return "";
  if (n > 99) return "99+";
  return String(n);
};

// ----------------- 二期：bug 双角色 -----------------

/**
 * bug 状态流枚举（key → label）。
 * MQL 按 **label** 匹配；流转 API 用 **key**。
 */
export const BUG_STATUS = {
  OPEN: { key: "Not started", label: "OPEN" },
  IN_PROGRESS: { key: "In Progress", label: "IN PROGRESS" },
  RESOLVED: { key: "fYFKOOeAM", label: "RESOLVED" },
  REOPENED: { key: "FNB4WAesv", label: "REOPENED" },
  CLOSED: { key: "BBteJzss3", label: "CLOSED" },
  DEFERRED: { key: "pgn2ztyb6", label: "暂不处理" },
  NOT_BUG: { key: "qtbvj_1rm", label: "非问题关闭" },
  ENDED: { key: "systemEnded", label: "已终止" },
} as const;

/** 开发「待修」白名单（RESOLVED 不算待修） */
export const BUG_PENDING_FIX_LABELS: readonly string[] = [
  BUG_STATUS.OPEN.label,
  BUG_STATUS.IN_PROGRESS.label,
  BUG_STATUS.REOPENED.label,
];

/** 测试「待回归」白名单 */
export const BUG_PENDING_REGRESSION_LABELS: readonly string[] = [
  BUG_STATUS.RESOLVED.label,
];

/** 收件箱分组 id */
export type InboxGroupId = "pendingMr" | "myBugs" | "pendingRegression";

/**
 * 按设置页 userRole 决定收件箱分组显隐。
 * - fe / be → 仅「我的 BUG」
 * - qa → 「待测 MR」+「待回归」
 * - 未设置 / other → 全显示
 */
export const inboxGroupsVisibleForRole = (
  role: string | undefined | null,
): ReadonlySet<InboxGroupId> => {
  if (role === "fe" || role === "be") {
    return new Set<InboxGroupId>(["myBugs"]);
  }
  if (role === "qa") {
    return new Set<InboxGroupId>(["pendingMr", "pendingRegression"]);
  }
  return new Set<InboxGroupId>(["pendingMr", "myBugs", "pendingRegression"]);
};

/** 归一化状态文案：trim + 大写（label 比对用） */
export const normalizeBugStatusLabel = (raw: string | undefined): string =>
  (raw ?? "").trim().toUpperCase();

/** 是否属于开发待修状态（按 label 白名单） */
export const isBugPendingFixStatus = (statusLabel: string | undefined): boolean => {
  const n = normalizeBugStatusLabel(statusLabel);
  return BUG_PENDING_FIX_LABELS.some((l) => l.toUpperCase() === n);
};

/** 是否属于测试待回归状态 */
export const isBugPendingRegressionStatus = (
  statusLabel: string | undefined,
): boolean => {
  const n = normalizeBugStatusLabel(statusLabel);
  return BUG_PENDING_REGRESSION_LABELS.some((l) => l.toUpperCase() === n);
};

/**
 * 拼 bug 详情页 URL。
 * 优先 host + simpleName（与一期 story URL 同款）；缺省回落 project.feishu.cn + projectKey。
 */
export const buildBugDetailUrl = (opts: {
  projectKey: string;
  workItemId: string;
  host?: string;
  simpleName?: string;
}): string => {
  const id = opts.workItemId.trim();
  const slug = (opts.simpleName || opts.projectKey).trim();
  const host = (opts.host || "project.feishu.cn").replace(/^https?:\/\//, "");
  return `https://${host}/${slug}/bug/detail/${id}`;
};

/**
 * 从飞书项目 bug 详情 URL 推导同空间的 story 详情 URL。
 * 复用 bug URL 的 origin + 空间路径前缀，把 `/<实体>/detail/<id>` 换成 `/story/detail/<storyId>`；
 * storyId 缺失/空白、或 URL 不含该 detail 段时返 null（结果不带 query）。
 */
export const buildStoryUrlFromBug = (
  bugUrl: string,
  storyId?: string,
): string | null => {
  const id = (storyId ?? "").trim();
  if (!id) return null;

  let url: URL;
  try {
    url = new URL(bugUrl);
  } catch {
    return null;
  }

  // 路径须含「实体/detail/id」段（典型 /bug/detail/<id>），否则无法定位同空间 story
  const match = url.pathname.match(/^(.+)\/[^/]+\/detail\/[^/]+\/?$/);
  if (!match) return null;

  url.pathname = `${match[1]}/story/detail/${id}`;
  url.search = "";
  url.hash = "";
  return url.toString();
};

/** MQL 单字段（moql_field_list 项） */
export interface MoqlField {
  key?: string;
  name?: string;
  value?: unknown;
  value_type?: string;
}

/** 从 MQL 行归一出的 bug 摘要 */
export interface ParsedBugRow {
  workItemId: string;
  name: string;
  statusLabel: string;
  statusKey?: string;
  priorityLabel?: string;
  relatedStoryId?: string;
  relatedStoryName?: string;
}

/** 从 key_label / 嵌套对象抠 label / key */
const pickKeyLabel = (
  v: unknown,
): { key?: string; label?: string } | null => {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const key =
    typeof o.key === "string"
      ? o.key
      : typeof o.value === "string"
        ? o.value
        : undefined;
  const label =
    typeof o.label === "string"
      ? o.label
      : typeof o.name === "string"
        ? o.name
        : typeof o.cn_name === "string"
          ? o.cn_name
          : undefined;
  if (!key && !label) return null;
  return { key, label };
};

/**
 * 读 moql_field_list 里某个字段的展示值。
 * 兼容 string_value / long_value / key_label_value / key_label_value_list。
 *
 * ⚠️ CLI 真实响应的 value 按 value_type 包了一层壳（2026-07-14 实测漏扫根因）：
 * `{ value: { string_value: "xxx" }, value_type: "string_value" }`、
 * `{ value: { key_label_value_list: [{key,label}] }, ... }`——
 * 旧代码假设 value 是裸值、String(对象) 出 "[object Object]"、状态解析空串被过滤全丢。
 * 这里先解壳再走原逻辑；裸值形状也继续兼容。
 */
export const readMoqlFieldValue = (
  fields: MoqlField[],
  ...namesOrKeys: string[]
): {
  text?: string;
  key?: string;
  label?: string;
  relatedId?: string;
  relatedName?: string;
} => {
  const needles = new Set(namesOrKeys.map((s) => s.trim().toLowerCase()));
  const hit = fields.find((f) => {
    const k = (f.key ?? "").trim().toLowerCase();
    const n = (f.name ?? "").trim().toLowerCase();
    return needles.has(k) || needles.has(n);
  });
  if (!hit) return {};
  const vt = (hit.value_type ?? "").toLowerCase();
  let v = hit.value;
  // 解 value_type 同名壳：value = { [value_type]: 内层值 }
  if (
    vt &&
    v &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    vt in (v as Record<string, unknown>)
  ) {
    v = (v as Record<string, unknown>)[vt];
  }

  if (vt === "long_value" || typeof v === "number") {
    return { text: String(v) };
  }
  if (vt === "string_value" || typeof v === "string") {
    return { text: typeof v === "string" ? v : String(v ?? "") };
  }
  if (vt === "key_label_value") {
    const kl = pickKeyLabel(v);
    return {
      text: kl?.label ?? kl?.key,
      key: kl?.key,
      label: kl?.label,
      // 关联工作项时常把 work_item_id 放在 key
      relatedId: kl?.key,
      relatedName: kl?.label,
    };
  }
  if (vt === "key_label_value_list" && Array.isArray(v) && v.length > 0) {
    const kl = pickKeyLabel(v[0]);
    return {
      text: kl?.label ?? kl?.key,
      key: kl?.key,
      label: kl?.label,
      relatedId: kl?.key,
      relatedName: kl?.label,
    };
  }
  // 无 value_type：尽力猜
  if (typeof v === "string" || typeof v === "number") {
    return { text: String(v) };
  }
  const kl = pickKeyLabel(v);
  if (kl) {
    return {
      text: kl.label ?? kl.key,
      key: kl.key,
      label: kl.label,
      relatedId: kl.key,
      relatedName: kl.label,
    };
  }
  return {};
};

/**
 * moql_field_list → 归一 bug 行。缺 id / 名称 → null。
 * 字段名按中文展示名 + 常见英文字段 key 双匹配。
 */
export const parseMoqlBugRow = (fields: MoqlField[]): ParsedBugRow | null => {
  const idField = readMoqlFieldValue(fields, "工作项id", "工作项ID", "work_item_id", "id");
  const nameField = readMoqlFieldValue(fields, "名称", "name");
  const statusField = readMoqlFieldValue(fields, "状态", "work_item_status", "status");
  const priorityField = readMoqlFieldValue(fields, "优先级", "priority");
  const relatedField = readMoqlFieldValue(
    fields,
    "关联产品需求",
    "field_cf759f",
  );

  const workItemId = (idField.text ?? "").trim();
  const name = (nameField.text ?? "").trim();
  if (!workItemId || !name) return null;

  const statusLabel = (statusField.label ?? statusField.text ?? "").trim();
  return {
    workItemId,
    name,
    statusLabel,
    statusKey: statusField.key,
    priorityLabel: (priorityField.label ?? priorityField.text)?.trim() || undefined,
    relatedStoryId: relatedField.relatedId?.trim() || undefined,
    relatedStoryName: relatedField.relatedName?.trim() || undefined,
  };
};

/**
 * 解析 workitem query 响应：`data.<groupId>[]` 每项带 `moql_field_list`。
 * 返回归一后的 bug 行（不去重；调用方可再滤状态）。
 */
export const parseMoqlBugQueryResponse = (resp: unknown): ParsedBugRow[] => {
  if (!resp || typeof resp !== "object") return [];
  const root = resp as Record<string, unknown>;
  const data = root.data && typeof root.data === "object" ? root.data : root;
  if (!data || typeof data !== "object") return [];

  const out: ParsedBugRow[] = [];
  for (const groupVal of Object.values(data as Record<string, unknown>)) {
    if (!Array.isArray(groupVal)) continue;
    for (const row of groupVal) {
      if (!row || typeof row !== "object") continue;
      const m = row as Record<string, unknown>;
      const list = m.moql_field_list ?? m.moqlFieldList ?? m.fields;
      if (!Array.isArray(list)) continue;
      const parsed = parseMoqlBugRow(list as MoqlField[]);
      if (parsed) out.push(parsed);
    }
  }
  return out;
};

/**
 * 拼「改bug」推进指令预填文本（标题 / 链接 / 关联需求；描述留给 agent 按链接自取）。
 * 只带 bug 事实信息——行为约束（复现/修复/自检/HITL 流转）在 fix-bug skill 里，不在这重复。
 */
export const buildFixBugInstruction = (opts: {
  bugTitle: string;
  bugUrl: string;
  storyName?: string;
}): string => {
  const lines = [
    `改bug：${opts.bugTitle.trim() || "（无标题）"}`,
    `链接：${opts.bugUrl.trim()}`,
  ];
  if (opts.storyName?.trim()) {
    lines.push(`关联需求：${opts.storyName.trim()}`);
  }
  return lines.join("\n");
};

/** 出厂预置「改bug」派生 action id（skill 托管后 = app:fix-bug） */
export const BUILTIN_FIX_BUG_ACTION_ID = "app:fix-bug";
export const BUILTIN_FIX_BUG_SKILL = "fix-bug";
/** skill 预置记账 key（与 action 记账互相独立） */
export const BUILTIN_FIX_BUG_SKILL_PRESET_ID = "builtin-fix-bug-skill";
/**
 * action 预置记账 key（历史写过 `builtin-fix-bug`；id 已改为 app:fix-bug，
 * 记账仍用旧 key 防重复安装）。
 */
export const BUILTIN_FIX_BUG_ACTION_PRESET_ID = "builtin-fix-bug";
// ----------------- 三期：注意力（角标同源未读 + 增量通知文案） -----------------

/** 未读条目最小字段（diff / 通知文案用） */
export interface InboxAttentionItem {
  /** mrUrl 或 bugUrl */
  key: string;
  /** 通知展示标题（MR 标题 / bug 名） */
  title: string;
}

/** 从三分组抽出未见条目（seenAtMs === null） */
export const listUnreadInboxItems = (groups: {
  pendingMr: Array<{
    mrUrl: string;
    workItemName: string;
    mr: { title: string } | null;
    seenAtMs: number | null;
  }>;
  myBugs: Array<{ bugUrl: string; name: string; seenAtMs: number | null }>;
  pendingRegression: Array<{
    bugUrl: string;
    name: string;
    seenAtMs: number | null;
  }>;
}): InboxAttentionItem[] => {
  const out: InboxAttentionItem[] = [];
  for (const it of groups.pendingMr) {
    if (it.seenAtMs !== null) continue;
    const mrTitle = it.mr?.title?.trim();
    out.push({
      key: it.mrUrl,
      title: mrTitle || it.workItemName.trim() || "待测 MR",
    });
  }
  for (const it of groups.myBugs) {
    if (it.seenAtMs !== null) continue;
    out.push({ key: it.bugUrl, title: it.name.trim() || "BUG" });
  }
  for (const it of groups.pendingRegression) {
    if (it.seenAtMs !== null) continue;
    out.push({ key: it.bugUrl, title: it.name.trim() || "待回归" });
  }
  return out;
};

/**
 * 本轮相对上轮的「新增未读」判定。
 * `prevKeys === null` → 首轮（或降级后重建基线）：只建基线、不通知（存量不是新增）。
 * 已在上轮未读集合里的 key 不重复推。
 */
export const diffInboxUnreadForNotify = (
  prevKeys: ReadonlySet<string> | null,
  current: readonly InboxAttentionItem[],
): { notify: boolean; newItems: InboxAttentionItem[] } => {
  if (prevKeys === null) {
    return { notify: false, newItems: [] };
  }
  const newItems = current.filter((it) => !prevKeys.has(it.key));
  return { notify: newItems.length > 0, newItems };
};

/**
 * 合并成一条系统通知文案（每轮最多一条）。
 * 单条：title = 具体标题；多条：body 合并「新增 N 条…xxx 等」。
 */
export const buildInboxNotifyCopy = (
  newItems: readonly InboxAttentionItem[],
): { title: string; body: string } | null => {
  if (newItems.length === 0) return null;
  if (newItems.length === 1) {
    return {
      title: newItems[0]!.title,
      body: "收件箱新增待处理",
    };
  }
  return {
    title: "收件箱",
    body: `收件箱新增 ${newItems.length} 条待处理：${newItems[0]!.title} 等`,
  };
};
