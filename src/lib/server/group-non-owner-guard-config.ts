/**
 * 群里非属主相关的全局开关的服务端读取（设置 → 连接 → 飞书集成）：
 * - `feishuGroupNonOwnerGuard`（提示词约束，默认开）；
 * - `feishuGroupBotsEqualRights`（机器人与真人同权，默认关）。
 *
 * 别的机器人的 @ 没有「受理 / 不受理」设置项：一律受理（走群答疑），见 {@link isGroupBotsAllowed}；
 * 受理后能做什么由上面两个开关决定。
 *
 * 单独成文件而不放 feishu-bridge/bridge-config：注入链（task-question-inject）与 task-runner 依赖图
 * 不得静态依赖群模块（见 docs/feishu-group-collab.md 的依赖方向约束）；本文件只依赖 settings-fs。
 * 每次送达时现读（不缓存）：开关改了，活会话的下一条非属主消息立刻按新值走；排队消息按**送达时**的值算。
 */

import {
  GROUP_BOTS_EQUAL_RIGHTS_DEFAULT,
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

/**
 * 「机器人与真人同权」开着吗（`feishuGroupBotsEqualRights`，默认关；只认显式 true）。
 *
 * 失败口径与提示词开关一致、都是「宁可多约束」：读不到设置（首次启动 / 文件坏 / 读盘抛错）→ 取默认（关），
 * 即机器人仍只答疑。送达时现读（不缓存）：改开关后，活会话的下一条机器人消息立刻按新值走。
 */
export const isGroupBotsEqualRights = async (): Promise<boolean> => {
  try {
    const result = await readSettingsFile();
    if (result.status !== "ok") return GROUP_BOTS_EQUAL_RIGHTS_DEFAULT;
    return result.settings.feishuGroupBotsEqualRights === true;
  } catch {
    return GROUP_BOTS_EQUAL_RIGHTS_DEFAULT;
  }
};

/** 单测覆盖（null = 不覆盖、恒受理）。老的「机器人一律拒」用例靠它钉在放开之前的口径上；生产路径不会设它 */
let botsAllowedOverrideForTest: boolean | null = null;
export const __setGroupBotsAllowedForTest = (v: boolean | null): void => {
  botsAllowedOverrideForTest = v;
};

/**
 * 受理群里别的机器人 @ 本机机器人吗：**恒为是**（没有设置项，2026-11-05 用户：「机器人 @ 和真人一致，不需要配置」）。
 *
 * 受理 ≠ 放权：机器人的消息默认**始终**按「只答疑、不改代码」约束处理（机器人版约束段、不自动 @ 对方、不客套，
 * 见 group-non-owner-prompt）；设置「机器人与真人同权」（{@link isGroupBotsEqualRights}）打开后才跟真人一样看提示词开关。
 * 准入闸的租户 / 外部成员两道照常。只有单测能通过覆盖缝把它压成 false，用来保住「机器人被准入闸拒」那条老路径的覆盖。
 */
export const isGroupBotsAllowed = (): boolean =>
  botsAllowedOverrideForTest ?? true;
