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

import type { TaskEvent, ToolResultEventMeta } from "@/lib/types";

/** SSE ephemeral：不进 task.events / 不进持久 rows */
export const isEphemeralToolOutputDelta = (ev: TaskEvent): boolean =>
  ev.kind === "tool_output_delta" || ev.id.startsWith("ephemeral_tod_");

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

const normalizeTodoStatus = (v: unknown): TodoItem["status"] => {
  if (typeof v === "string" && TODO_STATUS_SET.has(v as TodoItem["status"])) {
    return v as TodoItem["status"];
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
  if (n.startsWith("mcp:")) return false;
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
};

/** 从残缺 JSON 流式前缀里抠 string 字段（键完整、值可能未闭合） */
const extractPartialJsonStringField = (
  raw: string,
  key: string,
): string | null => {
  // "key": "value… 或 "key":"value…
  const re = new RegExp(
    `"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"?`,
    "s",
  );
  const m = raw.match(re);
  if (!m?.[1]) return null;
  // 反解常见转义，残缺前缀不追求完备
  const unescaped = m[1]
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
  const trimmed = unescaped.trim();
  return trimmed || null;
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

  if (typeof args === "object" && !Array.isArray(args)) {
    const d = args.description;
    const p = args.prompt;
    const m = args.model;
    if (typeof d === "string" && d.trim()) description = d.trim();
    if (typeof p === "string" && p.trim()) prompt = p.trim();
    if (typeof m === "string" && m.trim()) model = m.trim();
  } else if (typeof args === "string") {
    const cleaned = args.replace(/…\(truncated \d+ chars\)$/, "").trim();
    if (!cleaned) return null;
    const parsed = parseToolArgsJson(cleaned);
    if (parsed) {
      const d = parsed.description;
      const p = parsed.prompt;
      const m = parsed.model;
      if (typeof d === "string" && d.trim()) description = d.trim();
      if (typeof p === "string" && p.trim()) prompt = p.trim();
      if (typeof m === "string" && m.trim()) model = m.trim();
    } else {
      // 残缺流式 JSON：尽量抠已写出的字段，抠不到就 null
      description = extractPartialJsonStringField(cleaned, "description");
      prompt = extractPartialJsonStringField(cleaned, "prompt");
      model = extractPartialJsonStringField(cleaned, "model");
    }
  } else {
    return null;
  }

  if (!description && !prompt) return null;
  return { description, prompt, model };
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

/** 单行截断（摘要行用） */
const clipOneLine = (s: string, max = 120): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max)}…`;
};

export type ToolBlockStatus = "running" | "success" | "error";

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
};

/** 连续非破坏性工具收成一行 */
export type ToolVerbGroup = {
  kind: "__tool_verb_group__";
  id: string;
  members: ToolBlock[];
  ts: number;
  actionId?: string;
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
  if (meta.status !== "success" && meta.status !== "error") return undefined;
  if (typeof meta.output !== "string") return undefined;
  return meta as unknown as ToolResultEventMeta;
};

const toolCallToBlock = (
  ev: TaskEvent,
  result?: ToolResultEventMeta,
  resultTs?: number,
): ToolBlock => {
  const callId = getCallId(ev) || ev.id;
  const name = result?.name || getToolName(ev) || "tool";
  let status: ToolBlockStatus = "running";
  if (result) status = result.status === "error" ? "error" : "success";
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
 * 把 tool_call + tool_result 按 callId 配对，再对连续 verb-group 成员收组。
 * tool_result 单独出现（历史缺 running）→ 合成 completed 块。
 * tool_output_delta 应在进本函数前已滤掉。
 *
 * 历史双写兜底：同 callId 多条 tool_call 只出一块——args 取更长、id/ts 留第一条
 * （服务端新数据已修、已落盘历史仍可能双条，渲染层必须去重）。
 */
export const mergeToolDisplayEvents = (
  events: TaskEvent[],
): StreamRenderItem[] => {
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

    if (ev.kind === "tool_call") {
      const cid = getCallId(ev);

      // 同 callId 已有块：只升级更长的 args，不另 push（保持流位置 = 第一条）
      if (cid && firstBlockIndexByCallId.has(cid)) {
        const idx = firstBlockIndexByCallId.get(cid)!;
        const existing = raw[idx];
        if (isToolBlock(existing)) {
          const nextArgs = getArgs(ev);
          if ((nextArgs?.length ?? 0) > (existing.args?.length ?? 0)) {
            existing.args = nextArgs;
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
      raw.push(toolCallToBlock(ev, resultMeta, resultEv?.ts));
      continue;
    }

    if (ev.kind === "tool_result") {
      if (consumedResults.has(ev.id)) continue;
      const meta = asToolResultMeta(ev.meta);
      if (!meta) {
        raw.push(ev);
        continue;
      }
      raw.push({
        kind: "__tool_block__",
        id: ev.id,
        callId: meta.callId,
        name: meta.name,
        status: meta.status === "error" ? "error" : "success",
        text: ev.text,
        result: meta,
        ts: ev.ts,
        actionId: ev.actionId,
      });
      continue;
    }

    raw.push(ev);
  }

  // 连续 updateTodos 只留最新（中间状态无回看价值）；再进 verb-group
  return groupVerbRuns(collapseConsecutiveTodoBlocks(raw));
};

/**
 * 连续多条待办工具块（中间无其它非 ephemeral 项）→ 只保留最新一条。
 * id/ts 用最新，虚拟列表 key 跟随最新 call。
 */
const collapseConsecutiveTodoBlocks = (
  items: StreamRenderItem[],
): StreamRenderItem[] => {
  const out: StreamRenderItem[] = [];
  for (const it of items) {
    if (isToolBlock(it) && isTodoTool(it.name)) {
      const prev = out[out.length - 1];
      if (prev && isToolBlock(prev) && isTodoTool(prev.name)) {
        out[out.length - 1] = it;
        continue;
      }
    }
    out.push(it);
  }
  return out;
};

const groupVerbRuns = (items: StreamRenderItem[]): StreamRenderItem[] => {
  const out: StreamRenderItem[] = [];
  let buf: ToolBlock[] = [];

  const flush = () => {
    if (buf.length === 0) return;
    if (buf.length === 1) {
      out.push(buf[0]);
    } else {
      out.push({
        kind: "__tool_verb_group__",
        id: `verb_${buf[0].id}`,
        members: buf,
        ts: buf[buf.length - 1].ts,
        actionId: buf[0].actionId,
      });
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

/** unified diff 统计 +N/-M */
export const countDiffStats = (
  diff: string,
): { added: number; removed: number } => {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
};

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
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

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

  for (const raw of diff.split("\n")) {
    // 文件头 / git 元信息：文件名已在 UI 标题展示，这里纯重复 → 跳过
    if (
      raw.startsWith("--- ") ||
      raw.startsWith("+++ ") ||
      raw.startsWith("diff --git") ||
      raw.startsWith("index ")
    ) {
      continue;
    }

    if (raw.startsWith("@@")) {
      const m = raw.match(HUNK_HEADER_RE);
      if (m) {
        oldLine = Number(m[1]);
        newLine = Number(m[2]);
      } else {
        // 残缺 @@（截断尾部常见）→ 后续变更行不再瞎编行号
        oldLine = undefined;
        newLine = undefined;
      }
      out.push({ kind: "hunk", text: "" });
      continue;
    }

    if (raw.startsWith("+")) {
      const entry: DiffViewLine = { kind: "add", text: raw.slice(1) };
      if (newLine !== undefined) {
        entry.newLine = newLine;
        newLine += 1;
      }
      out.push(entry);
      continue;
    }

    if (raw.startsWith("-")) {
      const entry: DiffViewLine = { kind: "del", text: raw.slice(1) };
      if (oldLine !== undefined) {
        entry.oldLine = oldLine;
        oldLine += 1;
      }
      out.push(entry);
      continue;
    }

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
      continue;
    }

    out.push({ kind: "context", text: raw });
  }

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
  const parsed = parseToolArgsJson(block.args);
  const diff = block.result?.diff;
  const diffStats = diff ? countDiffStats(diff) : null;

  // 待办：N 项 · M 完成（专属卡折叠行同文案）
  if (isTodoTool(block.name)) {
    const todos = parseTodoToolArgs(block.args);
    if (todos) return todoListSummary(todos);
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
    if (cmd) return clipOneLine(`$ ${cmd}`);
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
      const path = pickStr(parsed, ["path", "glob", "file", "target_directory"]);
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
      const pat = pickStr(parsed, [
        "glob_pattern",
        "glob",
        "pattern",
        "path",
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
      "glob_pattern",
      "glob",
      "query",
      "url",
    ]);
    if (hint) {
      const prefix = pickStr(parsed, ["command", "cmd"]) ? "$ " : "";
      return clipOneLine(`${prefix}${hint}`);
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
  const summary = toolBlockSummary(block);
  // text 若只是「调用 shell:{...}」这类带 JSON 的，不当作 detail
  if (!summary) return null;
  if (summary === block.text && /\{/.test(block.text)) return null;
  return summary;
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

/** verb group 文案（对标 GB「Read N files」） */
export const verbGroupLabel = (group: ToolVerbGroup): string => {
  const n = group.members.length;
  const failed = group.members.filter((m) => m.status === "error").length;
  const base = `读取了 ${n} 个文件`;
  return failed > 0 ? `${base}（${failed} 失败）` : `${base}…`;
};

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

/** 实时输出保留尾部 N 行 */
export const trimLiveOutputLines = (text: string, maxLines = 20): string => {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return lines.slice(-maxLines).join("\n");
};
