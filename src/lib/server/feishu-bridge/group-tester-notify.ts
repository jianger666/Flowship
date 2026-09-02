/**
 * 提测完成后在需求群 @ 测试人员（工作项评论 @ 不推通知的补位）。
 *
 * 由 ship 的 `notify_group_testers` 工具在交卷前调用（与飞书项目评论同一拍）。
 * 只往**已绑定**的需求群发、不建群。
 * 发到需求群走 {@link shareToRequirementGroup}（`format: "post"` + mentions）；
 * 换人（user_key → 邮箱 → 注册表 open_id）仍在本模块。
 * 对不上 / 没群 / bot 不在群一律静默：不抛、不写 error 事件、不弹引导。
 *
 * 依赖方向同 group-broadcast：本模块被 task-runner 静态引用，feishu-group /
 * meegle-cli / 注册表一律运行时动态 import。
 */

import { isLightweightDailyTask } from "@/lib/lightweight-task";
import type { ShareToGroupInput } from "@/lib/server/feishu-group";
import type { ActionRecord, Task } from "@/lib/types";

import { buildActionMrLinks } from "./group-broadcast";

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

export interface TesterAtTarget {
  openId: string;
  name: string;
}

export interface TesterRegistryMember {
  openId: string;
  name?: string;
}

export interface TesterRoleMember {
  userKey?: string;
  email?: string;
  name?: string;
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
 * user_key → 邮箱（角色成员优先，search 兜底）→ 注册表 open_id。
 * 换不出 open_id 的进 missedNames（展示名或 key），不挡能 @ 到的人。
 */
export const pickTesterAtTargets = (
  testerKeys: string[] | undefined,
  roleMembers: TesterRoleMember[],
  searchByKey: Record<string, { email: string; name?: string }>,
  registry: Record<string, TesterRegistryMember>,
): { at: TesterAtTarget[]; missedNames: string[] } => {
  const byKey = new Map<string, TesterRoleMember>();
  for (const m of roleMembers) {
    const k = m.userKey?.trim();
    if (k) byKey.set(k, m);
  }
  const at: TesterAtTarget[] = [];
  const seenOpenId = new Set<string>();
  const missedNames: string[] = [];
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
    if (openId) {
      if (!seenOpenId.has(openId)) {
        seenOpenId.add(openId);
        at.push({ openId, name: name || "测试" });
      }
    } else {
      missedNames.push(name || key);
    }
  }
  return { at, missedNames };
};

/** 提测通知正文（@ 由 shareToRequirementGroup 按 mentions 拼，这里只写给人看的话） */
export const buildTesterNotifyContent = (
  mrs: Array<{ label: string; url: string }>,
): string => {
  const mrLines = mrs.map((m) => `- ${m.label} ${m.url}`).join("\n");
  return `已提测，请验收：\n${mrLines}`.trim();
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
    | Record<string, { email: string; name?: string }>
    | Promise<Record<string, { email: string; name?: string }>>;
  readRegistry: () => Promise<Record<string, TesterRegistryMember>>;
  /** 发到需求群的统一入口；本模块固定 `format: "post"` + `allowCreate: false` */
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

    let searchByKey: Record<string, { email: string; name?: string }> = {};
    const missingEmail = testerKeys.filter((k) => {
      const role = roleMembers.find((m) => m.userKey?.trim() === k);
      return !asEmail(role?.email);
    });
    if (missingEmail.length > 0) {
      try {
        const raw = await deps.searchUsers(missingEmail);
        searchByKey = await deps.parseSearchMap(raw);
      } catch (err) {
        deps.warn(`user search 失败（有邮箱的人仍会 @）：${errText(err)}`);
      }
    }

    const registry = await deps.readRegistry();
    const { at, missedNames } = pickTesterAtTargets(
      testerKeys,
      roleMembers,
      searchByKey,
      registry,
    );
    if (at.length === 0) return "skipped_no_open_ids";
    if (!claimNotify(task.id, action.id)) return "skipped_duplicate";

    try {
      await deps.shareToGroup(
        task,
        {
          format: "post",
          content: buildTesterNotifyContent(mrs),
          mentions: at,
        },
        { allowCreate: false },
      );
    } catch (err) {
      const code = groupErrorCode(err);
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

    const named = at.map((t) => t.name).join("、");
    const missed =
      missedNames.length > 0
        ? `（${missedNames.join("、")} 未登记 IM 身份，未 @）`
        : "";
    try {
      await opts.emitInfo?.(`已在需求群 @ ${named}${missed}`);
    } catch {
      /* 事件流写失败不影响已经发出去的 @ */
    }
    return "sent";
  } catch (err) {
    deps.warn(`准备失败 task=${task.id}：${errText(err)}`);
    return "failed";
  }
};
