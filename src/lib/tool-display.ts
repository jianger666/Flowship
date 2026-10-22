/**
 * 工具块展示：配对 / 折叠规则 / verb-group（对标 Grok Build P1）
 *
 * 折叠规则（照抄 docs/grok-build-portable-assets §4.1）：
 *   - read / grep / glob / list* / search*：默认折叠；连续 ≥1 个收成「读取了 N 个文件…」
 *   - shell（Execute）：默认折叠，摘要行显示可读命令；运行中展开直播输出，完成后收起
 *   - edit / write：默认可展开看 diff；摘要行 = filePath +N/−M（绝不 dump args JSON）
 *   - Execute/Edit 不参与 verb-group（与 GB verb_group_kind 排除一致）
 *
 * 只做 UI 渲染前合并，不动 events.jsonl。
 */

import { backgroundJobIdsInText } from "@/lib/background-subagents";
import { LIVE_OUTPUT_MAX_LINES, trimLiveOutput } from "@/lib/live-output-cap";
import { isMcpToolName } from "@/lib/mcp-tool-name";
import { isAbsolutePathLike } from "@/lib/path-utils";
import type { TaskEvent, ToolResultEventMeta } from "@/lib/types";
import { SCHEDULE_TOOL_NAME, scheduleToolSummary } from "@/lib/schedule";
import { WAIT_TOOL_NAME, waitToolSummary } from "@/lib/wait-display";

/** SSE ephemeral：不进 task.events / 不进持久 rows */
export const isEphemeralToolOutputDelta = (ev: TaskEvent): boolean =>
  ev.kind === "tool_output_delta" || ev.id.startsWith("ephemeral_tod_");

/**
 * 回合内某次工具失败（grep / shell 挂了、run 还在继续）。
 * 旧数据写成了 kind=error + meta.callId，会跟「整轮崩溃」抢同一张红卡和重试按钮。
 * 渲染层丢掉这些事件，只留 tool_result 配出来的工具行。
 */
export const isInTurnToolErrorEvent = (ev: TaskEvent): boolean =>
  ev.kind === "error" && typeof ev.meta?.callId === "string";

/** 待办条目（updateTodos / todo_write 等） */
export type TodoItem = {
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
};

const TODO_STATUS_SET = new Set<TodoItem["status"]>([
  "pending",
  "in_progress",
  "completed",
  "cancelled",
]);

/**
 * 是否待办清单类工具（大小写 / 下划线变体）。
 * 进专属卡 + 连续合并；不进 verb-group。
 */
export const isTodoTool = (name: string): boolean => {
  const n = name.toLowerCase().replace(/[-_\s]/g, "");
  return (
    n === "updatetodos" ||
    n === "todowrite" ||
    n === "writetodos" ||
    n === "todoupdate"
  );
};

/**
 * 归一化后的 status 键（小写、去掉 `-` `_` 空白）→ 内部枚举。
 * Cursor SDK 真实发的是驼峰 `inProgress`（pi / 其它来源可能是 `in_progress` / `in-progress`），
 * 以前只认 snake_case，「进行中」条目永远掉成 pending（空心圈）。`canceled`（美式拼写）一并兜住。
 */
const TODO_STATUS_BY_KEY: Record<string, TodoItem["status"]> = {
  pending: "pending",
  inprogress: "in_progress",
  completed: "completed",
  cancelled: "cancelled",
  canceled: "cancelled",
};

const normalizeTodoStatus = (v: unknown): TodoItem["status"] => {
  if (typeof v === "string") {
    const hit = TODO_STATUS_BY_KEY[v.toLowerCase().replace(/[-_\s]/g, "")];
    if (hit && TODO_STATUS_SET.has(hit)) return hit;
  }
  // 非法 / 缺失 → pending（容错，别整条丢）
  return "pending";
};

/** 单条 todo 对象 → TodoItem；非对象返 null */
const normalizeTodoItem = (raw: unknown): TodoItem | null => {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  // content 缺失时兜底 title / 空串，仍出条目（status 仍可读）
  let content = "";
  if (typeof obj.content === "string") content = obj.content;
  else if (typeof obj.title === "string") content = obj.title;
  return { content, status: normalizeTodoStatus(obj.status) };
};

/**
 * 残缺 / 截断 JSON：从 `"todos":[` 后抠完整 `{...}` 对象。
 * 抠不出完整条目 → null（调用方回退普通工具行）。
 */
const extractTodosFromPartialJson = (raw: string): TodoItem[] | null => {
  const m = raw.match(/"todos"\s*:\s*\[/);
  if (!m || m.index == null) return null;
  const slice = raw.slice(m.index + m[0].length);
  const items: TodoItem[] = [];
  let i = 0;
  while (i < slice.length) {
    while (i < slice.length && /[\s,]/.test(slice[i]!)) i += 1;
    if (i >= slice.length || slice[i] === "]") break;
    if (slice[i] !== "{") break; // 半截对象 / 非对象 → 停

    let depth = 0;
    let inStr = false;
    let esc = false;
    let j = i;
    for (; j < slice.length; j += 1) {
      const c = slice[j]!;
      if (inStr) {
        if (esc) {
          esc = false;
          continue;
        }
        if (c === "\\") {
          esc = true;
          continue;
        }
        if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') {
        inStr = true;
        continue;
      }
      if (c === "{") depth += 1;
      else if (c === "}") {
        depth -= 1;
        if (depth === 0) {
          j += 1;
          break;
        }
      }
    }
    // 括号未闭合 = 截断在对象中间，后面都不可信
    if (depth !== 0) break;

    try {
      const parsed: unknown = JSON.parse(slice.slice(i, j));
      const item = normalizeTodoItem(parsed);
      if (item) items.push(item);
    } catch {
      break;
    }
    i = j;
  }
  return items.length > 0 ? items : null;
};

/**
 * 解析 updateTodos 类工具的 args。
 * 容忍：JSON 字符串 / 已解析对象 / 截断前缀（尽量抠完整条目）。
 * 抠不出任何条目 → null（UI 回退 RegularToolBlockRow）。
 */
export const parseTodoToolArgs = (
  args: string | Record<string, unknown> | null | undefined,
): TodoItem[] | null => {
  if (args == null) return null;

  const fromTodosField = (todos: unknown): TodoItem[] | null => {
    if (!Array.isArray(todos) || todos.length === 0) return null;
    const items: TodoItem[] = [];
    for (const t of todos) {
      const item = normalizeTodoItem(t);
      if (item) items.push(item);
    }
    return items.length > 0 ? items : null;
  };

  if (typeof args === "object" && !Array.isArray(args)) {
    return fromTodosField(args.todos);
  }

  if (typeof args === "string") {
    const cleaned = args.replace(/…\(truncated \d+ chars\)$/, "").trim();
    if (!cleaned) return null;
    const parsed = parseToolArgsJson(cleaned);
    if (parsed) return fromTodosField(parsed.todos);
    // 截断 JSON：尽量抠已写完的完整 todo 对象
    return extractTodosFromPartialJson(cleaned);
  }

  return null;
};

/** 折叠行摘要：`N 项 · M 完成` */
export const todoListSummary = (todos: TodoItem[]): string => {
  const done = todos.filter((t) => t.status === "completed").length;
  return `${todos.length} 项 · ${done} 完成`;
};

/** GB verb_group：非破坏性读/搜类 */
export const isVerbGroupMember = (name: string): boolean => {
  const n = name.toLowerCase();
  // 待办专属卡 / 连续合并，绝不进 verb-group
  if (isTodoTool(name)) return false;
  if (isMcpToolName(n)) return false;
  if (
    n === "shell" ||
    n === "edit" ||
    n === "write" ||
    n === "delete" ||
    n === "delete_file"
  ) {
    return false;
  }
  // read / Read / readFile
  if (n === "read" || n.startsWith("read_") || n.includes("read_file")) {
    return true;
  }
  // listDir / LS / list_dir
  if (
    n === "ls" ||
    n === "listdir" ||
    n === "list_dir" ||
    n === "list" ||
    n.includes("list_dir") ||
    n.includes("listdir")
  ) {
    return true;
  }
  // grep / glob / search / SemanticSearch / web_*
  if (
    n === "grep" ||
    n === "glob" ||
    n === "search" ||
    n.includes("search") ||
    n.startsWith("web") ||
    n === "greptool" ||
    n === "globtool"
  ) {
    return true;
  }
  return false;
};

/** shell / edit / write / delete——破坏性或改盘类（verb-group 排除同源） */
export const isDestructiveOrShellTool = (name: string): boolean => {
  const n = name.toLowerCase();
  return (
    n === "shell" ||
    n === "edit" ||
    n === "write" ||
    n === "delete" ||
    n === "delete_file"
  );
};

/**
 * 工具块默认是否折叠（对标 GB DisplayMode::Collapsed）。
 * edit/write 默认展开看 diff；shell 与读/搜一律折叠。
 */
export const toolBlockDefaultCollapsed = (
  name: string,
  nested = false,
): boolean => {
  if (nested) return true;
  if (isVerbGroupMember(name)) return true;
  const n = name.toLowerCase();
  // edit/write：展开看 inline diff（GB collapsed_edit_blocks=OFF 同款）
  if (n === "edit" || n === "write") return false;
  // 待办清单本身就是要看的内容 → 默认展开
  if (isTodoTool(name)) return false;
  // shell 对齐 GB Execute=Collapsed；其余默认折叠
  return true;
};

/**
 * 渲染时实际折叠态。write 一完成就收起：产物已经在产物栏，展开区只是再铺路径，
 * 交卷前「处理中…」空等时尤其吵。用户点开仍以手动为准（调用方管）。
 * edit 仍默认展开看 diff。
 */
export const toolBlockAutoCollapsed = (
  name: string,
  status: ToolBlockStatus,
  nested = false,
): boolean => {
  if (name.toLowerCase() === "write" && status !== "running") return true;
  return toolBlockDefaultCollapsed(name, nested);
};

/** 剥 stringifyMeta 截断后缀后再 JSON.parse；失败返 null */
export const parseToolArgsJson = (
  args?: string,
): Record<string, unknown> | null => {
  if (!args?.trim()) return null;
  // truncate() 后缀形如 …(truncated 123 chars)
  const cleaned = args.replace(/…\(truncated \d+ chars\)$/, "").trim();
  try {
    const v: unknown = JSON.parse(cleaned);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
  } catch {
    // 非 JSON（历史脏数据）→ 调用方走兜底
  }
  return null;
};

/** Task 子代理工具 args（description + prompt） */
export type TaskToolArgs = {
  description: string | null;
  prompt: string | null;
  /** 子代理指定模型（args.model，未指定 = 跟随主线） */
  model: string | null;
  /** 子代理指定思考档（args.effort，未指定 = 沿用 / 模型默认） */
  effort: string | null;
};

/**
 * 单遍还原 JSON 字符串转义。必须单遍：逐个 replace 会把 `C:\\new`（原文 `\\` + `n`）
 * 里的 `\n` 先还原成换行，Windows 路径 / 命令就坏了。
 */
const unescapeJsonStringBody = (s: string): string =>
  s.replace(/\\(u[0-9a-fA-F]{4}|[\s\S])/g, (_m, esc: string) => {
    if (esc.length === 5) return String.fromCharCode(parseInt(esc.slice(1), 16));
    switch (esc) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "b":
        return "\b";
      case "f":
        return "\f";
      default:
        return esc; // `\"` `\\` `\/` → 后面那个字符本身
    }
  });

