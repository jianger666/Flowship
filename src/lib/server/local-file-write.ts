/**
 * 预览窗里「保存编辑」的服务端实现
 *
 * 设计要点（编辑是破坏性操作，宁可拒绝也不要悄悄改坏用户的文件）：
 * - 范围：只能覆盖**已存在**的普通文件（不建新文件、不改目录），且路径必须在 local-file-edit-policy 允许范围内；
 * - 往返无损：BOM / 换行风格由调用方带回、这里原样还原（text-codec）；非 UTF-8 / 含 NUL / 换行混用的文件读时就不给编辑，
 *   这里再兜一道（磁盘内容与读时不同也会被冲突检测拦下）；
 * - 冲突检测：调用方带上读时的 mtime，磁盘上的已经变了（agent 在改 / 别的编辑器改了）就 409，除非 force；
 * - 原子写：先写同目录临时文件 + fsync，再 rename 覆盖——掉电 / 崩溃不会留下半截文件；保留原权限位；
 *   rename 在个别环境（Windows 文件被占用、跨设备）失败时退回直接覆盖写；
 * - 同一路径的保存串行化，避免两个快速连点交错写。
 *
 * 局限（不装作能做到）：「检查 mtime → rename」之间不是原子的，外部进程恰好在这几毫秒内写同一个文件仍可能被覆盖；
 * 这是单机桌面端的合理边界，真正强一致需要文件锁，跨平台不可靠。
 */

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import { extOfPath, detectLocalFileKind, isTextKind } from "@/lib/local-file-kind";
import { encodeTextBuffer } from "@/lib/preview/text-codec";
import { editBlockReason, getEditRoots } from "@/lib/server/local-file-edit-policy";
import { nonLocalPathReason } from "@/lib/unc-path";

/** 可编辑文件的体积上限：编辑器每次按键都要重新着色，文件太大会卡；也保证读时不会被截断 */
export const MAX_EDIT_BYTES = 256 * 1024;

export type WriteFailureCode =
  | "invalid"
  | "not_found"
  | "forbidden"
  | "too_large"
  | "conflict"
  | "io";

export class LocalFileWriteError extends Error {
  constructor(
    message: string,
    readonly code: WriteFailureCode,
    readonly status: number,
    readonly detail?: { currentMtimeMs: number; currentSize: number },
  ) {
    super(message);
    this.name = "LocalFileWriteError";
  }
}

export interface WriteLocalFileInput {
  path: string;
  content: string;
  eol: "lf" | "crlf";
  bom: boolean;
  /** 读文件时拿到的 mtimeMs；与磁盘现状对不上 = 期间被别处改过 */
  expectedMtimeMs: number;
  /** 用户明确选择「覆盖」时带上，跳过冲突检测 */
  force?: boolean;
}

export interface WriteLocalFileResult {
  absolutePath: string;
  size: number;
  mtimeMs: number;
}

/** mtime 比较的容差：个别文件系统（FAT / 网络盘）的时间精度是 1~2 秒，这里只吸收浮点 / 亚毫秒误差 */
const MTIME_EPSILON_MS = 1;

const chains = new Map<string, Promise<unknown>>();

/** 同一路径的任务排队执行（失败不影响后续） */
const serialize = <T>(key: string, job: () => Promise<T>): Promise<T> => {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.then(job, job);
  const tail = next.catch(() => undefined);
  chains.set(key, tail);
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return next;
};

const isErrno = (err: unknown, ...codes: string[]): boolean =>
  codes.includes((err as NodeJS.ErrnoException | undefined)?.code ?? "");

const atomicReplace = async (real: string, data: Buffer, mode: number): Promise<void> => {
  const dir = path.dirname(real);
  const tmp = path.join(dir, `.${path.basename(real)}.flowship-${randomBytes(4).toString("hex")}.tmp`);
  let handle: FileHandle | null = null;
  try {
    handle = await fs.open(tmp, "wx", mode & 0o777);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    // umask 可能削掉了权限位：显式还原成原文件的权限（win32 上是近似 no-op）
    await fs.chmod(tmp, mode & 0o777).catch(() => undefined);
    await fs.rename(tmp, real);
  } catch (err) {
    if (handle) await handle.close().catch(() => undefined);
    await fs.unlink(tmp).catch(() => undefined);
    // 目录不可写 / 跨设备 / Windows 上目标被占用：退回直接覆盖写（文件本身可写时仍能保存）
    if (isErrno(err, "EPERM", "EACCES", "EXDEV", "EBUSY")) {
      await fs.writeFile(real, data);
      return;
    }
    throw err;
  }
};

