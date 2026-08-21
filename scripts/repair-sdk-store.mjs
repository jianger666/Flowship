#!/usr/bin/env node
/**
 * 诊断并尽量自动修好 Cursor SDK 本地 SQLite store。
 *
 * 同事机器上报 `[internal] unable to open database file` 时跑这个，不必自己去翻
 * 杀毒 / OneDrive。会：测 WAL 能否打开、修 .cursor 目录权限、
 * Windows 上加 Defender 排除项（需要管理员）。
 *
 * ⚠️ 不扫、不改 Cursor IDE 的 chats/projects 数据库——只对目录做写探测和排除。
 *
 * 用法：node scripts/repair-sdk-store.mjs
 * Windows 同事发一次性脚本：仓库根目录 `发给同事-Windows-SDK-store检修/`
 * （.ps1 用 UTF-8 BOM；WinPS 5 无 BOM 会按 GBK 读，中文标点会把引号吃掉）
 */
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const isWin = process.platform === "win32";
const home = os.homedir();
const cursorRoot = path.join(home, ".cursor");
const appData = process.env.APPDATA || "";
const localAppData = process.env.LOCALAPPDATA || "";

/** 只探测这些目录本身，不递归进 chats / projects */
const candidateDirs = () => {
  const dirs = [cursorRoot];
  if (appData) {
    dirs.push(
      path.join(appData, "fe-ai-flow"),
      path.join(appData, "fe-ai-flow-test"),
    );
  }
  if (localAppData) {
    dirs.push(
      path.join(localAppData, "fe-ai-flow"),
      path.join(localAppData, "fe-ai-flow-test"),
    );
  }
  if (process.env.FLOWSHIP_DATA_DIR) dirs.push(process.env.FLOWSHIP_DATA_DIR);
  return [...new Set(dirs.filter(Boolean))];
};

const log = (line) => process.stdout.write(`${line}\n`);
const ok = (line) => log(`  [ok] ${line}`);
const warn = (line) => log(`  [!!] ${line}`);
const info = (line) => log(`  [--] ${line}`);

const oneDriveHints = () => {
  const hints = [];
  const od = process.env.OneDrive || process.env.OneDriveConsumer || "";
  if (od) hints.push(`OneDrive=${od}`);
  for (const key of ["USERPROFILE", "HOME"]) {
    const v = process.env[key];
    if (v && /onedrive/i.test(v)) hints.push(`${key} 含 OneDrive：${v}`);
  }
  if (od && cursorRoot.toLowerCase().startsWith(od.toLowerCase())) {
    hints.push(`.cursor 落在 OneDrive 同步目录里：${cursorRoot}`);
  }
  return hints;
};

