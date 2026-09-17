/**
 * 群出问登记（bot 回执关联消费用，内部简化版）。
 *
 * 背景：任务在需求群里 @ 谁要数据（如 @同事 要学号、@另一台机器人要结论），对方回来
 * 的结论要能以“答案数据”身份回到任务。内部使用、机制从简：只认两门——
 * ① 发件人 == 被问目标（服务端下发的稳定 ID）；② 窗口期内（默认 2 小时）。
 * 关键词不再硬拦（留着仅作备注/兼容）：内容够不够、是不是想要的答案由模型判断，
 * 不够最多补问一次（补问前需重新登记，登记已耗）；命中后静默吃进会话、群里不再回（吃掉就闭嘴，防环）。
 * 一次只等一件事：同任务同群同目标只留最新登记。
 *
 * 登记来源：agent 在群里问完后调 `expect_group_reply` 显式登记。没有登记 = 不消费，
 * 只走现有非属主只读链路。
 *
 * 进程级内存表（重启即忘）；去重 + 一问一答即焚由调用方
 * （group-route）执行，这里只做存取与匹配。
 */

export interface OutboundQuestionEntry {
  taskId: string;
  chatId: string;
  /** 出问消息 id（群历史里的 om_xxx） */
  messageId: string;
  /**
   * 被问目标的稳定身份：只收飞书服务端命名空间的 ID（`ou_xxx` / `cli_xxx`，@ 标签里的
   * user_id 原样抄）。显示名不许进登记——群昵称是用户随手可改的自由文本，
   * 进来就是可伪造的匹配格，登记时直接拒单。
   */
  target: string;
  /** 备注用关键词（可选，不做判定；内容是否够用由模型判断） */
  keywords: string[];
  /** 在等什么事（一句话备注，给模型看，不做判定） */
  about?: string;
  /** 登记时间（Date.now()） */
  createdAt: number;
  /** 有效期 ms（默认 2 小时） */
  ttlMs: number;
}

const REGISTRY_KEY = "__flowshipGroupOutboundRegistryV1__";
export const OUTBOUND_QUESTION_TTL_MS = 2 * 60 * 60 * 1000;
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
/** 单测：注册表里还剩几个 task 的键（断言空壳清理：删 task/烧空后应为 0） */
export const __getCorrelatedTaskCountForTest = (): number =>
  getRegistry().size;

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

/**
 * 清掉 task 下的过期条目（读时顺手清，长跑进程不堆积）。
 * 空了就整项删（review 十轮-1）：`set(taskId, [])` 留空壳，千级任务慢慢攒。
 */
const pruneExpired = (
  taskId: string,
  now: number,
  list: OutboundQuestionEntry[],
): OutboundQuestionEntry[] => {
  const live = list.filter((e) => now - e.createdAt < e.ttlMs);
  if (live.length === 0) {
    getRegistry().delete(taskId);
  } else if (live.length !== list.length) {
    getRegistry().set(taskId, live);
  }
  return live;
};
/**
 * 按 task 整项清（删任务/终结/归档链调用：条目虽没秘密，空壳也别留）。
 * 和熔断表、排队同一套路（review 十轮-1）。
 */
export const clearCorrelatedEntries = (taskId: string): void => {
  if (taskId) getRegistry().delete(taskId);
};

