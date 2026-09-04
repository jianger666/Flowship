/**
 * 工具回包进模型预算（D1 wrapper 层、V1）
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
 * V1 不落盘：`execute` 签名里没有 taskId/callId，透传要改 buildCustomTools +
 * MCP 桥接，diff 大 5 倍。被截掉的内容靠“重跑缩小版”拿（后缀指引教 agent
 * 怎么缩小），无状态、零竞态。残余风险：带副作用的 shell 命令重跑拿不到旧
 * 输出——靠 `[tool-budget]` warn 日志让人看得到，真出现再做落盘。
 */

import { truncateToLimit } from "./tool-result-persist";

/** 默认预算 32KB（shell/grep/task/MCP/其它） */
export const MODEL_OUTPUT_DEFAULT_BUDGET = 32 * 1024;
/** read 单独 64KB（看代码要上下文） */
export const MODEL_OUTPUT_READ_BUDGET = 64 * 1024;

export const budgetForTool = (toolName: string): number =>
  toolName === "read" ? MODEL_OUTPUT_READ_BUDGET : MODEL_OUTPUT_DEFAULT_BUDGET;

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
 * 纯函数：超预算则截断 + 拼缩小范围指引。
 * 主体截断复用事件落盘同款 `truncateToLimit`（code-point 边界、后缀计入配额），
 * 中文不会被拦腰砍；指引后缀挂在配额之外（约 150B、可观测性优先）。
 */
export const truncateModelOutput = (
  text: string,
  toolName: string,
  budget: number = budgetForTool(toolName),
): TruncatedModelOutput => {
  const originalBytes = Buffer.byteLength(text, "utf-8");
  if (originalBytes <= budget) {
    return { text, truncated: false, originalBytes, givenBytes: originalBytes };
  }
  const body = truncateToLimit(text, budget);
  const out =
    `${body}\n…(模型输入已截断：原文 ${fmtBytes(originalBytes)}，` +
    `本次只给前 ${fmtBytes(Buffer.byteLength(body, "utf-8"))}。${hintForTool(toolName)})`;
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
 */
export const withModelBudget = <T extends { name?: unknown; execute?: unknown }>(
  def: T,
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
          const t = truncateModelOutput(p.text, toolName, budget);
          if (!t.truncated) return part;
          hit = true;
          orig = Math.max(orig, t.originalBytes);
          return { ...p, text: t.text };
        });
        if (hit) {
          console.warn(
            `[tool-budget] tool=${toolName} 原=${fmtBytes(orig)} 给=${fmtBytes(budget)}（已截断进模型）`,
          );
          return { ...r, content };
        }
        return result;
      } catch {
        // 截断逻辑绝不能拖垮工具执行
        return result;
      }
    },
  };
};