/** 模拟 SQLite WAL：同时打开 db + wal + shm 并写入。这就是 SQLITE_CANTOPEN 的现场。 */
const probeWal = (dir) => {
  mkdirSync(dir, { recursive: true });
  const stamp = `flowship-wal-probe-${process.pid}`;
  const db = path.join(dir, `${stamp}.db`);
  const wal = `${db}-wal`;
  const shm = `${db}-shm`;
  const fds = [];
  try {
    for (const p of [db, wal, shm]) {
      const fd = openSync(p, "w+");
      fds.push(fd);
      writeSync(fd, Buffer.from("probe"));
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    for (const fd of fds) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    for (const p of [db, wal, shm]) {
      try {
        rmSync(p, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
};

const ensureWritableDir = (dir) => {
  mkdirSync(dir, { recursive: true });
  const probe = path.join(dir, `.flowship-write-${process.pid}`);
  let fd;
  try {
    fd = openSync(probe, "w");
    writeSync(fd, Buffer.from("ok"));
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      rmSync(probe, { force: true });
    } catch {
      /* ignore */
    }
  }
};

const run = (cmd, args) => {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    const e = err;
    const stderr =
      e && typeof e === "object" && "stderr" in e ? String(e.stderr) : "";
    return `__fail__:${stderr || (err instanceof Error ? err.message : String(err))}`;
  }
};

const addDefenderExclusions = (dirs) => {
  if (!isWin) return { skipped: true, needAdmin: false, lines: ["非 Windows，跳过 Defender"] };
  const lines = [];
  let needAdmin = false;
  for (const dir of dirs) {
    const out = run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `try { Add-MpPreference -ExclusionPath '${dir.replace(/'/g, "''")}' -ErrorAction Stop; 'ok' } catch { $_.Exception.Message }`,
    ]);
    if (out === "ok") {
      lines.push(`Defender 已排除 ${dir}`);
    } else if (/access|denied|administrator|权限|0x80070005/i.test(out)) {
      needAdmin = true;
      lines.push(`需要管理员才能排除 ${dir}`);
    } else if (out.startsWith("__fail__")) {
      lines.push(`Defender 排除失败 ${dir}：${out.slice(8).trim()}`);
    } else {
      lines.push(`Defender 排除 ${dir}：${out}`);
    }
  }
  return { skipped: false, needAdmin, lines };
};

const icaclsGrant = (dir) => {
  if (!isWin || !existsSync(dir)) return [];
  const user = process.env.USERNAME || "Users";
  const out = run("icacls", [dir, "/grant", `${user}:(OI)(CI)M`, "/C"]);
  if (out.startsWith("__fail__")) {
    return [`icacls 失败：${out.slice(8).trim()}`];
  }
  return [`已给 ${user} 写权限：${dir}`];
};

const main = () => {
  log("Flowship / Cursor SDK store 一键检修");
  log(`系统 ${process.platform}  ${os.release()}  home=${home}`);
  const od = oneDriveHints();
  if (od.length === 0) ok("家目录看不出 OneDrive 重定向");
  else od.forEach((h) => warn(h));

  const dirs = candidateDirs();
  log("");
  log("1) 目录可写 + WAL 开文件探测（只测目录本身，不动 IDE 数据库）");
  let walFailed = false;
  const existingDirs = [];
  for (const dir of dirs) {
    const exists = existsSync(dir);
    if (!exists) {
      info(`不存在（跳过）${dir}`);
      continue;
    }
    try {
      if (!statSync(dir).isDirectory()) {
        warn(`不是目录 ${dir}`);
        continue;
      }
    } catch (err) {
      warn(`stat 失败 ${dir}：${err instanceof Error ? err.message : err}`);
      continue;
    }
    existingDirs.push(dir);
    const w = ensureWritableDir(dir);
    if (!w.ok) {
      warn(`写不进 ${dir}：${w.error}`);
      walFailed = true;
      continue;
    }
    const wal = probeWal(dir);
    if (wal.ok) ok(`WAL 探测通过 ${dir}`);
    else {
      warn(`WAL 探测失败 ${dir}：${wal.error}`);
      walFailed = true;
    }
  }

  log("");
  log("2) 修 .cursor 权限");
  if (existsSync(cursorRoot)) {
    icaclsGrant(cursorRoot).forEach((l) => (l.includes("失败") ? warn(l) : ok(l)));
    if (!isWin) ok(`.cursor 已存在 ${cursorRoot}`);
  } else {
    const made = ensureWritableDir(cursorRoot);
    if (made.ok) ok(`已创建 ${cursorRoot}`);
    else warn(`创建 ${cursorRoot} 失败：${made.error}`);
  }

  log("");
  log("3) Windows Defender 排除（杀毒扫 WAL 是最常见原因）");
  const excludeTargets = [
    cursorRoot,
    ...dirs.filter((d) => /fe-ai-flow/i.test(d)),
  ];
  const def = addDefenderExclusions([...new Set(excludeTargets)]);
  def.lines.forEach((l) =>
    /需要管理员|失败/.test(l) ? warn(l) : ok(l),
  );

  log("");
  log("4) 复测 WAL");
  let stillBad = false;
  for (const dir of existingDirs) {
    const wal = probeWal(dir);
    if (wal.ok) ok(`复测通过 ${dir}`);
    else {
      warn(`复测仍失败 ${dir}：${wal.error}`);
      stillBad = true;
    }
  }

  log("");
  if (!stillBad && !walFailed && !def.needAdmin) {
    log("结论：本机这些目录现在能写 WAL。请让同事重启 Flowship 再试一条新对话。");
    process.exitCode = 0;
    return;
  }
  if (def.needAdmin) {
    log("结论：需要管理员权限才能加杀毒排除。请用发给同事的 .cmd 以管理员运行。");
    process.exitCode = 2;
    return;
  }
  log("结论：自动修复后 WAL 仍打不开。把上面整段输出发回来。常见剩余原因：");
  log("  - 企业 EDR 不是 Defender，排除加不上（需要 IT 放行 %USERPROFILE%\\.cursor）");
  log("  - 家目录被 OneDrive 同步（上面 [!!] 会标出来）");
  process.exitCode = 1;
};

main();
