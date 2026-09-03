/**
 * 需求群自动播报（第三批）
 *
 * app 内跑完一个 action（产物过后置检查、切 awaiting_ack）后，按
 * `bridge-config.GROUP_COLLAB_POLICY.autoBroadcast` 档位自动把产物以分享卡发进需求群。
 * 该档位固定 `off`（2026-07-28 起不再是用户设置）——整条链保留、只是常驻不播。
 *
 * # 与第二批出向（group-outbound）的分工
 *
 * | 触发源 | 谁发 | 开关 |
 * |--------|------|------|
 * | 群里 @bot「推进 xxx」 | group-outbound（done 事件） | `advanceResultToGroup`（固定开） |
 * | app 内推进 | **本模块**（action 完成收口点） | `autoBroadcast`（固定 off） |
 *
 * 两条路会撞在同一个 action 上（群里发起的推进跑完、两边都想发）——两道防线：
 * 1. `hasGroupAdvanceReplyFor` 同步预筛让位给 outbound；
 * 2. 预筛扑空时（done flush 先摘走了登记）靠 group-shared 的产物卡防重表兜底——
 *    两边共用一张表、先占再发，谁先占谁发。
 *
 * # 铁律：不建群
 *
 * 播报只往**已经绑定的**需求群发（`getBoundGroupChatId` 只读不建）。
 * `shareToRequirementGroup` 内部的 ensure 会建群 + 拉人——那是用户显式分享才该有的
 * 副作用，后台自动播报不能替用户拉群。
 *
 * # 铁律：绝不影响主流程
 *
 * 播报是 action 完成之后的增强动作。任何一步失败（没群 / bot 不在群 / 飞书挂）
 * 只写 warn + 事件流一条 info，**不抛给调用方**、不改任何 task 状态。
 * 整体还有 {@link BROADCAST_TIMEOUT_MS} 兜底，避免慢调用长期占着收尾方的 postcheck claim。
 *
 * # 依赖方向
 *
 * `feishu-group` 静态引 `meegle-cli`，而本模块被 task-runner 静态引用；
 * 为了不拉垮「把 meegle-cli 整个 mock 掉」的 ownership 单测，
 * 对 feishu-group 一律 **type-only import + 运行时动态 import()**（同 group-outbound）。
 */

import { promises as fs } from "node:fs";

import { isLightweightDailyTask } from "@/lib/lightweight-task";
import type { ShareLink, ShareToGroupInput } from "@/lib/server/feishu-group";
import { getActionArtifactPath } from "@/lib/server/task-fs-core";
import { actionDisplayLabel } from "@/lib/task-display";
import type { ActionRecord, GroupAutoBroadcast, Task } from "@/lib/types";

import {
  getGroupAutoBroadcastMode,
  isAdvanceResultToGroupEnabled,
  isFeishuChatBridgeEnabled,
} from "./bridge-config";
import {
  claimGroupArtifactCard,
  hasGroupAdvanceReplyFor,
  releaseGroupArtifactCard,
} from "./group-shared";

const LOG = "[feishu-bridge/group-broadcast]";

/** 播报整体超时——超时只是放弃本次播报，收尾方的 claim 不会被长期占住 */
export const BROADCAST_TIMEOUT_MS = 30_000;

/** 卡片最多挂几个 MR 按钮（多仓 ship 可能一次 10 条；超了的进正文裸链接，保证不丢） */
const MAX_MR_LINKS = 10;

/**
 * 播报结果（调用方不消费，单测按它断言分支）。
 * `skipped_*` = 有意不发；`failed` = 发了没成、已降级成 info 事件。
 */
export type BroadcastOutcome =
  | "sent"
  | "failed"
  | "skipped_lightweight"
  | "skipped_mode"
  | "skipped_bridge_off"
  | "skipped_duplicate"
  | "skipped_group_reply"
  | "skipped_no_group"
  | "skipped_no_content";

// ----------------- 可注入依赖（单测 mock 外部调用） -----------------

