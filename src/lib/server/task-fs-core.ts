/**
 * task-fs 基建层（V0.9.x 从 task-fs.ts 拆出、纯搬家零逻辑变更）
 *
 * 职责（task-fs / task-artifacts 共用的底座）：
 *   - 数据目录路径常量 + id 生成 + 路径 helper（events.jsonl / actions/ / artifact / check log）
 *   - meta.json 类型（TaskMetaV06）+ zod schema 校验 + 原子读写
 *   - per-task mutex（withTaskLock、挂 globalThis）
 *   - 事件流读写（readEvents / readEventsTail / readEventsBefore / appendEventLine）
 *   - hydrate（meta → Task / TaskSummary）
 *
 * 依赖方向（保证无环）：只依赖 types / data-root、不 import task-fs / task-artifacts。
 * 数据布局说明见 task-fs.ts 顶部注释。
 */

import { createReadStream, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";

import type {
  ActionRecord,
  GitBranchInfo,
  MRRecord,
  ModelSelection,
  RepoStatus,
  RunStatus,
  Task,
  TaskContextDoc,
  TaskEvent,
  TaskMode,
  TaskSummary,
} from "@/lib/types";
import { dataRoot, RenameAbortedError, renameWithRetry } from "./data-root";
import { failpoint } from "./failpoints";
// 只用其纯函数（getTaskCwd 路径计算、零 IO）、task-worktrees 不反向依赖本模块（无环）
import { getTaskCwd } from "./task-worktrees";
import { z } from "zod";

// ----------------- 路径常量 -----------------

export const DATA_DIR = path.join(dataRoot(), "tasks");
export const META_FILE = "meta.json";
export const EVENTS_FILE = "events.jsonl";
export const ACTIONS_DIR = "actions";
// 任务专属可写工作目录（V0.x「产出解耦」）：artifact 之外的文件产出（脚本 / 数据 / 中间产物）
// 没有明确去处时写这里——只读仓 / 无仓任务也永远有合法可写落点。建任务时创建、随任务删除。
export const WORKSPACE_DIR = "workspace";
/** 工具超长输出全量落盘目录（Phase 1 tool_result 截断后查看完整输出用、随任务删） */
export const TOOL_OUTPUTS_DIR = "tool-outputs";
export const REVISIONS_SUBDIR = ".revisions";
// 划除（软删）的 artifact 挪进这个隐藏子目录——跟 .revisions / .checks 同风格、
// agent 的 ls / rg 默认都扫不到、防被按编号拼路径翻出来读（V0.8.16、见 setActionArtifactExcluded）
export const EXCLUDED_SUBDIR = ".excluded";
// 单 action 最多保留 10 个 revision、超出 GC 删最早（沿用 V0.5.12 的上限策略）
export const MAX_REVISIONS_PER_ACTION = 10;
/**
 * Windows 上进程持有任务目录句柄时 fs.rm 会 EBUSY（典型：shell 卡死后 cwd 停在 workspace、
 * kill-orphans 在 win32 是 no-op）。deleteTask 降级写此标记、删掉 meta 让 UI 立刻消失；
 * boot recovery 只清扫带此标记的目录（绝不动 bench/fixture 等无标记手工目录）。
 */
export const DELETED_TOMBSTONE_FILE = ".deleted-tombstone";

// ----------------- id 生成 / 校验 -----------------

export const newTaskId = (): string =>
  `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

export const newEventId = (): string =>
  `e_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

export const newActionId = (n: number): string => `act_${n}`;

export const newContextDocId = (): string =>
  `ctx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// 防路径穿越：只允许字母数字下划线
export const sanitizeId = (id: string): string => {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`非法 id: ${id}`);
  }
  return id;
};

export const taskDir = (id: string): string =>
  path.join(DATA_DIR, sanitizeId(id));

// ----------------- 路径 helper（给 prompt / runner 用）-----------------

/**
 * events.jsonl 的绝对路径
 * agent cwd 是用户业务仓库、不是 ai-flow 本身、所以必须用绝对路径
 */
export const getEventsLogPath = (taskId: string): string =>
  path.join(taskDir(taskId), EVENTS_FILE);

/**
 * actions/ 目录的绝对路径（给 prompt 用、agent 写 artifact 走这里）
 */
export const getActionsDir = (taskId: string): string =>
  path.join(taskDir(taskId), ACTIONS_DIR);

/**
 * 任务工作目录 workspace/ 的绝对路径（给 prompt / runner 用）
 * agent 的非 artifact 产出兜底落点、绝对路径注入 prompt（agent cwd 是业务仓库）
 */
export const getTaskWorkspaceDir = (taskId: string): string =>
  path.join(taskDir(taskId), WORKSPACE_DIR);

/**
 * 给单条 action 算 artifact 文件名（相对名、不含目录前缀）
 * 命名规则：`<N>-<type>.md`、N 不前导 0、跟 V0.6-REFACTOR.md §4.3 一致
 * type 用 string：历史退役类型（learn / test）磁盘上仍可能有 artifact、路径拼装不能卡死在枚举。
 */
export const actionArtifactFilename = (n: number, type: string): string =>
  `${n}-${type}.md`;

/**
 * 给单条 action 算 artifact 相对路径（meta 里 `ActionRecord.artifactPath` 存这个）
 * 例：`actions/1-plan.md`
 */
export const actionArtifactRelPath = (n: number, type: string): string =>
  `${ACTIONS_DIR}/${actionArtifactFilename(n, type)}`;

/**
 * 给单条 action 算 artifact 绝对路径（prompt 里塞给 agent）
 */
export const getActionArtifactPath = (
  taskId: string,
  n: number,
  type: string,
): string => path.join(getActionsDir(taskId), actionArtifactFilename(n, type));

// ----------------- 基础 fs helper -----------------

export const ensureDataDir = async (): Promise<void> => {
  await fs.mkdir(DATA_DIR, { recursive: true });
};

export const exists = async (p: string): Promise<boolean> => {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
};

// ----------------- meta.json 类型 + 读写 -----------------

/**
 * meta.json 的实际结构（V0.6）
 * - 跟 Task 比少 events（events.jsonl 独立、避免大字段反复读写）
 */
export interface TaskMetaV06 {
  id: string;
  title: string;
  mode?: TaskMode;
  repoStatus: RepoStatus;
  runStatus: RunStatus;
  currentActionId: string | null;
  actions: ActionRecord[];
  mrs: MRRecord[];
  /**
   * V0.6.1：每仓 1 条、build 第一次跑前按仓数初始化
   * （V0.6.0 时是单数 `gitBranch?: GitBranchInfo`、为支持多仓 task 改为数组）
   */
  gitBranches?: GitBranchInfo[];
  /**
   * V0.6.1：飞书测试人员记忆（A+C 兜底后落库、同 task 后续 ship 直接复用）
   * 2026-06-12 起存 user_key（原 lark_user_id 体系被官方 MCP 封死、详见 types.ts）
   */
  feishuTesterUserKeys?: string[];
  repoPaths: string[];
  /**
   * 非 git 目录清单快照（详见 types.ts Task.nonGitRepoPaths）。
   * undefined = 全 git（老任务）。
   */
  nonGitRepoPaths?: string[];
  /**
   * 只读仓清单快照（详见 types.ts Task.readonlyRepoPaths）。
   * undefined = 无只读仓（老任务）。
   */
  readonlyRepoPaths?: string[];
  /**
   * 脚本仓清单快照（详见 types.ts Task.scriptRepoPaths）。
   * undefined = 无脚本仓（老任务）。
   */
  scriptRepoPaths?: string[];
  /** V0.6.3：per-repo 线上分支（key=repoPath、建 task 时从 settings 快照、空则 build 探 origin/HEAD） */
  repoBaseBranches?: Record<string, string>;
  /** V0.6.3：per-repo「已有工作分支」覆盖（key=repoPath、建 task 时用户填、空则 build 用算法名） */
  repoFeatureBranches?: Record<string, string>;
  /** V0.6.7：per-repo 测试分支快照（ship 提测目标、空则回退默认 test） */
  repoTestBranches?: Record<string, string>;
  /** V0.6.7：per-repo dev 分支快照（暂存、无固定用途） */
  repoDevBranches?: Record<string, string>;
  /** V0.6.7：per-repo 有效命名模板快照（build 渲染分支名用） */
  repoBranchTemplates?: Record<string, string>;
  feishuStoryUrl?: string;
  contextDocs?: TaskContextDoc[];
  disabledMcpServers?: string[];
  /** V0.10：任务隔离工作区开关（新建默认 true、逃生口 false、详见 types.ts Task.isolateWorktree） */
  isolateWorktree?: boolean;
  /** V0.11.1：最近一次 agent 会话的 agentId（服务重启后 Agent.resume 续会话、详见 types.ts） */
  sessionAgentId?: string;
  /** V0.6.14：ship 合并后是否删源分支（缺省保留、详见 types.ts Task.removeSourceBranchOnMerge） */
  removeSourceBranchOnMerge?: boolean;
  /** V0.8 侧栏：用户置顶（缺省 false） */
  pinned?: boolean;
  createdAt: number;
  updatedAt: number;
  model?: ModelSelection;
  uiLayout?: { artifactPanelSize?: number };
}

/**
 * V0.6 meta schema 校验（V0.6.27 从手写 4 字段检查升级 zod）
 *
 * 分层策略：顶层关键字段 + actions 元素关键字段严格（枚举 / 类型）、
 * 其余嵌套对象宽松（passthrough、不逐字段建模——schema 跟着 types.ts 全量双写会漂移）。
 * 半损坏 meta（手改出错 / schema 演进漏字段）在这里被拦、不再带病传播到 UI / prompt 渲染。
 */
const ActionRecordLooseSchema = z
  .looseObject({
    id: z.string().min(1),
    n: z.number().int().nonnegative(),
    // 放行任意非空字符串：内置 ACTION_TYPES + custom + 历史退役类型（learn / test）。
    // 若收窄成枚举、带旧 learn 记录的 meta.json 会整单读失败（404）。
    // 新推进仍由 advance route 用 ACTION_TYPES / custom 白名单拦。
    type: z.string().min(1),
    status: z.enum(["running", "awaiting_ack", "completed", "error", "cancelled"]),
    userInstruction: z.string(),
    artifactPath: z.string().nullable(),
    startedAt: z.number(),
    endedAt: z.number().nullable(),
  });

const TaskMetaV06Schema = z
  .looseObject({
    id: z.string().min(1),
    title: z.string(),
    mode: z.enum(["task", "chat"]).optional(),
    repoStatus: z.enum([
      "developing",
      "merged",
      "abandoned",
    ]),
    runStatus: z.enum(["idle", "running", "awaiting_user", "error"]),
    currentActionId: z.string().nullable(),
    actions: z.array(ActionRecordLooseSchema),
    mrs: z.array(z.looseObject({})),
    // role 已退役：历史 meta 里残留的 role 字段靠 looseObject 自然忽略、不校验不读入
    repoPaths: z.array(z.string()),
    pinned: z.boolean().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
  });

export const isValidMetaShape = (raw: unknown): raw is TaskMetaV06 => {
  const parsed = TaskMetaV06Schema.safeParse(raw);
  if (!parsed.success) {
    // 校验失败打出具体哪个字段坏了（手写检查时代只能知道「不合法」、定位要人肉 diff）
    console.warn(
      `[task-fs] meta schema 校验失败：${parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
    return false;
  }
  return true;
};

