/**
 * POST /api/system/open-path
 *
 * Body: { path: string } — 绝对路径；用系统默认应用打开。
 * 可执行 / 脚本 / 快捷方式等危险类型不会被运行，降级为「在文件管理器中显示」（响应带 revealed + notice）；
 * UNC / 设备路径（任何平台）与 Windows 下非盘符路径一律 400（避免 SMB / NTLM 外泄），与 reveal-in-folder /
 * open-in-ide 同一份白名单 {@link nonLocalPathReason}（Q4-05：Windows 下 NT 命名空间前缀 UNC、`/C:/x`、`/c/Users` 等原先能走到 open）。
 */

import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { NextResponse } from "next/server";

import { buildOpenPathPlan } from "@/lib/local-file-os";
import { stripHostInjectedEnv } from "@/lib/server/host-env";
import { nonLocalPathReason } from "@/lib/unc-path";

export const runtime = "nodejs";

const runSpawn = (
  command: string,
  args: string[],
  opts?: { ignoreNonZeroExit?: boolean },
): Promise<string | null> =>
  new Promise((resolve) => {
    // env 剔宿主注入变量：默认应用常是 Electron 系（VS Code 等），吃到 ELECTRON_RUN_AS_NODE=1 会被当纯 node 秒退（R10b-05）
    const child = spawn(command, args, {
      stdio: "ignore",
      detached: true,
      env: stripHostInjectedEnv(),
    });
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
  // 统一白名单放在绝对路径校验之前：`//host/share` 在 posix 上 isAbsolute 为真（Q4-05）
  const nonLocal = nonLocalPathReason(p);
  if (nonLocal) return NextResponse.json({ error: nonLocal }, { status: 400 });
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
