/**
 * Cursor 路径的子代理工具 `subagent`（Flowship 自有，与 pi 的 `task` 同参同语义）
 *
 * # 为什么要自己做
 * Cursor SDK 的原生 `task` 子代理在本地运行**固定用 composer 系**：
 *   - `AgentOptions.agents[x].model` 类型上有，但本地运行里被忽略（2026-10-13 实测：声明
 *     `claude-sonnet-5-5`，SDK 下发的 task 调用 model 仍是 `composer-2.5-fast`，子代理自述 Composer）；
 *   - `task` 的入参也没有 effort。
 * 所以模型 / effort 想自己定，只能 Flowship 自己起子 agent：`local.customTools` 里挂一个工具，
 * 工具回调里 `Agent.create` 一个嵌套子 agent（模型 / effort 由入参决定）、跑完把最终文本当工具结果返回。
 *
 * # 实测过的前提（2026-10-13，真实 Cursor SDK 1.0.37，composer-2.5 当父、claude-sonnet-5-5 当子）
 * 1. 自定义工具回调可以同步阻塞很久：75s / 330s 都正常返回，没有 MCP 那个 ~60s 超时
 *    （所以不需要 ask_user 那套「立刻返回 + shell curl 长轮询」）。
 * 2. 回调里可以直接嵌套 `Agent.create`，子 agent 用 `claude-sonnet-5-5` + `reasoning_effort=low`
 *    跑通；`RunResult.model` 回读出的就是请求的模型和参数。
 * 3. 同一轮里并行发起多个自定义工具调用是并行执行的（两个 20s 的调用总共 20s）。
 * 4. **取消不联动**：父 `run.cancel()` 后，回调拿不到 AbortSignal（`SDKCustomToolContext` 里没有），
 *    子 agent 会一直跑到自然结束（实测 shell 子进程 sleep 活到结束、白烧 token）。所以必须自己联动：
 *    每个父 agent 实例一个 link，记着在跑的子 run；覆盖父 `run.cancel()` / `close()` /
 *    `[Symbol.asyncDispose]()`，先取消子 run 再放行。实测联动后子 run 立即 CANCELLED、
 *    回调立即结束、子 shell 进程也跟着没了。
 *
 * # 范围（用户拍板）
 * - 只能选**当前 provider（Cursor）**的模型；缺省 / inherit = 沿用父会话当前模型（含其思考档）。
 * - fast 变体不在代码里拦，继续靠 `.cursor/rules/subagent-no-fast.mdc` 约束。
 * - 与原生 `task` 并存（不 disallow）：原生 `task` 仍在、只是不能选模型。
 *
 * # 子 agent 的边界
 * 不带系统工具（submit_work / ask_user…）、不带用户 MCP、不带 `subagent`/`task`——防递归与副作用。
 * explore = 只读白名单（read / grep / glob / ls）；其余 = 默认内置工具、去掉 `task`。
 */

import { Agent as CursorAgent } from "@cursor/sdk";
import type { ModelSelection, SDKCustomTool, ToolName } from "@cursor/sdk";

import { withoutHiddenModelSelection } from "@/lib/model-params";
import {
  catalogFromModelOptions,
  formatModelCatalog,
  parseSubagentRequest,
  resolveSubagentModel,
  SUBAGENT_INPUT_JSON_SCHEMA,
  SUBAGENT_TOOL_DESCRIPTION,
  SubagentUsageError,
  subagentNeedsCatalog,
  wantsModelList,
  type ModelCatalogEntry,
  type SubagentModelSelection,
  type SubagentRequest,
} from "@/lib/subagent-spec";

import { listModelOptions } from "./model-catalog";
import { withCursorJsonlStore } from "./sdk-agent-store";
import {
  SDK_CREATE_RESUME_TIMEOUT_MS,
  SDK_SEND_TIMEOUT_MS,
  withSdkDeadline,
} from "./sdk-deadline";

/** explore（只读）：读 / 搜，不写文件、不跑命令（与 pi 的 read/grep/find/ls 对齐） */
export const CURSOR_SUBAGENT_READONLY_TOOLS: ToolName[] = [
  "read",
  "grep",
  "glob",
  "ls",
];

/** 工具说明：共用文案 + Cursor 特有的一句（与原生 task 的区别，帮模型选对工具） */
export const CURSOR_SUBAGENT_DESCRIPTION =
  SUBAGENT_TOOL_DESCRIPTION +
  "需要指定模型 / effort 时必须用本工具（Cursor 原生 task 不能指定模型，固定用 composer 系）。" +
  "同一轮里可以并行发起多个本工具调用。";

