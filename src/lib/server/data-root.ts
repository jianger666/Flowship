/**
 * 数据根目录单一源（V0.7.0）
 *
 * 桌面端（Electron）注入 FLOWSHIP_DATA_DIR 指向系统 userData（卸载/更新不丢数据、
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
  process.env.FLOWSHIP_DATA_DIR || path.join(process.cwd(), "data");

/**
 * 去掉文本开头的 UTF-8 BOM（U+FEFF）。
 * Windows 记事本「另存为 UTF-8（带 BOM）」会在文件头塞一个；`JSON.parse` 不认它，
 * 会把一份其实没坏的 config.json / meta.json 判成损坏（设置页读不出、agent 读不到 apiKey、事件脱敏失效……）。
 * 只去开头的一个——文本中间的 U+FEFF 是内容，不动。
 */
export const stripBom = (text: string): string =>
  text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

/**
 * 把「读 / 解析配置文件」的异常说成一句**不带文件内容**的话（给日志、诊断包用）。
 * 为什么不直接用 err.message：V8 的 JSON.parse 报错会把出错处附近的原文拼进去
 * （形如 `Unexpected token 'S', "{"apiKey": SECRET…" is not valid JSON`），而 config.json 里最先出现的就是密钥；
 * 日志会进 main.log、诊断包是要发给别人的。
 * 只留错误类别：JSON 格式不对（能取到就带出错位置）/ 系统错误码（EACCES、EISDIR……）/ 兜底「读取失败」。
 */
export const describeConfigReadError = (err: unknown): string => {
  if (err instanceof SyntaxError) {
    const pos = /\bat position (\d+)/.exec(err.message)?.[1];
    return pos ? `JSON 格式不对（位置 ${pos}）` : "JSON 格式不对";
  }
  const code = (err as NodeJS.ErrnoException)?.code;
  return typeof code === "string" ? code : "读取失败";
};

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
 * 写文件并 fsync（原子写的 tmp 阶段用；Q9-04）。
 *
 * 为什么：只有 tmp + rename 时，断电 / 内核崩溃可能出现「rename 已持久化、tmp 的数据块没落盘」
 * ——目标文件变成空文件或半截文件（设置 / 自定义 action / meta 整个读不出来；回退重写则整段对话变空）。
 * rename 之前 fsync(tmp) 才能保证 rename 之后看到的一定是完整内容。
 *
 * - fsync 本身失败（个别网络盘 / 文件系统不支持）只 warn、不挡写：效果不会比改前（完全不 fsync）更差。
 * - 只 fsync 文件、不 fsync 父目录（win32 不支持目录 fsync；与 meta 原子写同口径）。
 * - `content` 是 Uint8Array 时按字节原样写（`encoding` 被忽略）：回退重写要保留坏行的原始字节，
 *   不能经 string 往返（非法 UTF-8 会被替换成 U+FFFD）。
 *
 * @param opts.mode 新建文件的权限位（只对新建生效；win32 上调用方不要传）
 */
export const writeFileFsynced = async (
  filePath: string,
  content: string | Uint8Array,
  opts?: { mode?: number },
): Promise<void> => {
  const fh = await fs.open(filePath, "w", opts?.mode);
  try {
    await fh.writeFile(content, "utf-8");
    await fh.sync().catch((err: unknown) => {
      // 只记文件名 + 错误码：不带路径里的目录、更不带内容
      console.warn(
        `[data-root] fsync 失败（忽略、继续 rename）file=${path.basename(filePath)}：${
          (err as NodeJS.ErrnoException)?.code ?? String(err)
        }`,
      );
    });
  } finally {
    await fh.close();
  }
};

/**
 * 原子写私密文件（0600）：同目录 tmp（fsync）→ rename → chmod。
 * 新建 tmp 时带 mode 0600；rename 覆盖后对最终路径再 chmod 一次兜底。
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
    // fsync(tmp) 之后才允许 rename：防断电后目标文件变空 / 半截（Q9-04，见 writeFileFsynced）
    await writeFileFsynced(
      tmpPath,
      content,
      supportsUnixFileMode() ? { mode: 0o600 } : undefined,
    );
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
