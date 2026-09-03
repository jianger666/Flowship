/**
 * 提测完成后在需求群 @ 测试人员（工作项评论 @ 不推通知的补位）。
 *
 * 由 ship 的 `notify_group_testers` 工具在交卷前调用（与飞书项目评论同一拍）。
 * 只往**已绑定**的需求群发、不建群。
 * 发到需求群走 {@link shareToRequirementGroup}（卡片 `<at email>`）；
 * 换人（user_key → 邮箱）仍在本模块，没邮箱的不 @。
 * 对不上 / 没群 / bot 不在群一律静默：不抛、不写 error 事件、不弹引导。
 *
 * 依赖方向同 group-broadcast：本模块被 task-runner 静态引用，feishu-group /
 * meegle-cli / 注册表一律运行时动态 import。
 */

import { isLightweightDailyTask } from "@/lib/lightweight-task";
import type { ShareToGroupInput } from "@/lib/server/feishu-group";
import type { ActionRecord, Task } from "@/lib/types";

import { buildActionMrLinks, buildAllActionMrLinks } from "./group-broadcast";

const LOG = "[feishu-bridge/group-tester-notify]";

/** 整次通知超时：放弃即可，不影响 ship 已完成 */
export const TESTER_NOTIFY_TIMEOUT_MS = 30_000;

export type TesterNotifyOutcome =
  | "sent"
  | "skipped_not_ship"
  | "skipped_lightweight"
  | "skipped_no_testers"
  | "skipped_conflicts"
  | "skipped_no_mrs"
  | "skipped_no_group"
  | "skipped_no_open_ids"
  | "skipped_duplicate"
  | "skipped_bot_not_in_group"
  | "failed";

/** 提测 @ 目标：只走卡片 `<at email>`，有邮箱才发。openId / unionId 字段是历史预留，当前发送链路不用，只参与去重合并。 */
export interface TesterAtTarget {
  name: string;
  email?: string;
  openId?: string;
  unionId?: string;
}

export interface TesterRegistryMember {
  openId: string;
  name?: string;
}

export interface TesterRoleMember {
  userKey?: string;
  email?: string;
  name?: string;
  /** 工作项角色里一般没有，有就顺手用（user search 的 out_id 是主要来源） */
  unionId?: string;
}

/** 注册表按规范化邮箱索引（与 group-members.json 同口径） */
const asEmail = (raw: unknown): string => {
  if (typeof raw !== "string") return "";
  const v = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : "";
};

const uniqueKeys = (raw: string[] | undefined): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw ?? []) {
    const k = item.trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
};

/**
 * user_key → at 目标（只认邮箱）。
 * 角色邮箱优先、缺了用 user search 补；open_id / union_id 只做同一人合并去重用，不进发送。
 * user_key / lark_user_id 不许进 at（官方封死 cross tenant）。
 * 换不出邮箱的进 missedNames（展示名或 key），不挡能 @ 到的人。
 */