// ----------------- 依赖（可注入，单测不碰真实 SDK） -----------------

/** 子 run 的最小形状（真实 SDK 的 Run 是它的超集） */
export interface SubagentChildRun {
  stream(): AsyncIterable<unknown>;
  wait(): Promise<{
    status: string;
    result?: string;
    error?: { message?: string } | null;
  }>;
  cancel(): Promise<void>;
}

/** 子 agent 的最小形状（真实 SDK 的 SDKAgent 是它的超集） */
export interface SubagentChildAgent {
  send(prompt: string): Promise<SubagentChildRun>;
  close?: () => unknown;
}

export interface CursorSubagentDeps {
  /** 父会话当前模型（inherit 的基线）；没有 = 父会话没显式选模型 */
  parentModel?: SubagentModelSelection;
  /** 当前 provider 的模型目录；拿不到返回 null（此时不校验 model id） */
  loadCatalog: () => Promise<ModelCatalogEntry[] | null>;
  /** 起子 agent；model 为空 = 沿用 SDK 默认（仅父会话没选模型且 inherit 时） */
  createChild: (opts: {
    model?: SubagentModelSelection;
    explore: boolean;
  }) => Promise<SubagentChildAgent>;
}

export interface SubagentLink {
  /** 挂进 `local.customTools` 的工具 */
  tool: SDKCustomTool;
  /** 给父 agent 接上取消联动（覆盖 send 返回的 run.cancel / close / asyncDispose）；返回同一对象 */
  attach: <A extends object>(agent: A) => A;
  /** 取消所有在跑的子 run（父 run 被取消 / 会话被关时调） */
  cancelAll: () => Promise<void>;
}

const CANCELLED_TEXT = "子任务已取消";

const noop = (): void => {};

const toText = (v: unknown): string => {
  if (!v || typeof v !== "object") return "";
  const content = (v as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const c of content) {
    if (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string") {
      out += (c as { text: string }).text;
    }
  }
  return out;
};

/** 子 run 终态不是 finished 时给模型看的原因 */
const describeRunFailure = (res: {
  status: string;
  error?: { message?: string } | null;
}): string => {
  const detail = res.error?.message?.trim();
  return detail ? `${res.status}：${detail}` : res.status;
};

const textResult = (text: string, isError = false) => ({
  content: [{ type: "text" as const, text }],
  ...(isError ? { isError: true } : {}),
});

/**
 * 每个父 agent 实例建一个 link：工具闭包、在跑的子 run 集合、取消代数都绑在这个实例上
 *（不按 agentId 全局存——恢复会话的新旧实例 agentId 相同，全局按 id 存会互相误杀）。
 */
