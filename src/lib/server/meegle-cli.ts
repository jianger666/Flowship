/**
 * meegle CLI 服务端封装（V0.14 首页飞书看板）
 *
 * 首页看板 / 工作项预览 / URL 解析都走这里——execFile 直调内置 meegle 二进制
 *（data/tools/bin/meegle、V0.12 起可在设置页安装）、`--format json` 输出好解析。
 *
 * 关键设计：
 * - **响应结构宽松归一**（normalizeWorkitem）：mywork / workitem get 的响应字段名
 *   没有公开 schema（官方 skill 文档只写了请求参数）、按常见命名多重兜底解析、
 *   解析不出的字段留 undefined、UI 容错渲染。真实结构以用户登录后实测校准。
 * - **错误三态**：not_installed（二进制不存在）/ not_authed（未登录）/ error（其他）——
 *   首页据此渲染降级态（装 CLI 引导 / 授权引导 / 报错重试）。
 * - 超时 30s：CLI 走公网 API、网络差时别挂死 route。
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";

import { meegleBin } from "./feishu-cli";

const execFileAsync = promisify(execFile);

// ---------- 基础执行 ----------

export type MeegleFailure = "not_installed" | "not_authed" | "error";

export class MeegleError extends Error {
  constructor(
    public readonly kind: MeegleFailure,
    message: string,
  ) {
    super(message);
    this.name = "MeegleError";
  }
}

/** 跑一条 meegle 命令、解析 JSON 输出；失败抛 MeegleError（kind 三态） */
const runMeegle = async (args: string[]): Promise<unknown> => {
  const bin = meegleBin();
  try {
    await fs.access(bin);
  } catch {
    throw new MeegleError("not_installed", "meegle CLI 未安装");
  }
  let stdout: string;
  try {
    const r = await execFileAsync(bin, [...args, "--format", "json"], {
      timeout: 30_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    stdout = r.stdout;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const text = `${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message ?? ""}`;
    if (/not logged in|no local token|auth login|unauthorized|401/i.test(text)) {
      throw new MeegleError("not_authed", "meegle 未登录、请先在设置页授权");
    }
    // 未登录时动态命令未注册、报 unknown command——同样按未登录处理
    if (/unknown command/i.test(text)) {
      throw new MeegleError("not_authed", "meegle 未登录（命令集未加载）、请先在设置页授权");
    }
    throw new MeegleError("error", (e.stderr || e.message || "meegle 调用失败").slice(0, 500));
  }
  try {
    return JSON.parse(stdout);
  } catch {
    // 有些命令可能带非 JSON 前缀行、截取首个 { / [ 起始再试一次
    const idx = Math.min(
      ...["{", "["].map((c) => {
        const i = stdout.indexOf(c);
        return i < 0 ? Number.MAX_SAFE_INTEGER : i;
      }),
    );
    if (idx < Number.MAX_SAFE_INTEGER) {
      try {
        return JSON.parse(stdout.slice(idx));
      } catch {
        /* fallthrough */
      }
    }
    throw new MeegleError("error", `meegle 输出不是 JSON：${stdout.slice(0, 200)}`);
  }
};

// ---------- 登录态 ----------

export const meegleAuthStatus = async (): Promise<{
  installed: boolean;
  authenticated: boolean;
  host?: string;
}> => {
  const bin = meegleBin();
  try {
    await fs.access(bin);
  } catch {
    return { installed: false, authenticated: false };
  }
  try {
    // auth status 未登录时 exit 1、但 stdout 仍是 JSON——直接拿输出解析
    const r = await execFileAsync(bin, ["auth", "status"], {
      timeout: 10_000,
    }).catch((err) => ({ stdout: (err as { stdout?: string }).stdout ?? "" }));
    const parsed = JSON.parse(r.stdout) as {
      authenticated?: boolean;
      host?: string | null;
    };
    return {
      installed: true,
      authenticated: !!parsed.authenticated,
      host: parsed.host ?? undefined,
    };
  } catch {
    return { installed: true, authenticated: false };
  }
};

// ---------- 工作项归一化 ----------

/** 看板用的工作项归一形状（字段解析不出就 undefined、UI 容错） */
export interface BoardWorkitem {
  /** 工作项 ID（字符串化） */
  id: string;
  /** 标题 */
  name: string;
  /** 空间 key（后续 workitem get / 流转都要带） */
  projectKey?: string;
  /** 空间名（展示用） */
  projectName?: string;
  /** 工作项类型（story / issue…、api_name 或 label） */
  typeLabel?: string;
  /** 当前状态 / 节点名（飞书侧状态徽标） */
  statusLabel?: string;
  /** 排期开始 / 结束（ms、时间线视图用） */
  scheduleStart?: number;
  scheduleEnd?: number;
  /** 详情页 URL（建任务时作 feishuStoryUrl） */
  url?: string;
  /** 原始对象（预览页兜底展示 / 调试） */
  raw: Record<string, unknown>;
}

const asStr = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v : typeof v === "number" ? String(v) : undefined;

const asMs = (v: unknown): number | undefined => {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return undefined;
  // 秒级时间戳兜底转毫秒（< 10^12 视为秒）
  return v < 1e12 ? v * 1000 : v;
};

// 从多个候选 key 里取第一个非空
const pick = (obj: Record<string, unknown>, keys: string[]): unknown => {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  }
  return undefined;
};

// 日期解析：ms 时间戳（秒级兜底）或 "YYYY-MM-DD" 字符串（mywork 实测形态）
const asDateMs = (v: unknown): number | undefined => {
  const n = asMs(v);
  if (n) return n;
  if (typeof v === "string" && v.trim()) {
    const t = Date.parse(v);
    if (Number.isFinite(t) && t > 0) return t;
  }
  return undefined;
};

/**
 * 单个工作项归一。mywork todo 实测结构（2026-07-10 登录后校准）：
 * ```
 * { node_info: { node_name: "前端开发", node_state_key },
 *   project_key, project_name,
 *   schedule: { start_time: "2025-06-03", end_time: "2025-06-04" },   // 字符串日期
 *   work_item_info: { work_item_id: 4969867129, work_item_name, work_item_type_key } }
 * ```
 * 顶层扁平形态（workitem query 等其他接口可能用）保留兜底。
 */
export const normalizeWorkitem = (rawItem: unknown): BoardWorkitem | null => {
  if (!rawItem || typeof rawItem !== "object") return null;
  const m = rawItem as Record<string, unknown>;
  // 核心字段可能嵌在 work_item_info 子对象（mywork 实测）、也可能顶层扁平
  const info =
    m.work_item_info && typeof m.work_item_info === "object"
      ? (m.work_item_info as Record<string, unknown>)
      : m;
  const id = asStr(pick(info, ["work_item_id", "workItemId", "id"]));
  const name = asStr(pick(info, ["work_item_name", "name", "title"]));
  if (!id || !name) return null;

  // 状态：mywork 在 node_info.node_name（当前节点名）；其他接口可能给字符串 / 对象
  let statusLabel: string | undefined;
  if (m.node_info && typeof m.node_info === "object") {
    statusLabel = asStr((m.node_info as Record<string, unknown>).node_name);
  }
  if (!statusLabel) {
    const rawStatus = pick(m, ["work_item_status", "status", "current_status", "state"]);
    if (typeof rawStatus === "string") statusLabel = rawStatus;
    else if (rawStatus && typeof rawStatus === "object") {
      const s = rawStatus as Record<string, unknown>;
      statusLabel = asStr(pick(s, ["label", "name", "state_key", "value"]));
    }
  }

  // 排期：mywork 的 schedule.{start_time,end_time} 是 "YYYY-MM-DD" 字符串；ms 形态兜底
  let scheduleStart: number | undefined;
  let scheduleEnd: number | undefined;
  const sched = pick(m, ["schedule", "node_schedule"]);
  if (sched && typeof sched === "object") {
    const s = sched as Record<string, unknown>;
    scheduleStart = asDateMs(pick(s, ["start_time", "estimate_start_date", "start_date", "start"]));
    scheduleEnd = asDateMs(pick(s, ["end_time", "estimate_end_date", "end_date", "end", "due_date"]));
  }
  scheduleStart ??= asDateMs(pick(m, ["estimate_start_date", "start_date", "start_time"]));
  scheduleEnd ??= asDateMs(pick(m, ["estimate_end_date", "end_date", "deadline", "due_date"]));

  const typeRaw = pick(info, ["work_item_type_key", "work_item_type", "type_key", "type"]);
  const typeLabel =
    typeof typeRaw === "string"
      ? typeRaw
      : typeRaw && typeof typeRaw === "object"
        ? asStr((typeRaw as Record<string, unknown>).label ?? (typeRaw as Record<string, unknown>).name)
        : undefined;

  return {
    id,
    name,
    projectKey: asStr(pick(m, ["project_key", "projectKey", "space_id"])),
    projectName: asStr(pick(m, ["project_name", "space_name", "simple_name"])),
    typeLabel,
    statusLabel,
    scheduleStart,
    scheduleEnd,
    url: asStr(pick(m, ["url", "link", "detail_url"])),
    raw: m,
  };
};

// 响应里挖工作项数组：常见包裹 data.list / list / data / items / results
const extractItems = (resp: unknown): unknown[] => {
  if (Array.isArray(resp)) return resp;
  if (!resp || typeof resp !== "object") return [];
  const r = resp as Record<string, unknown>;
  for (const k of ["list", "items", "results", "work_items", "workItems"]) {
    if (Array.isArray(r[k])) return r[k] as unknown[];
  }
  if (r.data !== undefined) return extractItems(r.data);
  return [];
};

// ---------- 业务查询 ----------

export type MyworkAction = "todo" | "done" | "overdue" | "this_week";

/** 我的工作项（跨空间、不用配 space）——首页看板主数据源 */
export const fetchMyWorkitems = async (
  action: MyworkAction,
  pageNum = 1,
): Promise<BoardWorkitem[]> => {
  const resp = await runMeegle([
    "mywork",
    "todo",
    "--action",
    action,
    "--page-num",
    String(pageNum),
  ]);
  return extractItems(resp)
    .map(normalizeWorkitem)
    .filter((x): x is BoardWorkitem => x !== null);
};

/** 工作项详情（预览页 / 任务详情融合用；默认字段已含 description） */
export const fetchWorkitemDetail = async (
  workItemId: string,
  projectKey?: string,
): Promise<Record<string, unknown>> => {
  const args = ["workitem", "get", "--work-item-id", workItemId];
  if (projectKey) args.push("--project-key", projectKey);
  const resp = await runMeegle(args);
  if (resp && typeof resp === "object") {
    const r = resp as Record<string, unknown>;
    // 剥常见 data 包裹
    if (r.data && typeof r.data === "object") return r.data as Record<string, unknown>;
    return r;
  }
  return {};
};

// ---------- 节点排期（甘特展开细节 + 需求级跨度聚合） ----------

/** 工作项的单个节点排期（甘特展开行用） */
export interface WorkitemNode {
  name: string;
  /** not_started / doing / done 等（CLI basic.status 原样） */
  status?: string;
  start?: number;
  end?: number;
}

// 节点排期缓存：49 个工作项逐个调 CLI 太贵（每次 ~1s）、10 分钟内复用
const nodesCache = new Map<string, { at: number; nodes: WorkitemNode[] }>();
const NODES_TTL_MS = 10 * 60 * 1000;

/**
 * 拉工作项的全部节点排期（workflow get-node --node-id-list '["_all"]'、实测结构：
 * list[].basic.{name,node_key,status} + schedule.{estimate_start_time,estimate_finish_time}）。
 * 失败返回空数组（甘特降级为只显示 mywork 的当前节点排期）。
 */
export const fetchWorkitemNodes = async (
  workItemId: string,
  projectKey?: string,
  opts: { skipCache?: boolean } = {},
): Promise<WorkitemNode[]> => {
  const cacheKey = `${projectKey ?? ""}:${workItemId}`;
  if (!opts.skipCache) {
    const hit = nodesCache.get(cacheKey);
    if (hit && Date.now() - hit.at < NODES_TTL_MS) return hit.nodes;
  }
  try {
    const args = [
      "workflow",
      "get-node",
      "--work-item-id",
      workItemId,
      "--node-id-list",
      '["_all"]',
    ];
    if (projectKey) args.push("--project-key", projectKey);
    const resp = await runMeegle(args);
    const nodes: WorkitemNode[] = [];
    for (const raw of extractItems(resp)) {
      if (!raw || typeof raw !== "object") continue;
      const m = raw as Record<string, unknown>;
      const basic =
        m.basic && typeof m.basic === "object"
          ? (m.basic as Record<string, unknown>)
          : m;
      const name = asStr(basic.name);
      if (!name) continue;
      let start: number | undefined;
      let end: number | undefined;
      if (m.schedule && typeof m.schedule === "object") {
        const s = m.schedule as Record<string, unknown>;
        start = asDateMs(s.estimate_start_time);
        end = asDateMs(s.estimate_finish_time);
      }
      nodes.push({ name, status: asStr(basic.status), start, end });
    }
    nodesCache.set(cacheKey, { at: Date.now(), nodes });
    return nodes;
  } catch {
    return [];
  }
};

/** 并发拉多个工作项的节点排期（限并发、看板聚合需求级跨度用） */
export const fetchNodesForItems = async (
  items: Array<{ id: string; projectKey?: string }>,
  opts: { skipCache?: boolean } = {},
): Promise<Map<string, WorkitemNode[]>> => {
  const out = new Map<string, WorkitemNode[]>();
  const CONCURRENCY = 8;
  let idx = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (idx < items.length) {
      const cur = items[idx++];
      const nodes = await fetchWorkitemNodes(cur.id, cur.projectKey, opts);
      out.set(cur.id, nodes);
    }
  });
  await Promise.all(workers);
  return out;
};

