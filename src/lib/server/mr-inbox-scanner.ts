/**
 * 收件箱扫描器（服务端）——一期待测 MR + 二期 bug 双角色
 *
 * 分组：
 * - pendingMr：测试节点未完成的工作项评论里挖出的 GitLab MR（merged/closed 剔除）
 * - myBugs：经办人=我 且状态 in (OPEN / IN PROGRESS / REOPENED)
 * - pendingRegression：报告人=我 且状态=RESOLVED
 *
 * 作用域：只扫 settings.meegleProject（缺省 DEFAULT_MEEGLE_PROJECT）——全局唯一默认空间、
 * 不再 fetchProjects 全量遍历（多数空间无 bug 类型、白跑十几秒）。
 *
 * 按 settings.userRole 决定扫哪些组（fe/be 只扫 myBugs；qa 扫 MR+待回归；未设全扫）。
 *
 * 容错：单条失败 console.warn 跳过；meegle 未装/未登录结构化降级。
 * 缓存 TTL 10 分钟 + single-flight（只缓存 ok）；切默认空间时 invalidate。
 */

import {
  BUG_PENDING_FIX_LABELS,
  BUG_PENDING_REGRESSION_LABELS,
  buildBugDetailUrl,
  dedupeMrCandidatesByUrl,
  extractMrUrlsFromText,
  inboxGroupsVisibleForRole,
  isBugPendingFixStatus,
  isBugPendingRegressionStatus,
  isWorkitemReadyForQaInbox,
  MR_INBOX_CACHE_TTL_MS,
  parseGitlabMrUrl,
  parseMoqlBugQueryResponse,
  pickLatestMrUrlFromComments,
  stripBugMrFields,
  truncateCommentSnippet,
  type InboxGroupId,
  type MrInboxMrDetail,
  type MrUrlCandidate,
} from "@/lib/mr-inbox";
import { DEFAULT_MEEGLE_PROJECT, type UserRole } from "@/lib/types";
import {
  fetchMyUserKey,
  fetchUserSchedule,
  fetchWorkitemComments,
  fetchWorkitemNodes,
  meegleAuthStatus,
  MeegleError,
  queryWorkitemsByMql,
  type MeegleProject,
} from "./meegle-cli";
import { getMR } from "./gitlab-client";
import { readSettingsFile } from "./settings-fs";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 从 settings 解析默认飞书空间（缺 / 坏 → DEFAULT_MEEGLE_PROJECT）。
 * scanner 不走 client normalizeSettings、自己兜一层。
 */
const resolveDefaultMeegleProject = (
  settings: Record<string, unknown> | null,
): MeegleProject => {
  const raw = settings?.meegleProject;
  if (!raw || typeof raw !== "object") return { ...DEFAULT_MEEGLE_PROJECT };
  const o = raw as { key?: unknown; name?: unknown; simpleName?: unknown };
  if (typeof o.key !== "string" || !o.key.trim()) {
    return { ...DEFAULT_MEEGLE_PROJECT };
  }
  return {
    key: o.key,
    name:
      typeof o.name === "string" && o.name.trim()
        ? o.name
        : DEFAULT_MEEGLE_PROJECT.name,
    ...(typeof o.simpleName === "string" && o.simpleName
      ? { simpleName: o.simpleName }
      : {}),
  };
};

/** 待测 MR 单条 */
export interface MrInboxItem {
  mrUrl: string;
  workItemId: string;
  workItemName: string;
  projectKey: string;
  workItemUrl?: string;
  commentSnippet: string;
  commentAtMs: number;
  mr: MrInboxMrDetail | null;
  mrError?: string;
}

/** bug 收件箱单条（我的 BUG / 待回归共用；MR 字段仅待回归组会填） */
export interface BugInboxItem {
  /** bug 详情页 URL（已读标记 key） */
  bugUrl: string;
  workItemId: string;
  name: string;
  projectKey: string;
  statusLabel: string;
  priorityLabel?: string;
  relatedStoryId?: string;
  relatedStoryName?: string;
  /** 关联 MR URL（评论里抠到的；merged/closed 不带） */
  mrUrl?: string;
  /** GitLab 详情；无 token 时为 null */
  mr?: MrInboxMrDetail | null;
  /** getMR 失败文案 */
  mrError?: string;
}