export const writeLocalFile = async (input: WriteLocalFileInput): Promise<WriteLocalFileResult> => {
  const raw = typeof input.path === "string" ? input.path.trim() : "";
  if (!raw) throw new LocalFileWriteError("path 必填", "invalid", 400);
  // UNC 在碰文件系统之前拒绝（Windows 上 realpath 会触发 SMB / NTLM 外发）
  const nonLocal = nonLocalPathReason(raw);
  if (nonLocal) throw new LocalFileWriteError(nonLocal, "invalid", 400);
  if (!path.isAbsolute(raw) && !/^[a-zA-Z]:[\\/]/.test(raw)) {
    throw new LocalFileWriteError("path 必须是绝对路径", "invalid", 400);
  }
  if (typeof input.content !== "string") {
    throw new LocalFileWriteError("content 必须是字符串", "invalid", 400);
  }
  if (input.eol !== "lf" && input.eol !== "crlf") {
    throw new LocalFileWriteError("eol 只能是 lf 或 crlf", "invalid", 400);
  }
  if (!Number.isFinite(input.expectedMtimeMs)) {
    throw new LocalFileWriteError("expectedMtimeMs 必填", "invalid", 400);
  }

  // 两层串行：外层按调用方给的路径排队（realpath 是异步的，先到的请求不一定先解析完，
  // 不先排队就会乱序）；内层按真实路径排队（不同的符号链接路径指向同一个文件时也不交错）。
  // key 带前缀：raw 恰好等于 real 时两层不能共用一条链，否则内层会排在外层自己后面死锁
  return serialize(`raw:${path.resolve(raw)}`, async () => {
    let real: string;
    try {
      real = await fs.realpath(raw);
    } catch (err) {
      if (isErrno(err, "ENOENT", "ENOTDIR")) {
        throw new LocalFileWriteError("文件不存在（预览里只能保存已有文件）", "not_found", 404);
      }
      throw err;
    }
    return serialize(`real:${real}`, () => writeResolved(real, input));
  });
};

const writeResolved = async (
  real: string,
  input: WriteLocalFileInput,
): Promise<WriteLocalFileResult> => {
  const stat = await fs.stat(real);
  if (!stat.isFile()) throw new LocalFileWriteError("不是普通文件", "invalid", 400);

  const blocked = editBlockReason(real, await getEditRoots());
  if (blocked) throw new LocalFileWriteError(blocked, "forbidden", 403);

  if (!isTextKind(detectLocalFileKind(extOfPath(real)))) {
    throw new LocalFileWriteError("这类文件不支持在预览里编辑", "forbidden", 403);
  }
  // 磁盘上的文件已经超过上限：读时被截断过，客户端手里的不是全文，写回去会丢内容
  if (stat.size > MAX_EDIT_BYTES) {
    throw new LocalFileWriteError(
      `文件超过 ${MAX_EDIT_BYTES / 1024}KB 编辑上限，请用 IDE 编辑`,
      "too_large",
      413,
    );
  }

  const data = encodeTextBuffer(input.content, { eol: input.eol, bom: input.bom });
  if (data.length > MAX_EDIT_BYTES) {
    throw new LocalFileWriteError(
      `内容超过 ${MAX_EDIT_BYTES / 1024}KB 编辑上限，请用 IDE 编辑`,
      "too_large",
      413,
    );
  }

  if (!input.force && Math.abs(stat.mtimeMs - input.expectedMtimeMs) > MTIME_EPSILON_MS) {
    throw new LocalFileWriteError("文件在你编辑期间被修改过", "conflict", 409, {
      currentMtimeMs: stat.mtimeMs,
      currentSize: stat.size,
    });
  }

  try {
    await atomicReplace(real, data, stat.mode);
  } catch (err) {
    if (isErrno(err, "EACCES", "EPERM", "EROFS")) {
      throw new LocalFileWriteError("没有写入权限（文件只读或被占用）", "io", 403);
    }
    throw new LocalFileWriteError(
      `保存失败：${err instanceof Error ? err.message : String(err)}`,
      "io",
      500,
    );
  }

  const after = await fs.stat(real);
  return { absolutePath: real, size: after.size, mtimeMs: after.mtimeMs };
};
