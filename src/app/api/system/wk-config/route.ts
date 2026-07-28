/**
 * GET/PUT /api/system/wk-config
 *
 * 设置页「团队 wk 流程」：读写本机 `~/.wk/config.yaml` 里我们托管的几个键。
 * 业务逻辑在 `@/lib/server/wk-config`（键级合并、保留同事配的其它键），本文件只做 HTTP 壳。
 */

import { NextResponse } from "next/server";

import { isAbsolutePathLike } from "@/lib/path-utils";
import { errorResponse } from "@/lib/server/route-helpers";
import { readWkConfig, wkConfigPath, writeWkConfig } from "@/lib/server/wk-config";
import { normalizeHubUrl } from "@/lib/wk-hub";
import type { WkConfig, WkConfigInput } from "@/lib/wk-config";

export const runtime = "nodejs";

/** 当前配置 + 文件路径（路径给 UI 显示「写到哪」） */
export const GET = async () => {
  try {
    return NextResponse.json({
      config: await readWkConfig(),
      path: wkConfigPath(),
    });
  } catch (err) {
    console.error("[GET /api/system/wk-config] failed", err);
    return NextResponse.json(
      {
        error: "read_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
};

export const PUT = async (req: Request) => {
  let body: { config?: Partial<WkConfig> };
  try {
    body = (await req.json()) as { config?: Partial<WkConfig> };
  } catch {
    return errorResponse("请求体不是合法 JSON");
  }

  const raw = body.config;
  if (!raw || typeof raw !== "object") {
    return errorResponse("缺少 config");
  }

  const docRepoPath =
    typeof raw.docRepoPath === "string" ? raw.docRepoPath.trim() : "";
  if (docRepoPath && !isAbsolutePathLike(docRepoPath)) {
    return errorResponse(`WK产出目录要填绝对路径：${docRepoPath}`);
  }

  const hubRaw = typeof raw.hubBaseUrl === "string" ? raw.hubBaseUrl.trim() : "";
  const hubBaseUrl = hubRaw ? normalizeHubUrl(hubRaw) : "";
  if (hubRaw && !hubBaseUrl) {
    return errorResponse(`Delivery Hub 地址格式不对：${hubRaw}`);
  }

  // 客户端只能定这两项；两个 require_* 由 applyWkConfig 固定写 true（有地址时），
  // 没地址时三个 delivery_hub 键一起删（官方脚本 require_* 缺 base_url 会 FAIL 挡住 wk:*）
  const config: WkConfigInput = {
    docRepoPath,
    hubBaseUrl: hubBaseUrl || "",
  };

  try {
    await writeWkConfig(config);
    // 回读落盘结果：UI 拿到的永远是文件里的真值、不是它自己发过来的草稿
    return NextResponse.json({ config: await readWkConfig() });
  } catch (err) {
    console.error("[PUT /api/system/wk-config] failed", err);
    return NextResponse.json(
      {
        error: "write_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
};