// ---------- 空间 simple_name 解析（URL 拼接用） ----------

// project_key（哈希）→ simple_name（URL 里的空间短名、如 wk-dm）缓存：
// mywork 只给 project_key、拼详情页 URL 必须 simple_name（实测 project search 结构：
// { projects: [{ name, project_key, simple_name }] }）。10 分钟缓存、空间列表极少变。
let projectNameCache: { at: number; map: Map<string, string> } | null = null;

export const fetchProjectSimpleNames = async (): Promise<Map<string, string>> => {
  if (projectNameCache && Date.now() - projectNameCache.at < 10 * 60 * 1000) {
    return projectNameCache.map;
  }
  const map = new Map<string, string>();
  try {
    const resp = (await runMeegle(["project", "search"])) as Record<string, unknown>;
    const projects = Array.isArray(resp.projects) ? resp.projects : [];
    for (const p of projects as Array<Record<string, unknown>>) {
      const key = asStr(p.project_key);
      const simple = asStr(p.simple_name);
      if (key && simple) map.set(key, simple);
    }
    projectNameCache = { at: Date.now(), map };
  } catch {
    // 拉不到就返回空 map（URL 兜底拼接降级为跳过）
  }
  return map;
};

/** URL → 结构化字段（纯本地解析、无网络）；非工作项详情 URL 返回 null */
export const decodeWorkitemUrl = async (
  url: string,
): Promise<{ workItemId: string; simpleName?: string; typeKey?: string } | null> => {
  try {
    const resp = (await runMeegle(["url", "decode", "--url", url])) as Record<
      string,
      unknown
    >;
    const kind = asStr(resp.url_kind);
    const id = asStr(resp.work_item_id);
    if (kind !== "workitem_detail" || !id) return null;
    return {
      workItemId: id,
      simpleName: asStr(resp.simple_name),
      typeKey: asStr(resp.work_item_type),
    };
  } catch {
    return null;
  }
};