// per-task mutex（防 read-modify-write race、沿用 V0.5）
//
// V0.6.27 改挂 globalThis：本模块被十几个 route import、Next.js dev 下不同 route
// 是不同 webpack chunk、module-level Map 会各持一份（chat-mcp V0.3.3 实测踩过）——
// 锁不共享 = withTaskLock 跨 route 不互斥、并发 patch meta.json 可能丢更新。
const TASK_LOCKS_KEY = "__feAiFlowTaskFsLocksV1__";
const getTaskLocks = (): Map<string, Promise<unknown>> => {
  const g = globalThis as unknown as Record<
    string,
    Map<string, Promise<unknown>> | undefined
  >;
  if (!g[TASK_LOCKS_KEY]) g[TASK_LOCKS_KEY] = new Map();
  return g[TASK_LOCKS_KEY]!;
};
const taskLocks = getTaskLocks();

export const withTaskLock = async <T>(
  taskId: string,
  fn: () => Promise<T>,
): Promise<T> => {
  const previous = taskLocks.get(taskId) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  taskLocks.set(taskId, next);
  try {
    return await next;
  } finally {
    if (taskLocks.get(taskId) === next) {
      taskLocks.delete(taskId);
    }
  }
};

/**
 * 读 meta.json、返回 raw JSON
 * - 文件不存在 → null
 * - 文件破损 / V0.5 残留 → 抛错（让上层决定 skip 还是 propagate）
 */
