/**
 * 配置文件写 route（V0.7.16）—— 配置从 localStorage 迁到 data/config.json
 *
 * 落 `dataRoot()/config.json`（跟 FE_AI_FLOW_DATA_DIR、Electron 下在 userData/data）：
 * 明文 JSON、不绑 origin、主进程也能读、备份 / 同步 test 直接拷文件。
 *
 * 读配置走 `/api/settings/full`（仅 loopback、拿真值）；本 route 只保留 PUT。
 */
import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/server/route-helpers";
import { invalidateMrInboxCache } from "@/lib/server/mr-inbox-scanner";
import {
  maskSettingsSecrets,
  putSettingsFile,
} from "@/lib/server/settings-fs";
import { DEFAULT_MEEGLE_PROJECT } from "@/lib/types";

export const runtime = "nodejs";

/**
 * 写配置：PUT /api/settings、body = 整份 settings 对象、返 { ok, settings: 最终盘上内容 }
 * 原子写（tmp + rename）防写一半损坏（沿用 task-fs 的 meta 落盘方式）。
 *
 * CR-01：响应里的 settings 也脱敏。
 * CR-08：读改写串行化在 settings-fs.putSettingsFile（globalThis 写链）——
 * 两个快速 PUT 不会乱序互相覆盖。
 * 读失败（error）拒绝写入，避免用客户端缓存覆盖损坏但可能可修复的原文件。
 */

/** 从 settings 对象抠 meegleProject.key（缺 / 坏 → 默认悟空 key） */
const meegleProjectKeyOf = (raw: unknown): string => {
  if (!raw || typeof raw !== "object") return DEFAULT_MEEGLE_PROJECT.key;
  const key = (raw as { key?: unknown }).key;
  return typeof key === "string" && key.trim()
    ? key
    : DEFAULT_MEEGLE_PROJECT.key;
};

export const PUT = async (req: Request): Promise<Response> => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse("无效的请求体", 400);
  }
  if (!body || typeof body !== "object") {
    return errorResponse("配置必须是对象", 400);
  }
  try {
    // RMW 整段在 settings-fs 写链内（审查：锁只包 write 锁不住 route 侧合并）
    const result = await putSettingsFile(body as Record<string, unknown>);
    if (result.status === "unreadable") {
      console.error(
        "[/api/settings] PUT 拒绝：config.json 不可读:",
        result.reason,
      );
      return errorResponse("settings_unreadable", 500);
    }
    const { settings: guarded, previous } = result;
    // 默认空间 key 变了 → 收件箱缓存作废（否则仍显示旧空间扫到的条目）
    const oldKey = meegleProjectKeyOf(previous?.meegleProject);
    const newKey = meegleProjectKeyOf(guarded.meegleProject);
    if (oldKey !== newKey) {
      invalidateMrInboxCache();
    }
    // Windows Agent shell 偏好：落盘后立刻改 process.env.SHELL，用户拨开关不用重启
    try {
      const { applyAgentShellPreference } = await import(
        "@/lib/server/agent-shell"
      );
      await applyAgentShellPreference();
    } catch (err) {
      console.warn(
        "[/api/settings] 应用 Agent shell 偏好失败（配置已保存）:",
        err instanceof Error ? err.message : err,
      );
    }
    return NextResponse.json({
      ok: true,
      settings: maskSettingsSecrets(guarded),
    });
  } catch (err) {
    console.error("[/api/settings] 写 config.json 失败:", err);
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(`保存配置失败：${message}`, 500);
  }
};
