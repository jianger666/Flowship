/**
 * 工具回包进模型预算（D1 wrapper 层、V2 落盘）
 *
 * 背景：`tool-result-persist.ts` 的 8KB 只管事件落盘/展示——`emitToolResult` 是
 * 模型已经看到全量之后才截断存盘。所以黑天鹅要在 `execute` 返回前砍，
 * 模型先看到截断版。事件落盘链一个字不动。
 *
 * 归因（已核实）：
 *   - shell：收集上限 10MB，全量进模型——真黑洞，必包。
 *   - task（子 agent 全量回包）、MCP 桥接工具：无上限，必包。
 *   - pi 原生 grep/read：自带 50KB/2000 行 truncate，进模型上限实际是 50KB。
 *     照样包一层（grep 用 32KB 再收紧；read 给 64KB——pi 的 50KB 之下恒为
 *     no-op，留作语义声明 + pi 将来放宽的上保险）。
 *   - glob 500 条、edit/write/delete 输出小，包上无害、统一口径。
 *   - flowShipTools（submit_work/ask_user）输出小，不碰。
 *
 * V2 落盘（对齐 Claude Code 的 working-file 思路）：
 * 超预算时把**真实全量**写到 `tool-outputs/<callId>.txt`（与 UI「查看完整输出」
 * 同一个文件，复用 200 文件 / 50MB 配额），模型看到的是「前 32K 预览 + 落盘
 * 绝对路径 + read offset/limit / grep 取全文指引」——AI 永远有办法拿到全文，
 * 不用靠「换姿势重跑」碰运气。`execute` 返回前 await 落盘，后到的
 * buildToolResultMeta 直接复用该文件、不覆盖（覆盖会把全文洗成截断版）。
 * 无 taskId（oneshot / 落盘失败）时降级 V1 后缀（缩小范围重取）。
 */

import {
  registerModelSpillResult,
  spillModelFullOutput,
  truncateToLimit,
} from "./tool-result-persist";

/** 默认预算 32KB（shell/grep/task/MCP/其它） */
export const MODEL_OUTPUT_DEFAULT_BUDGET = 32 * 1024;
/** read 单独 64KB（看代码要上下文） */
export const MODEL_OUTPUT_READ_BUDGET = 64 * 1024;

export const budgetForTool = (toolName: string): number =>
  toolName === "read" ? MODEL_OUTPUT_READ_BUDGET : MODEL_OUTPUT_DEFAULT_BUDGET;

/** withModelBudget 的落盘配置：有 taskId 才落（oneshot / 只读无 task 上下文走 V1 后缀） */
export type ModelBudgetSpill = {
  taskId: string;
  /**
   * 子 agent 内层会话的文件名前缀（如 "sub-"）：父子会话 callId 都是随机串、
   * 理论上不会撞，加上前缀是零成本保险——内层落盘只给模型读，不进事件 meta。
   */
  filePrefix?: string;
};

const fmtBytes = (n: number): string => {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
};

const hintForTool = (toolName: string): string => {
  if (toolName === "shell") {
    return "shell→加 head/grep 缩小范围，或重定向到文件再用 read offset/limit 分页读";
  }
  if (toolName === "grep") {
    return "grep→缩小 pattern/path，加 glob 过滤";
  }
  if (toolName === "read") {
    return "read→用 offset/limit 分页读";
  }
  return "缩小参数范围重取";
};

export type TruncatedModelOutput = {
  text: string;
  truncated: boolean;
  originalBytes: number;
  givenBytes: number;
};

/**
 * 纯函数：超预算则截断 + 拼指引后缀。
 * 主体截断复用事件落盘同款 `truncateToLimit`（code-point 边界、后缀计入配额），
 * 中文不会被拦腰砍；指引后缀挂在配额之外（约 150～300B、可观测性优先）。
 * spillAbsPath 有值 → 后缀给落盘路径 + read/grep 取全文指引（V2）；
 * 无值 → 老缩小范围指引（V1 降级）。
 */
export const truncateModelOutput = (
  text: string,
  toolName: string,
  budget: number = budgetForTool(toolName),
  spillAbsPath?: string,
): TruncatedModelOutput => {
  const originalBytes = Buffer.byteLength(text, "utf-8");
  if (originalBytes <= budget) {
    return { text, truncated: false, originalBytes, givenBytes: originalBytes };
  }
  const body = truncateToLimit(text, budget);
  const tail = spillAbsPath
    ? `完整全文已落盘到 ${spillAbsPath}，用 read offset/limit 分页读全，或 grep 搜关键词定位`
    : hintForTool(toolName);
  const out =
    `${body}\n…(模型输入已截断：原文 ${fmtBytes(originalBytes)}，` +
    `本次只给前 ${fmtBytes(Buffer.byteLength(body, "utf-8"))}。${tail})`;
  return {
    text: out,
    truncated: true,
    originalBytes,
    givenBytes: Buffer.byteLength(out, "utf-8"),
  };
};

