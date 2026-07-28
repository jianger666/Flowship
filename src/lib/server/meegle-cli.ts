/**
 * meegle CLI 服务端封装（V0.14 首页飞书看板）
 *
 * 首页看板 / 工作项预览 / URL 解析都走这里——execFile 直调内置 meegle 二进制
 *（data/tools/bin/meegle、V0.12 起可在设置页安装）、`--format json` 输出好解析。
 *
 * 关键设计：
 * - **看板主数据源**：`fetchUserSchedule`（workhour list-schedule，人员排期同款接口）。
 * - **错误三态**：not_installed（二进制不存在）/ not_authed（未登录）/ error（其他）——
 *   首页据此渲染降级态（装 CLI 引导 / 授权引导 / 报错重试）。
 * - 超时 30s：CLI 走公网 API、网络差时别挂死 route。
 * - **进程级串行队列**（`meegle-queue.ts`）：所有 meegle 短命子进程同一时刻最多跑 1 个
 *   （凭据文件 `~/.meegle/{.machine-key,credentials.enc}` 并发 refresh 会撞毁 → 等效登出；
 *   看板 Promise.all 会排队变慢一点，凭据安全 > 首屏 200ms）。
 *   feishu-cli 的 auth status / version / config 也走同一队列；`auth login` 长驻交互例外。
 *   排队等在 chain 上、30s/10s timeout 仍只罩 execFileAsync——排队时间不计入超时。
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";

import { USER_ROLE_LABEL, USER_ROLES, type UserRole } from "@/lib/types";
import {
  meegleBin,
  registerMeegleIdentityCacheInvalidator,
} from "./feishu-cli";
import { enqueueMeegle } from "./meegle-queue";
import { readSettingsFile } from "./settings-fs";

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

/**
 * 跑一条 meegle 命令、解析 JSON 输出；失败抛 MeegleError（kind 三态）。
 * 整段（含 unknown-command 时的 auth status 复核）进串行队列——复核走 raw、
 * 避免已持锁再 enqueue 死锁。
 */
const runMeegle = (args: string[]): Promise<unknown> =>
  enqueueMeegle(() => runMeegleUnlocked(args));

/** execFile 超时被 kill / 带 signal / meegle exit 2（网络不可达）→ 瞬态，不是「确定未登录」 */
const isMeegleExecTransient = (err: unknown): boolean => {
  const e = err as {
    killed?: boolean;
    signal?: string | null;
    code?: number | string;
    message?: string;
    stderr?: string;
  };
  if (e.killed === true) return true;
  if (typeof e.signal === "string" && e.signal.length > 0) return true;
  // meegle auth status 官方：exit 2 = 网络不可达（与 feishu-cli probeMeegleAuth 对齐）
  if (e.code === 2) return true;
  const text = `${e.message ?? ""}\n${e.stderr ?? ""}`;
  return /ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|timed? ?out|network unreachable/i.test(
    text,
  );
};

