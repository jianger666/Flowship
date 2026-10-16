/**
 * POST /api/system/open-path
 *
 * Body: { path: string } — 绝对路径；用系统默认应用打开。
 * 可执行 / 脚本 / 快捷方式等危险类型不会被运行，降级为「在文件管理器中显示」（响应带 revealed + notice）；
 * Windows UNC 路径直接 400（避免 SMB / NTLM 外泄）。
 */

import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { NextResponse } from "next/server";

import { buildOpenPathPlan } from "@/lib/local-file-os";

export const runtime = "nodejs";

const runSpawn = (
  command: string,
  args: string[],
  opts?: { ignoreNonZeroExit?: boolean },
): Promise<string | null> =>
  new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => resolve(`无法执行 ${command}`));
    child.on("exit", (code) => {
      if (code === 0 || opts?.ignoreNonZeroExit) resolve(null);
      else resolve(`打开失败（退出码 ${code ?? "?"}）`);
    });
    child.unref();
  });

export const POST = async (req: Request) => {
  let body: { path?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "body 不是合法 JSON" }, { status: 400 });
  }
  const p = (body.path ?? "").trim();
  if (!p) return NextResponse.json({ error: "path 必填" }, { status: 400 });
  if (!path.isAbsolute(p) && !/^[a-zA-Z]:[\\/]/.test(p)) {
    return NextResponse.json({ error: "path 必须是绝对路径" }, { status: 400 });
  }

  const plan = buildOpenPathPlan(p, os.platform());
  if (plan.kind === "reject") {
    return NextResponse.json({ error: plan.error }, { status: 400 });
  }
  const { command, args, ignoreNonZeroExit } = plan.spec;
  const failure = await runSpawn(command, args, { ignoreNonZeroExit });
  if (failure) return NextResponse.json({ error: failure }, { status: 400 });
  if (plan.kind === "reveal") {
    return NextResponse.json({ ok: true, revealed: true, notice: plan.notice });
  }
  return NextResponse.json({ ok: true });
};
