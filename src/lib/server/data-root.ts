/**
 * 数据根目录单一源（V0.7.0）
 *
 * 桌面端（Electron）注入 FE_AI_FLOW_DATA_DIR 指向系统 userData（卸载/更新不丢数据、
 * 也避免写进只读的 resources 目录）；不注入时回落 process.cwd()/data——
 * dev 行为跟以前完全一致。
 *
 * 所有要落 data/ 的模块（task-fs / mcp-oauth / uploads route）一律走这里、
 * 不要再各自拼 process.cwd()/data。
 *
 * 含密钥的目录 / 文件统一 0700 / 0600；win32 上 mode/chmod 是 no-op 或近似，
 * 统一跳过避免抛错。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { failpoint } from "./failpoints";

export const dataRoot = (): string =>
  process.env.FE_AI_FLOW_DATA_DIR || path.join(process.cwd(), "data");

/**
 * renameWithRetry 在 beforeAttempt 拒写时抛此错——调用方清 tmp、视为「未提交」。
 * 失败的 syscall 不消费授权；只有成功发起的 rename 才是线性化点。
 */
export class RenameAbortedError extends Error {
  constructor(message = "rename aborted: beforeAttempt returned false") {
    super(message);
    this.name = "RenameAbortedError";
  }
}

/** win32 上文件权限位不可靠，跳过 mode/chmod */
export const supportsUnixFileMode = (): boolean => process.platform !== "win32";

/**
 * 确保目录存在且为 0700（已存在则补 chmod）。
 * 失败只 warn、不抛——权限收紧是 best-effort，不能阻断业务写。
 */
export const ensurePrivateDir = async (dir: string): Promise<void> => {
  if (supportsUnixFileMode()) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      await fs.chmod(dir, 0o700);
    } catch (err) {
      // 只记路径 + 错误信息，绝不 dump 目录内容
      console.warn(
        `[data-root] chmod 0700 失败（${dir}）:`,
        err instanceof Error ? err.message : err,
      );
    }
  } else {
    await fs.mkdir(dir, { recursive: true });
  }
};

/**
 * Windows：目标文件被并发读 / 杀软扫描持有句柄时 rename 会 EPERM/EBUSY
 * （同事线上实测、mac/linux 无此语义）——短退避重试几轮；重试穿透才抛。
 * writePrivateFileAtomic / writeMeta 共用，避免两处重试策略漂移。
 *
 * @param beforeAttempt 每次真正调用 fs.rename 前同步验；false → 抛
 *   {@link RenameAbortedError}（不消费授权）。失败的 syscall 之后仍可换主拒提交。
 */
export const renameWithRetry = async (
  tmpPath: string,
  finalPath: string,
  beforeAttempt?: () => boolean,
): Promise<void> => {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    // 循环内每次尝试前插桩 + lease——首轮 EPERM 退避期间换主仍拦得住
    await failpoint("rename.beforeAttempt");
    if (beforeAttempt && !beforeAttempt()) {
      throw new RenameAbortedError();
    }
    try {
      await fs.rename(tmpPath, finalPath);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") throw err;
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }
  throw lastErr;
};

/**
 * 原子写私密文件（0600）：同目录 tmp → rename → chmod。
 * writeFile 的 mode 只对新建生效；rename 覆盖后对最终路径再 chmod 一次兜底。
 * 失败清理 tmp（参考 feishu-cli installBinaryAtomic）。
 */
export const writePrivateFileAtomic = async (
  finalPath: string,
  content: string,
): Promise<void> => {
  await ensurePrivateDir(path.dirname(finalPath));
  const tmpPath = `${finalPath}.tmp.${process.pid}.${Math.random()
    .toString(36)
    .slice(2)}`;
  try {
    if (supportsUnixFileMode()) {
      await fs.writeFile(tmpPath, content, { encoding: "utf-8", mode: 0o600 });
    } else {
      await fs.writeFile(tmpPath, content, "utf-8");
    }
    // 审查发现：原先单次 rename，Windows 上 EPERM/EBUSY 直接失败——与 writeMeta 对齐重试
    await renameWithRetry(tmpPath, finalPath);
    // 覆盖已存在的 0644 文件时，部分平台 rename 可能保留旧 inode 权限——显式收紧
    if (supportsUnixFileMode()) {
      try {
        await fs.chmod(finalPath, 0o600);
      } catch (err) {
        console.warn(
          `[data-root] chmod 0600 失败（${finalPath}）:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
};

/**
 * 幂等收紧已存在路径的权限（启动迁移用）。
 * ENOENT 静默跳过；其它失败 console.warn、不阻断启动。日志只含路径、不含文件内容。
 */
export const hardenPathMode = async (
  targetPath: string,
  mode: number,
): Promise<void> => {
  if (!supportsUnixFileMode()) return;
  try {
    await fs.chmod(targetPath, mode);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    console.warn(
      `[data-root] 启动收紧权限失败（${targetPath} → ${mode.toString(8)}）:`,
      err instanceof Error ? err.message : err,
    );
  }
};