export const readMetaRaw = async (id: string): Promise<unknown | null> => {
  const p = path.join(taskDir(id), META_FILE);
  if (!(await exists(p))) return null;
  const raw = await fs.readFile(p, "utf-8");
  if (raw.trim().length === 0) {
    throw new Error(
      `meta.json 为空 taskId=${id}（可能上次进程写一半挂了、检查 data/tasks/${id}/）`,
    );
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `meta.json 解析失败 taskId=${id}：${msg}\n` +
        `文件长度=${raw.length}、前 200 字符=${raw.slice(0, 200)}`,
    );
  }
};

/**
 * 读 V0.6 meta（不符合 schema 直接抛错、写操作前必须 schema 完整）
 */
export const readMetaV06 = async (id: string): Promise<TaskMetaV06 | null> => {
  const raw = await readMetaRaw(id);
  if (!raw) return null;
  if (!isValidMetaShape(raw)) {
    throw new Error(
      `任务 ${id} meta.json schema 不匹配 V0.6（可能 V0.5 残留 / 文件破损）`,
    );
  }
  return raw;
};

/**
 * R20-3 / R26-5：把序列化 + 写 tmp 与原子 rename 拆开。
 * prepare 期间脏值只在 tmp、meta.json 未动；commit = rename；abort = unlink tmp。
 * 条件事务 helper 用「prepare → 同步复查 → commit(finalGuard)」消灭写后回滚窗口。
 *
 * R26-5 线性化：finalGuard 在 failpoint await 之后、rename 发起前同步执行——
 * owner/caller map 不受 task lock 约束，B 可在「prepare 后检查」与 rename 之间接管；
 * 权威检查必须落在 rename 紧前，否则 A 仍会提交旧值。
 */
