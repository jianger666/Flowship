/**
 * 「更新已就位、等重启」检测（V0.10.1、2026-07-07 线上事故沉淀）
 *
 * 背景：mac 壳自更新会原地替换 /Applications 里的 .app（macSelfUpdate）。用户在
 * 「更新完成」弹窗点「稍后」后、老进程继续跑在已被替换的 bundle 上——此后 SDK 沙箱的
 * zsh state-dump helper 因 bundle 资源失配永久挂死、任何新起的 agent run 第一条
 * shell 调用就永远不返回、任务假死在「运行中」（v0.9.10 → v0.9.14 实测事故）。
 *
 * 机制：壳替换成功后写 marker（<dataRoot>/update-pending-restart.json、含新版本号）、
 * 壳下次启动时删掉。server 在所有「起新 agent run」的入口查 marker、存在就拒绝、
 * 提示必须重启——已在跑的 run（更新前起的、仍健康）不受影响。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { dataRoot } from "@/lib/server/data-root";

const markerPath = (): string =>
  path.join(dataRoot(), "update-pending-restart.json");

/**
 * 查「更新就位未重启」marker：存在返回给用户看的拒绝文案（透传 UI toast）、不存在返 null。
 * dev（无壳）永远没有 marker、天然放行。
 */
export const checkUpdatePendingRestart = async (): Promise<string | null> => {
  let raw: string;
  try {
    raw = await fs.readFile(markerPath(), "utf8");
  } catch {
    return null; // 没 marker、正常放行
  }
  let version = "";
  try {
    version = (JSON.parse(raw) as { version?: string }).version ?? "";
  } catch {
    // marker 内容坏了照样拦——文件存在本身就是「已替换未重启」的信号
  }
  return `应用已更新${version ? `到 v${version}` : ""}、但还没重启——老进程继续起任务会永久卡死（shell 挂起）。请重启应用后再运行。`;
};

/** 起新 agent run 前的硬闸：marker 存在直接抛（消息由 API 层透传到前端 toast） */
export const assertNoUpdatePendingRestart = async (): Promise<void> => {
  const msg = await checkUpdatePendingRestart();
  if (msg) throw new Error(msg);
};
