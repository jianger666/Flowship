/**
 * 配置存取层（过渡版 V0.7.16：localStorage → config.json 文件迁移中）
 *
 * 背景：原来配置存浏览器 localStorage（Chromium leveldb）、桌面端有硬伤——
 * 按 origin 含端口隔离（换端口配置就丢、同步 test 还得转端口）、不透明 leveldb、
 * Electron 主进程读不到。改存 `data/config.json`（走 /api/settings、跟 FE_AI_FLOW_DATA_DIR）。
 *
 * 无感迁移（已有用户零操作、配置一条不丢）：
 * - 内存缓存 cache：模块加载即同步读 localStorage 兜底（启动无空窗、providers 等同步读立即有值）
 * - initSettings()：app 启动 await 一次、读 config.json；文件在 → 用文件（权威）；
 *   文件不在（首次升级）→ 把当前 cache（localStorage 旧配置）写进文件（迁移）
 * - getSettings()：同步读 cache（签名不变、9 处调用方零改动）
 * - saveSettings()：写 cache + **串行队列 await** 落 config.json（权威、CR-08）+ 过渡期双写 localStorage（回滚保险）
 *
 * ⏰ 清理任务（见 REMOVE_LOCALSTORAGE_AFTER）：过了保留期、且确认所有同事都升级过本过渡版后、
 *   做「清理版」——删掉 localStorage 读取 / 迁移 / 双写、saveSettings 改纯文件、只留 config.json + 缓存。
 *
 * 数据 schema 看 src/lib/types.ts
 */

import { JUMP_IDES } from "./types";
import type {
  ActionLayoutPref,
  FeAiFlowSettings,
  ModelSelection,
  ModelUsageEntry,
} from "./types";

const KEY = "fe-ai-flow:settings";
const API = "/api/settings";
// CR-01：默认 GET /api/settings 已脱敏（apiKey / gitToken 掩码）、client 初始化
// 灌 cache 必须拿真值——走专门的全量读取口（仅 loopback、middleware 强制）
const API_FULL = "/api/settings/full";

// ⏰ localStorage 迁移逻辑的保留截止日。过了这天、dev 控制台会红字提醒做「清理版」、
//    届时把本文件里所有 localStorage 读 / 写 / 迁移逻辑删掉、只留 config.json + 内存缓存。
const REMOVE_LOCALSTORAGE_AFTER = "2026-06-28";

export const DEFAULT_SETTINGS: FeAiFlowSettings = {
  apiKey: "",
  defaultModel: { id: "" },
  repos: [],
  jumpIde: "cursor",
  submitShortcut: "mod-enter",
  gitHost: "",
  gitToken: "",
  // 留空 = 运行时回退内置兜底（feature/{storyId}-{taskTitle}）、不再预填进设置页
  branchTemplate: "",
  disabledMcpServers: [],
  mcpServers: {},
  actionLayout: { order: [], hidden: [] },
  reuseAgentDefault: false,
  modelUsage: [],
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
 * schema 归一：把原始对象（localStorage 或 config.json 读出来的）填全字段 + 校验、
 * 缺省 / 坏值回退默认。localStorage 和文件两条来源共用同一套归一逻辑。
 */
const normalizeSettings = (
  parsed: (Partial<FeAiFlowSettings> & {
    defaultModel?: unknown;
    /** V0.12.x 已删的老字段：读到时做一次「烘焙进模板」迁移、之后不再落盘 */
    username?: unknown;
  }) | null,
): FeAiFlowSettings => {
  if (!parsed || typeof parsed !== "object") return DEFAULT_SETTINGS;

  // ---- username 迁移（V0.12.x 删字段）----
  // 老配置有 username 时：把模板里的 {username} 一次性替换成真实名字（全局 + 各仓覆盖）、
  // 老用户分支名零变化；模板缺省时老默认是 feature/{username}/... 、同样烘焙成显式模板。
  // 幂等：替换后模板里没有 {username}、重复跑无副作用；下次 saveSettings 落盘即完成迁移。
  const legacyUsername =
    typeof parsed.username === "string" ? parsed.username.trim() : "";
  const bakeUsername = (tpl: string | undefined): string | undefined => {
    if (!legacyUsername || !tpl) return tpl;
    return tpl.replaceAll("{username}", legacyUsername);
  };
  const rawGlobalTemplate =
    typeof parsed.branchTemplate === "string" && parsed.branchTemplate.trim()
      ? parsed.branchTemplate
      : // 老用户没显式配过模板但有 username = 依赖老默认 feature/{username}/...——烘焙成显式模板保行为
        legacyUsername
        ? "feature/{username}/{storyId}-{taskTitle}"
        : "";
  const repos = (Array.isArray(parsed.repos) ? parsed.repos : []).map((r) =>
    r?.branchTemplate ? { ...r, branchTemplate: bakeUsername(r.branchTemplate)! } : r,
  );
  const merged = { ...DEFAULT_SETTINGS, ...parsed };
  // 老字段不落进归一结果（Partial 展开会带上、显式删）
  delete (merged as Record<string, unknown>).username;

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
    // V0.6.1 加：ship action GitLab 配置、PAT 明文存（用户拍板可接受）
    gitHost: typeof parsed.gitHost === "string" ? parsed.gitHost : "",
    gitToken: typeof parsed.gitToken === "string" ? parsed.gitToken : "",
    // V0.6.7：全局默认分支命名模板；V0.12.x 起留空合法（运行时回退内置兜底）
    branchTemplate: bakeUsername(rawGlobalTemplate) ?? "",
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
    // V0.11.x：模型使用计数、坏值 / 缺省回退空
    modelUsage: Array.isArray(parsed.modelUsage)
      ? (parsed.modelUsage as ModelUsageEntry[]).filter(
          (e) => e && typeof e.id === "string" && typeof e.count === "number",
        )
      : [],
  };
};