export const prepareMetaWrite = async (
  meta: TaskMetaV06,
): Promise<{
  /** @returns true=已 rename；false=finalGuard 拒写 / 已 settled（tmp 已清） */
  commit: (finalGuard?: () => boolean) => Promise<boolean>;
  abort: () => Promise<void>;
}> => {
  const dir = taskDir(meta.id);
  // createTask 靠这里 mkdir 建任务目录；deleteTask 持 withTaskLock 后与之互斥，不会「删完被写回复活」
  await fs.mkdir(dir, { recursive: true });
  const finalPath = path.join(dir, META_FILE);
  // 原子写：tmp + rename（Windows 重试逻辑与 writePrivateFileAtomic 共用 renameWithRetry）
  const tmpPath = `${finalPath}.tmp.${process.pid}.${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  try {
    await fs.writeFile(tmpPath, JSON.stringify(meta, null, 2), "utf-8");
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
  let settled = false;
  return {
    commit: async (finalGuard?: () => boolean) => {
      if (settled) return false;
      settled = true;
      try {
        // R25-1 / R25-5：rename 已发起未落盘窗口——矩阵可在此注入 stop，
        // 验证 stop 的锁内收尾必排在本 commit 持锁返回之后（见 finalizeStaleAndIdleLocked）
        await failpoint("metaCommit.beforeRename");
        // R26-5：权威 lease——同步、无 await 夹缝；false 则 unlink tmp、不 rename
        if (finalGuard && !finalGuard()) {
          await fs.unlink(tmpPath).catch(() => {});
          return false;
        }
        // R27-1：finalGuard 压进 rename retry 循环——每次 fs.rename 前再验；
        // 首轮失败退避期间换主 → RenameAbortedError → 清 tmp、返 false
        await renameWithRetry(tmpPath, finalPath, finalGuard);
        return true;
      } catch (err) {
        await fs.unlink(tmpPath).catch(() => {});
        // R27-1：beforeAttempt 拒写 = 未提交（不是 IO 故障）
        if (err instanceof RenameAbortedError) return false;
        throw err;
      }
    },
    abort: async () => {
      if (settled) return;
      settled = true;
      await fs.unlink(tmpPath).catch(() => {});
    },
  };
};

/** 无条件写 meta：prepare + commit（finalGuard 不传、照常 rename） */
export const writeMeta = async (meta: TaskMetaV06): Promise<void> => {
  const prepared = await prepareMetaWrite(meta);
  await prepared.commit();
};

// ----------------- 事件流 -----------------

/** 尾部 / bootstrap 最多带这么多条（调用方传入更大值会被 clamp） */
export const MAX_EVENTS_TAIL = 1000;
/** cursor 分页单页上限 */
export const MAX_EVENTS_PAGE = 500;
/** 反向读尾部时每块字节数——IO 量跟「要的条数 × 平均行宽」同阶，不跟文件总长 */
const EVENTS_TAIL_CHUNK = 64 * 1024;

/** 解析一行 JSONL（容忍 CRLF、空行、崩溃半行） */
const parseEventLine = (raw: string): TaskEvent | null => {
  const text = raw.trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as TaskEvent;
  } catch {
    return null;
  }
};

/** 从 Buffer 行去 CR 再 parse（反向按字节扫 \n 时用） */
const parseEventLineBuf = (buf: Buffer): TaskEvent | null => {
  let s = buf;
  if (s.length > 0 && s[s.length - 1] === 0x0d) s = s.subarray(0, s.length - 1);
  return parseEventLine(s.toString("utf-8"));
};

/**
 * 全量读 events.jsonl（诊断包 / 真需要全量的路径）。
 * 长任务热点路径请用 readEventsTail / readEventsBefore。
 */
export const readEvents = async (id: string): Promise<TaskEvent[]> => {
  const p = path.join(taskDir(id), EVENTS_FILE);
  if (!(await exists(p))) return [];
  const raw = await fs.readFile(p, "utf-8");
  return raw
    .split(/\r?\n/)
    .map((line) => parseEventLine(line))
    .filter((x): x is TaskEvent => x !== null);
};

/**
 * 从文件尾按块反向读，只解析最后 n 条有效事件。
 * IO/解析量 ≈ O(n 条对应的字节)，不随文件总长线性增长。
 * hasMore = 文件里还有比返回结果更早的有效事件（多读到第 n+1 条才置 true）。
 */
export const readEventsTail = async (
  id: string,
  n: number,
): Promise<{ events: TaskEvent[]; hasMore: boolean }> => {
  const limit = Math.max(0, Math.min(Math.floor(n), MAX_EVENTS_TAIL));
  if (limit === 0) return { events: [], hasMore: false };

  const p = path.join(taskDir(id), EVENTS_FILE);
  if (!(await exists(p))) return { events: [], hasMore: false };

  const fh = await fs.open(p, "r");
  try {
    const { size } = await fh.stat();
    if (size === 0) return { events: [], hasMore: false };

    let pos = size;
    // 更靠文件尾一侧、尚未与更早块拼成「行首」的碎片（跨块行）
    let carry = Buffer.alloc(0);
    // collected[0] = 文件中最后一条有效事件（倒序）
    const collected: TaskEvent[] = [];

    while (pos > 0 && collected.length <= limit) {
      const toRead = Math.min(EVENTS_TAIL_CHUNK, pos);
      pos -= toRead;
      const buf = Buffer.allocUnsafe(toRead);
      const { bytesRead } = await fh.read(buf, 0, toRead, pos);
      const data = Buffer.concat([buf.subarray(0, bytesRead), carry]);

      // 按字节找 \n，再整行 decode——避免 UTF-8 多字节字符被块边界切断后乱码
      const linesFromRight: Buffer[] = [];
      let end = data.length;
      for (let i = data.length - 1; i >= 0; i--) {
        if (data[i] !== 0x0a) continue;
        linesFromRight.push(data.subarray(i + 1, end));
        end = i;
      }
      if (pos > 0) {
        carry = data.subarray(0, end);
      } else {
        carry = Buffer.alloc(0);
        if (end > 0) linesFromRight.push(data.subarray(0, end));
      }

      for (const lineBuf of linesFromRight) {
        const ev = parseEventLineBuf(lineBuf);
        if (!ev) continue; // 空行 / 崩溃半行 / 坏 JSON
        collected.push(ev);
        if (collected.length > limit) break;
      }
    }

    const hasMore = collected.length > limit;
    const events = collected.slice(0, limit).reverse();
    return { events, hasMore };
  } finally {
    await fh.close();
  }
};

/**
 * 流式向前扫：取 cursor（beforeId）之前紧邻的一页更早事件（时间正序）。
 * 只在内存里保留 page 大小的滑动窗口，找到锚点即停、不把整文件解析成数组。
 * 锚点不存在 → { events: [], hasMore: false }（与旧路由语义一致）。
 */
export const readEventsBefore = async (
  id: string,
  beforeId: string,
  limit: number,
): Promise<{ events: TaskEvent[]; hasMore: boolean }> => {
  const page = Math.max(0, Math.min(Math.floor(limit), MAX_EVENTS_PAGE));
  if (page === 0 || !beforeId) return { events: [], hasMore: false };

  const p = path.join(taskDir(id), EVENTS_FILE);
  if (!(await exists(p))) return { events: [], hasMore: false };

  const stream = createReadStream(p, { encoding: "utf-8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  const window: TaskEvent[] = [];
  let discarded = false;
  let found = false;

  try {
    for await (const line of rl) {
      const ev = parseEventLine(line);
      if (!ev) continue;
      if (ev.id === beforeId) {
        found = true;
        break;
      }
      window.push(ev);
      if (window.length > page) {
        window.shift();
        discarded = true;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  if (!found) return { events: [], hasMore: false };
  return { events: window, hasMore: discarded };
};

/**
 * per-task events.jsonl 追加串行队列。
 *
 * Node 文档明确：同一文件并发 appendFile 不安全；且 tool_result 单行常 >8KB，
 * 超过 POSIX O_APPEND 原子写保证（管道缓冲通常 4KB～PIPE_BUF）。同 task 的写源
 * 含 run 流 / 后台 post-check / ask notifier 等，必须按 taskId 串行化。
 * 挂 globalThis：与 withTaskLock 同因——Next.js dev 多 chunk 下 module-level Map 会分裂。
 */
const EVENT_APPEND_CHAINS_KEY = "__feAiFlowEventAppendChainsV1__";
const getEventAppendChains = (): Map<string, Promise<void>> => {
  const g = globalThis as unknown as Record<
    string,
    Map<string, Promise<void>> | undefined
  >;
  if (!g[EVENT_APPEND_CHAINS_KEY]) g[EVENT_APPEND_CHAINS_KEY] = new Map();
  return g[EVENT_APPEND_CHAINS_KEY]!;
};

/**
 * R28-5：per-task 进程内事件单调序号（与 append 链同挂 globalThis，防 chunk 分裂）。
 * 只在链内写行前发号，保证 seq 与磁盘 / publish 顺序一致。
 */
const EVENT_SEQ_COUNTERS_KEY = "__feAiFlowEventSeqCountersV1__";
const getEventSeqCounters = (): Map<string, number> => {
  const g = globalThis as unknown as Record<
    string,
    Map<string, number> | undefined
  >;
  if (!g[EVENT_SEQ_COUNTERS_KEY]) g[EVENT_SEQ_COUNTERS_KEY] = new Map();
  return g[EVENT_SEQ_COUNTERS_KEY]!;
};

/**
 * R29-6：从 events.jsonl 尾部恢复 last seq（读最后 ~64KB、倒扫首条带 seq 的事件）。
 * 文件不存在 / 无 seq → 0。仅在 per-task append 链内调用（天然串行）。
 */
const readMaxSeqFromDurableTail = async (taskId: string): Promise<number> => {
  const p = path.join(taskDir(taskId), EVENTS_FILE);
  try {
    const st = await fs.stat(p);
    if (st.size <= 0) return 0;
    const tailBytes = 64 * 1024;
    const start = Math.max(0, st.size - tailBytes);
    const fh = await fs.open(p, "r");
    try {
      const len = st.size - start;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, start);
      const text = buf.toString("utf-8");
      const lines = text.split("\n");
      // 非文件头起读时首行可能被截断，跳过
      const startIdx = start > 0 ? 1 : 0;
      for (let i = lines.length - 1; i >= startIdx; i--) {
        const line = lines[i]?.trim();
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as { seq?: unknown };
          if (typeof parsed.seq === "number" && Number.isFinite(parsed.seq)) {
            return parsed.seq;
          }
        } catch {
          // 坏行跳过
        }
      }
      return 0;
    } finally {
      await fh.close();
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
};

/**
 * R29-6：Map miss 时先从 durable 尾部灌入 counter，再发号。
 * 必须在 append 链内 await——恢复与发号同序、无并发。
 */
const ensureEventSeqCounter = async (taskId: string): Promise<void> => {
  const counters = getEventSeqCounters();
  if (counters.has(taskId)) return;
  const restored = await readMaxSeqFromDurableTail(taskId);
  // 链内串行：await 后仍 miss 才写入（防极端重复 ensure）
  if (!counters.has(taskId)) {
    counters.set(taskId, restored);
  }
};

/** R28-5：为 task 发下一个单调 seq（1-based）；调用前须 ensureEventSeqCounter */
const nextEventSeq = (taskId: string): number => {
  const counters = getEventSeqCounters();
  const n = (counters.get(taskId) ?? 0) + 1;
  counters.set(taskId, n);
  return n;
};

/**
 * R29-3：appendFile 失败（ENOENT）时回退刚发的号——同步链内无并发，
 * 仅当 counter 仍等于本次 seq 才回退，避免误伤后续成功写入。
 */
const rollbackEventSeq = (taskId: string, seq: number): void => {
  const counters = getEventSeqCounters();
  if (counters.get(taskId) !== seq) return;
  if (seq <= 1) counters.delete(taskId);
  else counters.set(taskId, seq - 1);
};

/**
 * R29-6：仅在 events 文件真删（deleteTask）时清 seq counter。
 * stop / cleanupChatTaskState 不再清——文件还在、counter 保持才单调。
 */
export const clearEventSeqCounter = (taskId: string): void => {
  getEventSeqCounters().delete(taskId);
};

/**
 * 实际 append（无串行）。
 * @returns true=已写入；false=ENOENT（任务目录已删、R27-7 透传给上层不 publish）
 */
const appendEventLineUnlocked = async (
  id: string,
  ev: TaskEvent,
): Promise<boolean> => {
  // 不再无条件 mkdir：审查发现与 deleteTask 竞态时会把已删目录「复活」。
  // 调用方约定目录已存在（createTask 先 writeMeta；appendEvent 先查 meta；boot recovery 已有 meta）。
  // 目录没了 = 任务已删 → ENOENT 返 false（R27-7：上层不构造成功、不 publish 幽灵事件）。
  try {
    await fs.appendFile(
      path.join(taskDir(id), EVENTS_FILE),
      JSON.stringify(ev) + "\n",
      "utf-8",
    );
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    throw err;
  }
};

/**
 * 追加一条事件行（按 taskId 串行）。
 * 链上单次写入失败会抛给调用方，但不中断后续写入（catch 后继续）。
 *
 * R28-5 OrderedEventCommit：写行成功后、链内同步调用 onCommitted（通常 = publish），
 * 再释放链——杜绝「A 写完等 meta touch、B 先 publish」的 SSE/磁盘反序。
 *
 * @param lease R26-5：可选；在 chain 回调内、appendFile 之前同步执行。
 *   false → 跳过写盘、返 false（堵死「检查通过后入队、B claim、队列才执行 A」）。
 * @param onCommitted R28-5：可选；写行成功且 failpoint 通过后、仍在链内同步调用。
 * @returns true=已 append；false=lease 拒写或 ENOENT（R27-7）
 */
export const appendEventLine = async (
  id: string,
  ev: TaskEvent,
  lease?: () => boolean,
  onCommitted?: (event: TaskEvent) => void,
): Promise<boolean> => {
  const chains = getEventAppendChains();
  const previous = chains.get(id) ?? Promise.resolve();
  // R26-5：lease 必须在 chain 内、appendFile 前同步验——入队后失主则拒写
  const run = async (): Promise<boolean> => {
    await failpoint("event.inQueue");
    // R29-3：lease 拒绝路径不发号（不烧号）；发号紧挨即将 appendFile
    if (lease && !lease()) return false;
    // R29-6：Map miss（stop 后 / 进程重启）→ 先从 durable 尾部恢复再发号
    await ensureEventSeqCounter(id);
    // R28-5 / R29-3：链内、lease 通过后发号——与写盘 / publish 同序
    ev.seq = nextEventSeq(id);
    // R27-7：ENOENT 透传 false——上层 appendEvent 返 null、write* 不 publish
    const ok = await appendEventLineUnlocked(id, ev);
    if (!ok) {
      // R29-3：未落盘——回退刚发的号，避免烧号空洞
      rollbackEventSeq(id, ev.seq);
      delete ev.seq;
      return false;
    }
    // R28-5：写行成功后、publish 前——矩阵可挂起证明 B 不能插队 publish
    await failpoint("event.beforePublish");
    // R29：onCommitted（通常 publish）抛错不得断 append 链——写盘已成功，吞错继续放链
    try {
      onCommitted?.(ev);
    } catch (err) {
      console.error(
        `[task-fs-core] onCommitted 抛错 task=${id} seq=${ev.seq}：`,
        err,
      );
    }
    return true;
  };
  // previous 失败也跑本次写（.then(run, run)）；本次失败仍抛给 await 方
  const next = previous.then(run, run);
  // 链尾永不 reject，避免一次失败毒死后续排队者
  const retained = next.then(
    () => undefined,
    () => undefined,
  );
  chains.set(id, retained);
  try {
    return await next;
  } finally {
    if (chains.get(id) === retained) {
      chains.delete(id);
    }
  }
};

/**
 * R28-3：同步读盘上 sessionAgentId（finalGuard 用、无 await 夹缝）。
 * 读失败 / 缺字段 → undefined。
 */
export const readSessionAgentIdSync = (taskId: string): string | undefined => {
  try {
    const raw = JSON.parse(
      readFileSync(path.join(taskDir(taskId), META_FILE), "utf-8"),
    ) as { sessionAgentId?: unknown };
    return typeof raw.sessionAgentId === "string"
      ? raw.sessionAgentId
      : undefined;
  } catch {
    return undefined;
  }
};

// ----------------- hydrate（meta → Task）-----------------

/** meta + 已读好的 events → Task（不 IO） */
export const assembleTask = (
  meta: TaskMetaV06,
  events: TaskEvent[],
): Task => ({
  id: meta.id,
  title: meta.title,
  mode: meta.mode,
  repoStatus: meta.repoStatus,
  runStatus: meta.runStatus,
  currentActionId: meta.currentActionId,
  actions: meta.actions,
  mrs: meta.mrs,
  gitBranches: meta.gitBranches,
  feishuTesterUserKeys: meta.feishuTesterUserKeys,
  repoPaths: meta.repoPaths,
  nonGitRepoPaths: meta.nonGitRepoPaths,
  readonlyRepoPaths: meta.readonlyRepoPaths,
  scriptRepoPaths: meta.scriptRepoPaths,
  repoBaseBranches: meta.repoBaseBranches,
  repoFeatureBranches: meta.repoFeatureBranches,
  repoTestBranches: meta.repoTestBranches,
  repoDevBranches: meta.repoDevBranches,
  repoBranchTemplates: meta.repoBranchTemplates,
  feishuStoryUrl: meta.feishuStoryUrl,
  contextDocs: meta.contextDocs,
  disabledMcpServers: meta.disabledMcpServers,
  isolateWorktree: meta.isolateWorktree,
  sessionAgentId: meta.sessionAgentId,
  // 计算字段（不落盘）：agent 实际工作目录——隔离 task = worktree cwd、否则 = 原仓库 cwd。
  // client 的「在 IDE 打开工作区 / 复制路径 / 预览」都要它、而 dataRoot 只有 server 知道
  workCwd: getTaskCwd(meta),
  // 计算字段（不落盘）：任务数据目录（artifact / workspace / 事件日志所在）——
  // client 的「打开任务文件夹」按钮用
  taskDirPath: taskDir(meta.id),
  removeSourceBranchOnMerge: meta.removeSourceBranchOnMerge,
  pinned: meta.pinned,
  createdAt: meta.createdAt,
  updatedAt: meta.updatedAt,
  model: meta.model,
  uiLayout: meta.uiLayout,
  events,
});

/**
 * meta → Task
 * - 读全量 events.jsonl + 每条 action 的 artifact、组合成完整 Task object
 */
export const hydrateTask = async (meta: TaskMetaV06): Promise<Task> => {
  const events = await readEvents(meta.id);
  return assembleTask(meta, events);
};

/**
 * meta → Task，只带尾部 n 条事件（长任务详情 / SSE bootstrap 用）。
 * eventsTruncated = hasMore（文件里还有更早事件）。
 */
export const hydrateTaskWithTailEvents = async (
  meta: TaskMetaV06,
  tail: number,
): Promise<Task> => {
  const { events, hasMore } = await readEventsTail(meta.id, tail);
  const task = assembleTask(meta, events);
  if (hasMore) task.eventsTruncated = true;
  return task;
};

/**
 * task summary（V0.5.3 引入、V0.6 调整字段）
 * 列表场景用、不读 events.jsonl / artifact 内容
 */
export const hydrateTaskSummary = (meta: TaskMetaV06): TaskSummary => {
  const lastAction = meta.actions[meta.actions.length - 1];
  return {
    id: meta.id,
    title: meta.title,
    mode: meta.mode,
    repoStatus: meta.repoStatus,
    runStatus: meta.runStatus,
    currentActionId: meta.currentActionId,
    mrs: meta.mrs,
    gitBranches: meta.gitBranches,
    feishuTesterUserKeys: meta.feishuTesterUserKeys,
    repoPaths: meta.repoPaths,
    feishuStoryUrl: meta.feishuStoryUrl,
    contextDocs: meta.contextDocs,
    disabledMcpServers: meta.disabledMcpServers,
    pinned: meta.pinned,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    model: meta.model,
    uiLayout: meta.uiLayout,
    actionCount: meta.actions.length,
    lastActionType: lastAction?.type,
    lastActionStatus: lastAction?.status,
  };
};