const runMeegleUnlocked = async (args: string[]): Promise<unknown> => {
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
    // 瞬态优先：VPN 卡 / 超时 kill 的 stderr 偶尔带 "auth login" 提示文案，
    // 若先走未登录正则会把登录着的人误判成 not_authed（看板弹「去授权」）
    if (isMeegleExecTransient(err)) {
      throw new MeegleError(
        "error",
        (e.stderr || e.message || "meegle 调用超时或网络不可达").slice(0, 500),
      );
    }
    if (/not logged in|no local token|auth login|unauthorized|401/i.test(text)) {
      throw new MeegleError("not_authed", "meegle 未登录、请先在设置页授权");
    }
    // 未登录时动态命令未注册、报 unknown command——但升级 / 重启后 CLI 冷启动、
    // 命令集加载慢也会瞬态报同样的错（用户实测「升级完首屏授权像没检测到」）：
    // 用静态命令 auth status 复核、真没登录才报 not_authed、登录着 / 探测瞬态算 error
    if (/unknown command/i.test(text)) {
      // 已在队列槽内：走 raw，勿再 enqueueMeegle（会死锁）
      const st = await meegleAuthStatusUnlocked();
      if (st.authenticated) {
        throw new MeegleError("error", "meegle 命令集尚未就绪、请稍后重试");
      }
      // auth status 自己超时 / exit 2 → transient，别当成未登录
      if (st.transient) {
        throw new MeegleError("error", "meegle 登录态探测失败（网络超时）、请稍后重试");
      }
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

/** auth status 实际执行（不进队列）；供已持锁的 runMeegleUnlocked 复核用 */
const meegleAuthStatusUnlocked = async (): Promise<{
  installed: boolean;
  authenticated: boolean;
  host?: string;
  /**
   * 探测失败是瞬态（超时 kill / exit 2 网络不可达 / 无 stdout）——
   * 不是「确定未登录」。unknown-command 复核必须看这个，否则 VPN 卡会误报 not_authed。
   */
  transient?: boolean;
}> => {
  const bin = meegleBin();
  try {
    await fs.access(bin);
  } catch {
    return { installed: false, authenticated: false };
  }
  try {
    // 官方：exit 0 = token 有效；1 = 未登录 / token 失效；2 = 网络不可达
    const r = await execFileAsync(bin, ["auth", "status"], {
      timeout: 10_000,
    });
    const parsed = JSON.parse(r.stdout) as {
      authenticated?: boolean;
      host?: string | null;
    };
    return {
      installed: true,
      authenticated: !!parsed.authenticated,
      host: parsed.host ?? undefined,
    };
  } catch (err) {
    const e = err as { code?: number; stdout?: string };
    // exit 1 时 stdout 仍常有 JSON（authenticated:false）——有输出就信 JSON
    if (typeof e.stdout === "string" && e.stdout.trim()) {
      try {
        const parsed = JSON.parse(e.stdout) as {
          authenticated?: boolean;
          host?: string | null;
        };
        const transient = isMeegleExecTransient(err);
        return {
          installed: true,
          authenticated: !!parsed.authenticated,
          host: parsed.host ?? undefined,
          // exit 2 / 超时即使带 JSON 也标瞬态（调用方不得当未登录）
          ...(transient ? { transient: true } : {}),
        };
      } catch {
        /* fallthrough */
      }
    }
    // 无可用 stdout（超时 kill / 解析失败）→ 一律瞬态，绝不当 authenticated:false
    // （旧实现 catch 一律 false，是 VPN 卡看板弹「去授权」的元凶）
    return { installed: true, authenticated: false, transient: true };
  }
};

/** 对外入口：走串行队列（boot / 看板探测也会打这条，必须和 runMeegle 互斥） */
export const meegleAuthStatus = (): Promise<{
  installed: boolean;
  authenticated: boolean;
  host?: string;
  transient?: boolean;
}> => enqueueMeegle(() => meegleAuthStatusUnlocked());

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

// ---------- 业务查询（看板主源：workhour list-schedule） ----------

/** 工作项详情（预览页 / 任务详情融合用；默认字段已含 description） */
// 成功结果进程内缓存：同一 story 反复起 agent 时 resolveUserIdentity 不重付 CLI
const workitemDetailCache = new Map<string, Record<string, unknown>>();
const workitemDetailCacheKey = (id: string, projectKey?: string): string =>
  `${projectKey ?? ""}:${id}`;

export const fetchWorkitemDetail = async (
  workItemId: string,
  projectKey?: string,
): Promise<Record<string, unknown>> => {
  const cacheKey = workitemDetailCacheKey(workItemId, projectKey);
  const cached = workitemDetailCache.get(cacheKey);
  if (cached) return cached;

  const args = ["workitem", "get", "--work-item-id", workItemId];
  if (projectKey) args.push("--project-key", projectKey);
  const resp = await runMeegle(args);
  let detail: Record<string, unknown> = {};
  if (resp && typeof resp === "object") {
    const r = resp as Record<string, unknown>;
    // 剥常见 data 包裹
    if (r.data && typeof r.data === "object") {
      detail = r.data as Record<string, unknown>;
    } else {
      detail = r;
    }
  }
  // 成功才缓存（空对象也算一次成功响应、避免同 key 狂打）
  workitemDetailCache.set(cacheKey, detail);
  return detail;
};

// ---------- 当前用户（子任务「只看自己」过滤 + agent prompt 身份注入） ----------

// user me 缓存（user_key / 姓名不会变、进程级缓存即可）——**只缓存成功结果**：
// v1.1.x 修（用户实测「升级重启后首屏授权像没检测到」的隐患之一）：原来失败也缓存 null、
// server 冷启动首拉赶上 CLI 慢 / 网络抖一次、看板就永远 not_authed 到进程重启
// ⚠️ 换账号后必须清：登录成功 / 登出 / 卸载走 invalidateMeegleIdentityCaches（审查发现：
//   旧缓存永不过期 + feishu 只清状态缓存 → 扫错人）
let meCache: string | undefined;
/** 身份缓存（姓名 + user_key）；与 meCache 同源、成功后两边一起填 */
let identityCache: MeegleIdentity | undefined;

/** 本人邮箱缓存（需求群成员注册表的 key）；只缓存成功结果 */
let myEmailCache: string | undefined;

/** 清 me / identity 进程内缓存（换账号后必须调；projectsCache 自带 TTL 不在此列） */
export const invalidateMeegleIdentityCaches = (): void => {
  meCache = undefined;
  identityCache = undefined;
  myEmailCache = undefined;
};

// meegle-cli 已依赖 feishu-cli、反向 import 会循环——用注册回调挂到 invalidateStatusCache
registerMeegleIdentityCacheInvalidator(invalidateMeegleIdentityCaches);

/** meegle `user me` 归一：姓名（name_cn 优先）+ user_key */
export interface MeegleIdentity {
  userKey: string;
  /** 展示名：name_cn 优先、否则 name_en */
  name: string;
}

/**
 * 当前登录用户的 user_key（实测 user me 返回 { user_key, name_cn, ... }）。
 * 真·未登录返 null；**瞬态失败（超时 / 网络抖）原样抛**——调用方（board route）
 * 会按 error 态渲染「重试」、而不是误导性的「去授权」（升级重启后冷启动踩过）
 */
export const fetchMyUserKey = async (): Promise<string | null> => {
  if (meCache !== undefined) return meCache;
  // 身份已缓存时复用（避免再打一次 user me）
  if (identityCache) {
    meCache = identityCache.userKey;
    return meCache;
  }
  try {
    const resp = (await runMeegle(["user", "me"])) as Record<string, unknown>;
    const key = asStr(resp.user_key);
    if (key) {
      meCache = key;
      // 顺手填身份缓存（姓名有就存、没有只缓存 key）
      const name = asStr(resp.name_cn) ?? asStr(resp.name_en);
      if (name) identityCache = { userKey: key, name };
    }
    return key ?? null;
  } catch (err) {
    if (err instanceof MeegleError && err.kind === "not_authed") return null;
    throw err;
  }
};

/**
 * 当前登录用户身份（姓名 + user_key）。
 * 给 agent prompt「发起人」行用——**增强路径、失败一律返 null**（未登录 / 超时 / 缺字段都不抛、
 * 别堵 task / chat 启动）。成功结果进程级缓存。
 */
export const fetchMyIdentity = async (): Promise<MeegleIdentity | null> => {
  if (identityCache) return identityCache;
  try {
    const resp = (await runMeegle(["user", "me"])) as Record<string, unknown>;
    const userKey = asStr(resp.user_key);
    const name = asStr(resp.name_cn) ?? asStr(resp.name_en);
    if (!userKey || !name) return null;
    identityCache = { userKey, name };
    meCache = userKey;
    return identityCache;
  } catch {
    // 身份是增强不是依赖：not_authed / 超时 / 解析失败都吞掉
    return null;
  }
};

// ---------- 本人邮箱（需求群成员注册表的 key） ----------

/** 从一条用户记录里抠邮箱（各命令字段名不统一、都试一遍） */
const pickUserEmail = (rec: Record<string, unknown>): string | undefined =>
  asStr(rec.email) ??
  asStr(rec.user_email) ??
  asStr(rec.enterprise_email) ??
  asStr(rec.email_address);

/**
 * 从 `user search` 响应里按 user_key 找邮箱（纯函数、单测友好）。
 * CLI 各版本包裹层不一（裸数组 / { data: [...] } / { list: [...] }）——都兼容；
 * 只有一条结果时不强求 key 匹配（`current_login_user()` 之类的查法拿不到 key 回填）。
 */
export const parseUserSearchEmail = (
  resp: unknown,
  userKey?: string,
): string | undefined => {
  const items: Record<string, unknown>[] = [];
  const collect = (v: unknown, depth: number): void => {
    if (depth > 3 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          items.push(item as Record<string, unknown>);
        }
      }
      return;
    }
    const rec = v as Record<string, unknown>;
    for (const key of ["data", "list", "items", "users", "result"]) {
      if (rec[key] !== undefined) collect(rec[key], depth + 1);
    }
    // 单对象响应（没有列表包裹）
    if (items.length === 0 && pickUserEmail(rec)) items.push(rec);
  };
  collect(resp, 0);
  if (items.length === 0) return undefined;

  if (userKey) {
    const hit = items.find(
      (it) => asStr(it.user_key) === userKey || asStr(it.key) === userKey,
    );
    const email = hit ? pickUserEmail(hit) : undefined;
    if (email) return email;
  }
  return items.length === 1 ? pickUserEmail(items[0]!) : undefined;
};