export const createCursorSubagentLink = (
  deps: CursorSubagentDeps,
): SubagentLink => {
  const live = new Set<SubagentChildRun>();
  /**
   * 取消代数：cancelAll 每调一次 +1。工具回调开头记一份，每个 await 之后对一下——
   * 变了说明父 run 在这期间被取消了（回调拿不到 AbortSignal，只能这样接力），
   * 补取消刚起好的子 run 并退出，不留孤儿。永久标志位不行：同一个 agent 的下一轮还要能正常派子任务。
   */
  let generation = 0;

  const cancelAll = async (): Promise<void> => {
    generation += 1;
    await Promise.allSettled([...live].map((r) => r.cancel()));
  };

  const runSubagent = async (req: SubagentRequest): Promise<string> => {
    const gen0 = generation;
    const cancelled = (): boolean => generation !== gen0;
    const parentSel: SubagentModelSelection = deps.parentModel ?? {
      id: "default",
    };

    const catalog = subagentNeedsCatalog(req) ? await deps.loadCatalog() : null;
    if (wantsModelList(req.model)) {
      return catalog
        ? `当前模型：${deps.parentModel?.id ?? "(未指定)"}\n可选模型（当前 provider）：\n${formatModelCatalog(catalog)}`
        : "拿不到当前 provider 的模型清单；可直接填模型 id，或省略 model 沿用当前模型。";
    }
    // Cursor 各模型的 effort 参数 id 不统一（reasoning_effort / effort / thinking），
    // 没有目录就没法知道该写哪个 id——宁可明确报错也不乱猜（猜错 SDK 会静默忽略）
    if (req.effort && !catalog) {
      throw new SubagentUsageError(
        "拿不到当前 provider 的模型清单，无法确定 effort 该用哪个参数；先省略 effort（沿用当前档位），或稍后重试。",
      );
    }
    const resolved = resolveSubagentModel(req, parentSel, catalog);
    if (!resolved.ok) throw new SubagentUsageError(resolved.error);
    if (cancelled()) throw new Error(CANCELLED_TEXT);

    // 父会话没显式选模型且这次也没换 → 不替它编一个模型 id，让 SDK 走默认
    const childModel =
      resolved.inherited && !deps.parentModel ? undefined : resolved.model;

    let child: SubagentChildAgent | undefined;
    let run: SubagentChildRun | undefined;
    try {
      child = await deps.createChild({
        model: childModel,
        explore: req.subagentType === "explore",
      });
      if (cancelled()) throw new Error(CANCELLED_TEXT);
      run = await child.send(req.prompt);
      // 先登记再复查（同步、中间无 await）：cancelAll 要么看得到它、要么先于它改了代数
      live.add(run);
      if (cancelled()) {
        await run.cancel().catch(noop);
        throw new Error(CANCELLED_TEXT);
      }

      let streamed = "";
      try {
        for await (const m of run.stream()) streamed += toText(m);
      } catch {
        // 流中途断：终态以 wait() 为准（失败会在下面抛出来）
      }
      const res = await run.wait();
      if (res.status === "cancelled") throw new Error(CANCELLED_TEXT);
      if (res.status !== "finished") {
        const partial = (res.result ?? streamed).trim();
        const reason = describeRunFailure(res);
        throw new Error(
          partial
            ? `${reason}\n（子任务中途失败，已产出的部分内容：）\n${partial}`
            : reason,
        );
      }
      return (res.result ?? streamed).trim();
    } finally {
      if (run) live.delete(run);
      try {
        await Promise.resolve(child?.close?.());
      } catch {
        /* 关闭失败不影响结果 */
      }
    }
  };

  const tool: SDKCustomTool = {
    description: CURSOR_SUBAGENT_DESCRIPTION,
    inputSchema: JSON.parse(
      JSON.stringify(SUBAGENT_INPUT_JSON_SCHEMA),
    ) as NonNullable<SDKCustomTool["inputSchema"]>,
    execute: async (args) => {
      const parsed = parseSubagentRequest(args);
      // 用法错误（prompt 空 / model / effort 无效）：isError 标出来，message 原样给模型改
      if (!parsed.ok) return textResult(parsed.error, true);
      try {
        const out = await runSubagent(parsed.request);
        return textResult(out || "(子任务无输出)");
      } catch (err) {
        if (err instanceof SubagentUsageError) {
          return textResult(err.message, true);
        }
        const msg = err instanceof Error ? err.message : String(err);
        // 取消不是失败：不加「子任务失败」前缀，也别当错误吓模型
        if (msg === CANCELLED_TEXT) return textResult(CANCELLED_TEXT);
        return textResult(`子任务失败：${msg}`, true);
      }
    },
  };

  const attach = <A extends object>(agent: A): A =>
    wrapAgentWithCancelLink(agent, cancelAll);

  return { tool, attach, cancelAll };
};

// ----------------- 取消联动（Proxy 包一层：send→run.cancel / close / asyncDispose） -----------------

type AnyFn = (...args: unknown[]) => unknown;

/**
 * 为什么用 Proxy 而不是直接改对象的方法：
 * 原地替换 `run.cancel` / `agent.close` 会换掉 SDK 对象上的方法本身——任何持有原对象、
 * 对原方法做比较 / 断言的代码都会失效（实测：chat-runner 一批测试断言 `fakeRun.cancel` 这个 spy，
 * 被替换后报「not a spy」）。代理不碰原对象，原方法原封不动，只是经代理调用时多做一步联动。
 *
 * 取属性一律 `Reflect.get(target, prop, target)` 且函数绑回 target：SDK 的 Run / Agent 是 class 实例，
 * 方法里可能读私有字段 / getter，`this` 必须是原对象，不能是代理。
 */
const getFromTarget = (target: object, prop: string | symbol): unknown => {
  const v = Reflect.get(target, prop, target);
  return typeof v === "function" ? (v as AnyFn).bind(target) : v;
};

/** 冻结的对象 Proxy 不得改 get 的返回值（违反不变式会抛 TypeError），这种直接不代理 */
const canProxy = (o: unknown): o is object =>
  o !== null && typeof o === "object" && !Object.isFrozen(o);