export const pickTesterAtTargets = (
  testerKeys: string[] | undefined,
  roleMembers: TesterRoleMember[],
  searchByKey: Record<string, { email: string; name?: string; unionId?: string }>,
  registry: Record<string, TesterRegistryMember>,
): { at: TesterAtTarget[]; missedNames: string[] } => {
  const byKey = new Map<string, TesterRoleMember>();
  for (const m of roleMembers) {
    const k = m.userKey?.trim();
    if (k) byKey.set(k, m);
  }
  const at: TesterAtTarget[] = [];
  const byIdentity = new Map<string, TesterAtTarget>();
  const missedNames: string[] = [];
  // 同一个人多 key 命中时合并：邮箱 / open_id / union_id 任一相同即同一人，
  // 先到的占位、后到的只补它缺的字段（open_id 去重、union 合并都在这里收敛）。
  // 注意：别名邮箱只 @ 首个——命中时不改已有邮箱（同 open_id 多邮箱只认第一个），
  // 这是故意的（少 @ 不错 @），不是 bug。
  const push = (target: TesterAtTarget): void => {
    const keys = [
      target.email?.trim().toLowerCase(),
      target.openId?.trim(),
      target.unionId?.trim(),
    ].filter((k): k is string => !!k);
    if (keys.length === 0) return;
    const hit = keys
      .map((k) => byIdentity.get(k))
      .find((t): t is TesterAtTarget => !!t);
    if (hit) {
      if (!hit.openId && target.openId) hit.openId = target.openId;
      if (!hit.unionId && target.unionId) hit.unionId = target.unionId;
      if ((!hit.name || hit.name === "测试") && target.name) hit.name = target.name;
      return;
    }
    const entry = { ...target, name: target.name.trim() || "测试" };
    for (const k of keys) byIdentity.set(k, entry);
    at.push(entry);
  };
  for (const key of uniqueKeys(testerKeys)) {
    const role = byKey.get(key);
    const searched = searchByKey[key];
    const email = asEmail(role?.email) || asEmail(searched?.email);
    const name =
      role?.name?.trim() ||
      searched?.name?.trim() ||
      (email ? registry[email]?.name?.trim() : "") ||
      "";
    const openId = email ? registry[email]?.openId?.trim() : "";
    // union 只留作同一人合并去重用，不进发送（只走卡片 `<at email>`）。
    const unionId = role?.unionId?.trim() || searched?.unionId?.trim() || "";
    // 只认邮箱：没邮箱的直接进 missed，别进 `at`——`at` 即“能发的”，发送侧不再二次过滤。
    if (!email) {
      missedNames.push(name || key);
      continue;
    }
    push({
      name,
      ...(email ? { email } : {}),
      ...(openId ? { openId } : {}),
      ...(unionId ? { unionId } : {}),
    });
  }
  return { at, missedNames };
};

/** 提测通知正文。`@ + 请验收`开头，MR 列表全列正文（方便复制粘贴），按钮再挂一遍（方便点开）。飞书会把 `<at email>` 渲染成 `@名字`，后面不要再拼名字，否则 `@肖康 肖康` 重复。 */
export const buildTesterNotifyContent = (
  mrs: Array<{ label: string; url: string }>,
  cardAts: Array<{ email: string; name: string }> = [],
): string => {
  const mrLines = mrs.map((m) => `- ${m.label} ${m.url}`).join("\n");
  const atLine = cardAts
    .map((a) => `<at email=${a.email}></at>`)
    .join(" ")
    .trim();
  const head = atLine ? `${atLine} 已提测，请验收：` : `已提测，请验收：`;
  return `${head}\n${mrLines}`.trim();
};

export const actionHasShipConflicts = (action: ActionRecord): boolean =>
  (action.sideEffects?.mrs ?? []).some((m) => m.hasConflicts === true);

// ----------------- 防重（同一 action 交卷只 @ 一次） -----------------

const DEDUP_KEY = "__flowshipGroupTesterNotifyDedupV1__";

type DedupState = { claimed: Set<string> };

const getDedup = (): DedupState => {
  const g = globalThis as unknown as Record<string, DedupState | undefined>;
  if (!g[DEDUP_KEY]) g[DEDUP_KEY] = { claimed: new Set() };
  return g[DEDUP_KEY]!;
};

const claimNotify = (taskId: string, actionId: string): boolean => {
  const key = `${taskId}:${actionId}`;
  const state = getDedup();
  if (state.claimed.has(key)) return false;
  state.claimed.add(key);
  return true;
};

/**
 * 发送明确失败时退坑，让人工可重调一次。
 * 与播报的区别：播报任何失败都退（重播一张产物卡可接受）；提测@成功占位不放
 *（防重复交卷刷出两张@卡），超时占位不放（在途请求可能仍会落卡，放了必双@），
 * 只在发送明确抛错时退——漏@（测试收不到通知）比极小概率双@恶劣得多。
 */
const releaseNotify = (taskId: string, actionId: string): void => {
  getDedup().claimed.delete(`${taskId}:${actionId}`);
};

export const __resetTesterNotifyDedupForTest = (): void => {
  getDedup().claimed.clear();
};

// ----------------- 可注入依赖 -----------------