// 【过渡期】同步读 localStorage：内存缓存的即时初值 + 首次迁移的数据源
const readLocalStorage = (): FeAiFlowSettings | null => {
  if (!isBrowser()) return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    return normalizeSettings(JSON.parse(raw));
  } catch (err) {
    console.warn("[local-store] localStorage settings 损坏、忽略", err);
    return null;
  }
};

// 内存缓存：模块加载即用 localStorage 兜底（启动无空窗）、initSettings 后被 config.json 覆盖。
// getSettings 同步读它——这是「保持同步签名、调用方零改动」的关键。
let cache: FeAiFlowSettings = readLocalStorage() ?? DEFAULT_SETTINGS;
// initSettings 单飞：多个 hook（providers / use-settings）同时调时共享同一 promise、
// 都等到 config.json 加载完再读缓存；失败时清空、允许下次重试（SPA 不刷页、bool 标志会永久挡住重试）。
let initPromise: Promise<void> | null = null;

// 同步读缓存（签名不变、prepareRunArgs 等 9 处调用方一律不用改）
export const getSettings = (): FeAiFlowSettings => cache;

// 【过渡期】过了保留期就 dev 警告：该做「清理版」删 localStorage 逻辑了
const warnIfMigrationExpired = (): void => {
  if (
    process.env.NODE_ENV !== "production" &&
    new Date() > new Date(REMOVE_LOCALSTORAGE_AFTER)
  ) {
    console.warn(
      `⚠️ [local-store] localStorage 迁移逻辑已过保留期（${REMOVE_LOCALSTORAGE_AFTER}）、` +
        "请做「清理版」：删掉 localStorage 读 / 写 / 迁移、只留 config.json + 内存缓存。",
    );
  }
};

/**
 * 启动初始化（app 根组件挂载时 await 一次、initialized 去重）
 *
 * 读 config.json：文件在 → 用文件覆盖缓存（权威源）；文件不在（首次升级）→ 把当前缓存
 * （来自 localStorage 的旧配置）写进文件、完成无感迁移。文件链路挂了不阻塞、继续用
 * localStorage 兜底的缓存、下次启动再试。
 */
/**
 * PUT config.json 并消费返回（V0.13）：server 可能在首次落盘后跑 MCP 一次性迁移
 * （Cursor 快照合入 mcpServers）——盘上最终内容随响应返回、这里回填进 cache、
 * 否则 cache 不含快照、下次整对象 PUT 会把迁移结果盖丢。
 * 只回填 mcpServers（server 唯一会改的字段）、不整包覆盖——防连续快速编辑时
 * 响应把用户更新的其它字段顶回去。
 *
 * CR-08：非 2xx 一律 throw——原实现 500 也静默当成功、重启后修改凭空消失。
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
  try {
    const data = (await res.json()) as {
      ok?: boolean;
      settings?: Partial<FeAiFlowSettings>;
    };
    const returned = data?.settings?.mcpServers;
    if (
      returned &&
      JSON.stringify(returned) !== JSON.stringify(body.mcpServers ?? {})
    ) {
      cache = { ...cache, mcpServers: returned };
    }
  } catch {
    // 响应体解析失败不影响写入本身（写已成功、只是拿不到回填）
  }
};

export const initSettings = (): Promise<void> => {
  if (!isBrowser()) return Promise.resolve();
  // 已在跑 / 已跑完：复用同一 promise、不重复 fetch
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      // 全量口（含明文密钥、仅 loopback）——默认 /api/settings 已脱敏、灌 cache 必须真值
      const res = await fetch(API_FULL);
      const data = (await res.json()) as {
        exists?: boolean;
        settings?: unknown;
      };
      if (data.exists && data.settings) {
        cache = normalizeSettings(data.settings as Partial<FeAiFlowSettings>);
      } else {
        // 首次升级：把当前缓存（localStorage 旧配置 / 默认）迁移进 config.json；
        // server 会在落盘后补跑 MCP 迁移、putSettings 内部回填快照进 cache
        await putSettings(cache);
      }
    } catch (err) {
      console.warn(
        "[local-store] config.json 初始化失败、暂用 localStorage 兜底缓存、下次再试迁移",
        err,
      );
      initPromise = null; // 失败清空、允许下次重试（避免永久卡在 localStorage）
    }
    warnIfMigrationExpired();
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
 *          内存 cache 同步更新（乐观、getSettings 立即可读）；localStorage 双写为
 *          过渡期回滚保险、其失败不影响返回值。
 */
export const saveSettings = async (next: FeAiFlowSettings): Promise<boolean> => {
  cache = next;
  if (!isBrowser()) return false;
  // 【过渡期】双写 localStorage：回滚保险（清理版删掉这段）；失败只 log、不挡权威写
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch (err) {
    console.error("[local-store] saveSettings localStorage 失败", err);
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
};

/**
 * 取使用次数 top N 的模型（次数同则最近用过的优先）——「常用模型」chip 用。
 */
export const getTopUsedModels = (n: number): ModelUsageEntry[] =>
  [...(getSettings().modelUsage ?? [])]
    .sort((a, b) => b.count - a.count || b.lastUsedAt - a.lastUsedAt)
    .slice(0, n);
