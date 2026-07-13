/**
 * 配置文件读写 route（V0.7.16）—— 配置从 localStorage 迁到 data/config.json
 *
 * 落 `dataRoot()/config.json`（跟 FE_AI_FLOW_DATA_DIR、Electron 下在 userData/data）：
 * 明文 JSON、不绑 origin、主进程也能读、备份 / 同步 test 直接拷文件。
 */
import { promises as fs } from "node:fs";
import { NextResponse } from "next/server";

import { dataRoot } from "@/lib/server/data-root";
import { errorResponse } from "@/lib/server/route-helpers";
import {
  maskSettingsSecrets,
  preserveSecretsOnPut,
  readSettingsFile,
  settingsFilePath,
} from "@/lib/server/settings-fs";

export const runtime = "nodejs";

const configPath = (): string => settingsFilePath();

/**
 * 读配置：GET /api/settings → { exists, settings }（**脱敏**：apiKey / gitToken 掩码）
 *
 * CR-01：默认口径不再全量导出密钥——client 初始化要拿真值走 `/api/settings/full`
 * （仅 loopback、middleware 已强制）。文件不存在返 exists:false。
 */
export const GET = async (): Promise<Response> => {
  const settings = await readSettingsFile();
  if (!settings) {
    return NextResponse.json({ exists: false, settings: null });
  }
  return NextResponse.json({
    exists: true,
    settings: maskSettingsSecrets(settings),
  });
};

/**
 * 写配置：PUT /api/settings、body = 整份 settings 对象、返 { ok, settings: 最终盘上内容 }
 * 原子写（tmp + rename）防写一半损坏（沿用 task-fs 的 meta 落盘方式）。
 *
 * CR-01：响应里的 settings 也脱敏。
 * CR-08：写操作串行化（进程级 promise chain）——两个快速 PUT 不会乱序互相覆盖、
 * 后到的请求一定后落盘。
 */

// 写队列单例（dev 多 chunk 共享 globalThis、对齐 preview-manager 的做法）
const WRITE_QUEUE_KEY = "__feAiFlowSettingsWriteQueueV1__";
const getWriteQueue = (): { current: Promise<void> } => {
  const g = globalThis as unknown as Record<string, { current: Promise<void> } | undefined>;
  if (!g[WRITE_QUEUE_KEY]) g[WRITE_QUEUE_KEY] = { current: Promise.resolve() };
  return g[WRITE_QUEUE_KEY]!;
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
    const dir = dataRoot();
    await fs.mkdir(dir, { recursive: true });
    const finalPath = configPath();
    // 掩码值兜底（不是「防清空」守卫——用户拍板「自己清 key 是合法操作、别拦」）：
    // 只拦「client 误把脱敏展示值当真值回写」这一种明确的坏数据；清空放行
    const current = await readSettingsFile();
    const { settings: guarded } = preserveSecretsOnPut(
      body as Record<string, unknown>,
      current,
    );
    const tmpPath = `${finalPath}.tmp.${process.pid}.${Math.random()
      .toString(36)
      .slice(2)}`;
    await fs.writeFile(tmpPath, JSON.stringify(guarded, null, 2), "utf-8");
    await fs.rename(tmpPath, finalPath);
    const finalRaw = await fs.readFile(finalPath, "utf-8");
    return NextResponse.json({
      ok: true,
      settings: maskSettingsSecrets(JSON.parse(finalRaw) as Record<string, unknown>),
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
