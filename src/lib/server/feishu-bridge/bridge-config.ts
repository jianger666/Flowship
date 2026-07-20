/**
 * 飞书桥接配置读取（开关 / 数据目录 / 深链协议）
 *
 * 开关落在 `<dataRoot>/config.json`（与设置页同源）；本模块只读、不写。
 */

import path from "node:path";

import { dataRoot, ensurePrivateDir } from "@/lib/server/data-root";
import { readSettingsFile } from "@/lib/server/settings-fs";

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
