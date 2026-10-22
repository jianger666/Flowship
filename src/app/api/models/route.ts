import { NextResponse } from "next/server";
import { hasUrlUserinfo, redactUrlUserinfo } from "@/lib/custom-provider-url";
import type { CustomProviderFormat } from "@/lib/types";
import {
  listModelOptions,
  parseFormatParam,
  type ModelCatalogSource,
} from "@/lib/server/model-catalog";

export const runtime = "nodejs";

interface RequestBody {
  apiKey?: string;
  /** 有值 = 自定义 provider 路径（baseUrl + apiKey + format） */
  baseUrl?: string;
  format?: CustomProviderFormat;
}

/**
 * 拉可用模型列表
 *
 * - cursor：凭 apiKey 调 Cursor SDK（历史行为）
 * - custom：baseUrl + apiKey + format 走自定义 HTTP provider 的 /v1/models
 *
 * 为什么走 server route：用户的 API key 在 localStorage、模型列表又必须
 * 凭这个 key 调对应接口、所以由前端 POST 上来 + server 端代理调用、
 * 不会暴露给第三方页面。响应里只回必要字段、避免 schema 变化时前端 type 跟着变。
 *
 * 拉取 / 10 分钟内存缓存 / 超时都在 `@/lib/server/model-catalog`（子代理选模型共用）。
 */
export const POST = async (req: Request) => {
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: "无效的请求体" }, { status: 400 });
  }

  let source: ModelCatalogSource;
  if (body.baseUrl) {
    // 自定义 provider：baseUrl 必填；apiKey 允许空（本地无鉴权端点）
    const baseUrl = body.baseUrl.trim();
    if (!baseUrl) {
      return NextResponse.json({ error: "缺少 baseUrl" }, { status: 400 });
    }
    // 含用户名 / 密码的地址 fetch 会直接抛错并把整串（含密钥）回显：不发请求，直接 400 说明原因（不回显地址）
    if (hasUrlUserinfo(baseUrl)) {
      return NextResponse.json(
        { error: "接口地址里带了用户名 / 密码：请把密钥填到 API Key，不要写进地址" },
        { status: 400 },
      );
    }
    source = {
      kind: "custom",
      baseUrl,
      apiKey: body.apiKey?.trim() ?? "",
      format: parseFormatParam(body.format),
    };
  } else {
    const apiKey = body.apiKey?.trim();
    if (!apiKey) {
      return NextResponse.json({ error: "缺少 apiKey" }, { status: 400 });
    }
    source = { kind: "cursor", apiKey };
  }

  try {
    return NextResponse.json({ models: await listModelOptions(source) });
  } catch (err) {
    // 日志 / 响应都擦掉 URL userinfo（地址里带 `user:TOKEN@` 时 fetch 异常消息含整串密钥，D1-05）
    const message = redactUrlUserinfo(err instanceof Error ? err.message : String(err));
    console.error("[/api/models] error:", redactUrlUserinfo(err instanceof Error ? (err.stack ?? err.message) : String(err)));
    // 仅 dev 把 stack 摘要随响应返、production 不泄露 server 路径 / 内部实现
    const detail =
      process.env.NODE_ENV !== "production" &&
      err instanceof Error &&
      err.stack
        ? redactUrlUserinfo(err.stack.split("\n").slice(0, 3).join(" | "))
        : "";
    return NextResponse.json(
      { error: `拉取模型列表失败：${message}${detail ? ` (${detail})` : ""}` },
      { status: 502 }
    );
  }
};