type TextPart = { type: string; text?: unknown; [k: string]: unknown };
type ExecuteResultLike = {
  content?: unknown;
  [k: string]: unknown;
};

/**
 * 包一层 ToolDefinition：在 `execute` 返回后、进模型前截断 text 内容。
 * 只动 content 里 type=text 的 part（image 等原样），details/usage 等一律保留。
 * 形状未知（string / 无 content）→ 直接放行，绝不炸。
 *
 * V2：有 spill.taskId 且超预算 → 先把全量落盘（await，后到的 meta 层复用），
 * 再给模型「预览 + 落盘路径」后缀；落盘失败 / 无 taskId → V1 后缀。
 * 截断逻辑绝不能拖垮工具执行：落盘 try/catch，失败降级。
 */
export const withModelBudget = <T extends { name?: unknown; execute?: unknown }>(
  def: T,
  spill?: ModelBudgetSpill,
): T => {
  const d = def as T & {
    name?: unknown;
    execute?: (...args: never[]) => Promise<unknown>;
  };
  const prev = d.execute;
  if (typeof prev !== "function") return def;
  const toolName = typeof d.name === "string" ? d.name : "unknown";
  const budget = budgetForTool(toolName);
  return {
    ...d,
    execute: async (...args: never[]): Promise<unknown> => {
      const result = await prev(...args);
      try {
        const r = result as ExecuteResultLike | null | undefined;
        if (!r || typeof r !== "object" || !Array.isArray(r.content)) {
          return result;
        }
        // 先收全原文：落盘文件 = 模型不限预算时会看到的全部 text part 拼接。
        // 命中条件是「任一 part 超预算」——多 part 各自合规但总和超是极端 corner
        // （pi 单 part 上限 50KB），inline 给模型自己压缩上下文，不落盘打扰。
        const originals: string[] = [];
        for (const part of r.content) {
          const p = part as TextPart | null | undefined;
          if (
            p &&
            typeof p === "object" &&
            p.type === "text" &&
            typeof p.text === "string"
          ) {
            originals.push(p.text);
          }
        }
        // 注：先收进 boolean 再判断——直接 `if (!originals.some(...)) return` 会让
        // TS 把 originals 窄化成 never，后面取 originals[0] 编不过。
        const anyOver = originals.some(
          (t) => Buffer.byteLength(t, "utf-8") > budget,
        );
        if (!anyOver) {
          return result;
        }
        // V2 落盘（best-effort）：callId 取 execute 首参（pi 规范）；失败 → V1 后缀
        let spillAbs: string | undefined;
        // args 是 never[]（沿用旧签名）：首参即 pi 规范的 toolCallId，显式按 unknown 取
        const callId: unknown = args[0];
        const taskId = spill?.taskId;
        if (
          taskId &&
          typeof callId === "string" &&
          callId.length > 0 &&
          originals.length > 0
        ) {
          const full =
            originals.length === 1
              ? originals[0]!
              : originals
                  .map((t, i) => `--- [part ${i + 1}] ---\n${t}`)
                  .join("\n");
          try {
            const saved = await spillModelFullOutput(
              taskId,
              `${spill?.filePrefix ?? ""}${callId}`,
              full,
            );
            if (saved) spillAbs = saved.absPath;
          } catch {
            // 落盘失败 → V1 后缀（spillModelFullOutput 内部已 warn，这里静默降级）
            spillAbs = undefined;
          }
        }
        let hit = false;
        let orig = 0;
        const content = r.content.map((part) => {
          const p = part as TextPart | null | undefined;
          if (
            !p ||
            typeof p !== "object" ||
            p.type !== "text" ||
            typeof p.text !== "string"
          ) {
            return part;
          }
          const t = truncateModelOutput(p.text, toolName, budget, spillAbs);
          if (!t.truncated) return part;
          hit = true;
          orig = Math.max(orig, t.originalBytes);
          return { ...p, text: t.text };
        });
        if (hit) {
          console.warn(
            `[tool-budget] tool=${toolName} 原=${fmtBytes(orig)} 给=${fmtBytes(budget)}（已截断进模型）` +
              (spillAbs ? ` 落盘=${spillAbs}` : "（未落盘：无 taskId 或落盘失败）"),
          );
          const out = { ...r, content };
          // P2-2：同一引用直连落盘路径，meta 层省掉长度猜 + stat miss
          if (spillAbs) registerModelSpillResult(out, spillAbs);
          return out;
        }
        return result;
      } catch {
        // 截断逻辑绝不能拖垮工具执行
        return result;
      }
    },
  };
};