/**
 * 当前登录用户的邮箱——**需求群成员注册表的 key**。
 *
 * 必须走 meegle：注册表的另一端（工作项角色成员）给的就是 meegle 侧邮箱，
 * 两边同源才对得上号。lark-cli 侧拿不到本人邮箱（`authen/v1/user_info` 不返 email、
 * `contact +get-user` 缺 `contact:user.basic_profile:readonly`，2026-07-27 实测）。
 *
 * 探测链：`user me` 直接带 email → 否则用 user_key 走 `user search` 换。
 * **增强路径、失败一律返 null**（未装 / 未登录 / 超时都不抛）。
 */
export const fetchMyEmail = async (): Promise<string | null> => {
  if (myEmailCache !== undefined) return myEmailCache;
  try {
    const me = (await runMeegle(["user", "me"])) as Record<string, unknown>;
    const direct = pickUserEmail(me);
    if (direct) {
      myEmailCache = direct;
      return direct;
    }
    const userKey = asStr(me.user_key);
    if (!userKey) return null;
    const searched = await runMeegle([
      "user",
      "search",
      "--user-keys",
      JSON.stringify([userKey]),
    ]);
    const email = parseUserSearchEmail(searched, userKey);
    if (!email) return null;
    myEmailCache = email;
    return email;
  } catch {
    // 不缓存失败：CLI 装好 / 登录上之后下一轮就能拿到
    return null;
  }
};

// ---------- 工作项角色成员（建群拉人的数据源） ----------

/** 工作项某个角色下的一位成员（字段解析不出就 undefined） */
export interface WorkitemRoleMember {
  /** 角色名（「开发」「测试」「产品」…、空间自定义、不要写死枚举） */
  role?: string;
  name?: string;
  /** 邮箱——需求群成员注册表的反查 key */
  email?: string;
  /** 飞书项目 user_key（纯数字、@ mention 用；换不出 IM open_id） */
  userKey?: string;
}

/**
 * 从 `workitem get` 响应里抠角色成员（纯函数、单测友好）。
 *
 * 服务端把它放在 `work_item_attribute.role_members[]`，但不同空间 / 版本还见过
 * `role_owners`、以及塞进 `work_item_fields` 里的形态——所以做**有界深度遍历**、
 * 见到这两个 key 的数组就收，不写死路径。
 */
export const parseWorkitemRoleMembers = (
  resp: unknown,
): WorkitemRoleMember[] => {
  const out: WorkitemRoleMember[] = [];

  const pushMember = (raw: unknown, role: string | undefined): void => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const m = raw as Record<string, unknown>;
    const email = pickUserEmail(m);
    const name = asStr(m.name) ?? asStr(m.name_cn) ?? asStr(m.name_en);
    const userKey = asStr(m.key) ?? asStr(m.user_key);
    if (!email && !name && !userKey) return;
    out.push({
      ...(role ? { role } : {}),
      ...(name ? { name } : {}),
      ...(email ? { email } : {}),
      ...(userKey ? { userKey } : {}),
    });
  };

  const takeRoleArray = (arr: unknown[]): void => {
    for (const entry of arr) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const e = entry as Record<string, unknown>;
      const role = asStr(e.role) ?? asStr(e.role_name) ?? asStr(e.name);
      const members = e.members ?? e.owners ?? e.users ?? e.member_list;
      if (Array.isArray(members)) {
        for (const m of members) pushMember(m, role);
        continue;
      }
      // 扁平形态：角色条目本身就是一个人
      if (pickUserEmail(e) || asStr(e.key) || asStr(e.user_key)) {
        pushMember(e, undefined);
      }
    }
  };

  const walk = (v: unknown, depth: number): void => {
    if (depth > 6 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) walk(item, depth + 1);
      return;
    }
    const rec = v as Record<string, unknown>;
    for (const [key, value] of Object.entries(rec)) {
      if ((key === "role_members" || key === "role_owners") && Array.isArray(value)) {
        takeRoleArray(value);
        continue;
      }
      walk(value, depth + 1);
    }
  };

  walk(resp, 0);
  return out;
};

/**
 * 工作项角色成员清单（建群时按 email 反查注册表用）。
 * 复用 `fetchWorkitemDetail` 的全量查询 + 进程缓存——建群是低频动作、
 * 不值得为它多打一次 CLI 往返。
 */
export const fetchWorkitemRoleMembers = async (
  workItemId: string,
  projectKey?: string,
): Promise<WorkitemRoleMember[]> =>
  parseWorkitemRoleMembers(await fetchWorkitemDetail(workItemId, projectKey));