export interface GroupBroadcastDeps {
  getMode: () => Promise<GroupAutoBroadcast>;
  isBridgeEnabled: () => Promise<boolean>;
  isAdvanceResultToGroupEnabled: () => Promise<boolean>;
  /** 只读取工作项已绑定的群 id（**不建群**）——播报的准入闸（同步预筛那一半） */
  getBoundGroupChatId: (
    task: Pick<Task, "feishuStoryUrl">,
  ) => Promise<string | null>;
  /** 第二参恒传 `{ allowCreate: false }`——闸的另一半贴在 createChat 紧前 */
  shareToGroup: (
    task: Task,
    input: ShareToGroupInput,
    opts: { allowCreate: false },
  ) => Promise<unknown>;
  readArtifact: (absPath: string) => Promise<string>;
  warn: (msg: string) => void;
}

const defaultDeps = (): GroupBroadcastDeps => ({
  getMode: () => getGroupAutoBroadcastMode(),
  isBridgeEnabled: () => isFeishuChatBridgeEnabled(),
  isAdvanceResultToGroupEnabled: () => isAdvanceResultToGroupEnabled(),
  // 动态 import：见文件头「依赖方向」
  getBoundGroupChatId: async (task) =>
    (await import("@/lib/server/feishu-group")).getBoundGroupChatId(task),
  shareToGroup: async (task, input, opts) =>
    (await import("@/lib/server/feishu-group")).shareToRequirementGroup(
      task,
      input,
      opts,
    ),
  readArtifact: (absPath) => fs.readFile(absPath, "utf-8"),
  warn: (msg) => console.warn(`${LOG} ${msg}`),
});

let deps: GroupBroadcastDeps = defaultDeps();

/** 单测替换依赖；传 null 恢复 */
export const __setGroupBroadcastDepsForTest = (
  partial: Partial<GroupBroadcastDeps> | null,
): void => {
  deps = partial ? { ...defaultDeps(), ...partial } : defaultDeps();
};

// ----------------- 判定 / 取材（纯函数） -----------------

/**
 * 档位 × action 类型 → 要不要播。
 * `ship` 档只认提测（ship）——群里最关心「提测了没、MR 在哪」，
 * 方案 / 改代码 / 复核这些过程产物默认不进群刷屏。
 */
export const shouldBroadcastAction = (
  mode: GroupAutoBroadcast,
  actionType: string,
): boolean => {
  if (mode === "all") return true;
  if (mode === "ship") return actionType === "ship";
  return false;
};

/**
 * 本次 action 产出的 MR 链接按钮（多仓 ship 一仓一条）。
 * 只取本 action 自己的 `sideEffects.mrs`——task.mrs 是全历史，
 * 拿它会把上一轮 ship 的旧 MR 也挂到这张卡上。
 */
/**
 * 本次 action 产出的全部 MR 链接（不封顶）。
 * 正文用它全列（方便复制粘贴）；按钮用 {@link buildActionMrLinks} 的封顶版，超的只在正文里，保证不丢。
 */
export const buildAllActionMrLinks = (action: ActionRecord): ShareLink[] => {
  const mrs = action.sideEffects?.mrs ?? [];
  const links: ShareLink[] = [];
  for (const mr of mrs) {
    const url = mr.mrUrl?.trim();
    if (!url) continue;
    // 仓路径末段当标签（crm-web），拿不到就退回「MR」
    const repoTail = mr.repoPath?.split("/").filter(Boolean).pop();
    links.push({ label: repoTail ? `MR · ${repoTail}` : "MR", url });
  }
  return links;
};

export const buildActionMrLinks = (action: ActionRecord): ShareLink[] =>
  buildAllActionMrLinks(action).slice(0, MAX_MR_LINKS);

// ----------------- 播报闭环 -----------------

