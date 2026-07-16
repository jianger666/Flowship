/**
 * 配置存取层：config.json（权威）+ 内存 cache（同步读）
 *
 * - 内存缓存 cache：初值 DEFAULT_SETTINGS；initSettings() 成功后用 config.json 覆盖
 * - getSettings()：同步读 cache（签名不变、调用方零改动）
 * - saveSettings()：写 cache + 串行队列 await 落 config.json（CR-08）
 * - P1-03：init 未成功前拒绝整对象 PUT，避免用默认/脏缓存覆盖磁盘有效配置
 *
 * 历史：曾从 localStorage 无感迁移到 config.json（截止 2026-06-28）；迁移链已退役。
 * 纯 UI 偏好类 localStorage（recent-workdirs / 视图记忆等）不走本文件。
 *
 * 数据 schema 看 src/lib/types.ts
 */

import { DEFAULT_MEEGLE_PROJECT, JUMP_IDES, USER_ROLES } from "./types";
import type {
  ActionLayoutPref,
  FeAiFlowSettings,
  ModelSelection,
  ModelUsageEntry,
  UserRole,
} from "./types";

/** 已退役的 settings localStorage key——启动时删掉防残留脏数据被误读 */
const LEGACY_SETTINGS_KEY = "fe-ai-flow:settings";
const API = "/api/settings";
// CR-01：默认 GET /api/settings 已脱敏（apiKey / gitToken 掩码）、client 初始化
// 灌 cache 必须拿真值——走专门的全量读取口（仅 loopback、middleware 强制）
const API_FULL = "/api/settings/full";

export const DEFAULT_SETTINGS: FeAiFlowSettings = {
  apiKey: "",
  defaultModel: { id: "" },
  repos: [],
  jumpIde: "cursor",
  submitShortcut: "mod-enter",
  gitToken: "",
  // 留空 = 运行时回退内置兜底（feature/{storyId}-{taskTitle}）、不再预填进设置页
  branchTemplate: "",
  disabledMcpServers: [],
  mcpServers: {},
  actionLayout: { order: [], hidden: [] },
  reuseAgentDefault: false,
  // Windows Agent shell 用 Git Bash——默认关、非 win32 UI 也不展示
  agentShellGitBash: false,
  isolateWorktreeDefault: true,
  disabledSkills: [],
  disabledRules: [],
  modelUsage: [],
  // 默认悟空产研空间——看板 / 收件箱唯一作用域（历史用户零迁移）
  meegleProject: { ...DEFAULT_MEEGLE_PROJECT },
};

const isBrowser = (): boolean =>
  typeof window !== "undefined" && typeof window.localStorage !== "undefined";

// defaultModel 字段读出来校验：必须是 { id: string } 形态、不然回 default
// 老 schema 兼容（V0.5.12.2 删）：以前 defaultModel 是纯 string、残留就重配
const readDefaultModel = (raw: unknown): ModelSelection => {
  if (
    raw &&
    typeof raw === "object" &&
    "id" in raw &&
    typeof (raw as { id: unknown }).id === "string"
  ) {
    return raw as ModelSelection;
  }
  return { id: "" };
};

// 推进面板布局偏好归一：order / hidden 必须是字符串数组、坏值 / 缺省回退空
const normalizeActionLayout = (raw: unknown): ActionLayoutPref => {
  if (!raw || typeof raw !== "object") return { order: [], hidden: [] };
  const o = raw as { order?: unknown; hidden?: unknown };
  const toStrArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return { order: toStrArr(o.order), hidden: toStrArr(o.hidden) };
};

/**
 * 默认飞书空间归一：缺失 / 形状不对 / key 非字符串或空 → 回落 DEFAULT_MEEGLE_PROJECT。
 * 历史 config 无此字段时自动落默认、不写迁移脚本。
 */
const normalizeMeegleProject = (
  raw: unknown,
): NonNullable<FeAiFlowSettings["meegleProject"]> => {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_MEEGLE_PROJECT };
  const o = raw as { key?: unknown; name?: unknown; simpleName?: unknown };
  if (typeof o.key !== "string" || !o.key.trim()) {
    return { ...DEFAULT_MEEGLE_PROJECT };
  }
  if (typeof o.name !== "string" || !o.name.trim()) {
    return { ...DEFAULT_MEEGLE_PROJECT };
  }
  return {
    key: o.key,
    name: o.name,
    ...(typeof o.simpleName === "string" && o.simpleName
      ? { simpleName: o.simpleName }
      : {}),
  };
};