export type MrInboxScanResult =
  | {
      status: "ok";
      pendingMr: MrInboxItem[];
      myBugs: BugInboxItem[];
      pendingRegression: BugInboxItem[];
      scannedAt: number;
      gitTokenConfigured: boolean;
    }
  | { status: "not_installed" | "not_authed" | "error"; message: string };

// ----------------- 进程全局状态（缓存 + single-flight + 近期变更） -----------------

/** 近期变更补丁 TTL：与缓存同量级，扫完落库前套用、防 in-flight 期间的合并/流转被整表覆盖 */
const RECENT_MUTATION_TTL_MS = 10 * 60 * 1000;

interface MrInboxGlobalState {
  cache: { at: number; result: MrInboxScanResult } | null;
  inFlight: Promise<MrInboxScanResult> | null;
  /**
   * 扫描 in-flight 期间用户合并 / 流转的补丁集。
   * 若不记：scan 完成后用「合并前」快照整表写回 → 按钮 / 已流转行复活。
   * value = 发生时间 ms；写入时顺手清过期条目。
   */
  recentMutations: {
    mergedMrUrls: Map<string, number>;
    removedBugUrls: Map<string, number>;
  };
}

const MR_INBOX_GLOBAL_KEY = "__feAiFlowMrInbox__";

const getGlobalState = (): MrInboxGlobalState => {
  const g = globalThis as unknown as Record<string, MrInboxGlobalState | undefined>;
  if (!g[MR_INBOX_GLOBAL_KEY]) {
    g[MR_INBOX_GLOBAL_KEY] = {
      cache: null,
      inFlight: null,
      recentMutations: {
        mergedMrUrls: new Map(),
        removedBugUrls: new Map(),
      },
    };
  }
  // 进程热更新可能留下缺字段的旧全局态，补齐避免访问 Map 炸
  const state = g[MR_INBOX_GLOBAL_KEY];
  if (!state.recentMutations) {
    state.recentMutations = {
      mergedMrUrls: new Map(),
      removedBugUrls: new Map(),
    };
  }
  return state;
};

/** 清掉 Map 里超过 TTL 的旧条目（写入 / 套用前各跑一次） */
const pruneOldMutations = (map: Map<string, number>, now: number): void => {
  for (const [key, at] of map) {
    if (now - at > RECENT_MUTATION_TTL_MS) map.delete(key);
  }
};

/**
 * 把近期合并 / 流转补丁套到扫描结果上（落缓存与返回调用方前都要过）。
 * - pendingMr：mrUrl 已合并 → 整条剔除
 * - myBugs / pendingRegression：mrUrl 已合并 → 剥 MR 字段；bugUrl 已流转 → 整条剔除
 */
const applyRecentMutations = (
  result: Extract<MrInboxScanResult, { status: "ok" }>,
): Extract<MrInboxScanResult, { status: "ok" }> => {
  const state = getGlobalState();
  const now = Date.now();
  pruneOldMutations(state.recentMutations.mergedMrUrls, now);
  pruneOldMutations(state.recentMutations.removedBugUrls, now);
  const { mergedMrUrls, removedBugUrls } = state.recentMutations;
  if (mergedMrUrls.size === 0 && removedBugUrls.size === 0) return result;

  const stripMergedMr = (it: BugInboxItem): BugInboxItem => {
    if (!it.mrUrl || !mergedMrUrls.has(it.mrUrl)) return it;
    return stripBugMrFields(it);
  };
  const keepBug = (it: BugInboxItem): boolean => !removedBugUrls.has(it.bugUrl);

  return {
    ...result,
    pendingMr: result.pendingMr.filter((it) => !mergedMrUrls.has(it.mrUrl)),
    myBugs: result.myBugs.filter(keepBug).map(stripMergedMr),
    pendingRegression: result.pendingRegression
      .filter(keepBug)
      .map(stripMergedMr),
  };
};

