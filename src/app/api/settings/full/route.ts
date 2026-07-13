/**
 * GET /api/settings/full → { exists, settings }（**全量、含明文密钥**）
 *
 * CR-01：默认的 /api/settings GET 已脱敏；本路由是唯一的全量读取口、
 * 专给 client 启动初始化（local-store.initSettings）灌 cache 用。
 * 访问面收敛：服务端只绑 127.0.0.1（启动脚本 -H / Electron HOSTNAME）+
 * middleware 校验 Host/Origin 是 loopback、非本机页面拿不到。
 */
import { NextResponse } from "next/server";

import { readSettingsFile } from "@/lib/server/settings-fs";

export const runtime = "nodejs";

export const GET = async (): Promise<Response> => {
  const settings = await readSettingsFile();
  if (!settings) {
    return NextResponse.json({ exists: false, settings: null });
  }
  return NextResponse.json({ exists: true, settings });
};
