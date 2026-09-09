/**
 * 群出问登记（bot 回执关联消费用）。
 *
 * 背景：任务在需求群里 @ 某个 bot 要数据（如 @桃子哥 要 COMPLETED 学号），对方回来
 * 的结论要能以“答案数据”身份回到任务。约束（用户拍板）：一视同仁单通道、无受信
 * 名单、无全量补拉、判定全硬规则（发件人 / 窗口期 / 必含要素），fail-closed。
 *
 * 登记来源：agent 在群里问完后调 `expect_group_reply` 显式登记（message_id 取发问
 * send 的回执、target 取 @ 的目标、keywords 必填）。没有登记 = 不消费，只走现有
 * 非属主只读链路。
 *
 * 进程级内存表（重启即忘，TTL 本来就短）；去重 + 一问一答即焚由调用方
 * （group-route）执行，这里只做存取与匹配。
 */

export interface OutboundQuestionEntry {
  taskId: string;
  chatId: string;
  /** 出问消息 id（群历史里的 om_xxx） */
  messageId: string;
  /**
   * 被问目标的稳定身份：只收飞书服务端命名空间的 ID（`ou_xxx` / `cli_xxx`，@ 标签里的
   * user_id 原样抄）。显示名不许进登记——群昵称是用户随手可改的自由文本（P1），
   * 进来就是可伪造的匹配格，登记时直接拒单。
   */
  target: string;
  /** 必含要素（1-5 个，如「学号」；回复正文必须全部包含才消费，不分大小写） */
  keywords: string[];
  /** 登记时间（Date.now()） */
  createdAt: number;
  /** 有效期 ms（默认 30 分钟） */
  ttlMs: number;
}

const REGISTRY_KEY = "__flowshipGroupOutboundRegistryV1__";
export const OUTBOUND_QUESTION_TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES_PER_TASK = 20;

const getRegistry = (): Map<string, OutboundQuestionEntry[]> => {
  const g = globalThis as unknown as Record<
    string,
    Map<string, OutboundQuestionEntry[]> | undefined
  >;
  if (!g[REGISTRY_KEY]) g[REGISTRY_KEY] = new Map();
  return g[REGISTRY_KEY]!;
};

/** 单测：看某 task 还有几条登记（含过期，用于断言读时清理） */
export const __countOutboundForTest = (taskId: string): number =>
  getRegistry().get(taskId)?.length ?? 0;

/** 单测隔离 */
export const __resetOutboundRegistryForTest = (): void => { const g = globalThis as unknown as Record<
    string,
    Map<string, OutboundQuestionEntry[]> | undefined
  >;
  g[REGISTRY_KEY] = new Map();
};

const norm = (s: string): string => s.trim().toLowerCase();

/**
 * target 准入形态（P1）：只收飞书服务端下发的稳定 ID。
 * - `ou_xxx`：用户 / 机器人 open_id（sender_id / sender_bot_open_id 命名空间）
 * - `cli_xxx`：应用 app_id（sender_app_id 命名空间）
 * 显示名一律拒收——群昵称可随手改，精确相等在改名后恰恰帮攻击者，窗口+要素+即焚
 * 没有一条针对“名字可改”，缓释不成立。不知道 id 就去成员列表查，查不到问用户要。
 */
export const OUTBOUND_TARGET_RE = /^(ou|cli)_[A-Za-z0-9]+$/;

/**
 * 是否有在途登记（发件人对 + 窗口内，不看要素）。
 * 用途：图片卡片结论抽不出文本时，文案分叉——有在途登记回“收到图片结论、请补发文字版”，
 * 没登记才回“暂不支持”。文本门 fail-closed 不动，只是让对方知道收到了。
 */
export const hasPendingOutbound = (args: {
  taskId: string;
  chatId: string;
  senderIds: Array<string | undefined>;
  now?: number;
}): boolean => {
  const now = args.now ?? Date.now();
  const live = pruneExpired(args.taskId, now, getRegistry().get(args.taskId) ?? []);
  const want = new Set(
    (args.senderIds ?? []).map((s) => norm(s ?? "")).filter(Boolean),
  );
  if (want.size === 0) return false;
  return live.some(
    (e) =>
      (!e.chatId || e.chatId === args.chatId) && want.has(norm(e.target)),
  );
};

/** 清掉 task 下的过期条目（读时顺手清，长跑进程不堆积） */
const pruneExpired = (
  taskId: string,
  now: number,
  list: OutboundQuestionEntry[],
): OutboundQuestionEntry[] => {
  const live = list.filter((e) => now - e.createdAt < e.ttlMs);
  if (live.length !== list.length) {
    getRegistry().set(taskId, live);
  }
  return live;
};