/**
 * 从残缺 JSON 流式前缀里抠 string 字段（键完整、值可能未闭合）。
 * `complete` = 值的结束引号也在前缀里（false = 值本身被截断了）。
 */
const extractPartialJsonStringFieldInfo = (
  raw: string,
  key: string,
): { value: string; complete: boolean } | null => {
  // "key": "value… 或 "key":"value…
  const re = new RegExp(
    `"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)("?)`,
    "s",
  );
  const m = raw.match(re);
  if (!m?.[1]) return null;
  const complete = m[2] === '"';
  // 残缺前缀不追求完备
  let value = unescapeJsonStringBody(m[1]);
  // 值被截断时，服务端 `truncate`（按 UTF-16 码元切）可能正好切开一个代理对（emoji）→ 尾部留一个孤立高位代理，
  // 渲染成「�」。丢掉那半个字符（R7-04）；值完整时不动（完整值里的孤立代理是原文就有的）
  if (!complete) value = value.replace(/[\uD800-\uDBFF]$/, "");
  const trimmed = value.trim();
  if (!trimmed) return null;
  return { value: trimmed, complete };
};

const extractPartialJsonStringField = (
  raw: string,
  key: string,
): string | null => extractPartialJsonStringFieldInfo(raw, key)?.value ?? null;

/** 落盘截断后缀：`…(truncated 123 chars)`（task-stream `truncate` 追加） */
const ARGS_TRUNCATED_SUFFIX_RE = /…\(truncated \d+ chars\)$/;

/**
 * 摘要行会读的 string 字段。args 被服务端截断后整段 JSON 必然 parse 不了，
 * 但 command / path 这类关键字段在前缀里——逐个抠出来，摘要照样可读（V4-01）。
 */
const LOOSE_ARG_KEYS = [
  "command",
  "cmd",
  "path",
  "target_file",
  "file_path",
  "filePath",
  "pattern",
  "regex",
  "query",
  "glob",
  "glob_pattern",
  // Cursor SDK / pi 桥实际发的是 camelCase（tool-call-types.d.ts），snake_case 只是历史写法，两种都认（V4-05）
  "globPattern",
  "target_directory",
  "targetDirectory",
  "file",
  "url",
] as const;

/**
 * 宽松解析工具 args：整段 JSON 能 parse 就用；被截断（或流式残缺）时退到从前缀抠
 * {@link LOOSE_ARG_KEYS} 里的 string 字段。抠不出任何字段 → parsed=null（调用方走旧兜底）。
 *
 * `fieldCut`：args 确实带截断后缀、且抠出来的某个字段值本身没收尾（= 用户看到的是半截命令 / 路径）。
 * 命令完整、只是后面的长字段被截掉时为 false，不误报。
 */
type LooseArgs = { parsed: Record<string, unknown> | null; fieldCut: boolean };

/**
 * 解析缓存（D5-03）：`toolBlockSummary` / `toolBlockDetailLine` / `toolBlockExpandedArgsPreview` /
 * `toolBlockArgsTruncatedHint` 渲染一行时各调一遍，args 被截断（edit / write / 长 shell 几乎必然）时每遍都要
 * 跑 18 个正则（一行 20µs → 57µs）。按「同一个 args 字符串」缓存：四个函数共用一次解析，
 * 同一行以后每次重渲染（滚动 / 展开 / 状态变）也不再重算。
 * 有界：条目数上限（LRU，Map 迭代序 = 插入序）+ 超长 args 不入缓存（病态输入照旧每次算、不占内存）。
 * 返回的对象是共享的——调用方只读（现有三处调用点都只取字段）。
 */
const LOOSE_ARGS_CACHE_LIMIT = 512;
const LOOSE_ARGS_CACHE_MAX_LEN = 8192;
const looseArgsCache = new Map<string, LooseArgs>();
let looseArgsHits = 0;
let looseArgsMisses = 0;

/** 诊断 / 测试用：解析缓存的命中统计与当前规模 */
export const toolArgsParseCacheStats = (): {
  hits: number;
  misses: number;
  size: number;
  limit: number;
} => ({
  hits: looseArgsHits,
  misses: looseArgsMisses,
  size: looseArgsCache.size,
  limit: LOOSE_ARGS_CACHE_LIMIT,
});

const parseToolArgsLoose = (args?: string): LooseArgs => {
  if (typeof args !== "string" || args.length > LOOSE_ARGS_CACHE_MAX_LEN) {
    return parseToolArgsLooseUncached(args);
  }
  const hit = looseArgsCache.get(args);
  if (hit) {
    looseArgsHits++;
    // 续命：挪到插入序末尾
    looseArgsCache.delete(args);
    looseArgsCache.set(args, hit);
    return hit;
  }
  looseArgsMisses++;
  const value = parseToolArgsLooseUncached(args);
  looseArgsCache.set(args, value);
  if (looseArgsCache.size > LOOSE_ARGS_CACHE_LIMIT) {
    const oldest = looseArgsCache.keys().next().value as string;
    looseArgsCache.delete(oldest);
  }
  return value;
};