export interface GroupTesterNotifyDeps {
  getBoundGroupChatId: (
    task: Pick<Task, "feishuStoryUrl">,
  ) => Promise<string | null>;
  decodeStory: (
    url: string,
  ) => Promise<{ workItemId: string; simpleName?: string } | null>;
  fetchRoleMembers: (
    workItemId: string,
    projectKey?: string,
  ) => Promise<TesterRoleMember[]>;
  searchUsers: (userKeys: string[]) => Promise<unknown>;
  parseSearchMap: (
    resp: unknown,
  ) =>
    | Record<string, { email: string; name?: string; unionId?: string }>
    | Promise<Record<string, { email: string; name?: string; unionId?: string }>>;
  readRegistry: () => Promise<Record<string, TesterRegistryMember>>;
  /** 发到需求群的统一入口；本模块固定 `kind: "message"` 卡片 + `allowCreate: false` */
  shareToGroup: (
    task: Task,
    input: ShareToGroupInput,
    opts: { allowCreate: false },
  ) => Promise<unknown>;
  warn: (msg: string) => void;
}

const defaultDeps = (): GroupTesterNotifyDeps => ({
  getBoundGroupChatId: async (task) =>
    (await import("@/lib/server/feishu-group")).getBoundGroupChatId(task),
  decodeStory: async (url) =>
    (await import("@/lib/server/meegle-cli")).decodeWorkitemUrl(url),
  fetchRoleMembers: async (workItemId, projectKey) =>
    (await import("@/lib/server/meegle-cli")).fetchWorkitemRoleMembers(
      workItemId,
      projectKey,
    ),
  searchUsers: async (userKeys) =>
    (await import("@/lib/server/meegle-cli")).searchUsersByKeys(userKeys),
  parseSearchMap: async (resp) =>
    (await import("@/lib/server/meegle-cli")).parseUserSearchEmailMap(resp),
  readRegistry: async () => {
    const { readGroupMemberRegistry } = await import(
      "@/lib/server/feishu-group-registry"
    );
    const reg = await readGroupMemberRegistry();
    const out: Record<string, TesterRegistryMember> = {};
    for (const [email, entry] of Object.entries(reg.members)) {
      const openId = entry.openId?.trim();
      if (!openId) continue;
      out[email] = {
        openId,
        ...(entry.name?.trim() ? { name: entry.name.trim() } : {}),
      };
    }
    return out;
  },
  shareToGroup: async (task, input, opts) =>
    (await import("@/lib/server/feishu-group")).shareToRequirementGroup(
      task,
      input,
      opts,
    ),
  warn: (msg) => console.warn(`${LOG} ${msg}`),
});

let deps: GroupTesterNotifyDeps = defaultDeps();

export const __setGroupTesterNotifyDepsForTest = (
  partial: Partial<GroupTesterNotifyDeps> | null,
): void => {
  deps = partial ? { ...defaultDeps(), ...partial } : defaultDeps();
};

export interface TesterNotifyOpts {
  emitInfo?: (text: string) => Promise<void> | void;
}

const errText = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/** 不静态 import FeishuGroupError：本模块被 task-runner 引用，要避开 meegle 整包 */
const groupErrorCode = (err: unknown): string | undefined => {
  if (!err || typeof err !== "object") return undefined;
  const rec = err as { name?: string; code?: unknown };
  if (rec.name === "FeishuGroupError" && typeof rec.code === "string") {
    return rec.code;
  }
  return undefined;
};