// ---------- prompt「用户身份」行（姓名 meegle + 角色 settings） ----------

/**
 * 从服务端 config.json 读设置页「我的角色」、映射中文标签。
 * 未设 / 坏值 → null（不注入角色段）。
 */
const readUserRoleLabel = async (): Promise<string | null> => {
  const result = await readSettingsFile();
  const settings = result.status === "ok" ? result.settings : null;
  const raw = settings?.userRole;
  if (typeof raw !== "string" || !USER_ROLES.includes(raw as UserRole)) {
    return null;
  }
  return USER_ROLE_LABEL[raw as UserRole];
};

/**
 * 拼 prompt「用户身份」行。
 * - 姓名 + 角色 → `- 发起人：陈禄江（角色：前端）`
 * - 只有姓名 → `- 发起人：陈禄江`
 * - 只有角色（meegle 未登录）→ `- 发起人角色：前端`
 * - 两个都没有 → 空串（调用方不注入整行）
 */
export const formatUserIdentityLine = (
  name: string | null | undefined,
  roleLabel: string | null | undefined,
): string => {
  const n = name?.trim() ?? "";
  const r = roleLabel?.trim() ?? "";
  if (n && r) return `- 发起人：${n}（角色：${r}）`;
  if (n) return `- 发起人：${n}`;
  if (r) return `- 发起人角色：${r}`;
  return "";
};

/**
 * 解析并拼出可直接塞进 super / chat prompt 的「用户身份」行。
 * - 姓名：meegle `user me`（进程级缓存保留）
 * - 角色：只读 settings.userRole（设置页 / 首页清单写入）——不再反查 story 角色组、
 *   不再读 identity.json、不再依赖 decodeUrl
 *
 * meegle 查询包 **5s 总预算**（超时仍可用角色单独注入；底层成功结果进缓存、下次能用）；
 * meegle 失败另记 60s 负缓存、避免每次启动都卡满 5s（角色仍照常注入）。
 */
/** 姓名 resolve 总预算（ms）——超时跳过姓名、不堵 agent 启动 */
const IDENTITY_RESOLVE_BUDGET_MS = 5_000;
/** meegle 失败负缓存 TTL：网络挂时 60s 内不再发起 user me */
const IDENTITY_NEG_CACHE_MS = 60_000;
let identityNegCachedAt = 0;

export const resolveUserIdentityForPrompt = async (): Promise<string> => {
  // 角色走本地文件、瞬时；与 meegle 姓名解耦——超时也能注入「发起人角色」
  const roleLabel = await readUserRoleLabel();

  const negHit =
    identityNegCachedAt > 0 &&
    Date.now() - identityNegCachedAt < IDENTITY_NEG_CACHE_MS;

  let name: string | null = null;
  if (!negHit) {
    // 迟到成功清负缓存；catch 吞掉防 unhandled rejection
    const work = fetchMyIdentity()
      .then((id) => {
        if (id) identityNegCachedAt = 0;
        return id?.name ?? null;
      })
      .catch((): null => null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve(null);
      }, IDENTITY_RESOLVE_BUDGET_MS);
    });
    try {
      name = await Promise.race([work, timeout]);
      if (name) identityNegCachedAt = 0;
      else if (timedOut) identityNegCachedAt = Date.now();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return formatUserIdentityLine(name, roleLabel);
};

// ---------- 节点 / 子任务类型（fetchUserSchedule 展开细节用） ----------

/** 节点下的子任务（甘特展开的最细粒度） */
export interface WorkitemSubTask {
  name: string;
  start?: number;
  end?: number;
  finished?: boolean;
  /** 负责人 user_key 列表 */
  owners?: string[];
}

/** 工作项的单个节点排期（甘特展开行用） */
export interface WorkitemNode {
  name: string;
  /** not_started / doing / done / finished 等（CLI basic.status 原样） */
  status?: string;
  start?: number;
  end?: number;
  subTasks: WorkitemSubTask[];
}

// ---------- 节点状态（提测收件箱 / workflow get-node） ----------

/**
 * 拉工作项全部节点（workflow get-node --node-id-list '["_all"]'）。
 * 实测结构：`{ list: [{ basic: { name, status, node_key }, ... }], pagination }`；
 * 节点常 >20 个，带 `--auto-paginate`。失败抛 MeegleError（调用方按项跳过）。
 */
export const fetchWorkitemNodes = async (
  workItemId: string,
  projectKey?: string,
): Promise<Array<{ name: string; status?: string }>> => {
  const args = [
    "workflow",
    "get-node",
    "--work-item-id",
    workItemId,
    "--node-id-list",
    '["_all"]',
    "--auto-paginate",
  ];
  if (projectKey) args.push("--project-key", projectKey);
  const resp = await runMeegle(args);
  const nodes: Array<{ name: string; status?: string }> = [];
  for (const raw of extractListItems(resp)) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Record<string, unknown>;
    const basic =
      m.basic && typeof m.basic === "object"
        ? (m.basic as Record<string, unknown>)
        : m;
    const name = asStr(basic.name);
    if (!name) continue;
    nodes.push({ name, status: asStr(basic.status) });
  }
  return nodes;
};

/** 工作项评论（提测收件箱挖 MR 链接用） */
export interface WorkitemComment {
  id?: string;
  content: string;
  /** 创建时间 ms（解析失败 0） */
  createdAtMs: number;
}

/**
 * 拉工作项评论列表（comment list）。
 * 实测结构：`{ comments: [{ comment_id, content, created_at, creator, file_url }] }`——
 * 字段名无公开 schema，按多候选 key 容错（id / comment_id / content / created_at …）。
 */