/**
 * schema 归一：把 config.json 读出来的原始对象填全字段 + 校验、
 * 缺省 / 坏值回退默认。
 */
export const normalizeSettings = (
  parsed: Partial<FeAiFlowSettings> | null,
): FeAiFlowSettings => {
  if (!parsed || typeof parsed !== "object") return DEFAULT_SETTINGS;

  const repos = (Array.isArray(parsed.repos) ? parsed.repos : []).map((r) => {
    if (!r || typeof r !== "object") return r;
    // 只读 / 脚本仓开关：只认显式 true、其它（缺省 / 脏值）当关
    return {
      ...r,
      readonly: r.readonly === true ? true : undefined,
      scriptRepo: r.scriptRepo === true ? true : undefined,
    };
  });
  const merged = { ...DEFAULT_SETTINGS, ...parsed };
  // 历史残留键读取时忽略、不落进归一结果
  // username：V0.12.x 已删；gitHost：已退役（host 按任务仓库 remote 现推）
  delete (merged as Record<string, unknown>).username;
  delete (merged as Record<string, unknown>).gitHost;

  return {
    ...merged,
    defaultModel: readDefaultModel(parsed.defaultModel),
    repos,
    // 代码跳转 IDE：枚举外的值（旧档 / 手改坏）回退 cursor
    jumpIde: JUMP_IDES.includes(parsed.jumpIde as never)
      ? (parsed.jumpIde as FeAiFlowSettings["jumpIde"])
      : "cursor",
    // 提交快捷键：旧配置没有 / 手改坏时回退当前默认行为
    submitShortcut:
      parsed.submitShortcut === "enter" ? "enter" : "mod-enter",
    // V0.6.1 加：ship PAT 明文存（用户拍板可接受）；host 不进 settings
    gitToken: typeof parsed.gitToken === "string" ? parsed.gitToken : "",
    // V0.6.7：全局默认分支命名模板；V0.12.x 起留空合法（运行时回退内置兜底）
    branchTemplate:
      typeof parsed.branchTemplate === "string" ? parsed.branchTemplate : "",
    // V0.6.5：建任务默认 MCP 黑名单快照源
    disabledMcpServers: Array.isArray(parsed.disabledMcpServers)
      ? parsed.disabledMcpServers
      : [],
    mcpServers:
      parsed.mcpServers &&
      typeof parsed.mcpServers === "object" &&
      !Array.isArray(parsed.mcpServers)
        ? (parsed.mcpServers as FeAiFlowSettings["mcpServers"])
        : {},
    // V0.9：推进面板布局偏好、坏值 / 缺省回退空（= 全显示、默认顺序）
    actionLayout: normalizeActionLayout(parsed.actionLayout),
    // v0.9.11：推进 dialog「续用当前 Agent」默认勾选、缺省 / 坏值回退 false（每 action 新 agent）
    reuseAgentDefault: parsed.reuseAgentDefault === true,
    // Windows：Agent shell 用 Git Bash、缺省 / 坏值回退 false（不改 SHELL）
    agentShellGitBash: parsed.agentShellGitBash === true,
    // v1.1.x：新任务默认隔离工作区、缺省 / 坏值回退 true（只有显式 false 才默认直跑原仓）
    isolateWorktreeDefault: parsed.isolateWorktreeDefault !== false,
    // v1.1.x：禁用 skill / rule 名单、坏值 / 缺省回退空（= 全启用）
    disabledSkills: Array.isArray(parsed.disabledSkills)
      ? (parsed.disabledSkills as unknown[]).filter(
          (s): s is string => typeof s === "string",
        )
      : [],
    disabledRules: Array.isArray(parsed.disabledRules)
      ? (parsed.disabledRules as unknown[]).filter(
          (s): s is string => typeof s === "string",
        )
      : [],
    // V0.11.x：模型使用计数、坏值 / 缺省回退空
    modelUsage: Array.isArray(parsed.modelUsage)
      ? (parsed.modelUsage as ModelUsageEntry[]).filter(
          (e) => e && typeof e.id === "string" && typeof e.count === "number",
        )
      : [],
    // 我的角色：枚举外 / 缺省 → undefined（首页就绪清单据此判定未选）
    userRole: USER_ROLES.includes(parsed.userRole as UserRole)
      ? (parsed.userRole as UserRole)
      : undefined,
    // 默认飞书空间：缺 / 坏 → 悟空产研（看板 + 收件箱唯一作用域）
    meegleProject: normalizeMeegleProject(parsed.meegleProject),
  };
};