const withTimeout = async <T>(
  p: Promise<T>,
  ms: number,
  onTimeout: () => T,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(onTimeout()), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/**
 * ship 进行中尝试在需求群 @ 测试。绝不抛。
 */
export const notifyShipTestersInGroup = async (
  task: Task,
  action: ActionRecord,
  opts: TesterNotifyOpts = {},
): Promise<TesterNotifyOutcome> =>
  withTimeout<TesterNotifyOutcome>(
    runNotify(task, action, opts),
    TESTER_NOTIFY_TIMEOUT_MS,
    () => {
      deps.warn(
        `超时 task=${task.id} action=${action.id}、放弃（不影响提测完成）`,
      );
      return "failed";
    },
  ).catch((err): TesterNotifyOutcome => {
    deps.warn(`未捕获异常 task=${task.id} action=${action.id}：${errText(err)}`);
    return "failed";
  });

const runNotify = async (
  task: Task,
  action: ActionRecord,
  opts: TesterNotifyOpts,
): Promise<TesterNotifyOutcome> => {
  if (action.type !== "ship") return "skipped_not_ship";
  if (isLightweightDailyTask(task)) return "skipped_lightweight";

  const testerKeys = uniqueKeys(task.feishuTesterUserKeys);
  if (testerKeys.length === 0) return "skipped_no_testers";
  if (actionHasShipConflicts(action)) return "skipped_conflicts";

  const mrs = buildActionMrLinks(action);
  if (mrs.length === 0) return "skipped_no_mrs";
  // 正文用不封顶的全量（超 10 条的溢到正文、保证不丢），按钮用封顶版
  const allMrs = buildAllActionMrLinks(action);

  try {
    const chatId = await deps.getBoundGroupChatId(task);
    if (!chatId) return "skipped_no_group";

    const url = task.feishuStoryUrl?.trim() ?? "";
    let roleMembers: TesterRoleMember[] = [];
    if (url) {
      try {
        const decoded = await deps.decodeStory(url);
        if (decoded?.workItemId) {
          roleMembers = await deps.fetchRoleMembers(
            decoded.workItemId,
            decoded.simpleName,
          );
        }
      } catch (err) {
        deps.warn(`读工作项角色失败（继续用 user search）：${errText(err)}`);
      }
    }

    const registry = await deps.readRegistry();
    let searchByKey: Record<string, { email: string; name?: string; unionId?: string }> = {};
    // 只补缺邮箱的 key：全员都有邮箱，只走卡片 `<at email>`，不走 post 降级。
    const missingIdentity = testerKeys.filter((k) => {
      const role = roleMembers.find((m) => m.userKey?.trim() === k);
      return !asEmail(role?.email);
    });
    if (missingIdentity.length > 0) {
      try {
        const raw = await deps.searchUsers(missingIdentity);
        searchByKey = await deps.parseSearchMap(raw);
      } catch (err) {
        deps.warn(`user search 失败（能换出来的仍会 @）：${errText(err)}`);
      }
    }

    const { at, missedNames } = pickTesterAtTargets(
      testerKeys,
      roleMembers,
      searchByKey,
      registry,
    );
    // 只走卡片：有邮箱才 @（`<at email>` 已证可渲染+推送），没邮箱的进 missed，不走 post。
    const cardTargets = at.filter((t) => t.email);
    if (cardTargets.length === 0) {
      return "skipped_no_open_ids";
    }
    if (!claimNotify(task.id, action.id)) return "skipped_duplicate";

    try {
      await deps.shareToGroup(
        task,
        {
          kind: "message",
          title: "提测通知",
          content: buildTesterNotifyContent(
            allMrs,
            cardTargets.map((t) => ({ email: t.email!, name: t.name })),
          ),
          links: mrs,
        },
        { allowCreate: false },
      );
    } catch (err) {
      const code = groupErrorCode(err);
      // 发送明确失败即退坑（见 releaseNotify 注释）；超时不走这里。
      releaseNotify(task.id, action.id);
      if (code === "bot_not_in_group") {
        deps.warn(
          `bot 不在群，静默跳过 task=${task.id} action=${action.id}`,
        );
        return "skipped_bot_not_in_group";
      }
      if (code === "no_group" || code === "no_story") {
        return "skipped_no_group";
      }
      deps.warn(`发送失败 task=${task.id}：${errText(err)}`);
      return "failed";
    }

    // 回执只报实际发出去的人：没邮箱的没发，不能拿 `at` 充数（否则谎报）。
    const named = cardTargets.map((t) => t.name).join("、");
    const missed =
      missedNames.length > 0
        ? `（${missedNames.join("、")} 未换出 IM 身份，未 @）`
        : "";
    const viaNote = "（卡片 @）";
    try {
      await opts.emitInfo?.(`已在需求群 @ ${named}${missed}${viaNote}`);
    } catch {
      /* 事件流写失败不影响已经发出去的 @ */
    }
    return "sent";
  } catch (err) {
    deps.warn(`准备失败 task=${task.id}：${errText(err)}`);
    return "failed";
  }
};
