/**
 * 收件箱「已忽略」条目的简要信息（纯函数；客户端构造 / 服务端清洗 / 面板展示共用）。
 *
 * 为什么存：忽略存储原先只有 `{url: ts}`，用户想在面板里看「我都忽略过什么」时只剩一串 URL。
 * 忽略时顺手存标题 / 所属分组 / 引用（仓库!编号 或 #工作项 id），旧数据缺这些字段时回落显示 url。
 */

import { parseGitlabMrUrl } from "@/lib/mr-inbox";

export type IgnoredGroup = "pendingMr" | "myBugs" | "pendingRegression";

const GROUPS: readonly IgnoredGroup[] = [
  "pendingMr",
  "myBugs",
  "pendingRegression",
];

/** 分组中文名（面板展示） */
export const IGNORED_GROUP_LABEL: Record<IgnoredGroup, string> = {
  pendingMr: "待测 MR",
  myBugs: "我的 BUG",
  pendingRegression: "待回归",
};

export interface IgnoredMeta {
  title?: string;
  group?: IgnoredGroup;
  /** MR：`group/proj!12`；bug：`#工作项id` */
  ref?: string;
}

/** 列表接口返回的一行 */
export interface IgnoredEntry extends IgnoredMeta {
  url: string;
  /** 忽略时间 ms */
  at: number;
}

const MAX_TITLE_LEN = 200;
const MAX_REF_LEN = 200;

/** 清洗外部传入的 meta：只留已知字段、类型 / 长度兜底；全空返回 undefined */
export const sanitizeIgnoredMeta = (raw: unknown): IgnoredMeta | undefined => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const out: IgnoredMeta = {};
  if (typeof o.title === "string" && o.title.trim()) {
    out.title = o.title.trim().slice(0, MAX_TITLE_LEN);
  }
  if (
    typeof o.group === "string" &&
    (GROUPS as readonly string[]).includes(o.group)
  ) {
    out.group = o.group as IgnoredGroup;
  }
  if (typeof o.ref === "string" && o.ref.trim()) {
    out.ref = o.ref.trim().slice(0, MAX_REF_LEN);
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

interface SnapshotLike {
  url: string;
  pendingMr?: { workItemName: string; mr: { title: string } | null };
  myBugs?: { name: string; workItemId: string };
  pendingRegression?: { name: string; workItemId: string };
}

/** 从忽略前的快照提取简要信息（快照里没抠到条目 → undefined） */
export const buildIgnoredMeta = (
  snapshot: SnapshotLike,
): IgnoredMeta | undefined => {
  const mr = snapshot.pendingMr;
  if (mr) {
    const parsed = parseGitlabMrUrl(snapshot.url);
    return sanitizeIgnoredMeta({
      title: mr.mr?.title || mr.workItemName,
      group: "pendingMr",
      ref: parsed ? `${parsed.projectPath}!${parsed.iid}` : undefined,
    });
  }
  const bug = snapshot.myBugs ?? snapshot.pendingRegression;
  if (bug) {
    return sanitizeIgnoredMeta({
      title: bug.name,
      group: snapshot.myBugs ? "myBugs" : "pendingRegression",
      ref: bug.workItemId ? `#${bug.workItemId}` : undefined,
    });
  }
  return undefined;
};

/** 面板展示文案：缺标题回落 url；缺引用 / 分组则省略 */
export const describeIgnoredEntry = (
  e: IgnoredEntry,
): { title: string; sub: string } => {
  const parts: string[] = [];
  if (e.group) parts.push(IGNORED_GROUP_LABEL[e.group]);
  if (e.ref) parts.push(e.ref);
  return { title: e.title || e.url, sub: parts.join(" · ") };
};