// 内存缓存：初值默认；initSettings 成功后被 config.json 覆盖。
// getSettings 同步读它——这是「保持同步签名、调用方零改动」的关键。
let cache: FeAiFlowSettings = DEFAULT_SETTINGS;
// initSettings 单飞：多个 hook（providers / use-settings）同时调时共享同一 promise、
// 都等到 config.json 加载完再读缓存；失败时清空、允许下次重试（SPA 不刷页、bool 标志会永久挡住重试）。
let initPromise: Promise<void> | null = null;
// P1-03：最近一次 init 是否成功灌过权威 config.json。
// 失败时 cache 保持 DEFAULT_SETTINGS——禁止用它整对象 PUT 覆盖磁盘。
let initSucceeded = false;

// 同步读缓存（签名不变、prepareRunArgs 等 9 处调用方一律不用改）
export const getSettings = (): FeAiFlowSettings => cache;

/**
 * PUT config.json（CR-08：非 2xx 一律 throw——原实现 500 也静默当成功、重启后修改凭空消失）。
 * 响应里的 settings 脱敏后不再需要回填 mcpServers（server 不再在 PUT 后改写该字段）。
 */
const putSettings = async (body: FeAiFlowSettings): Promise<void> => {
  const res = await fetch(API, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data?.error) message = data.error;
    } catch {
      // 错误体不是 JSON、用状态码兜底
    }
    throw new Error(message);
  }
};

/**
 * 启动初始化（app 根组件挂载时 await 一次、initialized 去重）
 *
 * 读 config.json：文件在 → 用文件覆盖缓存（权威源）；文件不在 → 用 DEFAULT_SETTINGS
 * 写进文件起步。文件链路挂了不阻塞、cache 保持 DEFAULT、下次启动再试；
 * P1-03 闸门禁止失败态整对象 PUT。
 */
export const initSettings = (): Promise<void> => {
  if (!isBrowser()) return Promise.resolve();
  // 已在跑 / 已跑完：复用同一 promise、不重复 fetch
  if (initPromise) return initPromise;
  initPromise = (async () => {
    // 清掉已退役的 settings localStorage 残留（一行、防脏数据被误读）
    try {
      window.localStorage.removeItem(LEGACY_SETTINGS_KEY);
    } catch {
      // 忽略：隐私模式 / 配额满等、不影响权威 config 路径
    }
    try {
      // 全量口（含明文密钥、仅 loopback）——默认 /api/settings 已脱敏、灌 cache 必须真值
      const res = await fetch(API_FULL);
      // 非 2xx（含 500 settings_unreadable）必须 throw——不得用默认值整包 PUT 覆盖磁盘
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try {
          const errBody = (await res.json()) as { error?: string };
          if (errBody?.error) detail = errBody.error;
        } catch {
          // 错误体非 JSON、用状态码兜底
        }
        throw new Error(`GET ${API_FULL} ${detail}`);
      }
      const data = (await res.json()) as {
        exists?: boolean;
        settings?: unknown;
      };
      if (data.exists && data.settings) {
        cache = normalizeSettings(data.settings as Partial<FeAiFlowSettings>);
      } else if (data.exists === false) {
        // 明确「文件不存在」：用当前 cache（= DEFAULT_SETTINGS）写进 config.json 起步；
        // MCP 不自动从 Cursor 搬——用户在能力页自己导入
        await putSettings(cache);
      } else {
        // exists 字段缺失 = 响应形状不对、按失败处理（防误写）
        throw new Error("GET full settings 响应形状异常（缺 exists）");
      }
      initSucceeded = true;
    } catch (err) {
      console.warn(
        "[local-store] config.json 初始化失败、暂用默认设置、下次再试",
        err,
      );
      // 失败态：cache 回到默认、拒绝后续整对象 PUT（P1-03）
      cache = DEFAULT_SETTINGS;
      initSucceeded = false;
      initPromise = null; // 失败清空、允许下次重试
    }
  })();
  return initPromise;
};