/** 收件箱入口：缓存新鲜直接返；refresh 强制重扫；并发 single-flight */
export const getMrInbox = async (
  opts: { refresh?: boolean } = {},
): Promise<MrInboxScanResult> => {
  const state = getGlobalState();
  if (!opts.refresh && state.cache) {
    if (Date.now() - state.cache.at < MR_INBOX_CACHE_TTL_MS) {
      return state.cache.result;
    }
  }
  if (state.inFlight) return state.inFlight;

  const run = scanMrInbox()
    .then((result) => {
      if (result.status === "ok") {
        // 扫描可能早于用户合并/流转启动：落库前套补丁，调用方拿到的也是套用后的
        const patched = applyRecentMutations(result);
        state.cache = { at: Date.now(), result: patched };
        return patched;
      }
      return result;
    })
    .finally(() => {
      state.inFlight = null;
    });
  state.inFlight = run;
  return run;
};

/** 合并成功后从缓存剔除该 MR，并记入近期补丁（防 in-flight 扫描整表覆盖） */
export const removeMrFromInboxCache = (mrUrl: string): void => {
  const state = getGlobalState();
  const now = Date.now();
  pruneOldMutations(state.recentMutations.mergedMrUrls, now);
  pruneOldMutations(state.recentMutations.removedBugUrls, now);
  state.recentMutations.mergedMrUrls.set(mrUrl, now);

  if (!state.cache || state.cache.result.status !== "ok") return;
  const r = state.cache.result;
  state.cache = {
    at: state.cache.at,
    result: {
      ...r,
      pendingMr: r.pendingMr.filter((it) => it.mrUrl !== mrUrl),
    },
  };
};

/**
 * 合并成功后清掉 bug 条目上的 MR 关联（待回归 + 我的 BUG 防御性）。
 * 口径：直接剥掉 mrUrl / mr / mrError——合并不等于回归通过，bug 行本身保留、
 * UI 侧「合并」按钮与状态 chip 随字段消失（不把 state 改成 merged 留残骸）。
 */
export const markBugMrMergedInCache = (mrUrl: string): void => {
  const state = getGlobalState();
  const now = Date.now();
  pruneOldMutations(state.recentMutations.mergedMrUrls, now);
  pruneOldMutations(state.recentMutations.removedBugUrls, now);
  state.recentMutations.mergedMrUrls.set(mrUrl, now);

  if (!state.cache || state.cache.result.status !== "ok") return;
  const r = state.cache.result;
  const clearMr = (it: BugInboxItem): BugInboxItem => {
    if (it.mrUrl !== mrUrl) return it;
    return stripBugMrFields(it);
  };
  state.cache = {
    at: state.cache.at,
    result: {
      ...r,
      myBugs: r.myBugs.map(clearMr),
      pendingRegression: r.pendingRegression.map(clearMr),
    },
  };
};

/** bug 流转成功后从缓存剔除，并记入近期补丁（我的 BUG / 待回归都扫一遍） */
export const removeBugFromInboxCache = (bugUrl: string): void => {
  const state = getGlobalState();
  const now = Date.now();
  pruneOldMutations(state.recentMutations.mergedMrUrls, now);
  pruneOldMutations(state.recentMutations.removedBugUrls, now);
  state.recentMutations.removedBugUrls.set(bugUrl, now);

  if (!state.cache || state.cache.result.status !== "ok") return;
  const r = state.cache.result;
  state.cache = {
    at: state.cache.at,
    result: {
      ...r,
      myBugs: r.myBugs.filter((it) => it.bugUrl !== bugUrl),
      pendingRegression: r.pendingRegression.filter((it) => it.bugUrl !== bugUrl),
    },
  };
};

