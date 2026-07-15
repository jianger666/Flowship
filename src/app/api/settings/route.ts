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
  preserveSecretsOnPut,
  readSettingsFile,
  writeSettingsFileAtomic,
} from "@/lib/server/settings-fs";
import { DEFAULT_MEEGLE_PROJECT } from "@/lib/types";

export const runtime = "nodejs";

/**
 * 写配置：PUT /api/settings、body = 整份 settings 对象、返 { ok, settings: 最终盘上内容 }
 * 原子写（tmp + rename）防写一半损坏（沿用 task-fs 的 meta 落盘方式）。
 *
 * CR-01：响应里的 settings 也脱敏。
 * CR-08：写操作串行化（进程级 promise chain）——两个快速 PUT 不会乱序互相覆盖、
 * 后到的请求一定后落盘。
 * P1-04：读失败（error）拒绝写入，避免用客户端缓存覆盖损坏但可能可修复的原文件。
 */

// 写队列单例（dev 多 chunk 共享 globalThis、对齐 preview-manager 的做法）
const WRITE_QUEUE_KEY = "__feAiFlowSettingsWriteQueueV1__";
const getWriteQueue = (): { current: Promise<void> } => {
  const g = globalThis as unknown as Record<string, { current: Promise<void> } | undefined>;
  if (!g[WRITE_QUEUE_KEY]) g[WRITE_QUEUE_KEY] = { current: Promise.resolve() };
  return g[WRITE_QUEUE_KEY]!;
};

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
  // 串行执行写入：挂到队列尾、前一个写完才轮到自己（失败也不断链）
  const queue = getWriteQueue();
  const run = queue.current.then(async (): Promise<Response> => {
    const currentResult = await readSettingsFile();
    // 文件损坏 / 权限失败：拒绝覆盖（missing 才允许首次写入）
    if (currentResult.status === "error") {
      console.error(
        "[/api/settings] PUT 拒绝：config.json 不可读:",
        currentResult.reason,
      );
      return errorResponse("settings_unreadable", 500);
    }
    const current =
      currentResult.status === "ok" ? currentResult.settings : null;
    // 掩码值兜底（不是「防清空」守卫——用户拍板「自己清 key 是合法操作、别拦」）：
    // 只拦「client 误把脱敏展示值当真值回写」这一种明确的坏数据；清空放行
    const { settings: guarded } = preserveSecretsOnPut(
      body as Record<string, unknown>,
      current,
    );
    // 默认空间 key 变了 → 收件箱缓存作废（否则仍显示旧空间扫到的条目）
    const oldKey = meegleProjectKeyOf(current?.meegleProject);
    const newKey = meegleProjectKeyOf(guarded.meegleProject);
    if (oldKey !== newKey) {
      invalidateMrInboxCache();
    }
    // P0-02：0600 + 目录 0700 + tmp/rename（writeSettingsFileAtomic）
    await writeSettingsFileAtomic(guarded);
    return NextResponse.json({
      ok: true,
      settings: maskSettingsSecrets(guarded),
    });
  });
  // 队列指针只关心「上一个写是否结束」、错误在本请求消费、不传染下一个
  queue.current = run.then(
    () => undefined,
    () => undefined,
  );
  try {
    return await run;
  } catch (err) {
    console.error("[/api/settings] 写 config.json 失败:", err);
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(`保存配置失败：${message}`, 500);
  }
};