const parseToolArgsLooseUncached = (
  args?: string,
): LooseArgs => {
  const full = parseToolArgsJson(args);
  if (full) return { parsed: full, fieldCut: false };
  if (!args?.trim()) return { parsed: null, fieldCut: false };
  const cleaned = args.replace(ARGS_TRUNCATED_SUFFIX_RE, "").trim();
  // 只处理「JSON 对象的残缺前缀」；其它脏数据保持旧兜底
  if (!cleaned.startsWith("{")) return { parsed: null, fieldCut: false };
  const out: Record<string, unknown> = {};
  let incomplete = false;
  for (const key of LOOSE_ARG_KEYS) {
    const hit = extractPartialJsonStringFieldInfo(cleaned, key);
    if (!hit) continue;
    out[key] = hit.value;
    if (!hit.complete) incomplete = true;
  }
  if (Object.keys(out).length === 0) return { parsed: null, fieldCut: false };
  return {
    parsed: out,
    fieldCut: incomplete && ARGS_TRUNCATED_SUFFIX_RE.test(args),
  };
};

/**
 * 解析 name=task 子代理工具的 args。
 * 容忍：JSON 字符串 / 已解析对象 / running 时残缺流式前缀。
 * 拿不到 description 且拿不到 prompt → 返 null（安全降级）。
 */
export const parseTaskToolArgs = (
  args: string | Record<string, unknown> | null | undefined,
): TaskToolArgs | null => {
  if (args == null) return null;

  let description: string | null = null;
  let prompt: string | null = null;
  let model: string | null = null;
  let effort: string | null = null;

  if (typeof args === "object" && !Array.isArray(args)) {
    const d = args.description;
    const p = args.prompt;
    const m = args.model;
    const e = args.effort;
    if (typeof d === "string" && d.trim()) description = d.trim();
    if (typeof p === "string" && p.trim()) prompt = p.trim();
    if (typeof m === "string" && m.trim()) model = m.trim();
    if (typeof e === "string" && e.trim()) effort = e.trim();
  } else if (typeof args === "string") {
    const cleaned = args.replace(/…\(truncated \d+ chars\)$/, "").trim();
    if (!cleaned) return null;
    const parsed = parseToolArgsJson(cleaned);
    if (parsed) {
      const d = parsed.description;
      const p = parsed.prompt;
      const m = parsed.model;
      const e = parsed.effort;
      if (typeof d === "string" && d.trim()) description = d.trim();
      if (typeof p === "string" && p.trim()) prompt = p.trim();
      if (typeof m === "string" && m.trim()) model = m.trim();
      if (typeof e === "string" && e.trim()) effort = e.trim();
    } else {
      // 残缺流式 JSON：尽量抠已写出的字段，抠不到就 null
      description = extractPartialJsonStringField(cleaned, "description");
      prompt = extractPartialJsonStringField(cleaned, "prompt");
      model = extractPartialJsonStringField(cleaned, "model");
      effort = extractPartialJsonStringField(cleaned, "effort");
    }
  } else {
    return null;
  }

  if (!description && !prompt) return null;
  return { description, prompt, model, effort };
};

const pickStr = (
  obj: Record<string, unknown>,
  keys: string[],
): string | undefined => {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
};

