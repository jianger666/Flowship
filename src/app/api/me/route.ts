import { NextResponse } from "next/server";
import { Cursor } from "@cursor/sdk";
import type { ApiKeyInfo } from "@/lib/types";

export const runtime = "nodejs";

interface RequestBody {
  apiKey?: string;
}

// SDK 卡死时不能让 route 一直挂着、超过这个就当失败处理
const SDK_TIMEOUT_MS = 15_000;

// server 内存缓存：me 信息几乎不变、按 apiKey 缓存 10 分钟、命中毫秒返回
// （配合客户端 localStorage SWR、跟 /api/models 一套路子）
const CACHE_TTL_MS = 10 * 60 * 1000;
const meCache = new Map<string, { info: ApiKeyInfo; ts: number }>();

// 只挑前端要展示的字段透传（SDK schema 变化不直接波及前端）
const pickFields = (u: Awaited<ReturnType<typeof Cursor.me>>): ApiKeyInfo => ({
  apiKeyName: u.apiKeyName,
  userId: u.userId,
  userEmail: u.userEmail,
  userFirstName: u.userFirstName,
  userLastName: u.userLastName,
  createdAt: u.createdAt,
});

// 给 promise 加超时；超时 reject 让上层识别
const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${label} 超时（${ms}ms）`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });

/**
 * 拉 API Key 归属信息（Cursor.me）
 *
 * 为什么走 server route：跟 /api/models 同理——用户 apiKey 在 localStorage、
 * 必须凭它调 Cursor 接口、由前端 POST 上来 server 端代理、不暴露给第三方页面。
 */
export const POST = async (req: Request) => {
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: "无效的请求体" }, { status: 400 });
  }

  const apiKey = body.apiKey?.trim();
  if (!apiKey) {
    return NextResponse.json({ error: "缺少 apiKey" }, { status: 400 });
  }

  const hit = meCache.get(apiKey);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) {
    return NextResponse.json({ user: hit.info });
  }

  try {
    const me = await withTimeout(
      Cursor.me({ apiKey }),
      SDK_TIMEOUT_MS,
      "获取账号信息",
    );
    const info = pickFields(me);
    meCache.set(apiKey, { info, ts: Date.now() });
    return NextResponse.json({ user: info });
  } catch (err) {
    console.error("[/api/me] error:", err);
    const message = err instanceof Error ? err.message : String(err);
    const detail =
      process.env.NODE_ENV !== "production" && err instanceof Error && err.stack
        ? err.stack.split("\n").slice(0, 3).join(" | ")
        : "";
    return NextResponse.json(
      { error: `获取账号信息失败：${message}${detail ? ` (${detail})` : ""}` },
      { status: 502 },
    );
  }
};