export const fetchWorkitemComments = async (
  workItemId: string,
  projectKey: string,
): Promise<WorkitemComment[]> => {
  const resp = await runMeegle([
    "comment",
    "list",
    "--work-item-id",
    workItemId,
    "--project-key",
    projectKey,
    "--auto-paginate",
  ]);
  const out: WorkitemComment[] = [];
  for (const raw of extractCommentItems(resp)) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Record<string, unknown>;
    const content =
      asStr(m.content) ?? asStr(m.text) ?? asStr(m.body) ?? asStr(m.comment);
    if (!content) continue;
    const id =
      asStr(m.comment_id) ??
      asStr(m.commentId) ??
      asStr(m.id) ??
      (typeof m.comment_id === "number" ? String(m.comment_id) : undefined) ??
      (typeof m.id === "number" ? String(m.id) : undefined);
    const createdAtMs =
      parseCommentTimeMs(m.created_at) ??
      parseCommentTimeMs(m.createdAt) ??
      parseCommentTimeMs(m.create_time) ??
      parseCommentTimeMs(m.created_time) ??
      0;
    out.push({ id, content, createdAtMs });
  }
  return out;
};

/** 从 get-node / 通用 list 响应挖数组
 *（transition：list-state-transitions 实测顶层是 `{ state_key, transition: [...] }`——
 * 2026-07-14 踩过：不认这个键 → 恒空数组 → 收件箱回归通过/打回永远「无法流转」） */
const extractListItems = (resp: unknown): unknown[] => {
  if (Array.isArray(resp)) return resp;
  if (!resp || typeof resp !== "object") return [];
  const r = resp as Record<string, unknown>;
  for (const k of ["list", "items", "results", "nodes", "transition", "data"]) {
    if (Array.isArray(r[k])) return r[k] as unknown[];
  }
  if (r.data !== undefined) return extractListItems(r.data);
  return [];
};

/** 从 comment list 响应挖评论数组 */
const extractCommentItems = (resp: unknown): unknown[] => {
  if (Array.isArray(resp)) return resp;
  if (!resp || typeof resp !== "object") return [];
  const r = resp as Record<string, unknown>;
  for (const k of ["comments", "list", "items", "results", "data"]) {
    if (Array.isArray(r[k])) return r[k] as unknown[];
  }
  if (r.data !== undefined) return extractCommentItems(r.data);
  return [];
};

/** 评论时间：毫秒戳 / 秒戳 / "2026-06-25 16:02:33" */
const parseCommentTimeMs = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    // 10 位当秒、13 位当毫秒
    return v < 1e12 ? v * 1000 : v;
  }
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) {
      return n < 1e12 ? n * 1000 : n;
    }
    const t = Date.parse(v.includes("T") ? v : v.replace(" ", "T"));
    if (Number.isFinite(t) && t > 0) return t;
  }
  return undefined;
};

// ---------- 人员排期（V0.14.1 起看板主数据源、飞书「人员排期」视图同款接口） ----------

/**
 * 按空间 + 人 + 时间区间查排期（workhour list-schedule、实测结构）：
 * ```
 * user_workload_list[0].tasks[]: {
 *   work_item_info: { id, name, work_item_status },
 *   time: { start: "2026-06-15 00:00:00", end: "...", duration: 0.5 },   // 需求级排期
 *   state: { state_name: "技术排期" },                                    // 当前节点名
 *   subtasks: [{ id, name, time: {...} }],                               // 我的子任务
 * }
 * ```
 * 为什么换它：mywork todo 只覆盖「当前节点等我操作」的工作项、同事的需求
 * （子任务负责人、非节点 owner）拉不到、空间下拉也因此缺空间——workhour 是
 * 飞书人员排期视图的底层接口、按空间查我参与的全部排期、语义正确。
 */
export const fetchUserSchedule = async (
  projectKey: string,
  userKey: string,
  startMs: number,
  endMs: number,
): Promise<BoardWorkitem[]> => {
  const fmt = (ms: number): string => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const resp = (await runMeegle([
    "workhour",
    "list-schedule",
    "--project-key",
    projectKey,
    "--user-keys",
    JSON.stringify([userKey]),
    "--start-time",
    fmt(startMs),
    "--end-time",
    fmt(endMs),
    "--work-item-type-keys",
    '["_all"]',
  ])) as Record<string, unknown>;

  const workloads = Array.isArray(resp.user_workload_list)
    ? (resp.user_workload_list as Array<Record<string, unknown>>)
    : [];
  const tasks = Array.isArray(workloads[0]?.tasks)
    ? (workloads[0]!.tasks as Array<Record<string, unknown>>)
    : [];

  // "2026-06-15 00:00:00"（空格分隔）→ ms
  const parseTime = (v: unknown): number | undefined => {
    if (typeof v !== "string" || !v.trim()) return undefined;
    const t = Date.parse(v.replace(" ", "T"));
    return Number.isFinite(t) && t > 0 ? t : undefined;
  };

  const items: BoardWorkitem[] = [];
  for (const task of tasks) {
    const info =
      task.work_item_info && typeof task.work_item_info === "object"
        ? (task.work_item_info as Record<string, unknown>)
        : {};
    const id = asStr(info.id);
    const name = asStr(info.name);
    if (!id || !name) continue;

    const time =
      task.time && typeof task.time === "object"
        ? (task.time as Record<string, unknown>)
        : {};
    const state =
      task.state && typeof task.state === "object"
        ? (task.state as Record<string, unknown>)
        : {};

    // 子任务（人员排期语义下天然只有自己的）
    const subTasks: WorkitemSubTask[] = [];
    if (Array.isArray(task.subtasks)) {
      for (const sub of task.subtasks as Array<Record<string, unknown>>) {
        const subName = asStr(sub.name);
        if (!subName) continue;
        const st =
          sub.time && typeof sub.time === "object"
            ? (sub.time as Record<string, unknown>)
            : {};
        subTasks.push({
          name: subName,
          start: parseTime(st.start),
          end: parseTime(st.end),
        });
      }
    }

    const statusLabel = asStr(state.state_name);
    items.push({
      id,
      name,
      projectKey,
      statusLabel,
      scheduleStart: parseTime(time.start),
      scheduleEnd: parseTime(time.end),
      raw: task,
    });
    // 前端展开逻辑遍历 nodes 取 subTasks——包一层单节点结构复用现有渲染
    const last = items[items.length - 1] as BoardWorkitem & {
      nodes?: WorkitemNode[];
    };
    last.nodes =
      subTasks.length > 0
        ? [{ name: statusLabel ?? "排期", status: undefined, start: undefined, end: undefined, subTasks }]
        : [];
  }
  console.log(
    `[meegle] workhour ${projectKey} ${fmt(startMs)}~${fmt(endMs)}：原始 ${tasks.length} 条、解析 ${items.length} 条`,
  );
  return items;
};