export interface BroadcastActionOpts {
  /**
   * 往任务事件流写一条 info（降级提示用）。
   * 由收尾持有者传入——它才知道自己是否还持有租约、写不写得动。
   */
  emitInfo?: (text: string) => Promise<void> | void;
}

const withTimeout = async <T>(
  p: Promise<T>,
  ms: number,
  onTimeout: () => T,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(onTimeout()), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/**
 * action 完成后按设置自动播报进需求群。
 *
 * **绝不抛**——所有异常在内部收敛成 `failed` + 一条 info 事件。
 * 调用方（task-runner 后置检查收口点）拿到返回值也不需要做任何事。
 */
export const broadcastActionCompletion = async (
  task: Task,
  action: ActionRecord,
  opts: BroadcastActionOpts = {},
): Promise<BroadcastOutcome> =>
  withTimeout<BroadcastOutcome>(
    runBroadcast(task, action, opts),
    BROADCAST_TIMEOUT_MS,
    () => {
      // 超时不退坑：在途的那次 share 可能仍会成功，退了会让下轮交卷重发一张重复卡
      deps.warn(
        `播报超时 task=${task.id} action=${action.id}、放弃等待（不影响 action 完成）`,
      );
      return "failed";
    },
  ).catch((err): BroadcastOutcome => {
    // 兜底：runBroadcast 自身已全包 try/catch，这里只防「防御性代码本身抛」
    deps.warn(
      `播报未捕获异常 task=${task.id} action=${action.id}：${errText(err)}`,
    );
    return "failed";
  });

const runBroadcast = async (
  task: Task,
  action: ActionRecord,
  opts: BroadcastActionOpts,
): Promise<BroadcastOutcome> => {
  // —— 同步零 IO 预筛（每个 action 完成都会走这里、别上来就读盘）——

  // 轻量任务没有飞书工作项 = 没有需求群可发
  if (isLightweightDailyTask(task)) return "skipped_lightweight";

  // 群内推进让位给 group-outbound：它会在 done 事件里发同一份产物，
  // 两边都发就是群里连着两张一样的卡
  const outboundOwnsThis = hasGroupAdvanceReplyFor(task.id, action.id);

  // —— 读设置（到这里才碰盘）——

  let mode: GroupAutoBroadcast;
  try {
    mode = await deps.getMode();
  } catch (err) {
    deps.warn(`读播报设置失败、当作不播：${errText(err)}`);
    return "skipped_mode";
  }
  if (!shouldBroadcastAction(mode, action.type)) return "skipped_mode";

  if (outboundOwnsThis && (await safeAdvanceResultEnabled())) {
    return "skipped_group_reply";
  }

  // 桥接总开关关掉时整条群链不跑（与出向同口径）
  try {
    if (!(await deps.isBridgeEnabled())) return "skipped_bridge_off";
  } catch (err) {
    deps.warn(`读桥接开关失败、当作不播：${errText(err)}`);
    return "skipped_bridge_off";
  }

  // —— 取材 ——

  const content = await readArtifactContent(task, action);
  if (!content) return "skipped_no_content";

  // —— 准入闸（第一半：同步预筛）：必须已经有需求群 ——
  //
  // shareToRequirementGroup 内部是 ensureRequirementGroup（没群就**建群 + 拉人 + bind**）。
  // 那是「用户显式分享」才该有的动作；自动播报是后台行为，不能因为跑完一个 action
  // 就悄悄给全组人拉个群（P2-3）。这里只读绑定、没群直接放弃、连 info 都不写
  //（没群不是异常、是这个需求还没人开始群协作）。
  // 这次读和真正建群之间还隔着占坑等 await（TOCTOU）——第二半闸是下面 share 调用里的
  // `allowCreate: false`，它贴在 createChat 紧前、没群直接抛 no_group。
  let boundChatId: string | null = null;
  try {
    boundChatId = await deps.getBoundGroupChatId(task);
  } catch (err) {
    deps.warn(`查需求群失败、当作没群：${errText(err)}`);
    return "skipped_no_group";
  }
  if (!boundChatId) return "skipped_no_group";

  // —— 占坑 + 发 ——

  if (!claimGroupArtifactCard(task.id, action.id)) return "skipped_duplicate";

  const label = actionDisplayLabel(action);
  // 按钮只挂前 N 个（LINK_BUTTON_MAX），超的拼进正文——artifact 正文进 md 文件消息，
  // 打开文件即见，保证多仓一次出 10+ 条也不静默丢（提测卡同款“按钮 + 正文溢出”）。
  const links = buildActionMrLinks(action);
  const overflow = buildAllActionMrLinks(action).slice(links.length);
  const broadcastContent =
    overflow.length > 0
      ? `${content}\n\n---\n按钮只挂前 ${links.length} 个，剩下的 MR（复制粘贴用）：\n${overflow
          .map((m) => `- ${m.label} ${m.url}`)
          .join("\n")}`
      : content;
  try {
    await deps.shareToGroup(
      task,
      {
        kind: "artifact",
        title: label,
        content: broadcastContent,
        links,
      },
      // 后台播报绝不建群（准入闸的第二半、贴在 createChat 紧前）
      { allowCreate: false },
    );
    console.log(
      `${LOG} 已播报 task=${task.id} action=${action.id} type=${action.type} mode=${mode}`,
    );
    return "sent";
  } catch (err) {
    // 没发出去就退坑，让下一轮交卷还能再试
    releaseGroupArtifactCard(task.id, action.id);
    // 预筛之后群没了 / 刚被解绑：这不是失败、是「这个需求还没群」——静默跳过，
    // 不写降级 info（跟预筛扑空同一口径）
    if (isNoGroupError(err)) {
      deps.warn(
        `预筛时有群、真发时已无绑定群 task=${task.id} action=${action.id}、跳过播报`,
      );
      return "skipped_no_group";
    }
    // FeishuGroupError.message 本身已是可读中文（如「请在群设置里添加你的机器人 XX」）
    const reason = errText(err) || "未知错误";
    deps.warn(`播报失败 task=${task.id} action=${action.id}：${reason}`);
    try {
      await opts.emitInfo?.(`群播报失败：${reason}`);
    } catch (emitErr) {
      // 连降级提示都写不进去（多半是租约已失效）——到此为止，绝不上抛
      deps.warn(`播报降级事件写入失败：${errText(emitErr)}`);
    }
    return "failed";
  }
};

/** 群内推进开关读失败时按「开」处理——宁可让位不发，也别重复发两张卡 */
const safeAdvanceResultEnabled = async (): Promise<boolean> => {
  try {
    return await deps.isAdvanceResultToGroupEnabled();
  } catch {
    return true;
  }
};

/**
 * artifact 全文；没产物 / 读不到 / 空文件 → null（不发空卡）。
 *
 * **不截断**：播报走 `kind: "artifact"`，正文不进卡片、由 md 文件消息承载
 *（2026-07-27 用户拍板的内容形态）——截了就是给群里发半份产物。
 */
const readArtifactContent = async (
  task: Task,
  action: ActionRecord,
): Promise<string | null> => {
  if (!action.artifactPath) return null;
  try {
    const abs = getActionArtifactPath(task.id, action.n, action.type);
    const raw = await deps.readArtifact(abs);
    const text = raw.trim();
    if (!text) return null;
    return text;
  } catch (err) {
    deps.warn(`读 artifact 失败 task=${task.id} action=${action.id}：${errText(err)}`);
    return null;
  }
};

const errText = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * 是不是 `FeishuGroupError(code="no_group")`——「没群且本次不许建」。
 * 按 code 鸭子判定而不是 instanceof：feishu-group 只能动态 import（见文件头依赖方向），
 * 静态拿类做 instanceof 会把 meegle-cli 那张图拉进来。
 */
const isNoGroupError = (err: unknown): boolean =>
  !!err &&
  typeof err === "object" &&
  (err as { code?: unknown }).code === "no_group";
