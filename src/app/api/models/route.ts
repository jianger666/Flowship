import { NextResponse } from "next/server";
import { Cursor } from "@cursor/sdk";
import type { ModelOption } from "@/lib/types";

export const runtime = "nodejs";

interface RequestBody {
  apiKey?: string;
}

// SDK 卡死时不能让 route 一直挂着、超过这个就当失败处理
const SDK_TIMEOUT_MS = 15_000;

// server 内存缓存（V0.7.13）：SDK models.list 实测 5-15s、各入口（设置 / 新建任务 /
// 切模型）反复拉很折磨——按 apiKey 缓存 10 分钟、命中毫秒级返回。
// 配合客户端 localStorage SWR（use-models.ts）、后台刷新也基本秒回
const CACHE_TTL_MS = 10 * 60 * 1000;
const modelsCache = new Map<string, { models: ModelOption[]; ts: number }>();

// SDK 返回的 ModelListItem schema 比较杂、只挑前端实际要用的字段透传
// 这样 SDK 升级加新字段不会立刻影响到前端 type / 攻击面也小
const pickModelFields = (
  m: Awaited<ReturnType<typeof Cursor.models.list>>[number]
): ModelOption => ({
  id: m.id,
  displayName: m.displayName ?? m.id,
  description: m.description,
  parameters: m.parameters,
  variants: m.variants,
});

// 给一个 promise 加超时；超时 reject 一个特定 Error 让上层识别
const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${label} 超时（${ms}ms）`)),
      ms
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });

/**
 * 拉 Cursor SDK 可用模型列表
 *
 * 为什么走 server route：用户的 API key 在 localStorage、模型列表又必须
 * 凭这个 key 调 Cursor 接口、所以由前端 POST 上来 + server 端代理调用、
 * 不会暴露给第三方页面。响应里只回必要字段、避免 SDK schema 变化时
 * 前端 type 跟着变。
 *
 * 错误处理：
 * - SDK 卡死 → withTimeout 15s 后报失败、避免 route 永久挂起
 * - 错误响应只在 dev 时附带 stack 摘要、production 下不泄露 server 路径
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

  // 命中且未过期：直接返回（不打 SDK）
  const hit = modelsCache.get(apiKey);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) {
    return NextResponse.json({ models: hit.models });
  }

  try {
    const models = await withTimeout(
      Cursor.models.list({ apiKey }),
      SDK_TIMEOUT_MS,
      "拉取模型"
    );
    // 按 displayName 字母排序、避免 SDK 返回顺序看着乱
    const options: ModelOption[] = models
      .map(pickModelFields)
      .sort((a, b) =>
        a.displayName.localeCompare(b.displayName, "en", { sensitivity: "base" })
      );
    modelsCache.set(apiKey, { models: options, ts: Date.now() });
    return NextResponse.json({ models: options });
  } catch (err) {
    // SDK 经常抛 Error("Error")、message 没信息量、所以连 stack 一起打到 server log
    console.error("[/api/models] error:", err);
    const message = err instanceof Error ? err.message : String(err);
    // 仅 dev 把 stack 摘要随响应返、production 不泄露 server 路径 / 内部实现
    const detail =
      process.env.NODE_ENV !== "production" &&
      err instanceof Error &&
      err.stack
        ? err.stack.split("\n").slice(0, 3).join(" | ")
        : "";
    return NextResponse.json(
      { error: `拉取模型列表失败：${message}${detail ? ` (${detail})` : ""}` },
      { status: 502 }
    );
  }
};