/** 登记一条出问（同 messageId 幂等覆盖；同任务同群同目标只留最新，一次只等一件事） */
export const registerOutboundQuestion = (entry: {
  taskId: string;
  chatId: string;
  messageId: string;
  target: string;
  keywords?: string[];
  about?: string;
  ttlMs?: number;
}): { ok: true; replaced?: string } | { ok: false; error: string } => {
  const taskId = entry.taskId.trim();
  const messageId = entry.messageId.trim();
  const target = entry.target.trim();
  const keywords = (entry.keywords ?? [])
    .map((k) => k.trim().slice(0, 30))
    .filter(Boolean);
  // 单条 30 字封顶（和“关键词”体裁匹配）：超长只可能是误粘，脏数据别入库，拼接处不再二次截断。
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
  // 关键词仅备注：没有也能登记（内容够不够由模型判断，不硬拦）
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
    ...(typeof entry.about === "string" && entry.about.trim()
      ? { about: entry.about.trim().slice(0, 200) }
      : {}),
    createdAt: now,
    ttlMs:
      typeof entry.ttlMs === "number" && entry.ttlMs > 0
        ? entry.ttlMs
        : OUTBOUND_QUESTION_TTL_MS,
  };
  // 同 messageId 覆盖 + 同任务同群同目标只留最新（一次只等一件事，多问串行）。
  // 空串当通配（和 match/hasPending 一致：未绑定时占位的空 chatId 能命中任何群）——
  // 未绑定占位后绑定补登正式，同目标两条不再并存，正式烧掉后不留幽灵占位。
  // 跨群并行（两个具体串不同）不受影响。
  // 同目标覆盖是静默的：把被顶掉的旧 messageId 带回去，调用方写进 hint，丢也要丢得可见。
  // 通配谓词抽共用：查找与删除走同一口径，别再分叉。
  const sameTarget = (e: { target: string; chatId: string }): boolean =>
    norm(e.target) === norm(target) &&
    (!e.chatId || !next.chatId || (e.chatId || "") === next.chatId);
  const replaced = live.find(
    (e) => e.messageId !== messageId && sameTarget(e),
  )?.messageId;
  const deduped = live.filter(
    (e) => e.messageId !== messageId && !sameTarget(e),
  );
  deduped.push(next);
  // 同目标同窗口只留最新（多问同目标的歧义按此收敛）
  deduped.sort((a, b) => a.createdAt - b.createdAt);
  reg.set(taskId, deduped.slice(-MAX_ENTRIES_PER_TASK));
  return replaced ? { ok: true as const, replaced } : { ok: true as const };
};

export interface CorrelatedMatch {
  entry: OutboundQuestionEntry;
}

/**
 * 简化匹配（内部用）：只认两门，全代码判定，无模型参与——
 * ① 发件人 == 被问目标——只比三格服务端下发的稳定 ID
 *   （sender_id / bot open_id / app_id，任一命中）。发送人昵称不参与比对
 *    （昵称是用户可改的自由文本，改名即能精确命中；连把昵改成 `ou_xxx` 形态都防——
 *    调用方根本不传昵称这一格）；
 * ② 窗口期内（默认 2 小时）。
 * 关键词/备注不做判定：内容是不是想要的答案、够不够干活由模型判断，不够最多补问一次。
 * text 是历史参数：两门拆除后不再参与判定，保留只防 breaking（调用方传了也直接忽略）；
 * 清理时连调用方的拼串一起删。匹配成功由调用方即焚，吃掉后不再回群。
 */
export const matchCorrelatedAnswer = (args: {
  taskId: string;
  chatId: string;
  senderIds: Array<string | undefined>;
  text?: string;
  now?: number;
}): CorrelatedMatch | null => {
  const now = args.now ?? Date.now();
  // 读写都清过期：读时 pruneExpired 顺手清，写时落盘前过滤；空了整项删，不留空壳。
  const list = pruneExpired(args.taskId, now, getRegistry().get(args.taskId) ?? []);
  const want = new Set(
    (args.senderIds ?? []).map((s) => norm(s ?? "")).filter(Boolean),
  );
  if (want.size === 0) return null;
  // 同目标多问：正常只会剩最新一条（登记侧已收敛），兜底取最后一个命中的
  let hit: OutboundQuestionEntry | null = null;
  for (const e of list) {
    if (e.chatId && e.chatId !== args.chatId) continue;
    if (now - e.createdAt >= e.ttlMs) continue;
    if (!want.has(norm(e.target))) continue;
    hit = e;
  }
  return hit ? { entry: hit } : null;
};

/** 消费即焚（命中后调用；幂等）。烧空就整项删，不留空壳（review 十轮-1） */
export const burnCorrelatedEntry = (taskId: string, messageId: string): void => {
  const reg = getRegistry();
  const list = reg.get(taskId);
  if (!list) return;
  const live = list.filter((e) => e.messageId !== messageId);
  if (live.length === 0) reg.delete(taskId);
  else reg.set(taskId, live);
};
