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

/** GB verb_group：非破坏性读/搜类 */
export const isVerbGroupMember = (name: string): boolean => {
  const n = name.toLowerCase();
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

  if (typeof args === "object" && !Array.isArray(args)) {
    const d = args.description;
    const p = args.prompt;
    if (typeof d === "string" && d.trim()) description = d.trim();
    if (typeof p === "string" && p.trim()) prompt = p.trim();
  } else if (typeof args === "string") {
    const cleaned = args.replace(/…\(truncated \d+ chars\)$/, "").trim();
    if (!cleaned) return null;
    const parsed = parseToolArgsJson(cleaned);
    if (parsed) {
      const d = parsed.description;
      const p = parsed.prompt;
      if (typeof d === "string" && d.trim()) description = d.trim();
      if (typeof p === "string" && p.trim()) prompt = p.trim();
    } else {
      // 残缺流式 JSON：尽量抠已写出的字段，抠不到就 null
      description = extractPartialJsonStringField(cleaned, "description");
      prompt = extractPartialJsonStringField(cleaned, "prompt");
    }
  } else {
    return null;
  }

  if (!description && !prompt) return null;
  return { description, prompt };
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

  for (const ev of events) {
    if (isEphemeralToolOutputDelta(ev)) continue;

    if (ev.kind === "tool_call") {
      const cid = getCallId(ev);
      const resultEv = cid ? resultsByCallId.get(cid) : undefined;
      const resultMeta = resultEv
        ? asToolResultMeta(resultEv.meta)
        : undefined;
      if (resultEv) consumedResults.add(resultEv.id);
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

  return groupVerbRuns(raw);
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
