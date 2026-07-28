/**
 * 飞书桥接配置读取（开关 / 数据目录 / 深链协议）
 *
 * 开关落在 `<dataRoot>/config.json`（与设置页同源）；本模块只读、不写。
 */

import path from "node:path";

import { dataRoot, ensurePrivateDir } from "@/lib/server/data-root";
import { readSettingsFile } from "@/lib/server/settings-fs";
import type { GroupAutoBroadcast } from "@/lib/types";

/** 桥接落盘根：card-map、下载临时文件等 */
export const getBridgeDataDir = async (): Promise<string> => {
  const dir = path.join(dataRoot(), "feishu-bridge");
  await ensurePrivateDir(dir);
  return dir;
};

/**
 * 是否 test 实例——与 electron-app/main.js 对齐：
 * env `FLOWSHIP_TEST=1`，或 dataDir 指向 `fe-ai-flow-test`。
 */
export const isBridgeTestInstance = (): boolean => {
  if (process.env.FLOWSHIP_TEST === "1") return true;
  const dir = process.env.FLOWSHIP_DATA_DIR ?? "";
  return dir.includes("fe-ai-flow-test");
};

// 卡片深链入口已整体移除（2026-07-20 用户拍板）：飞书不放行自定义协议链接、
// http 跳板必开一页浏览器体验差——「在 app 中打开」不要了。
// 壳侧 flowship[-test]:// 协议注册保留（deep-link-handler 仍可被其它入口唤起）。

/** 全局桥接开关（默认关——用户在设置页显式打开） */
export const isFeishuChatBridgeEnabled = async (): Promise<boolean> => {
  const result = await readSettingsFile();
  if (result.status !== "ok") return false;
  return result.settings.feishuChatBridge === true;
};

/** 插电防休眠子开关（默认开；仅桥接开启时才有意义） */
export const isFeishuBridgeKeepAwakeEnabled = async (): Promise<boolean> => {
  const result = await readSettingsFile();
  if (result.status !== "ok") return true;
  const v = result.settings.feishuBridgeKeepAwake;
  // 缺省 / 非 false → true（决策 #14）
  return v !== false;
};

/** 流式回复子开关（默认开；关则 finalize 一次性发整卡） */
export const isFeishuBridgeStreamingEnabled = async (): Promise<boolean> => {
  const result = await readSettingsFile();
  if (result.status !== "ok") return true;
  const v = result.settings.feishuBridgeStreaming;
  // 缺省 / 非 false → true
  return v !== false;
};

/**
 * 需求群协作行为：**固定策略、不再是用户设置**（2026-07-28 用户拍板砍掉三个开关，
 * 原话「不需要那么多个性化挂设置」）。原 `settings.groupCollab` 字段已从 schema 删除。
 *
 * 一句话原则：**默认不主动吵群，但别人主动在群里发起的操作一定有回应。**
 *
 * 底层三条链（ask 卡发群 / 推进结果回群 / action 完成播报）全部保留、只是入参写死——
 * 以后想放开（重新挂设置或分场景差异化）只需改这里的常量，下游一行不用动。
 */
export const GROUP_COLLAB_POLICY: {
  askToGroup: boolean;
  advanceResultToGroup: boolean;
  autoBroadcast: GroupAutoBroadcast;
} = {
  // 每次 ask_user 都往群里发卡太吵。用户自己在 app 里答；要别人帮忙时手动「分享到群」
  askToGroup: false,
  // 群里点了推进却看不到结果、这功能就废了
  advanceResultToGroup: true,
  // 每个 action 跑完都刷群太吞
  autoBroadcast: "off",
};

/** ask_user 答题卡是否同步发需求群 */
export const isAskToGroupEnabled = async (): Promise<boolean> =>
  GROUP_COLLAB_POLICY.askToGroup;

/** 群内推进跑完是否自动把产物发回群 */
export const isAdvanceResultToGroupEnabled = async (): Promise<boolean> =>
  GROUP_COLLAB_POLICY.advanceResultToGroup;

/** app 内 action 跑完的自动播报档位 */
export const getGroupAutoBroadcastMode =
  async (): Promise<GroupAutoBroadcast> => GROUP_COLLAB_POLICY.autoBroadcast;