/** 登记一条出问（要素必填；同 messageId 幂等覆盖） */
export const registerOutboundQuestion = (entry: {
  taskId: string;
  chatId: string;
  messageId: string;
  target: string;
  keywords: string[];
  ttlMs?: number;
}): { ok: true } | { ok: false; error: string } => {
  const taskId = entry.taskId.trim();
  const messageId = entry.messageId.trim();
  const target = entry.target.trim();
  const keywords = (entry.keywords ?? [])
    .map((k) => k.trim())
    .filter(Boolean);
  if (!taskId || !messageId || !target) {
    return { ok: false, error: "taskId / messageId / target 均必填" };
  }
  // P1 fail-closed：target 非 ID 形态直接拒单（名字可改名冒充，拦在登记处）。
  if (!OUTBOUND_TARGET_RE.test(target)) {
    return {
      ok: false,
      error:
        "target 必须是对方的飞书 ID（ou_xxx / cli_xxx，原样抄 @ 标签里的 user_id；填显示名不建登记——群昵称可改名冒充）。不知道 id 就去成员列表查，查不到问用户要",
    };
  }
  // 要素必填：没有就不建登记（fail-closed，默认抽关键词已被评审否掉）
  if (keywords.length === 0) {
    return { ok: false, error: "keywords 必填（1-5 个），没有就不建登记" };
  }
  // 超 5 个直接报错：静默截断会让 agent 以为全登上了，缺的那个要素永远不中、查无对证
  if (keywords.length > 5) {
    return {
      ok: false,
      error: `keywords 最多 5 个，本次 ${keywords.length} 个，请精简后重登`,
    };
  }
  const reg = getRegistry();
  const list = reg.get(taskId) ?? [];
  const now = Date.now();
  const live = list.filter((e) => now - e.createdAt < e.ttlMs);
  const next: OutboundQuestionEntry = {
    taskId,
    chatId: entry.chatId.trim(),
    messageId,
    target,
    keywords,
    createdAt: now,
    ttlMs:
      typeof entry.ttlMs === "number" && entry.ttlMs > 0
        ? entry.ttlMs
        : OUTBOUND_QUESTION_TTL_MS,
  };
  const deduped = live.filter((e) => e.messageId !== messageId);
  deduped.push(next);
  // 同目标同窗口只留最新（多问同目标的歧义按此收敛）
  deduped.sort((a, b) => a.createdAt - b.createdAt);
  reg.set(taskId, deduped.slice(-MAX_ENTRIES_PER_TASK));
  return { ok: true };
};

export interface CorrelatedMatch {
  entry: OutboundQuestionEntry;
}

/**
 * 三硬门匹配（全代码判定，无模型参与）：
 * ① 发件人 == 被问目标——只比三格服务端下发的稳定 ID
 *   （sender_id / bot open_id / app_id，任一命中）。发送人昵称不参与比对（P1：
 *    昵称是用户可改的自由文本，改名即能精确命中；连把昵改成 `ou_xxx` 形态都防——
 *    调用方根本不传昵称这一格）；
 * ② 窗口期内；
 * ③ 正文含全部必含要素（大小写不敏感）。
 * text 调用方负责拼好（正文 + 取回的被指消息正文）；匹配成功由调用方即焚。
 */
export const matchCorrelatedAnswer = (args: {
  taskId: string;
  chatId: string;
  senderIds: Array<string | undefined>;
  text: string;
  now?: number;
}): CorrelatedMatch | null => {
  const now = args.now ?? Date.now();
  // 读时顺手清过期（只在写时清，长跑进程会只增不减）
  const list = pruneExpired(args.taskId, now, getRegistry().get(args.taskId) ?? []);
  const want = new Set(
    (args.senderIds ?? []).map((s) => norm(s ?? "")).filter(Boolean),
  );
  if (want.size === 0) return null;
  const body = (args.text ?? "").toLowerCase();
  // 同目标多问：按时间就近（取最后一个命中的）
  let hit: OutboundQuestionEntry | null = null;
  for (const e of list) {
    if (e.chatId && e.chatId !== args.chatId) continue;
    if (now - e.createdAt >= e.ttlMs) continue;
    if (!want.has(norm(e.target))) continue;
    const ok = e.keywords.every((k) => body.includes(k.toLowerCase()));
    if (!ok) continue;
    hit = e;
  }
  return hit ? { entry: hit } : null;
};

/** 消费即焚（命中后调用；幂等） */
export const burnCorrelatedEntry = (taskId: string, messageId: string): void => {
  const reg = getRegistry();
  const list = reg.get(taskId);
  if (!list) return;
  reg.set(taskId, list.filter((e) => e.messageId !== messageId));
};
