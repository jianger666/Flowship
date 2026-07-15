/**
 * GET /api/settings/full → { exists, settings }（**全量、含明文密钥**）
 *
 * CR-01：默认的 /api/settings GET 已脱敏；本路由是唯一的全量读取口、
 * 专给 client 启动初始化（local-store.initSettings）灌 cache 用。
 * 访问面收敛：服务端只绑 127.0.0.1（启动脚本 -H / Electron HOSTNAME）+
 * middleware 校验 Host/Origin 是 loopback、非本机页面拿不到。
 *
 * P1-04：config 损坏 / 权限失败 → 500 settings_unreadable（不得当 exists:false 首次迁移）。
 */
import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/server/route-helpers";
import { readSettingsFile } from "@/lib/server/settings-fs";

export const runtime = "nodejs";

export const GET = async (): Promise<Response> => {
  const result = await readSettingsFile();
  if (result.status === "missing") {
    return NextResponse.json({ exists: false, settings: null });
  }
  if (result.status === "error") {
    console.error("[/api/settings/full] config.json 不可读:", result.reason);
    return errorResponse("settings_unreadable", 500);
  }
  return NextResponse.json({ exists: true, settings: result.settings });
};