/** run 的代理：`cancel` 先把取消发给子 run、再放行父的 cancel（父的结果 / 错误原样返回） */
const wrapRunWithCancelLink = <R>(
  run: R,
  cancelChildren: () => Promise<void>,
): R => {
  if (!canProxy(run)) return run;
  return new Proxy(run, {
    get(target, prop) {
      if (prop !== "cancel") return getFromTarget(target, prop);
      const orig = getFromTarget(target, "cancel");
      if (typeof orig !== "function") return orig;
      return (...args: unknown[]): Promise<unknown> => {
        // 父 cancel 先发出去（它的 rejection 必须有人接住，否则等子取消期间会冒成 unhandled）
        const parent = Promise.resolve()
          .then(() => (orig as AnyFn)(...args))
          .then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error }),
          );
        return cancelChildren()
          .catch(noop)
          .then(() => parent)
          .then((settled) => {
            if (!settled.ok) throw settled.error;
            return settled.value;
          });
      };
    },
  }) as R;
};

/**
 * agent 的代理：
 *  - `send` 返回的 run 套上 {@link wrapRunWithCancelLink}；
 *  - `close` / `[Symbol.asyncDispose]` 先停子 run（会话被关后子代理不能继续烧 token）。
 * 其余属性 / 方法原样透传。
 */
const wrapAgentWithCancelLink = <A extends object>(
  agent: A,
  cancelChildren: () => Promise<void>,
): A => {
  if (!canProxy(agent)) {
    // 冻结的 agent 没法代理：退化成无联动（子 run 靠自然结束 / 用户取消），但要留痕、别装作联动了
    console.warn("[cursor-subagent] agent 不可代理，取消不联动子代理");
    return agent;
  }
  return new Proxy(agent, {
    get(target, prop) {
      const v = getFromTarget(target, prop);
      if (typeof v !== "function") return v;
      if (prop === "send") {
        return async (...args: unknown[]): Promise<unknown> =>
          wrapRunWithCancelLink(await (v as AnyFn)(...args), cancelChildren);
      }
      if (prop === "close") {
        return (...args: unknown[]): unknown => {
          void cancelChildren().catch(noop);
          return (v as AnyFn)(...args);
        };
      }
      if (prop === Symbol.asyncDispose) {
        return async (...args: unknown[]): Promise<unknown> => {
          await cancelChildren().catch(noop);
          return (v as AnyFn)(...args);
        };
      }
      return v;
    },
  });
};

// ----------------- 真实依赖（Cursor SDK） -----------------

/**
 * 为一个父 agent 实例建 link（真实 SDK 依赖）。
 * 子 agent 一律：同 apiKey / cwd、`settingSources:[]`（不加载 .cursor/，与父会话一致）、
 * 不带 customTools / mcpServers；模型参数过 `withoutHiddenModelSelection`（与 facade 同口径）。
 */
export const createCursorSubagentLinkForSession = (opts: {
  apiKey: string;
  parentModel?: ModelSelection;
  cwd?: string;
}): SubagentLink => {
  const parentModel = opts.parentModel
    ? withoutHiddenModelSelection(opts.parentModel)
    : undefined;
  return createCursorSubagentLink({
    parentModel,
    loadCatalog: async () => {
      try {
        const options = await listModelOptions({
          kind: "cursor",
          apiKey: opts.apiKey,
        });
        return catalogFromModelOptions(options);
      } catch (err) {
        console.warn(
          "[cursor-subagent] 模型清单拿不到、跳过校验：",
          err instanceof Error ? err.message : err,
        );
        return null;
      }
    },
    createChild: async ({ model, explore }) => {
      const base: Parameters<typeof CursorAgent.create>[0] = {
        apiKey: opts.apiKey,
        ...(model ? { model: withoutHiddenModelSelection(model) } : {}),
        local: {
          ...(opts.cwd ? { cwd: opts.cwd } : {}),
          settingSources: [],
        },
        // explore：只给读 / 搜白名单；其余：默认内置工具、去掉 task 防递归
        ...(explore
          ? { tools: [...CURSOR_SUBAGENT_READONLY_TOOLS] }
          : { disallowedTools: ["task" as ToolName] }),
      };
      // 与父会话同口径：create / send 都有硬上限（半死连接不能让父会话永远停在「子代理工作中」）；
      // 超时后迟到才返回的 agent / run 由 withSdkDeadline 自动 close / cancel，不留孤儿。
      // 只管「受理」，不限子任务本身跑多久（那由用户取消 / 整轮 24h 顶兜）。
      const agent = await withSdkDeadline(
        withCursorJsonlStore(base).then((b) => CursorAgent.create(b)),
        SDK_CREATE_RESUME_TIMEOUT_MS,
        "subagent.create",
      );
      return {
        send: (prompt) =>
          withSdkDeadline(agent.send(prompt), SDK_SEND_TIMEOUT_MS, "subagent.send"),
        close: () => agent.close(),
      };
    },
  });
};

export { CURSOR_SUBAGENT_TOOL_NAME } from "@/lib/cursor-subagent-display";