// ---------- 空间列表（下拉数据源 + URL 拼接） ----------

/** 可访问空间（project search 实测结构 { projects: [{ name, project_key, simple_name }] }） */
export interface MeegleProject {
  key: string;
  name: string;
  simpleName?: string;
}

// 空间列表缓存（10 分钟、空间极少变）——空间下拉 + URL 拼接共用
let projectsCache: { at: number; list: MeegleProject[] } | null = null;

/** 当前用户可访问的全部空间（V0.14.1 起空间下拉数据源——不再从数据聚合、
 * 同事踩过：mywork 覆盖不全导致下拉缺空间、看不到自己需求所在的空间） */
export const fetchProjects = async (): Promise<MeegleProject[]> => {
  if (projectsCache && Date.now() - projectsCache.at < 10 * 60 * 1000) {
    return projectsCache.list;
  }
  const resp = (await runMeegle(["project", "search"])) as Record<string, unknown>;
  const projects = Array.isArray(resp.projects) ? resp.projects : [];
  const list: MeegleProject[] = [];
  for (const p of projects as Array<Record<string, unknown>>) {
    const key = asStr(p.project_key);
    const name = asStr(p.name);
    if (key && name) list.push({ key, name, simpleName: asStr(p.simple_name) });
  }
  projectsCache = { at: Date.now(), list };
  return list;
};

export const fetchProjectSimpleNames = async (): Promise<Map<string, string>> => {
  const map = new Map<string, string>();
  try {
    for (const p of await fetchProjects()) {
      if (p.simpleName) map.set(p.key, p.simpleName);
    }
  } catch {
    // 拉不到就返回空 map（URL 兜底拼接降级为跳过）
  }
  return map;
};

/** URL → 结构化字段；非工作项详情 URL 返回 null */
// 成功结果按 url 缓存：同一 task 反复起 agent 不重付 decode CLI
const decodeUrlCache = new Map<
  string,
  { workItemId: string; simpleName?: string; typeKey?: string }
>();

export const decodeWorkitemUrl = async (
  url: string,
): Promise<{ workItemId: string; simpleName?: string; typeKey?: string } | null> => {
  const cached = decodeUrlCache.get(url);
  if (cached) return cached;
  try {
    const resp = (await runMeegle(["url", "decode", "--url", url])) as Record<
      string,
      unknown
    >;
    const kind = asStr(resp.url_kind);
    const id = asStr(resp.work_item_id);
    if (kind !== "workitem_detail" || !id) return null;
    const decoded = {
      workItemId: id,
      simpleName: asStr(resp.simple_name),
      typeKey: asStr(resp.work_item_type),
    };
    decodeUrlCache.set(url, decoded);
    return decoded;
  } catch {
    return null;
  }
};

// ---------- bug 收件箱：MQL 查询 / 状态流转 / 评论 ----------

/**
 * MQL 批量查工作项（必须走 -P 传 JSON——`--set` 会因 MQL 含 `=` 被拒）。
 * 返回原始 JSON（调用方用 parseMoqlBugQueryResponse 归一）。
 */
export const queryWorkitemsByMql = async (
  projectKey: string,
  mql: string,
): Promise<unknown> =>
  runMeegle([
    "workitem",
    "query",
    "--project-key",
    projectKey,
    "-P",
    JSON.stringify({ mql }),
  ]);

/** bug 简要字段（避开 `--fields _all` 的服务端序列化错） */
export interface BugBrief {
  name: string;
  statusKey?: string;
  statusLabel?: string;
  priorityLabel?: string;
  description?: string;
  relatedStoryId?: string;
  relatedStoryName?: string;
}

/**
 * 拉单条 bug 详情（name / status / priority / description / 关联产品需求）。
 * fields 显式列、不用 `_all`。
 */
export const fetchBugBrief = async (
  projectKey: string,
  workItemId: string,
): Promise<BugBrief> => {
  const resp = (await runMeegle([
    "workitem",
    "get",
    "--project-key",
    projectKey,
    "--work-item-id",
    workItemId,
    "--fields",
    "name,work_item_status,priority,description,field_cf759f",
  ])) as Record<string, unknown>;

  // 响应可能是扁平字段、也可能包在 fields / data 里——多形态容错
  const flat = flattenWorkitemFields(resp);
  const name =
    asStr(flat.name) ?? asStr(flat.work_item_name) ?? asStr(resp.name) ?? workItemId;
  const status = pickNestedKeyLabel(flat.work_item_status ?? flat.status);
  const priority = pickNestedKeyLabel(flat.priority);
  const related = pickNestedKeyLabel(flat.field_cf759f);
  const description =
    asStr(flat.description) ??
    (typeof flat.description === "object" && flat.description
      ? asStr((flat.description as Record<string, unknown>).doc_text) ??
        asStr((flat.description as Record<string, unknown>).text)
      : undefined);

  return {
    name,
    statusKey: status?.key,
    statusLabel: status?.label,
    priorityLabel: priority?.label ?? priority?.key,
    description,
    relatedStoryId: related?.key,
    relatedStoryName: related?.label,
  };
};

/** 把 workitem get 响应摊成 field_key → value 的扁平 map。
 * 实测（2026-07-14）响应形状：`{ work_item_attribute: { work_item_name,
 * work_item_status, ... }, work_item_fields: [{ key, name, value }] }`——
 * 旧代码只认 fields / data 包裹、导致 name 回落成 id、状态/优先级全丢。 */
