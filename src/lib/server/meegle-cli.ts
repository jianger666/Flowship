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

/** 单个工作项的宽松归一（字段名按飞书项目 openapi 常见命名多重兜底） */
export const normalizeWorkitem = (rawItem: unknown): BoardWorkitem | null => {
  if (!rawItem || typeof rawItem !== "object") return null;
  const m = rawItem as Record<string, unknown>;
  const id = asStr(pick(m, ["work_item_id", "workItemId", "id"]));
  const name = asStr(pick(m, ["name", "work_item_name", "title", "simple_name"]));
  if (!id || !name) return null;

  // 状态：可能是字符串、也可能是 {label} / {name} 对象
  const rawStatus = pick(m, [
    "work_item_status",
    "status",
    "current_status",
    "state",
    "node_name",
  ]);
  let statusLabel: string | undefined;
  if (typeof rawStatus === "string") statusLabel = rawStatus;
  else if (rawStatus && typeof rawStatus === "object") {
    const s = rawStatus as Record<string, unknown>;
    statusLabel = asStr(pick(s, ["label", "name", "state_key", "status_key", "value"]));
  }

  // 排期：schedule 对象 / 顶层字段两种形态
  let scheduleStart: number | undefined;
  let scheduleEnd: number | undefined;
  const sched = pick(m, ["schedule", "node_schedule"]);
  if (sched && typeof sched === "object") {
    const s = sched as Record<string, unknown>;
    scheduleStart = asMs(pick(s, ["estimate_start_date", "start_date", "start"]));
    scheduleEnd = asMs(pick(s, ["estimate_end_date", "end_date", "end", "due_date"]));
  }
  scheduleStart ??= asMs(pick(m, ["estimate_start_date", "start_date", "start_time"]));
  scheduleEnd ??= asMs(pick(m, ["estimate_end_date", "end_date", "deadline", "due_date", "expected_work_item_end_date"]));

  const projectKey = asStr(pick(m, ["project_key", "projectKey", "space_id"]));
  const typeRaw = pick(m, ["work_item_type_key", "work_item_type", "type_key", "type"]);
  const typeLabel =
    typeof typeRaw === "string"
      ? typeRaw
      : typeRaw && typeof typeRaw === "object"
        ? asStr((typeRaw as Record<string, unknown>).label ?? (typeRaw as Record<string, unknown>).name)
        : undefined;

  return {
    id,
    name,
    projectKey,
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
