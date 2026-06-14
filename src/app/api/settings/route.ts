/**
 * 配置文件读写 route（V0.7.16）—— 配置从 localStorage 迁到 data/config.json
 *
 * 落 `dataRoot()/config.json`（跟 FE_AI_FLOW_DATA_DIR、Electron 下在 userData/data）：
 * 明文 JSON、不绑 origin、主进程也能读、备份 / 同步 test 直接拷文件。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";

import { dataRoot } from "@/lib/server/data-root";
import { errorResponse } from "@/lib/server/route-helpers";

export const runtime = "nodejs";

const configPath = (): string => path.join(dataRoot(), "config.json");

/**
 * 读配置：GET /api/settings → { exists, settings }
 * 文件不存在返 exists:false（前端据此走「首次从 localStorage 迁移」分支）
 */
export const GET = async (): Promise<Response> => {
  try {
    const raw = await fs.readFile(configPath(), "utf-8");
    return NextResponse.json({ exists: true, settings: JSON.parse(raw) });
  } catch (err) {
    // ENOENT = 还没迁移过、正常；其它错误（损坏 / 权限）也当不存在、让前端 fallback localStorage
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[/api/settings] 读 config.json 失败:", err);
    }
    return NextResponse.json({ exists: false, settings: null });
  }
};

/**
 * 写配置：PUT /api/settings、body = 整份 settings 对象
 * 原子写（tmp + rename）防写一半损坏（沿用 task-fs 的 meta 落盘方式）
 */
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
    const dir = dataRoot();
    await fs.mkdir(dir, { recursive: true });
    const finalPath = configPath();
    const tmpPath = `${finalPath}.tmp.${process.pid}.${Math.random()
      .toString(36)
      .slice(2)}`;
    await fs.writeFile(tmpPath, JSON.stringify(body, null, 2), "utf-8");
    await fs.rename(tmpPath, finalPath);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[/api/settings] 写 config.json 失败:", err);
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(`保存配置失败：${message}`, 500);
  }
};