const flattenWorkitemFields = (resp: unknown): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  if (!resp || typeof resp !== "object") return out;
  const r = resp as Record<string, unknown>;
  // 顶层直接是字段
  for (const [k, v] of Object.entries(r)) {
    if (
      k === "fields" ||
      k === "data" ||
      k === "list" ||
      k === "work_item_attribute" ||
      k === "work_item_fields"
    ) {
      continue;
    }
    out[k] = v;
  }
  // work_item_attribute：系统属性（work_item_name / work_item_status …）直接摊平
  if (r.work_item_attribute && typeof r.work_item_attribute === "object") {
    Object.assign(out, r.work_item_attribute as Record<string, unknown>);
  }
  const flattenFieldArray = (arr: unknown[]): void => {
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const m = item as Record<string, unknown>;
      const key = asStr(m.field_key) ?? asStr(m.key) ?? asStr(m.name);
      if (key) out[key] = m.field_value ?? m.value ?? m;
    }
  };
  if (Array.isArray(r.work_item_fields)) {
    flattenFieldArray(r.work_item_fields);
  }
  const nest = r.fields ?? r.data;
  if (Array.isArray(nest)) {
    flattenFieldArray(nest);
  } else if (nest && typeof nest === "object") {
    Object.assign(out, nest as Record<string, unknown>);
  }
  return out;
};

const pickNestedKeyLabel = (
  v: unknown,
): { key?: string; label?: string } | undefined => {
  if (!v || typeof v !== "object") {
    if (typeof v === "string") return { label: v };
    return undefined;
  }
  // 多值字段（如关联产品需求）可能是 [{key,label}] 数组——取首个
  if (Array.isArray(v)) {
    return v.length > 0 ? pickNestedKeyLabel(v[0]) : undefined;
  }
  const o = v as Record<string, unknown>;
  // 有的形态是 { field_value: { key, label } }
  const inner =
    o.field_value && typeof o.field_value === "object"
      ? (o.field_value as Record<string, unknown>)
      : o;
  // id：关联工作项实测形状 [{ id, name }]（workitem get 的 field_cf759f）
  const key = asStr(inner.key) ?? asStr(inner.value) ?? asStr(inner.id);
  const label =
    asStr(inner.label) ?? asStr(inner.name) ?? asStr(inner.cn_name);
  if (!key && !label) return undefined;
  return { key, label };
};

/** 状态流转可选项（list-state-transitions） */
export interface StateTransitionOption {
  transitionId: string;
  /** 目标状态 key（如 BBteJzss3） */
  targetStateKey?: string;
  /** 目标状态 label（如 CLOSED） */
  targetStateLabel?: string;
  name?: string;
}

/**
 * 查 bug 当前可流转项。
 * work-item-type 固定 `bug`；user-key 用当前登录人。
 */
export const listBugStateTransitions = async (
  projectKey: string,
  workItemId: string,
  userKey: string,
): Promise<StateTransitionOption[]> => {
  const resp = await runMeegle([
    "workflow",
    "list-state-transitions",
    "--project-key",
    projectKey,
    "--work-item-id",
    workItemId,
    "--work-item-type",
    "bug",
    "--user-key",
    userKey,
  ]);
  const items = extractListItems(resp);
  const out: StateTransitionOption[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Record<string, unknown>;
    const transitionId =
      asStr(m.transition_id) ??
      asStr(m.transitionId) ??
      asStr(m.id) ??
      (typeof m.transition_id === "number" ? String(m.transition_id) : undefined);
    if (!transitionId) continue;
    // 目标状态可能在 state / target_state / destination 等嵌套里
    const target =
      pickNestedKeyLabel(m.state) ??
      pickNestedKeyLabel(m.target_state) ??
      pickNestedKeyLabel(m.targetState) ??
      pickNestedKeyLabel(m.destination) ??
      pickNestedKeyLabel(m.to_state);
    out.push({
      transitionId,
      targetStateKey: target?.key ?? asStr(m.state_key) ?? asStr(m.stateKey),
      targetStateLabel: target?.label ?? asStr(m.state_name) ?? asStr(m.name),
      name: asStr(m.name) ?? asStr(m.transition_name),
    });
  }
  return out;
};

/** 状态流转必填字段（未覆盖则应降级跳飞书） */
export interface StateRequiredField {
  fieldKey: string;
  fieldName?: string;
}

/**
 * 查流转到某 state 的必填字段。
 * mode=unfinished 只看未填完的——有返回就说明 app 表单盖不住、该去飞书。
 */
export const listBugStateRequired = async (
  projectKey: string,
  workItemId: string,
  stateKey: string,
): Promise<StateRequiredField[]> => {
  const resp = await runMeegle([
    "workflow",
    "list-state-required",
    "--project-key",
    projectKey,
    "--work-item-id",
    workItemId,
    "--state-key",
    stateKey,
    "--mode",
    "unfinished",
  ]);
  const items = extractListItems(resp);
  const out: StateRequiredField[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Record<string, unknown>;
    const fieldKey =
      asStr(m.field_key) ?? asStr(m.fieldKey) ?? asStr(m.key);
    if (!fieldKey) continue;
    out.push({
      fieldKey,
      fieldName: asStr(m.field_name) ?? asStr(m.name) ?? asStr(m.label),
    });
  }
  return out;
};

/** 执行状态流转（transition-id 来自 list-state-transitions） */
export const transitionBugState = async (
  projectKey: string,
  workItemId: string,
  transitionId: string,
): Promise<void> => {
  await runMeegle([
    "workflow",
    "transition-state",
    "--project-key",
    projectKey,
    "--work-item-id",
    workItemId,
    "--transition-id",
    transitionId,
  ]);
};

/** 给工作项加 markdown 评论 */
export const addWorkitemComment = async (
  projectKey: string,
  workItemId: string,
  content: string,
): Promise<void> => {
  await runMeegle([
    "comment",
    "add",
    "--project-key",
    projectKey,
    "--work-item-id",
    workItemId,
    "--content",
    content,
  ]);
};

// ---------- 需求群（group_type 逻辑字段）----------

