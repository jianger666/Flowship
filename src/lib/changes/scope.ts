/**
 * 改动面板「看哪一段」的 scope 与 URL 参数互转（前后端共用的纯函数）。
 *
 * - `branch`      整条分支：相对线上分支分叉点的全部改动，含已提交 + 未提交 + 未跟踪（默认）
 * - `uncommitted` 只看还没提交的：相对 HEAD，含未跟踪
 * - `commit:<sha>` 只看某一个提交自己的改动（相对它的第一父）
 *
 * 序列化成一个字符串放进 query：`scope=branch | uncommitted | commit:<7~64 位十六进制>`。
 */

import type { TaskChangeScope } from "../types";

export const DEFAULT_CHANGE_SCOPE: TaskChangeScope = { kind: "branch" };

const COMMIT_SCOPE_RE = /^commit:([0-9a-fA-F]{7,64})$/;

/**
 * 解析 query 里的 scope 字符串。空 / 缺省 = branch；写错的返回 null（路由据此回 400，
 * 而不是悄悄当成 branch——调用方以为看的是某个提交、实际给了整条分支，会误导人）。
 */
export const parseChangeScope = (
  raw: string | null | undefined,
): TaskChangeScope | null => {
  const v = (raw ?? "").trim();
  if (v === "" || v === "branch") return { kind: "branch" };
  if (v === "uncommitted") return { kind: "uncommitted" };
  const m = COMMIT_SCOPE_RE.exec(v);
  return m ? { kind: "commit", sha: m[1].toLowerCase() } : null;
};

export const formatChangeScope = (scope: TaskChangeScope): string =>
  scope.kind === "commit" ? `commit:${scope.sha}` : scope.kind;

export const sameChangeScope = (a: TaskChangeScope, b: TaskChangeScope): boolean =>
  a.kind === b.kind && (a.kind !== "commit" || (b.kind === "commit" && a.sha === b.sha));

/** 手动基线名在 URL 里的上限（与服务端 isSafeRefName 的 200 字符一致，超长直接丢弃） */
export const MAX_BASE_REF_LENGTH = 200;

/** 规整 query 里的 base 参数：空串 / 超长 → null（= 自动探测）；合法性最终由服务端白名单判定 */
export const normalizeBaseRefParam = (raw: string | null | undefined): string | null => {
  const v = (raw ?? "").trim();
  return v && v.length <= MAX_BASE_REF_LENGTH ? v : null;
};

// ----------------- 清单 / 单文件 diff 共用的 query -----------------

export interface ChangesQuery {
  scope: TaskChangeScope;
  /** 手动指定的对比基线（分支名，不带 origin/）；null = 自动探测 */
  baseRef: string | null;
  /** 忽略空白（git diff -w） */
  ignoreWs: boolean;
}

export const DEFAULT_CHANGES_QUERY: ChangesQuery = {
  scope: DEFAULT_CHANGE_SCOPE,
  baseRef: null,
  ignoreWs: false,
};

/** 从 URLSearchParams 解析；scope 写错返回 null（路由回 400） */
export const parseChangesQuery = (sp: URLSearchParams): ChangesQuery | null => {
  const scope = parseChangeScope(sp.get("scope"));
  if (!scope) return null;
  return {
    scope,
    baseRef: normalizeBaseRefParam(sp.get("base")),
    ignoreWs: sp.get("ws") === "1",
  };
};

/** query 的稳定字符串：做 effect 依赖 / 缓存键，也用来判断「手里这份数据是不是当前 query 拉的」 */
export const changesQueryKey = (q: ChangesQuery): string =>
  `${formatChangeScope(q.scope)}|${q.baseRef ?? ""}|${q.ignoreWs ? "ws" : ""}`;

/** 把 query 写进 URLSearchParams：默认值一律不写（URL 更短，缓存键也更稳定） */
export const appendChangesQuery = (sp: URLSearchParams, q: Partial<ChangesQuery>): void => {
  if (q.scope && q.scope.kind !== "branch") sp.set("scope", formatChangeScope(q.scope));
  if (q.baseRef) sp.set("base", q.baseRef);
  if (q.ignoreWs) sp.set("ws", "1");
};
