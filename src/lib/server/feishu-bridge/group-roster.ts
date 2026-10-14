/**
 * 需求群「群里都有谁」+「群里最近聊了什么」的数据来源（只做拉取 + 缓存，不做 prompt 拼装）。
 *
 * # 为什么走用户身份
 * 机器人身份缺 `im:chat.members:read`（见 lark-api.ts probeSelfInChat 的注释，99991672），
 * 用户身份已授权，所以成员列表 / 历史消息都带 `--as user`。
 *
 * # 设计要点
 * - **永不抛错**：答疑 agent 的上下文是锦上添花，拉不到就降级（learned / none / []），
 *   绝不能因为这里炸了让一次答疑整个失败。
 * - 成员：5 分钟 TTL；同 chatId 并发共享 in-flight；失败 60 秒负缓存（否则权限掉了每次答疑都
 *   白等一轮 lark-cli 超时）。
 * - learned：入向消息里见过的发送人 / mention，随手记下。接口不可用时它就是 roster 的全部来源；
 *   接口可用时用来补「has_more 被截断」漏掉的人，以及同步查名字。
 * - 历史：15 秒短缓存（同 chatId + limit），防连着几个答疑 run 重复拉；失败不缓存（返回 [] 即可）。
 * - 所有 lark 调用都经 runLark → enqueueLark 的进程级单飞队列，这里不再额外排队。
 */

import { runLark } from "./lark-api";
import type {
  GroupHistoryMessage,
  GroupMember,
  GroupRoster,
} from "./group-contract";

const ROSTER_TTL_MS = 5 * 60_000;
const ROSTER_NEG_TTL_MS = 60_000;
const HISTORY_TTL_MS = 15_000;

type Rec = Record<string, unknown>;

const asRec = (v: unknown): Rec | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

// ----------------- 状态 -----------------

interface RosterEntry {
  roster: GroupRoster;
  /** 过期时刻（ms）；失败的负缓存条目用较短 TTL */
  expiresAt: number;
}

/** chatId → 最近一次成功的 api 成员（不随 TTL 清掉：lookup 同步查名字时过期数据也比没有强） */
const apiMembers = new Map<string, Map<string, GroupMember>>();
/** chatId → 入向见过的成员 */
const learned = new Map<string, Map<string, GroupMember>>();
/** chatId → 缓存的 roster（成功或负缓存） */
const rosterCache = new Map<string, RosterEntry>();
const rosterInflight = new Map<string, Promise<GroupRoster>>();

interface HistoryEntry {
  messages: GroupHistoryMessage[];
  expiresAt: number;
}
const historyCache = new Map<string, HistoryEntry>();
const historyInflight = new Map<string, Promise<GroupHistoryMessage[]>>();

export const __resetGroupRosterForTest = (): void => {
  apiMembers.clear();
  learned.clear();
  rosterCache.clear();
  rosterInflight.clear();
  historyCache.clear();
  historyInflight.clear();
};

// ----------------- 成员解析 -----------------

/** 取数组：容错字段缺失 / 类型不对 */
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const parseMemberList = (
  list: unknown[],
  kind: GroupMember["kind"],
): GroupMember[] => {
  const out: GroupMember[] = [];
  for (const raw of list) {
    const r = asRec(raw);
    if (!r) continue;
    // member_id 是 open_id；兼容字段改名（open_id / id）
    const openId = str(r.member_id) || str(r.open_id) || str(r.id);
    if (!openId) continue;
    out.push({ openId, name: str(r.name), kind });
  }
  return out;
};

/**
 * 解析 `+chat-members-list` 的 JSON 根。返回 members + 是否被截断（has_more 为真）。
 * 根可能是 `{ok:true,data:{…}}`（runLark 原样返回整包）也可能直接是 data。
 */
export const parseMembersResponse = (
  rec: Rec,
): { members: GroupMember[]; truncated: boolean } => {
  const data = asRec(rec.data) ?? rec;
  const merged = new Map<string, GroupMember>();
  for (const m of [
    ...parseMemberList(arr(data.users), "user"),
    ...parseMemberList(arr(data.bots), "bot"),
  ]) {
    const prev = merged.get(m.openId);
    // 同一 open_id 重复出现：保留有名字的那条
    if (!prev || (!prev.name && m.name)) merged.set(m.openId, m);
  }
  const truncated =
    data.has_more === true ||
    (Array.isArray(data.truncations) && data.truncations.length > 0);
  return { members: [...merged.values()], truncated };
};

