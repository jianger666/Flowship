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

/** 自定义协议深链：正式 `flowship://`、test `flowship-test://`（壳注册的 scheme） */
export const getProtocolDeepLink = (taskId: string): string => {
  const scheme = isBridgeTestInstance() ? "flowship-test" : "flowship";
  return `${scheme}://tasks/${encodeURIComponent(taskId)}`;
};

/**
 * 飞书卡片用的深链（2026-07-19 用户实测踩坑后改跳板方案）：
 * 飞书客户端不放行卡片里的自定义协议链接（点了毫无反应）——改为本机 http 跳板页
 * `http://127.0.0.1:<本实例端口>/open/task/<id>`，页面里再跳 flowship[-test]:// 唤起壳。
 * 端口按本实例 PORT 环境变量生成（test 8776 / 正式 8876），天然区分环境不串台。
 */
export const getDeepLink = (taskId: string): string => {
  const port =
    Number(process.env.PORT) || (isBridgeTestInstance() ? 8776 : 8876);
  return `http://127.0.0.1:${port}/open/task/${encodeURIComponent(taskId)}`;
};

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