/** 整缓存作废（角色切换等场景可选） */
export const invalidateMrInboxCache = (): void => {
  const state = getGlobalState();
  state.cache = null;
};

// ----------------- 扫描实现 -----------------

interface CandidateWithItem extends MrUrlCandidate {
  workItemId: string;
  workItemName: string;
  projectKey: string;
  workItemUrl?: string;
}

/** 拼「经办人 / 报告人 = 当前登录人」+ 状态 in 白名单的 MQL */
const buildBugMql = (
  projectKey: string,
  roleField: "__经办人" | "__报告人",
  statusLabels: readonly string[],
  userKey: string,
): string => {
  const inList = statusLabels.map((s) => `'${s}'`).join(",");
  // ⚠️ array_contains 的用户匹配必须传显式 `<id:user_key>`——传 'current_login_user()'
  // 会被服务端当字面 label 找人、报 "user label does not exist"、整条查询失败扫不出 bug
  //（实测踩过：漏扫全部 bug 根因）。user_key 由 scanMrInbox 的 fetchMyUserKey 拿到。
  return (
    `SELECT \`名称\`, \`工作项id\`, \`状态\`, \`优先级\`, \`关联产品需求\` ` +
    `FROM \`${projectKey}\`.\`bug 管理\` ` +
    `WHERE array_contains(\`${roleField}\`, '<id:${userKey}>') ` +
    `AND \`状态\` in (${inList}) LIMIT 50`
  );
};

