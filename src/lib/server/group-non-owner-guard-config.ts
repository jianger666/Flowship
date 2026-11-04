/**
 * 群里非属主相关的两个全局开关的服务端读取（设置 → 连接 → 飞书集成）：
 * - `feishuGroupNonOwnerGuard`（提示词约束，默认开）；
 * - `feishuGroupAllowBots`（受理别的机器人的 @，默认开）。
 *
 * 单独成文件而不放 feishu-bridge/bridge-config：注入链（task-question-inject）与 task-runner 依赖图
 * 不得静态依赖群模块（见 docs/feishu-group-collab.md 的依赖方向约束）；本文件只依赖 settings-fs。
 * 每次送达时现读（不缓存）：开关改了，活会话的下一条非属主消息立刻按新值走；排队消息按**送达时**的值算。
 */

import {
  GROUP_ALLOW_BOTS_DEFAULT,
  GROUP_NON_OWNER_GUARD_DEFAULT,
} from "@/lib/group-non-owner-prompt";
import { readSettingsFile } from "@/lib/server/settings-fs";

export const isGroupNonOwnerGuardEnabled = async (): Promise<boolean> => {
  try {
    const result = await readSettingsFile();
    // 读不到设置（首次启动 / 文件坏）→ 取默认值（开）：宁可多约束，别因读盘失败放开
    if (result.status !== "ok") return GROUP_NON_OWNER_GUARD_DEFAULT;
    const v = result.settings.feishuGroupNonOwnerGuard;
    // 缺省 / 非 false → 开
    return v !== false;
  } catch {
    return GROUP_NON_OWNER_GUARD_DEFAULT;
  }
};

/** 单测覆盖（null = 不覆盖、读真实设置）。老的「机器人一律拒」用例靠它钉在放开之前的口径上 */
let botsAllowedOverrideForTest: boolean | null = null;
export const __setGroupBotsAllowedForTest = (v: boolean | null): void => {
  botsAllowedOverrideForTest = v;
};

/**
 * 受理群里别的机器人 @ 本机机器人吗（`feishuGroupAllowBots`，默认开；显式 false 才关）。
 *
 * 与提示词开关的失败口径**相反**：读不到设置（文件损坏 / 读盘报错）→ **不受理**（fail-closed）——这是放开准入、
 * 不是收紧约束，读不准就别放。设置文件不存在（首次启动）是正常的默认态 → 按默认（开）。
 */
export const isGroupBotsAllowed = async (): Promise<boolean> => {
  if (botsAllowedOverrideForTest !== null) return botsAllowedOverrideForTest;
  try {
    const result = await readSettingsFile();
    if (result.status === "missing") return GROUP_ALLOW_BOTS_DEFAULT;
    if (result.status !== "ok") return false;
    return result.settings.feishuGroupAllowBots !== false;
  } catch {
    return false;
  }
};