/**
 * 拉群方式读结果（读写协议不对称：读判别键是 `value`，写是 `type`）。
 * - auto / bind 通常带 group_id（oc_xxx）
 * - disabled 无 group_id
 */
export interface WorkitemGroupType {
  /** auto | bind | disabled | 未知原值 */
  value: string;
  groupId?: string;
  label?: string;
}

/**
 * 读工作项 `group_type`（只取拉群字段，不走 detail 全量缓存——bind 后要立刻再读）。
 */
export const fetchWorkitemGroupType = async (
  workItemId: string,
  projectKey?: string,
): Promise<WorkitemGroupType | null> => {
  const args = [
    "workitem",
    "get",
    "--work-item-id",
    workItemId,
    "--fields",
    '["group_type"]',
  ];
  if (projectKey) args.push("--project-key", projectKey);
  const resp = await runMeegle(args);
  return parseGroupTypeFromWorkitem(resp);
};

/**
 * bind 现有群到工作项：`field_value` 必须是 stringified JSON，
 * 写协议 `{"type":"bind","group_id":"oc_xxx"}`（判别键是 type，不是 value）。
 */
export const bindWorkitemGroup = async (
  workItemId: string,
  projectKey: string | undefined,
  groupId: string,
): Promise<void> => {
  const fieldValue = JSON.stringify({ type: "bind", group_id: groupId });
  const fields = JSON.stringify([
    { field_key: "group_type", field_value: fieldValue },
  ]);
  const args = [
    "workitem",
    "update",
    "--work-item-id",
    workItemId,
    "--fields",
    fields,
  ];
  if (projectKey) args.push("--project-key", projectKey);
  await runMeegle(args);
};

/**
 * 拉工作项名称（需求群群名 `<需求名>需求群` 的来源）。只取 name 一个字段。
 *
 * 建群拉同事走另一条路：`fetchWorkitemRoleMembers` 取角色成员**邮箱**、再到
 * 需求群成员注册表按邮箱反查 open_id / bot app_id（`feishu-group-registry`）——
 * user_key ↔ IM open_id 换不出来，邮箱才是两侧都有的键。
 */
export const fetchWorkitemName = async (
  workItemId: string,
  projectKey?: string,
): Promise<string | undefined> => {
  const args = [
    "workitem",
    "get",
    "--work-item-id",
    workItemId,
    "--fields",
    '["name"]',
  ];
  if (projectKey) args.push("--project-key", projectKey);
  const resp = await runMeegle(args);
  const flat = flattenWorkitemFields(resp);
  return (
    asStr(flat.name) ??
    asStr(flat.work_item_name) ??
    (resp && typeof resp === "object"
      ? asStr((resp as Record<string, unknown>).name)
      : undefined)
  );
};

/** 从 workitem get 响应抠 group_type */
/** export 仅供单测（真实服务端返回形状回归）；业务方走 fetchWorkitemGroupType */
export const parseGroupTypeFromWorkitem = (
  resp: unknown,
): WorkitemGroupType | null => {
  const flat = flattenWorkitemFields(resp);
  const raw =
    flat.group_type ??
    pickNestedFieldValue(resp, "group_type") ??
    // 真实服务端返回里 group_type 逻辑字段的 field_key 是 null（2026-07-27 实测）——
    // 按 key 匹配必然扑空。我们请求时 --fields 只要了 ["group_type"]，
    // 所以兜底：按值形状识别（对象含 value=auto/bind/disabled）。
    pickGroupTypeShapedValue(resp);
  if (raw == null) return null;
  // 可能是对象，也可能是 stringified JSON
  let obj: Record<string, unknown> | null = null;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        obj = parsed as Record<string, unknown>;
      } else {
        return { value: raw };
      }
    } catch {
      return { value: raw };
    }
  } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    obj = raw as Record<string, unknown>;
  }
  if (!obj) return null;
  // 读判别键是 value（偶发 type）
  const value =
    asStr(obj.value) ?? asStr(obj.type) ?? asStr(obj.group_type) ?? "";
  if (!value) return null;
  const groupId =
    asStr(obj.group_id) ?? asStr(obj.groupId) ?? asStr(obj.chat_id);
  return {
    value,
    groupId: groupId || undefined,
    label: asStr(obj.label) ?? asStr(obj.name),
  };
};

/**
 * 按「拉群字段的值形状」在 fields 数组里兜底找 group_type：
 * 对象且 value（或 type）∈ {auto, bind, disabled}。
 * 服务端对逻辑字段可能返回 field_key=null，按 key 匹配会漏（实测于 workitem get --fields '["group_type"]'）。
 */
const pickGroupTypeShapedValue = (resp: unknown): unknown => {
  if (!resp || typeof resp !== "object") return undefined;
  const r = resp as Record<string, unknown>;
  for (const arrKey of ["work_item_fields", "fields", "list"]) {
    const arr = r[arrKey];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const m = item as Record<string, unknown>;
      const v = m.field_value ?? m.value;
      const obj =
        v && typeof v === "object" && !Array.isArray(v)
          ? (v as Record<string, unknown>)
          : null;
      const discriminant = obj ? (asStr(obj.value) ?? asStr(obj.type)) : null;
      if (
        discriminant === "auto" ||
        discriminant === "bind" ||
        discriminant === "disabled"
      ) {
        return v;
      }
    }
  }
  if (r.data !== undefined) return pickGroupTypeShapedValue(r.data);
  return undefined;
};

/** 在嵌套 fields 数组里找指定 field_key 的 value */
const pickNestedFieldValue = (
  resp: unknown,
  fieldKey: string,
): unknown => {
  if (!resp || typeof resp !== "object") return undefined;
  const r = resp as Record<string, unknown>;
  for (const arrKey of ["work_item_fields", "fields", "list"]) {
    const arr = r[arrKey];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const m = item as Record<string, unknown>;
      const key = asStr(m.field_key) ?? asStr(m.key);
      if (key === fieldKey) return m.field_value ?? m.value;
    }
  }
  if (r.data !== undefined) return pickNestedFieldValue(r.data, fieldKey);
  return undefined;
};
