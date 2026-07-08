/**
 * POST /api/system/open-in-ide
 *
 * 用本机 IDE 打开文件 / 目录（V0.11.8）。JetBrains 系（idea / webstorm）跳转走这里——
 * `idea://` 协议只有 JetBrains Toolbox 会注册、直接装 IDEA 的机器点协议链接弹
 * 「找不到应用」（用户同事 Windows 实测）；后端探测安装位置直接 spawn、不依赖协议。
 *
 * Body: { ide: "idea" | "webstorm" | "cursor" | "vscode", path: string, line?: number }
 * 返回 { ok: true } 或 { error: 给用户看的原因 }
 */

import { NextResponse } from "next/server";
import { openInIde } from "@/lib/server/ide-tools";
import type { JumpIde } from "@/lib/types";

export const runtime = "nodejs";

const VALID_IDES = new Set<string>(["cursor", "vscode", "idea", "webstorm"]);

export const POST = async (req: Request) => {
  let body: { ide?: string; path?: string; line?: number };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "body 不是合法 JSON" }, { status: 400 });
  }
  const ide = (body.ide ?? "").trim();
  const p = (body.path ?? "").trim();
  if (!VALID_IDES.has(ide)) {
    return NextResponse.json({ error: `ide 非法：${ide}` }, { status: 400 });
  }
  if (!p) return NextResponse.json({ error: "path 必填" }, { status: 400 });
  const line =
    typeof body.line === "number" && Number.isFinite(body.line) && body.line > 0
      ? Math.floor(body.line)
      : undefined;

  const failure = await openInIde(ide as JumpIde, p, line);
  if (failure) return NextResponse.json({ error: failure }, { status: 400 });
  return NextResponse.json({ ok: true });
};
