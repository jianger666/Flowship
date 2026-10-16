/**
 * POST /api/system/reveal-in-folder
 *
 * Body: { path: string } — 绝对路径；在系统文件管理器中选中该文件。
 */

import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { NextResponse } from "next/server";

import { buildRevealInFolderSpec, isWindowsUncPath } from "@/lib/local-file-os";

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

  // UNC / 设备路径：explorer /select 也会主动连 SMB（NTLM 外泄），与 open-path 同口径拒绝；
  // 双引号会破坏 `/select,"..."` 单 argv 的引用。
  if (os.platform() === "win32" && (isWindowsUncPath(p) || p.includes('"'))) {
    return NextResponse.json(
      { error: "出于安全考虑，不支持网络共享（UNC）路径或含双引号的路径" },
      { status: 400 },
    );
  }

  const { command, args, ignoreNonZeroExit } = buildRevealInFolderSpec(
    p,
    os.platform(),
  );
  const failure = await runSpawn(command, args, { ignoreNonZeroExit });
  if (failure) return NextResponse.json({ error: failure }, { status: 400 });
  return NextResponse.json({ ok: true });
};