const learnedList = (chatId: string): GroupMember[] => [
  ...(learned.get(chatId)?.values() ?? []),
];

const buildLearnedRoster = (chatId: string, now: number): GroupRoster => {
  const members = learnedList(chatId);
  return {
    chatId,
    members,
    fetchedAt: now,
    source: members.length > 0 ? "learned" : "none",
  };
};

const cloneRoster = (r: GroupRoster): GroupRoster => ({
  ...r,
  members: r.members.map((m) => ({ ...m })),
});

const doFetchRoster = async (chatId: string): Promise<GroupRoster> => {
  const now = Date.now();
  try {
    const rec = await runLark(
      [
        "im",
        "+chat-members-list",
        "--chat-id",
        chatId,
        "--as",
        "user",
        "--page-all",
        "--format",
        "json",
      ],
      { as: "user" },
    );
    const { members, truncated } = parseMembersResponse(rec);
    if (members.length === 0 && !truncated) {
      // 成功但一个人都没解析出来 = 字段形状变了或群空：按失败降级，别把空名单当权威
      throw new Error("成员列表为空");
    }
    const byId = new Map(members.map((m) => [m.openId, m]));
    apiMembers.set(chatId, byId);
    const out = [...members];
    if (truncated) {
      // 被截断：入向见过的人可能就在漏掉的那部分里，并进来
      for (const l of learnedList(chatId)) {
        if (!byId.has(l.openId)) out.push(l);
      }
    }
    const roster: GroupRoster = {
      chatId,
      members: out,
      fetchedAt: now,
      source: "api",
    };
    rosterCache.set(chatId, { roster, expiresAt: now + ROSTER_TTL_MS });
    return roster;
  } catch (err) {
    console.warn(
      `[feishu-bridge/group-roster] 拉取群成员失败（${chatId}），降级为 learned/none：${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    const roster = buildLearnedRoster(chatId, now);
    rosterCache.set(chatId, { roster, expiresAt: now + ROSTER_NEG_TTL_MS });
    return roster;
  }
};

/**
 * 取群成员名单。永不抛错：拉取失败 → source:"learned"（入向积累）或 "none"，并 60 秒负缓存。
 * `force` 跳过缓存（也不并入已有 in-flight）。
 */
export const fetchGroupRoster = async (
  chatId: string,
  opts: { force?: boolean } = {},
): Promise<GroupRoster> => {
  try {
    if (!opts.force) {
      const hit = rosterCache.get(chatId);
      if (hit && hit.expiresAt > Date.now()) {
        // 负缓存期间 learned 可能又涨了：重新拼，别返回过期的空壳
        if (hit.roster.source !== "api") {
          return buildLearnedRoster(chatId, hit.roster.fetchedAt);
        }
        return cloneRoster(hit.roster);
      }
      const inflight = rosterInflight.get(chatId);
      if (inflight) return cloneRoster(await inflight);
    }
    const p = doFetchRoster(chatId).finally(() => {
      if (rosterInflight.get(chatId) === p) rosterInflight.delete(chatId);
    });
    rosterInflight.set(chatId, p);
    return cloneRoster(await p);
  } catch {
    return { chatId, members: [], fetchedAt: Date.now(), source: "none" };
  }
};

/**
 * 入向消息里见过的发送人 / mention 随手记下。
 * - 不覆盖 api 来源已有的非空名字（api 是权威）；
 * - 名字为空的条目补名字；
 * - learned 内部：新的非空名字覆盖旧的（昵称会改，后见到的更新）。
 */
export const learnGroupMember = (chatId: string, m: GroupMember): void => {
  const openId = str(m?.openId);
  if (!chatId || !openId) return;
  const name = str(m.name);
  let map = learned.get(chatId);
  if (!map) {
    map = new Map();
    learned.set(chatId, map);
  }
  const prev = map.get(openId);
  if (!prev) {
    map.set(openId, { openId, name, kind: m.kind });
  } else {
    if (name) prev.name = name;
    // kind 以首次为准；仅当旧条目没名字（信息很少）时才更新，避免来回抖动
  }
  // 同步补进 api 缓存里「名字为空」的条目（api 非空名字不动）
  const api = apiMembers.get(chatId)?.get(openId);
  if (api && !api.name && name) api.name = name;
  // 已缓存的 api roster 里同一条也补上，保证 fetchGroupRoster 命中缓存时一致
  const cached = rosterCache.get(chatId)?.roster;
  if (cached?.source === "api" && name) {
    const hit = cached.members.find((x) => x.openId === openId);
    if (hit && !hit.name) hit.name = name;
  }
};

/** 同步查名字（api + learned 合并，api 非空名字优先）；查不到 / 名字为空返回 undefined */
export const lookupGroupMemberName = (
  chatId: string,
  openId: string,
): string | undefined => {
  const a = apiMembers.get(chatId)?.get(openId)?.name;
  if (a) return a;
  const l = learned.get(chatId)?.get(openId)?.name;
  return l || undefined;
};

// ----------------- 群历史消息 -----------------

const mapSenderKind = (senderType: string): GroupHistoryMessage["senderKind"] =>
  senderType === "app" ? "bot" : senderType === "user" ? "user" : "unknown";

export const parseHistoryResponse = (
  rec: Rec,
  chatId: string,
): GroupHistoryMessage[] => {
  const data = asRec(rec.data) ?? rec;
  const out: GroupHistoryMessage[] = [];
  for (const raw of arr(data.messages)) {
    const r = asRec(raw);
    if (!r || r.deleted === true) continue;
    const sender = asRec(r.sender) ?? {};
    const senderKind = mapSenderKind(str(sender.sender_type));
    // 机器人：id 是 app_id（cli_…），真正能 @ 的 open_id 在 open_bot_id
    const senderOpenId =
      senderKind === "bot"
        ? str(sender.open_bot_id) || str(sender.id)
        : str(sender.id);
    const mentions: GroupHistoryMessage["mentions"] = [];
    for (const mr of arr(r.mentions)) {
      const m = asRec(mr);
      if (!m) continue;
      const openId = str(m.id) || str(m.open_id);
      if (!openId) continue;
      // 机器人发的 post 里 @ 的 name 常是空串：拿 roster 缓存补，补不到留空
      mentions.push({
        openId,
        name: str(m.name) || lookupGroupMemberName(chatId, openId) || "",
      });
    }
    out.push({
      messageId: str(r.message_id),
      createTime: str(r.create_time),
      senderOpenId,
      senderName:
        str(sender.name) ||
        (senderOpenId ? lookupGroupMemberName(chatId, senderOpenId) : "") ||
        "",
      senderKind,
      msgType: str(r.msg_type),
      content: typeof r.content === "string" ? r.content : "",
      mentions,
    });
  }
  // CLI 按 --order desc（新→旧）返回；调用方要旧→新
  return out.reverse();
};

const doFetchHistory = async (
  chatId: string,
  limit: number,
): Promise<GroupHistoryMessage[]> => {
  try {
    const rec = await runLark(
      [
        "im",
        "+chat-messages-list",
        "--chat-id",
        chatId,
        "--as",
        "user",
        "--order",
        "desc",
        "--page-size",
        String(limit),
        "--no-reactions",
        "--format",
        "json",
      ],
      { as: "user" },
    );
    return parseHistoryResponse(rec, chatId);
  } catch (err) {
    console.warn(
      `[feishu-bridge/group-roster] 拉取群历史失败（${chatId}），返回空：${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }
};

const cloneHistory = (list: GroupHistoryMessage[]): GroupHistoryMessage[] =>
  list.map((m) => ({ ...m, mentions: m.mentions.map((x) => ({ ...x })) }));

/** 最近 limit 条群消息，旧→新。永不抛错（失败 []，不缓存）；15 秒短缓存 + 并发去重 */
export const fetchRecentGroupMessages = async (
  chatId: string,
  limit = 20,
): Promise<GroupHistoryMessage[]> => {
  try {
    const n = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 20;
    const key = `${chatId}\u0000${n}`;
    const hit = historyCache.get(key);
    if (hit && hit.expiresAt > Date.now()) return cloneHistory(hit.messages);
    const inflight = historyInflight.get(key);
    if (inflight) return cloneHistory(await inflight);
    const p = (async () => {
      const startedAt = Date.now();
      const messages = await doFetchHistory(chatId, n);
      // 失败（空）不缓存：下一个 run 可以立刻重试；真·空群缓存与否差别不大
      if (messages.length > 0) {
        historyCache.set(key, { messages, expiresAt: startedAt + HISTORY_TTL_MS });
      }
      return messages;
    })().finally(() => {
      if (historyInflight.get(key) === p) historyInflight.delete(key);
    });
    historyInflight.set(key, p);
    return cloneHistory(await p);
  } catch {
    return [];
  }
};