// CR-08：客户端写队列——连续快速保存串行落盘、后发请求不可能被先发的整对象覆盖
let writeQueue: Promise<void> = Promise.resolve();

/**
 * 写设置（CR-08 起 async：await 权威文件 config.json 写成功才算成功）
 *
 * @returns true=服务端 config.json 落盘成功；false=写失败（500 / 网络断 / 磁盘只读）。
 *          调用方据此决定是否把字段标成「已保存」+ toast。
 *          内存 cache 同步更新（乐观、getSettings 立即可读）。
 */
export const saveSettings = async (next: FeAiFlowSettings): Promise<boolean> => {
  cache = next;
  if (!isBrowser()) return false;
  // P1-03：初始化未成功时先重试一次真实 GET；仍失败则拒绝 PUT（返 false，
  // 调用方如 use-settings 已有 toast.error——保持 Promise<boolean> 签名、不抛错）
  if (!initSucceeded) {
    await initSettings();
    if (!initSucceeded) await initSettings(); // 再试一次（失败会清空 initPromise）
    if (!initSucceeded) {
      console.error(
        "[local-store] saveSettings 拒绝写入：config.json 初始化仍失败、避免用本地缓存覆盖磁盘配置",
      );
      return false;
    }
    // 重试成功后 init 可能用服务端值盖掉了 cache——写回用户本次意图再落盘
    cache = next;
  }
  // 权威写：挂到串行队列尾（保序）、await 服务端结果（失败不再被静默当成功）
  const attempt = writeQueue.then(() => putSettings(next));
  // 队列指针只关心「上一个写是否结束」、错误由本次调用方消费、不传染下一个
  writeQueue = attempt.then(
    () => undefined,
    () => undefined,
  );
  try {
    await attempt;
    return true;
  } catch (err) {
    console.error("[local-store] 写 config.json 失败", err);
    return false;
  }
};

// ----------------- 模型使用计数（「常用模型」快捷 chip 数据源、V0.11.x） -----------------

// 「模型 + 参数组合」唯一 key（params 排序后拼、顺序无关）
const modelUsageKey = (sel: {
  id: string;
  params?: Array<{ id: string; value: string }>;
}): string =>
  `${sel.id}||${(sel.params ?? [])
    .map((p) => `${p.id}=${p.value}`)
    .sort()
    .join(",")}`;

// 计数上限：超了淘汰「次数最少、其次最久没用」的条目、防列表无限膨胀
const MODEL_USAGE_CAP = 20;

/**
 * 记一次模型使用（推进起新 agent / 重启阶段 / 新建任务 / chat 换模型时调）。
 * 按 id + params 组合计数、写回 settings（异步落 config.json）。
 */
export const recordModelUsage = (sel: ModelSelection): void => {
  if (!sel.id?.trim()) return;
  // P1-03：必须等 init 成功后再整对象落盘。init 失败时 cache 是默认值——
  // 直接 save 会覆盖磁盘有效配置（模型计数是增强数据、丢一次无妨）
  void initSettings().then(() => {
    if (!initSucceeded) {
      console.warn(
        "[local-store] recordModelUsage 跳过保存：settings 初始化未成功",
      );
      return;
    }
    const s = getSettings();
    const key = modelUsageKey(sel);
    const list = [...(s.modelUsage ?? [])];
    const idx = list.findIndex((e) => modelUsageKey(e) === key);
    if (idx >= 0) {
      list[idx] = { ...list[idx], count: list[idx].count + 1, lastUsedAt: Date.now() };
    } else {
      list.push({ id: sel.id, params: sel.params, count: 1, lastUsedAt: Date.now() });
    }
    if (list.length > MODEL_USAGE_CAP) {
      list.sort((a, b) => b.count - a.count || b.lastUsedAt - a.lastUsedAt);
      list.length = MODEL_USAGE_CAP;
    }
    // 计数是尽力而为的统计、写失败无需打扰用户（下次使用再计）
    void saveSettings({ ...s, modelUsage: list });
  });
};

/**
 * 取使用次数 top N 的模型（次数同则最近用过的优先）——「常用模型」chip 用。
 */
export const getTopUsedModels = (n: number): ModelUsageEntry[] =>
  [...(getSettings().modelUsage ?? [])]
    .sort((a, b) => b.count - a.count || b.lastUsedAt - a.lastUsedAt)
    .slice(0, n);