/** 单行截断（摘要行用）。上限只防巨型 args 进 DOM；真正裁切交给行上 CSS truncate，按容器宽度吃满。 */
const clipOneLine = (s: string, max = 500): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max)}…`;
};

/**
 * 展开区 shell 命令的显示上限。与服务端 shell args 的 truncate 上限同值
 * （sdk-message-handler `BIG_ARGS_TOOL_TRUNCATE_MAX`）——落盘里有多少就给用户看多少。
 */
const SHELL_DETAIL_CLIP_MAX = 4000;

export type ToolBlockStatus = "running" | "success" | "error" | "interrupted";

/** 配对后的单工具块（渲染层用） */
export type ToolBlock = {
  kind: "__tool_block__";
  id: string;
  callId: string;
  name: string;
  status: ToolBlockStatus;
  /** tool_call 原文摘要 */
  text: string;
  args?: string;
  result?: ToolResultEventMeta;
  ts: number;
  actionId?: string;
  /**
   * 已转后台、仍在跑（tool_call 本身已「完成」）。渲染层转圈用——不是工具状态，
   * status 仍是 success，不参与 coerceStaleRunningTools / 分组判定。两个来源：
   *  - shell：{@link markBackgroundRunningTools} 在会话 running 时按标记事件打上；
   *  - 子代理（task 卡）：{@link markBackgroundSubagentTools} 按服务端下发的「后台在跑清单」打上。
   */
  backgroundRunning?: boolean;
  /**
   * 行状态身份的覆盖值：只有「连续待办合并块」会带（= 首条待办的稳定身份）。
   * 合并块的 id / callId 跟随最新一条 call（key 与 loadFullOutput 都要最新的），但待办卡的折叠态、
   * React key 不能跟着每次 `todo_write` 换——见 {@link streamItemStableId}。
   */
  stableId?: string;
};

/** 连续非破坏性工具收成一行 */
export type ToolVerbGroup = {
  kind: "__tool_verb_group__";
  id: string;
  members: ToolBlock[];
  ts: number;
  actionId?: string;
  /**
   * 首个成员的稳定身份（{@link streamItemStableId}）。`id`（`verb_…`）对外不变，
   * 但工作过程组的 id / 存档 key 取它：单块 → 并成 verb 组时，组首成员的身份不能翻。
   */
  firstEventId?: string;
};

export type ToolDisplayItem = ToolBlock | ToolVerbGroup;

export type StreamRenderItem =
  | TaskEvent
  | ToolBlock
  | ToolVerbGroup;

export const isToolBlock = (it: StreamRenderItem): it is ToolBlock =>
  it.kind === "__tool_block__";

export const isToolVerbGroup = (it: StreamRenderItem): it is ToolVerbGroup =>
  it.kind === "__tool_verb_group__";

/**
 * 一行在整个流式 / 分页过程中不变的身份——React key、行视图状态存档 key、工作过程组 id 都用它
 * （R4-01 / R4-02 / V8-04，第三轮 review）。
 *
 *  - 工具块：`tool:${callId}`。call 事件自己的 id 与孤儿 `tool_result`（call 在上一页）的 id 是两个不同的值，
 *    但 callId 相同——分页补上上一页前后，同一个块的身份不变；
 *  - 连续待办合并块：取首条待办的身份（`stableId`），agent 每更新一次待办 id 都跟着最新 call，身份不动；
 *  - verb 组：首成员的身份（`firstEventId`）——读类工具连续完成时，单块并成 verb 组，组首的身份不翻；
 *  - 其余事件（思考 / info / 用户消息…）：事件 id。
 *
 * 注意不是「事件 id」：块 `id` 字段保持原义（call 事件 id，合并待办块取最新），别处按它找事件的逻辑不受影响。
 */
export const streamItemStableId = (it: StreamRenderItem): string => {
  if (it.kind === "__tool_verb_group__") {
    const g = it as ToolVerbGroup;
    return g.firstEventId ?? (g.members[0] ? streamItemStableId(g.members[0]) : g.id);
  }
  if (it.kind === "__tool_block__") {
    const b = it as ToolBlock;
    return b.stableId ?? `tool:${b.callId}`;
  }
  return it.id;
};

const getCallId = (ev: TaskEvent): string =>
  typeof ev.meta?.callId === "string" ? ev.meta.callId : "";

const getToolName = (ev: TaskEvent): string =>
  typeof ev.meta?.name === "string" ? ev.meta.name : "";

const getArgs = (ev: TaskEvent): string | undefined =>
  typeof ev.meta?.args === "string" ? ev.meta.args : undefined;

const asToolResultMeta = (
  meta: TaskEvent["meta"],
): ToolResultEventMeta | undefined => {
  if (!meta || typeof meta.callId !== "string" || typeof meta.name !== "string") {
    return undefined;
  }
  if (
    meta.status !== "success" &&
    meta.status !== "error" &&
    meta.status !== "interrupted"
  ) {
    return undefined;
  }
  if (typeof meta.output !== "string") return undefined;
  return meta as unknown as ToolResultEventMeta;
};

/** tool_result.status → 渲染块 status（interrupted 单独保留，不当 success） */
const toolResultStatusToBlock = (
  status: ToolResultEventMeta["status"],
): Exclude<ToolBlockStatus, "running"> => {
  if (status === "error") return "error";
  if (status === "interrupted") return "interrupted";
  return "success";
};

const toolCallToBlock = (
  ev: TaskEvent,
  result?: ToolResultEventMeta,
  resultTs?: number,
): ToolBlock => {
  const callId = getCallId(ev) || ev.id;
  const name = result?.name || getToolName(ev) || "tool";
  let status: ToolBlockStatus = "running";
  if (result) status = toolResultStatusToBlock(result.status);
  return {
    kind: "__tool_block__",
    id: ev.id,
    callId,
    name,
    status,
    text: ev.text,
    args: getArgs(ev),
    result,
    ts: resultTs ?? ev.ts,
    actionId: ev.actionId,
  };
};

/**
 * 块缓存（D5-01，第三轮 review）：同一条 tool_call 事件、同一个配对 result 事件 → 复用上一次产出的块对象。
 *
 * 为什么：这个函数每个新事件都重跑一遍全量事件，原先每次重建所有块对象，`memo(ToolBlockRow)` /
 * `memo(WorkGroupRow)` 在「事件追加」路径上一次都命不中（5000 事件追加 1 条，成员引用不变率 3.7%），
 * 展开的运行中尾组每个事件整组重渲（854 成员约 60ms render）。
 *
 * 安全性：键是事件对象（WeakMap，事件被回收缓存跟着走）；条目里存构造输入的快照（result 事件 / meta 引用、
 * text / ts / actionId / args / name / callId），任何一项变了（result 到场、事件被就地改）都重建，
 * 不会返回陈旧块。缓存里的块永远不被原地修改——下游（待办合并 / 后台标记 / 过期 running 兜底 / 重复 call 升级 args）
 * 一律克隆后再改。
 */
type CallBlockCacheEntry = {
  result: TaskEvent | undefined;
  resultMeta: ToolResultEventMeta | undefined;
  resultTs: number | undefined;
  text: string;
  ts: number;
  actionId: string | undefined;
  args: string | undefined;
  name: string;
  callId: string;
  block: ToolBlock;
};
const CALL_BLOCK_CACHE = new WeakMap<TaskEvent, CallBlockCacheEntry>();

const cachedCallBlock = (
  ev: TaskEvent,
  resultEv: TaskEvent | undefined,
  resultMeta: ToolResultEventMeta | undefined,
  useCache: boolean,
): ToolBlock => {
  const resultTs = resultEv?.ts;
  if (useCache) {
    const hit = CALL_BLOCK_CACHE.get(ev);
    if (
      hit &&
      hit.result === resultEv &&
      hit.resultMeta === resultMeta &&
      hit.resultTs === resultTs &&
      hit.text === ev.text &&
      hit.ts === ev.ts &&
      hit.actionId === ev.actionId &&
      hit.args === getArgs(ev) &&
      hit.name === getToolName(ev) &&
      hit.callId === getCallId(ev)
    ) {
      return hit.block;
    }
  }
  const block = toolCallToBlock(ev, resultMeta, resultTs);
  if (useCache) {
    CALL_BLOCK_CACHE.set(ev, {
      result: resultEv,
      resultMeta,
      resultTs,
      text: ev.text,
      ts: ev.ts,
      actionId: ev.actionId,
      args: getArgs(ev),
      name: getToolName(ev),
      callId: getCallId(ev),
      block,
    });
  }
  return block;
};

/** 孤儿 tool_result（call 在上一页）合成的块的缓存，规则同 {@link CALL_BLOCK_CACHE} */
type OrphanBlockCacheEntry = {
  meta: ToolResultEventMeta;
  text: string;
  ts: number;
  actionId: string | undefined;
  block: ToolBlock;
};
const ORPHAN_BLOCK_CACHE = new WeakMap<TaskEvent, OrphanBlockCacheEntry>();

const cachedOrphanResultBlock = (
  ev: TaskEvent,
  meta: ToolResultEventMeta,
  useCache: boolean,
): ToolBlock => {
  if (useCache) {
    const hit = ORPHAN_BLOCK_CACHE.get(ev);
    if (
      hit &&
      hit.meta === meta &&
      hit.text === ev.text &&
      hit.ts === ev.ts &&
      hit.actionId === ev.actionId
    ) {
      return hit.block;
    }
  }
  const block: ToolBlock = {
    kind: "__tool_block__",
    id: ev.id,
    callId: meta.callId,
    name: meta.name,
    status: toolResultStatusToBlock(meta.status),
    text: ev.text,
    result: meta,
    ts: ev.ts,
    actionId: ev.actionId,
  };
  if (useCache) {
    ORPHAN_BLOCK_CACHE.set(ev, {
      meta,
      text: ev.text,
      ts: ev.ts,
      actionId: ev.actionId,
      block,
    });
  }
  return block;
};

/**
 * 把 tool_call + tool_result 按 callId 配对，再对连续 verb-group 成员收组。
 * tool_result 单独出现（历史缺 running）→ 合成 completed 块。
 * tool_output_delta 应在进本函数前已滤掉。
 *
 * 历史双写兜底：同 callId 多条 tool_call 只出一块——args 取更长、id/ts 留第一条
 * （服务端新数据已修、已落盘历史仍可能双条，渲染层必须去重）。
 *
 * 块 / verb 组对象按输入缓存复用（见 {@link CALL_BLOCK_CACHE}）；`noCache` 仅给等价性测试对拍用。
 */
export const mergeToolDisplayEvents = (
  events: TaskEvent[],
  opts: { noCache?: boolean } = {},
): StreamRenderItem[] => {
  const useCache = !opts.noCache;
  const resultsByCallId = new Map<string, TaskEvent>();
  for (const ev of events) {
    if (ev.kind !== "tool_result") continue;
    const cid = getCallId(ev);
    if (cid) resultsByCallId.set(cid, ev);
  }

  const consumedResults = new Set<string>();
  const raw: StreamRenderItem[] = [];
  // callId → raw 里首次 tool_call 块下标（同 callId 后续只合并 args）
  const firstBlockIndexByCallId = new Map<string, number>();

  for (const ev of events) {
    if (isEphemeralToolOutputDelta(ev)) continue;
    // 历史双写：工具失败既落 kind=error 又落 tool_result。红卡是给整轮崩溃的，这里丢掉。
    if (isInTurnToolErrorEvent(ev)) continue;

    if (ev.kind === "tool_call") {
      const cid = getCallId(ev);

      // 同 callId 已有块：只升级更长的 args，不另 push（保持流位置 = 第一条）
      if (cid && firstBlockIndexByCallId.has(cid)) {
        const idx = firstBlockIndexByCallId.get(cid)!;
        const existing = raw[idx];
        if (isToolBlock(existing)) {
          const nextArgs = getArgs(ev);
          if ((nextArgs?.length ?? 0) > (existing.args?.length ?? 0)) {
            // 克隆再改：existing 可能是缓存里的块，原地改会污染下一次（只有第一条事件的）输入
            raw[idx] = { ...existing, args: nextArgs };
          }
        }
        const resultEv = resultsByCallId.get(cid);
        if (resultEv) consumedResults.add(resultEv.id);
        continue;
      }

      const resultEv = cid ? resultsByCallId.get(cid) : undefined;
      const resultMeta = resultEv
        ? asToolResultMeta(resultEv.meta)
        : undefined;
      if (resultEv) consumedResults.add(resultEv.id);
      if (cid) firstBlockIndexByCallId.set(cid, raw.length);
      raw.push(cachedCallBlock(ev, resultEv, resultMeta, useCache));
      continue;
    }

    if (ev.kind === "tool_result") {
      if (consumedResults.has(ev.id)) continue;
      const meta = asToolResultMeta(ev.meta);
      if (!meta) {
        raw.push(ev);
        continue;
      }
      raw.push(cachedOrphanResultBlock(ev, meta, useCache));
      continue;
    }

    raw.push(ev);
  }

  // 连续 updateTodos 只留最新（中间状态无回看价值）；再进 verb-group
  return groupVerbRuns(collapseConsecutiveTodoBlocks(raw, useCache), useCache);
};

/**
 * 后处理克隆缓存（D5-01）：下面几个「给块打标 / 改状态」的后处理每次都 `{ ...block, x }` 克隆，
 * 长期转圈的后台 shell / 子代理会让所在工作组每个事件都换引用。块对象本身是不可变的（见 CALL_BLOCK_CACHE），
 * 所以「同一个原块 → 同一个克隆」是安全的；原块被换掉（result 到场等）缓存自然落空。
 */
const INTERRUPTED_CLONES = new WeakMap<ToolBlock, ToolBlock>();
const BACKGROUND_CLONES = new WeakMap<ToolBlock, ToolBlock>();
const cloneOnce = (
  cache: WeakMap<ToolBlock, ToolBlock>,
  block: ToolBlock,
  patch: Partial<ToolBlock>,
): ToolBlock => {
  const hit = cache.get(block);
  if (hit) return hit;
  const next: ToolBlock = { ...block, ...patch };
  cache.set(block, next);
  return next;
};

/**
 * 渲染层兜底：会话已非 running 时，把仍挂 running 的工具块改成 interrupted。
 * 治历史脏数据（旧版 cancel 未补写 tool_result）；服务端已 finalize 的不受影响。
 */
export const coerceStaleRunningTools = (
  items: StreamRenderItem[],
): StreamRenderItem[] => {
  let changed = false;
  const mapBlock = (block: ToolBlock): ToolBlock => {
    if (block.status !== "running") return block;
    changed = true;
    return cloneOnce(INTERRUPTED_CLONES, block, { status: "interrupted" });
  };
  const out = items.map((it) => {
    if (isToolBlock(it)) return mapBlock(it);
    if (isToolVerbGroup(it)) {
      let groupChanged = false;
      const members = it.members.map((m) => {
        if (m.status !== "running") return m;
        groupChanged = true;
        return { ...m, status: "interrupted" as const };
      });
      if (!groupChanged) return it;
      changed = true;
      return { ...it, members };
    }
    return it;
  });
  return changed ? out : items;
};

/**
 * 给「已转后台、仍在跑」的 shell 块打 backgroundRunning（图标转圈用）。
 *
 * 调用方只在会话 running 时传非空集合——会话停了就不该转圈（进程可能还活着，
 * 但这一轮已经收尾，对用户来说没有「正在进行」的事）。
 * 只认 shell 块：标记是服务端按 shell 工具结果落的，别的工具名撞 callId 也不理。
 * 只给 `status === "success"` 的块打（与 {@link markBackgroundSubagentTools} 同口径）。
 * 没有命中的块保持原对象（引用稳定，下游 memo 不被无谓击穿）；全无命中返回原数组。
 */
export const markBackgroundRunningTools = (
  items: StreamRenderItem[],
  runningCallIds: ReadonlySet<string>,
): StreamRenderItem[] => {
  if (runningCallIds.size === 0) return items;
  let changed = false;
  const mapBlock = (block: ToolBlock): ToolBlock => {
    if (block.name.toLowerCase() !== "shell") return block;
    // 与子代理卡（markBackgroundSubagentTools）同口径：只有 success（= 起后台进程的那次调用已正常返回）才可能是「后台还在跑」。
    // running 本来就转圈；error / interrupted 的红叉 / 中断标不能被盖成转圈
    if (block.status !== "success") return block;
    if (!runningCallIds.has(block.callId)) return block;
    if (block.backgroundRunning) return block;
    changed = true;
    return cloneOnce(BACKGROUND_CLONES, block, { backgroundRunning: true });
  };
  const out = items.map((it) => {
    if (isToolBlock(it)) return mapBlock(it);
    if (isToolVerbGroup(it)) {
      let groupChanged = false;
      const members = it.members.map((m) => {
        const next = mapBlock(m);
        if (next !== m) groupChanged = true;
        return next;
      });
      return groupChanged ? { ...it, members } : it;
    }
    return it;
  });
  return changed ? out : items;
};

/**
 * 给「已转后台、仍在跑」的子代理卡（task 块）打 backgroundRunning（图标转圈用）。
 *
 * 现象（2026-10-19 用户截图）：主 AI 用 `run_in_background` 派子代理，`subagent` 工具调用立刻返回
 * 「已在后台启动…（后台任务 bg_xxxxxxxx）」→ 这张卡 status=success、亮绿勾，可子代理其实还在干活
 * （聊天框上方的条还写着「在后台工作」）；用户插话把前台子代理转后台时同理。
 *
 * 判定：卡片结果文本里带的后台任务 id 在 `runningJobIds`（服务端实时下发的后台在跑清单）里。
 *  - 不靠 callId：清单里没有 callId；也不靠「会话是否 running」——后台子代理常常在主 AI 说完之后才跑完，
 *    清单本身就是权威（跑完 / 取消 / 超时 / 应用重启都会从清单里消失，卡片随之回到完成态）；
 *  - 只认 task 块：只有 `subagent` 会写这种 id；别的工具名碰巧输出里带 `bg_xxxxxxxx` 也不理；
 *  - 只处理 success 的块（running 本来就转圈；error / interrupted 的标不能被盖掉）；
 *    没有命中的块保持原对象，全无命中返回原数组。
 */
export const markBackgroundSubagentTools = (
  items: StreamRenderItem[],
  runningJobIds: ReadonlySet<string>,
): StreamRenderItem[] => {
  if (runningJobIds.size === 0) return items;
  let changed = false;
  const out = items.map((it) => {
    if (!isToolBlock(it)) return it;
    if (it.name.toLowerCase() !== "task") return it;
    // 只有 success（= 派出去的那次调用已正常返回）才可能是「后台还在跑」：running 本来就转圈，
    // error / interrupted 的红叉 / 中断标不能被盖掉
    if (it.status !== "success" || it.backgroundRunning) return it;
    const ids = backgroundJobIdsInText(it.result?.output);
    if (!ids.some((id) => runningJobIds.has(id))) return it;
    changed = true;
    return cloneOnce(BACKGROUND_CLONES, it, { backgroundRunning: true });
  });
  return changed ? out : items;
};

/**
 * 连续多条待办工具块（中间无其它非 ephemeral 项）→ 只保留最新一条。
 * id / callId / ts 用最新（正文、直播输出、完整输出都要最新一条 call 的），
 * 但行**身份**用首条待办的（`stableId`）：agent 几乎每一步都更新待办，身份跟着最新 call 走的话，
 * 用户折叠过的待办卡每更新一次就自己弹开（R4-02），整行也跟着 remount。
 */
const collapseConsecutiveTodoBlocks = (
  items: StreamRenderItem[],
  useCache = true,
): StreamRenderItem[] => {
  const out: StreamRenderItem[] = [];
  for (const it of items) {
    if (isToolBlock(it) && isTodoTool(it.name)) {
      const prev = out[out.length - 1];
      if (prev && isToolBlock(prev) && isTodoTool(prev.name)) {
        out[out.length - 1] = withStableId(it, streamItemStableId(prev), useCache);
        continue;
      }
    }
    out.push(it);
  }
  return out;
};

/** 合并待办块 = 最新那块的克隆 + stableId；同一个最新块、同一个 stableId → 复用克隆（引用稳定，见 D5-01） */
const MERGED_TODO_CACHE = new WeakMap<
  ToolBlock,
  { stableId: string; block: ToolBlock }
>();
const withStableId = (
  latest: ToolBlock,
  stableId: string,
  useCache: boolean,
): ToolBlock => {
  if (useCache) {
    const hit = MERGED_TODO_CACHE.get(latest);
    if (hit && hit.stableId === stableId) return hit.block;
  }
  const block: ToolBlock = { ...latest, stableId };
  if (useCache) MERGED_TODO_CACHE.set(latest, { stableId, block });
  return block;
};

/** verb 组缓存：成员（按引用）逐个相同 → 复用上一次的组对象；键是组首块（D5-01） */
const VERB_GROUP_CACHE = new WeakMap<ToolBlock, ToolVerbGroup>();
const sameBlocks = (a: readonly ToolBlock[], b: readonly ToolBlock[]): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

const groupVerbRuns = (
  items: StreamRenderItem[],
  useCache = true,
): StreamRenderItem[] => {
  const out: StreamRenderItem[] = [];
  let buf: ToolBlock[] = [];

  const flush = () => {
    if (buf.length === 0) return;
    if (buf.length === 1) {
      out.push(buf[0]);
    } else {
      const hit = useCache ? VERB_GROUP_CACHE.get(buf[0]) : undefined;
      if (hit && sameBlocks(hit.members, buf)) {
        out.push(hit);
      } else {
        const group: ToolVerbGroup = {
          kind: "__tool_verb_group__",
          id: `verb_${buf[0].id}`,
          members: buf,
          ts: buf[buf.length - 1].ts,
          actionId: buf[0].actionId,
          // 首成员的稳定身份：工作过程组 id / verb 组存档 key 都取它（R4-01）
          firstEventId: streamItemStableId(buf[0]),
        };
        if (useCache) VERB_GROUP_CACHE.set(buf[0], group);
        out.push(group);
      }
    }
    buf = [];
  };

  for (const it of items) {
    if (
      isToolBlock(it) &&
      isVerbGroupMember(it.name) &&
      it.status !== "running"
    ) {
      // 同 actionId 才进同一组（跨 action 不混）
      if (
        buf.length > 0 &&
        buf[0].actionId !== it.actionId
      ) {
        flush();
      }
      buf.push(it);
      continue;
    }
    flush();
    out.push(it);
  }
  flush();
  return out;
};

/** unified diff 的逐行分类（见 walkUnifiedDiff） */
type DiffLineKind = "header" | "hunk" | "add" | "del" | "context";

/**
 * 干净 diff 视图的一行（对齐 Cursor IDE：双列行号 + 无文件头/@@ 原文）。
 * text 不含 +/- 前缀；hunk 仅作分隔标记，text 恒为空串。
 */
export type DiffViewLine = {
  kind: "add" | "del" | "context" | "hunk";
  /** 旧文件行号（add 行无） */
  oldLine?: number;
  /** 新文件行号（del 行无） */
  newLine?: number;
  /** 行内容（不含 +/- 前缀；hunk 行为空串） */
  text: string;
};

/** @@ -a,b +c,d @@ … —— 后面函数上下文忽略；b/d 可省略（默认 1） */
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * unified diff 逐行分类的唯一实现（countDiffStats / parseUnifiedDiff 共用，口径不会漂移）。
 *
 * 难点：文件头 `--- a/f` / `+++ b/f` 与「内容行」前缀撞车——被删的 `-- sql 注释`、markdown 的 `---`
 * 分隔线、被加的 `++i;` 在 diff 里分别是 `--- sql 注释` / `----` / `+++i;`，
 * 若一见 `---`/`+++` 前缀就当文件头跳过，这些真实增删行会被漏数、从视图里消失、后续行号还错位。
 * 所以**只在 hunk 正文之外**才认文件头：靠 `@@ -a,b +c,d @@` 的行数计数知道正文何时结束；
 * 计数对不上（截断 / 无 hunk 头）时，再用「`--- ` 后紧跟 `+++ ` 再跟 `@@`」的三行模式兜底识别下一个文件的头。
 * `diff --git` / `index ` 不带 +/-/空格前缀，任何位置都无歧义。
 *
 * visit 的第三个参数仅 hunk 行有值（合法 @@ 的正则匹配，残缺 @@ 为 null）。
 */
const walkUnifiedDiff = (
  diff: string,
  visit: (
    kind: DiffLineKind,
    raw: string,
    hunk: RegExpMatchArray | null,
  ) => void,
): void => {
  const rows = diff.split("\n");
  // 当前 hunk 正文还剩多少旧 / 新行没读（都为 0 = 不在 hunk 正文里）
  let oldRemain = 0;
  let newRemain = 0;

  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];

    // 文件头 / git 元信息：文件名已在 UI 标题展示，这里纯重复 → 跳过
    if (raw.startsWith("diff --git") || raw.startsWith("index ")) {
      oldRemain = 0;
      newRemain = 0;
      visit("header", raw, null);
      continue;
    }
    if (raw.startsWith("--- ") || raw.startsWith("+++ ")) {
      const inBody = oldRemain > 0 || newRemain > 0;
      const nextFileHeader =
        raw.startsWith("--- ") &&
        !!rows[i + 1]?.startsWith("+++ ") &&
        !!rows[i + 2]?.startsWith("@@");
      if (!inBody || nextFileHeader) {
        oldRemain = 0;
        newRemain = 0;
        visit("header", raw, null);
        continue;
      }
      // 在 hunk 正文里 → 它就是被删 / 被加的内容行，落到下面的 +/- 分支
    }

    if (raw.startsWith("@@")) {
      const m = raw.match(HUNK_HEADER_RE);
      // 行数省略 = 1；残缺 @@ → 不认正文计数
      oldRemain = m ? (m[2] === undefined ? 1 : Number(m[2])) : 0;
      newRemain = m ? (m[4] === undefined ? 1 : Number(m[4])) : 0;
      visit("hunk", raw, m);
      continue;
    }

    if (raw.startsWith("+")) {
      newRemain = Math.max(0, newRemain - 1);
      visit("add", raw, null);
    } else if (raw.startsWith("-")) {
      oldRemain = Math.max(0, oldRemain - 1);
      visit("del", raw, null);
    } else {
      // 合法上下文以空格开头（空串 = 被编辑器剥了尾空格的空上下文行）；其余（\ No newline…）不计数
      if (raw.startsWith(" ") || raw === "") {
        oldRemain = Math.max(0, oldRemain - 1);
        newRemain = Math.max(0, newRemain - 1);
      }
      visit("context", raw, null);
    }
  }
};

/** unified diff 统计 +N/-M */
export const countDiffStats = (
  diff: string,
): { added: number; removed: number } => {
  let added = 0;
  let removed = 0;
  walkUnifiedDiff(diff, (kind) => {
    if (kind === "add") added += 1;
    else if (kind === "del") removed += 1;
  });
  return { added, removed };
};

/**
 * 把 SDK unified diff 解析成可渲染行：剥文件头、递推行号、hunk 只留分隔标记。
 * 容错：非法行当 context（行号缺省、不递推）；空输入返 []。
 */
export const parseUnifiedDiff = (diff: string): DiffViewLine[] => {
  if (!diff) return [];

  const out: DiffViewLine[] = [];
  // 当前 hunk 内下一行应对齐的旧/新行号；尚未遇到合法 @@ 时为 undefined
  let oldLine: number | undefined;
  let newLine: number | undefined;

  walkUnifiedDiff(diff, (kind, raw, hunk) => {
    switch (kind) {
      case "header":
        return;
      case "hunk":
        if (hunk) {
          oldLine = Number(hunk[1]);
          newLine = Number(hunk[3]);
        } else {
          // 残缺 @@（截断尾部常见）→ 后续变更行不再瞎编行号
          oldLine = undefined;
          newLine = undefined;
        }
        out.push({ kind: "hunk", text: "" });
        return;
      case "add": {
        const entry: DiffViewLine = { kind: "add", text: raw.slice(1) };
        if (newLine !== undefined) {
          entry.newLine = newLine;
          newLine += 1;
        }
        out.push(entry);
        return;
      }
      case "del": {
        const entry: DiffViewLine = { kind: "del", text: raw.slice(1) };
        if (oldLine !== undefined) {
          entry.oldLine = oldLine;
          oldLine += 1;
        }
        out.push(entry);
        return;
      }
      case "context": {
        // 合法上下文以空格开头；其余（\ No newline…、截断残行等）当非法 → 行号缺省、不递推
        if (raw.startsWith(" ")) {
          const entry: DiffViewLine = { kind: "context", text: raw.slice(1) };
          if (oldLine !== undefined) {
            entry.oldLine = oldLine;
            oldLine += 1;
          }
          if (newLine !== undefined) {
            entry.newLine = newLine;
            newLine += 1;
          }
          out.push(entry);
          return;
        }
        out.push({ kind: "context", text: raw });
        return;
      }
    }
  });

  return out;
};

/**
 * 折叠摘要一行：人类可读，绝不 dump args JSON。
 *
 * 解析优先级：
 *   - edit/write：filePath +N/−M（diff 统计）
 *   - shell：`$ <command>`
 *   - read：文件路径
 *   - grep：pattern（+ path）
 *   - glob：glob pattern
 *   - 其它：从 args 抽 path/pattern；再不行用 result.output 首行 / block
 */
export const toolBlockSummary = (block: ToolBlock): string => {
  const n = block.name.toLowerCase();
  // 宽松解析：args 被服务端截断（>500 字符）后整段 JSON parse 不了，退到抠前缀字段（V4-01）
  const { parsed, fieldCut } = parseToolArgsLoose(block.args);
  const diff = block.result?.diff;
  const diffStats = diff ? countDiffStats(diff) : null;

  // 待办：N 项 · M 完成（专属卡折叠行同文案）
  if (isTodoTool(block.name)) {
    const todos = parseTodoToolArgs(block.args);
    if (todos) return todoListSummary(todos);
  }

  // wait：共 1m0s · 等 CI 跑完（没有可读入参时回落到下面的通用逻辑）
  if (n === WAIT_TOOL_NAME) {
    const waitSummary = waitToolSummary(block.args);
    if (waitSummary) return waitSummary;
  }

  // schedule：创建 · 30 分钟后 · 看 CI（解析不了入参时回落到通用逻辑）
  if (n === SCHEDULE_TOOL_NAME) {
    const scheduleSummary = scheduleToolSummary(block.args);
    if (scheduleSummary) return scheduleSummary;
  }

  // edit / write：路径 + 行统计
  if (n === "edit" || n === "write") {
    const path =
      block.result?.filePath ||
      (parsed
        ? pickStr(parsed, ["path", "target_file", "file_path", "filePath"])
        : undefined);
    if (path) {
      if (diffStats) return `${path} +${diffStats.added}/−${diffStats.removed}`;
      return path;
    }
  }

  // shell：可读命令
  if (n === "shell" && parsed) {
    const cmd = pickStr(parsed, ["command", "cmd"]);
    // 命令本体被截断：尾部补 …，别让半截命令读成完整命令
    if (cmd) return clipOneLine(`$ ${cmd}${fieldCut ? "…" : ""}`);
  }

  // read
  if (
    n === "read" ||
    n.startsWith("read_") ||
    n.includes("read_file")
  ) {
    const path =
      block.result?.filePath ||
      (parsed
        ? pickStr(parsed, ["path", "target_file", "file_path", "filePath"])
        : undefined);
    if (path) return clipOneLine(path);
  }

  // grep
  if (n === "grep" || n === "greptool" || n.includes("grep")) {
    if (parsed) {
      const pattern = pickStr(parsed, ["pattern", "regex", "query"]);
      const path = pickStr(parsed, [
        "path",
        "glob",
        "file",
        "target_directory",
        "targetDirectory",
      ]);
      if (pattern && path) return clipOneLine(`/${pattern}/ ${path}`);
      if (pattern) return clipOneLine(`/${pattern}/`);
      if (path) return clipOneLine(path);
    }
  }

  // glob / list
  if (
    n === "glob" ||
    n === "globtool" ||
    n === "ls" ||
    n === "listdir" ||
    n === "list_dir" ||
    n.includes("list_dir") ||
    n.includes("listdir")
  ) {
    if (parsed) {
      // globPattern / targetDirectory 是 SDK 与 pi 的真实形状（V4-05），snake_case 兼容老数据
      const pat = pickStr(parsed, [
        "globPattern",
        "glob_pattern",
        "glob",
        "pattern",
        "path",
        "targetDirectory",
        "target_directory",
      ]);
      if (pat) return clipOneLine(pat);
    }
  }

  // 通用：有 filePath 优先
  if (block.result?.filePath) return clipOneLine(block.result.filePath);

  // 通用 args 字段抽取（仍不 dump 整段 JSON）
  if (parsed) {
    const hint = pickStr(parsed, [
      "command",
      "cmd",
      "path",
      "target_file",
      "file_path",
      "filePath",
      "pattern",
      "globPattern",
      "glob_pattern",
      "glob",
      "query",
      "url",
    ]);
    if (hint) {
      const prefix = pickStr(parsed, ["command", "cmd"]) ? "$ " : "";
      return clipOneLine(`${prefix}${hint}${fieldCut ? "…" : ""}`);
    }
  }

  // args 非 JSON 时：若看起来像整段 JSON（以 { 开头）则丢掉，避免摘要行 dump
  if (block.args) {
    const flat = block.args.replace(/\s+/g, " ").trim();
    if (!flat.startsWith("{") && !flat.startsWith("[")) {
      return clipOneLine(flat);
    }
  }

  const out = block.result?.output?.trim();
  if (out) {
    const first = out.split("\n")[0] ?? out;
    return clipOneLine(first);
  }
  return block.text;
};

/**
 * 展开区「一层摘要」：可读命令/路径，不用 args JSON 原文。
 * 无可用字段时返 null（调用方不渲染该行）。
 */
export const toolBlockDetailLine = (block: ToolBlock): string | null => {
  // shell：展开就是为了看全命令，不套摘要行 500 字符的上限（服务端已放宽到 4000，能看到的就给全）
  if (block.name.toLowerCase() === "shell") {
    const { parsed, fieldCut } = parseToolArgsLoose(block.args);
    const cmd = parsed ? pickStr(parsed, ["command", "cmd"]) : undefined;
    if (cmd) {
      return clipOneLine(
        `$ ${cmd}${fieldCut ? "…" : ""}`,
        SHELL_DETAIL_CLIP_MAX,
      );
    }
  }
  const summary = toolBlockSummary(block);
  // text 若只是「调用 shell:{...}」这类带 JSON 的，不当作 detail
  if (!summary) return null;
  if (summary === block.text && /\{/.test(block.text)) return null;
  return summary;
};

/**
 * 展开区「参数被截断」提示：摘要读的那个字段（shell 的命令 / 路径等）本身只剩半截时返回文案，
 * 否则 null。命令完整、只是后面的长字段（write 的 content 等）被截掉不提示——那不影响用户看到的内容。
 */
export const toolBlockArgsTruncatedHint = (block: ToolBlock): string | null => {
  const { parsed, fieldCut } = parseToolArgsLoose(block.args);
  if (!parsed || !fieldCut) return null;
  return block.name.toLowerCase() === "shell"
    ? "命令过长已截断"
    : "参数过长已截断";
};

/**
 * 展开区 args 可读摘要：优先 detailLine；否则截断 args JSON 单行。
 * task 工具：description + prompt 前几行。无内容返 null（调用方走占位文案）。
 */
export const toolBlockExpandedArgsPreview = (
  block: ToolBlock,
): string | null => {
  // task 子代理：description + prompt 前几行（卡片有专属区，这里供通用兜底）
  if (block.name.toLowerCase() === "task") {
    const taskArgs = parseTaskToolArgs(block.args);
    if (taskArgs) {
      const bits: string[] = [];
      if (taskArgs.description) bits.push(taskArgs.description);
      if (taskArgs.prompt) {
        const preview = taskArgs.prompt
          .split("\n")
          .slice(0, 3)
          .join("\n")
          .trim();
        if (preview) bits.push(preview);
      }
      if (bits.length > 0) return bits.join("\n");
    }
  }

  const detail = toolBlockDetailLine(block);
  if (detail) return detail;

  if (block.args?.trim()) {
    return clipOneLine(block.args.replace(/\s+/g, " ").trim(), 160);
  }
  return null;
};

/** verb-group 成员的实际动作分类（文案按类计数、别把搜索也说成「读取文件」） */
export type VerbToolKind = "read" | "search" | "list" | "web" | "other";

/**
 * 工具名 → 动作分类。
 * 判定顺序有讲究：`web_search` 既 startsWith("web") 又 includes("search")、
 * 联网类先判、别被代码搜索桶吃掉。
 */
export const classifyVerbTool = (name: string): VerbToolKind => {
  const n = name.toLowerCase();
  // web_search / web_fetch / webSearch……
  if (n.startsWith("web")) return "web";
  if (n === "read" || n.startsWith("read_") || n.includes("read_file")) {
    return "read";
  }
  if (
    n === "ls" ||
    n === "list" ||
    n === "listdir" ||
    n === "list_dir" ||
    n.includes("list_dir") ||
    n.includes("listdir")
  ) {
    return "list";
  }
  if (
    n === "grep" ||
    n === "glob" ||
    n === "greptool" ||
    n === "globtool" ||
    n.includes("grep") ||
    n.includes("glob") ||
    n.includes("search")
  ) {
    return "search";
  }
  return "other";
};

/** 分类 → 计数文案；顺序即 label 里的拼接顺序 */
const VERB_KIND_LABEL: Array<[VerbToolKind, (n: number) => string]> = [
  ["read", (n) => `读取了 ${n} 个文件`],
  ["search", (n) => `搜索了 ${n} 次`],
  ["list", (n) => `列了 ${n} 个目录`],
  ["web", (n) => `联网查了 ${n} 次`],
  ["other", (n) => `其它 ${n} 次`],
];

/**
 * verb group 折叠行文案（对标 GB「Read N files」）。
 *
 * 按成员实际动作分类计数——组里混着 grep / glob / list / web_* 时不能一律说
 * 「读取了 N 个文件」（连搜 5 次显示「读取了 5 个文件」是错的）。
 * 多类时用 `·` 串起来：`读取了 3 个文件 · 搜索了 2 次`。
 */
export const verbGroupLabel = (group: ToolVerbGroup): string => {
  const counts = new Map<VerbToolKind, number>();
  for (const m of group.members) {
    const kind = classifyVerbTool(m.name);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const parts = VERB_KIND_LABEL.filter(([kind]) => counts.has(kind)).map(
    ([kind, format]) => format(counts.get(kind) ?? 0),
  );
  // 空组理论上进不来（groupVerbRuns 至少 2 个成员），兜底别渲出空串
  const base = parts.length > 0 ? parts.join(" · ") : "无操作";
  const failed = group.members.filter((m) => m.status === "error").length;
  return failed > 0 ? `${base}（${failed} 失败）` : `${base}…`;
};

/**
 * 指向「单个文件」的工具——路径可点跳 IDE。
 * grep / glob / list 的 path 是**目录**、跳过去会把 IDE 当前窗口的工作区换掉，不算。
 * delete 类也不算（文件已经没了、跳过去必报路径不存在）。
 */
const isSingleFileTool = (name: string): boolean => {
  const n = name.toLowerCase();
  return (
    n === "edit" ||
    n === "write" ||
    n === "read" ||
    n.startsWith("read_") ||
    n.includes("read_file")
  );
};

/**
 * 工具块指向的文件路径（渲染 IDE 跳转链接用）；拿不到返 null。
 *
 * - `result.filePath`（edit / write 落盘时由 tool-result-persist 带上）优先
 * - 否则单文件工具从 args 抽 path 类字段（read 的 `path` 等）
 * - shell / 待办 / 子代理 / 目录类工具一律 null
 */
export const toolBlockFilePath = (block: ToolBlock): string | null => {
  const fromResult = block.result?.filePath?.trim();
  if (fromResult) return fromResult;
  if (!isSingleFileTool(block.name)) return null;
  const parsed = parseToolArgsJson(block.args);
  if (!parsed) return null;
  return (
    pickStr(parsed, ["path", "target_file", "file_path", "filePath"]) ?? null
  );
};

/**
 * 展开区 detail 行里「属于文件路径」的那一段（渲染成可点链接的部分）；不是路径行返 null。
 *
 * 两种命中：
 * - detail 以完整路径打头：read = 路径本身、edit = `路径 +N/−M`
 * - 路径超长被 `toolBlockSummary` 的 clipOneLine 截成「前缀 + …」——此时
 *   startsWith 不成立（实测业务仓路径动辄 150+ 字），单独认一次「detail 是路径前缀」
 *
 * shell 的 `$ cmd`、args JSON 兜底等一律返 null（调用方渲染纯文本）。
 */
export const toolDetailPathSegment = (
  detailLine: string | null,
  filePath: string | null,
): string | null => {
  if (!detailLine || !filePath) return null;
  if (detailLine.startsWith(filePath)) return filePath;
  const clipped = detailLine.replace(/…$/, "");
  return clipped.length > 0 && filePath.startsWith(clipped) ? detailLine : null;
};

/**
 * 这个路径要不要 baseDir 才拼得出绝对路径（= 相对路径）。
 * 渲染层据此决定「要不要去查 task 的 cwd」——实测 SDK 给的基本都是绝对路径、
 * 绝大多数块直接能拼链接、不该为它们白发一次任务详情请求。
 */
export const toolPathNeedsBaseDir = (pathLike: string): boolean => {
  if (!pathLike) return false;
  // http:// / cursor:// 之类：给什么 baseDir 都跳不了
  if (/^[a-z]+:\/\//i.test(pathLike)) return false;
  return !isAbsolutePathLike(pathLike);
};

/**
 * 「加载完整输出」后，输出框要不要滚到底（U3a-06 尾巴）。
 *
 * 只有 shell：服务端对它存的预览是「头 + 尾」（命令的报错 / 汇总都在末尾，见 tool-result-persist 的
 * `previewModeFor`），用户点「加载完整输出」想看的正是尾巴——不滚的话 `<pre>` 停在最顶、
 * 得自己手动拖到底。read / grep 等是「头部」预览，要看的是文件 / 结果的开头，滚到底反而丢上下文。
 * 口径与服务端一致：按工具名 shell 判。
 */
export const shouldScrollFullOutputToEnd = (block: Pick<ToolBlock, "name">): boolean =>
  block.name.toLowerCase() === "shell";

/**
 * 输出框要不要滚到底：shell（见上）且「内容是头 + 尾的截断预览」或「已加载完整输出」（R7-05）。
 * 预览被截断（`result.truncated`）时报错 / 汇总在尾部，用户展开就是为了看它，不该先滚过 2KB 噪声头；
 * 没截断的短输出没有滚动条、写 scrollTop 也无害，但不必白写。运行中（没有 result，直播框）不滚。
 */
export const shouldScrollOutputToEnd = (
  block: Pick<ToolBlock, "name" | "result">,
  hasFullText: boolean,
): boolean =>
  shouldScrollFullOutputToEnd(block) &&
  (hasFullText || block.result?.truncated === true);

/** 从 tool_output_delta 抽 callId + chunk */
export const parseToolOutputDelta = (
  ev: TaskEvent,
): { callId: string; chunk: string } | null => {
  if (!isEphemeralToolOutputDelta(ev)) return null;
  const callId =
    typeof ev.meta?.callId === "string" ? ev.meta.callId : "";
  const chunk = typeof ev.meta?.chunk === "string" ? ev.meta.chunk : "";
  if (!callId || !chunk) return null;
  return { callId, chunk };
};

/**
 * 实时输出保留尾部 N 行（默认 20）**且不超过 8192 字符**，`\r` 也算换行（R7-02，实现见 lib/live-output-cap）。
 * 名字沿用旧的（调用方不改），语义是「行数 + 字符数」双封顶。
 */
export const trimLiveOutputLines = (
  text: string,
  maxLines = LIVE_OUTPUT_MAX_LINES,
): string => trimLiveOutput(text, maxLines);
