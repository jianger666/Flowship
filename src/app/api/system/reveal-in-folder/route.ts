/**
 * POST /api/system/reveal-in-folder
 *
 * Body: { path: string } — 绝对路径；在系统文件管理器中选中该文件。
 */

import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { NextResponse } from "next/server";

import { buildRevealInFolderSpec } from "@/lib/local-file-os";

export const runtime = "nodejs";

const runSpawn = (command: string, args: string[]): Promise<string | null> =>
  new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => resolve(`无法执行 ${command}`));
    child.on("exit", (code) => {
      if (code === 0) resolve(null);
      else resolve(`在文件夹中显示失败（退出码 ${code ?? "?"}）`);
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

  const { command, args } = buildRevealInFolderSpec(p, os.platform());
  const failure = await runSpawn(command, args);
  if (failure) return NextResponse.json({ error: failure }, { status: 400 });
  return NextResponse.json({ ok: true });
};