const scanPendingMr = async (
  myKey: string,
  projects: Array<{ key: string; name: string }>,
  host: string | undefined,
  simpleNames: Map<string, string>,
  gitToken: string,
): Promise<MrInboxItem[]> => {
  const from = Date.now() - 60 * DAY_MS;
  const to = Date.now() + 30 * DAY_MS;

  const workitems: Array<{ id: string; name: string; projectKey: string }> = [];
  const seenIds = new Set<string>();
  for (const project of projects) {
    try {
      const items = await fetchUserSchedule(project.key, myKey, from, to);
      for (const it of items) {
        if (seenIds.has(it.id)) continue;
        seenIds.add(it.id);
        workitems.push({ id: it.id, name: it.name, projectKey: project.key });
      }
    } catch (err) {
      console.warn(
        `[mr-inbox] 空间 ${project.name}(${project.key}) 排期拉取失败、跳过:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  const hits: typeof workitems = [];
  for (const wi of workitems) {
    try {
      const nodes = await fetchWorkitemNodes(wi.id, wi.projectKey);
      if (isWorkitemReadyForQaInbox(nodes)) hits.push(wi);
    } catch (err) {
      console.warn(
        `[mr-inbox] 工作项 ${wi.id} 节点拉取失败、跳过:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  const candidates: CandidateWithItem[] = [];
  for (const wi of hits) {
    try {
      const comments = await fetchWorkitemComments(wi.id, wi.projectKey);
      const simple = simpleNames.get(wi.projectKey);
      const workItemUrl =
        host && simple
          ? `https://${host}/${simple}/story/detail/${wi.id}`
          : undefined;
      for (const comment of comments) {
        for (const mrUrl of extractMrUrlsFromText(comment.content)) {
          candidates.push({
            mrUrl,
            atMs: comment.createdAtMs,
            commentContent: comment.content,
            commentId: comment.id,
            workItemId: wi.id,
            workItemName: wi.name,
            projectKey: wi.projectKey,
            workItemUrl,
          });
        }
      }
    } catch (err) {
      console.warn(
        `[mr-inbox] 工作项 ${wi.id} 评论拉取失败、跳过:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  const deduped = dedupeMrCandidatesByUrl(candidates);

  const items: MrInboxItem[] = [];
  if (gitToken) {
    const detailed = await Promise.all(
      deduped.map(async (c) => {
        const parsed = parseGitlabMrUrl(c.mrUrl);
        if (!parsed) return { c, mr: null as null, error: "MR URL 无法解析" };
        const r = await getMR({
          config: { host: parsed.host, token: gitToken },
          projectPath: parsed.projectPath,
          iid: parsed.iid,
        });
        if (!r.ok) return { c, mr: null as null, error: r.error };
        return { c, mr: r, error: undefined };
      }),
    );
    for (const { c, mr, error } of detailed) {
      if (mr && (mr.state === "merged" || mr.state === "closed")) continue;
      items.push({
        mrUrl: c.mrUrl,
        workItemId: c.workItemId,
        workItemName: c.workItemName,
        projectKey: c.projectKey,
        workItemUrl: c.workItemUrl,
        commentSnippet: truncateCommentSnippet(c.commentContent),
        commentAtMs: c.atMs,
        mr: mr
          ? {
              title: mr.title,
              sourceBranch: mr.sourceBranch,
              targetBranch: mr.targetBranch,
              state: mr.state,
              detailedMergeStatus: mr.detailedMergeStatus,
              hasConflicts: mr.hasConflicts,
              mergeable: mr.mergeable,
            }
          : null,
        ...(error ? { mrError: error } : {}),
      });
    }
  } else {
    for (const c of deduped) {
      items.push({
        mrUrl: c.mrUrl,
        workItemId: c.workItemId,
        workItemName: c.workItemName,
        projectKey: c.projectKey,
        workItemUrl: c.workItemUrl,
        commentSnippet: truncateCommentSnippet(c.commentContent),
        commentAtMs: c.atMs,
        mr: null,
      });
    }
  }
  return items;
};

const scanBugsForRole = async (
  projects: Array<{ key: string; name: string }>,
  roleField: "__经办人" | "__报告人",
  statusLabels: readonly string[],
  statusFilter: (label: string | undefined) => boolean,
  host: string | undefined,
  simpleNames: Map<string, string>,
  userKey: string,
): Promise<BugInboxItem[]> => {
  const byUrl = new Map<string, BugInboxItem>();
  for (const project of projects) {
    try {
      const mql = buildBugMql(project.key, roleField, statusLabels, userKey);
      const resp = await queryWorkitemsByMql(project.key, mql);
      const rows = parseMoqlBugQueryResponse(resp);
      for (const row of rows) {
        if (!statusFilter(row.statusLabel)) continue;
        const bugUrl = buildBugDetailUrl({
          projectKey: project.key,
          workItemId: row.workItemId,
          host,
          simpleName: simpleNames.get(project.key),
        });
        byUrl.set(bugUrl, {
          bugUrl,
          workItemId: row.workItemId,
          name: row.name,
          projectKey: project.key,
          statusLabel: row.statusLabel,
          priorityLabel: row.priorityLabel,
          relatedStoryId: row.relatedStoryId,
          relatedStoryName: row.relatedStoryName,
        });
      }
    } catch (err) {
      console.warn(
        `[mr-inbox] 空间 ${project.name}(${project.key}) bug MQL 失败、跳过:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return [...byUrl.values()];
};

/**
 * 待回归组：逐 bug 拉评论抠 MR、有 gitToken 时补详情。
 * comment list 只靠 work-item-id + project-key（与 story 同款、不传 type）——
 * 飞书评论按工作项 id 寻址，bug / story 共用；workflow 才要 --work-item-type。
 * 单条失败 warn 跳过，不挂整组（对齐 scanPendingMr）。
 */
const enrichPendingRegressionWithMr = async (
  bugs: BugInboxItem[],
  gitToken: string,
): Promise<BugInboxItem[]> => {
  if (bugs.length === 0) return bugs;
  return Promise.all(
    bugs.map(async (bug) => {
      try {
        const comments = await fetchWorkitemComments(
          bug.workItemId,
          bug.projectKey,
        );
        const mrUrl = pickLatestMrUrlFromComments(comments);
        if (!mrUrl) return bug;

        if (!gitToken) {
          return { ...bug, mrUrl, mr: null };
        }

        const parsed = parseGitlabMrUrl(mrUrl);
        if (!parsed) {
          return { ...bug, mrUrl, mr: null, mrError: "MR URL 无法解析" };
        }
        const r = await getMR({
          config: { host: parsed.host, token: gitToken },
          projectPath: parsed.projectPath,
          iid: parsed.iid,
        });
        if (!r.ok) {
          return { ...bug, mrUrl, mr: null, mrError: r.error };
        }
        // 已合 / 已关：当作无关联（按钮不出现），与 scanPendingMr 滤法一致
        if (r.state === "merged" || r.state === "closed") return bug;

        const mr: MrInboxMrDetail = {
          title: r.title,
          sourceBranch: r.sourceBranch,
          targetBranch: r.targetBranch,
          state: r.state,
          detailedMergeStatus: r.detailedMergeStatus,
          hasConflicts: r.hasConflicts,
          mergeable: r.mergeable,
        };
        return { ...bug, mrUrl: parsed.canonicalUrl, mr };
      } catch (err) {
        console.warn(
          `[mr-inbox] bug ${bug.workItemId} 关联 MR 失败、跳过:`,
          err instanceof Error ? err.message : err,
        );
        return bug;
      }
    }),
  );
};

const scanMrInbox = async (): Promise<MrInboxScanResult> => {
  try {
    const myKey = await fetchMyUserKey();
    if (!myKey) {
      return { status: "not_authed", message: "meegle 未登录、请先在设置页授权" };
    }

    const settingsResult = await readSettingsFile();
    const settings =
      settingsResult.status === "ok" ? settingsResult.settings : null;
    const userRole =
      settings && typeof settings.userRole === "string"
        ? (settings.userRole as UserRole)
        : undefined;
    const visible = inboxGroupsVisibleForRole(userRole);

    // 只扫默认空间（不再 fetchProjects 全量）
    const project = resolveDefaultMeegleProject(settings);
    const projects = [project];
    // simpleName 直接从 settings 构造（缺则空 map、下游 URL 兜底已有）
    const simpleNames = project.simpleName
      ? new Map([[project.key, project.simpleName]])
      : new Map<string, string>();
    const { host } = await meegleAuthStatus();

    const gitToken =
      settings && typeof settings.gitToken === "string"
        ? settings.gitToken.trim()
        : "";

    let pendingMr: MrInboxItem[] = [];
    let myBugs: BugInboxItem[] = [];
    let pendingRegression: BugInboxItem[] = [];

    const need = (g: InboxGroupId) => visible.has(g);

    if (need("pendingMr")) {
      pendingMr = await scanPendingMr(
        myKey,
        projects,
        host,
        simpleNames,
        gitToken,
      );
    }
    if (need("myBugs")) {
      myBugs = await scanBugsForRole(
        projects,
        "__经办人",
        BUG_PENDING_FIX_LABELS,
        isBugPendingFixStatus,
        host,
        simpleNames,
        myKey,
      );
    }
    if (need("pendingRegression")) {
      pendingRegression = await scanBugsForRole(
        projects,
        "__报告人",
        BUG_PENDING_REGRESSION_LABELS,
        isBugPendingRegressionStatus,
        host,
        simpleNames,
        myKey,
      );
      // 仅待回归组挂 MR（我的 BUG 不需要）
      pendingRegression = await enrichPendingRegressionWithMr(
        pendingRegression,
        gitToken,
      );
    }

    console.log(
      `[mr-inbox] 扫描完成：空间=${project.name}(${project.key})、角色=${userRole ?? "unset"}、MR ${pendingMr.length}、我的BUG ${myBugs.length}、待回归 ${pendingRegression.length}`,
    );
    return {
      status: "ok",
      pendingMr,
      myBugs,
      pendingRegression,
      scannedAt: Date.now(),
      gitTokenConfigured: !!gitToken,
    };
  } catch (err) {
    if (err instanceof MeegleError) {
      return { status: err.kind, message: err.message };
    }
    console.error("[mr-inbox] 扫描失败", err);
    return {
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
};
