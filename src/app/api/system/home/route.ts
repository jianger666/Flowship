import { NextResponse } from "next/server";
import os from "node:os";

export const runtime = "nodejs";

/**
 * 返回当前用户主目录（os.homedir()）
 *
 * 自由对话未绑工作目录时、agent 默认落在主目录跑（见 chat-runner）。前端拿不到
 * os.homedir()、走这个轻量接口把真实路径显示给用户（别只写抽象的「主目录」）。
 * 进程内几乎不变、客户端 module 级缓存一次即可（见 use-home-dir.ts）。
 */
export const GET = async () => NextResponse.json({ home: os.homedir() });
