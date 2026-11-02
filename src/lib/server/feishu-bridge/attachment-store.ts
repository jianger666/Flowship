/**
 * 入向附件落盘：净化文件名 + 独立子目录 + 唯一前缀 + TTL 清扫
 *
 * 为什么单独成模块：旧实现把下载产物 `rename` 成**发件人给的文件名**、直接落在 bridge 数据目录的顶层——
 * 与 `bridge-state.json`（去重表 / currentChatTaskId 路由 / 补拉水位）、`card-map.json`、`card-seq.json`
 * 同级。发件人把文件名起成 `bridge-state.json`，`fs.rename` 就把这些状态文件整个覆盖掉了
 *（POSIX / Windows 的 rename 都会替换同名目标）；同名附件之间也互相覆盖（属主自己 p2p 发的也会被换）；
 * 非图片附件还没有任何 TTL，只增不减。
 *
 * 现在的落点：`<bridge>/attachments/<messageId>/<唯一前缀>-<净化后的文件名>`——
 * - 子目录 + 前缀：不可能与 bridge 顶层任何状态文件同名，同名附件也不会互相覆盖；
 * - 文件名净化：去路径分隔符 / `..` / 控制字符 / Windows 非法字符 / 保留名 / 末尾点与空格，限长；
 * - TTL 清扫：只清 `attachments/` 与 `dl-*` 残留里**超过 N 天**的文件（保守，见 sweepStaleAttachments）。
 */

import { randomBytes } from "node:crypto";
import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";

/** bridge 数据目录下的附件根目录名 */
export const ATTACHMENTS_DIR_NAME = "attachments";

/**
 * 净化后文件名（不含唯一前缀）的长度上限，**按 UTF-8 字节算**；超长时保留扩展名。
 * 不能按字符数：文件系统（APFS / ext4 / NTFS 的 NAME_MAX）限的是单段 255 字节，
 * 一个汉字 3 字节、emoji 4 字节，按 UTF-16 码元卡 120 的话 ~82 个汉字就 ENAMETOOLONG、
 * 落盘降级成 `dl-…` 丢了原名。200 字节 + `<6hex>-` 前缀 7 字节，留足余量。
 */
const MAX_FILE_NAME_BYTES = 200;
/** 扩展名保留上限（字节）：更长的「扩展名」多半是整段乱码、不值得留 */
const MAX_EXT_BYTES = 16;
/** messageId 目录名上限 */
const MAX_DIR_NAME_LEN = 64;

/**
 * 要换成 `_` 的字符：C0 控制符 + DEL、C1 控制符（U+0080-009F，含 NEL U+0085）、
 * U+061C（ALM）、U+200E / U+200F（LRM / RLM）、U+2028 / U+2029（行 / 段分隔符）、
 * U+202A-202E（LRE / RLE / PDF / LRO / RLO）、U+2066-2069（LRI / RLI / FSI / PDI）。
 */
const UNSAFE_NAME_CHARS_RE =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

const utf8Bytes = (s: string): number => Buffer.byteLength(s, "utf8");

/** 按 UTF-8 字节数截到 ≤ maxBytes；以码点为单位（for…of），不会把多字节字符 / 代理对劈成两半 */
const truncateToUtf8Bytes = (s: string, maxBytes: number): string => {
  let used = 0;
  let out = "";
  for (const ch of s) {
    const n = utf8Bytes(ch);
    if (used + n > maxBytes) break;
    out += ch;
    used += n;
  }
  return out;
};

/** Windows 保留设备名（无论带不带扩展名都不能做文件名） */
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * 把发件人给的文件名净化成「在任何平台都是安全的单段文件名」：
 * - 路径分隔符（`/` `\`）→ `_`（保持旧行为：`a/b.pdf` → `a_b.pdf`）；
 * - 控制字符（含 NUL / C1 / NEL）、行 / 段分隔符（U+2028 / U+2029）、双向控制符
 *   （RLO / LRE / 隔离符 / LRM / RLM / ALM：`photo\u202Egnp.exe` 会被显示成 `photoexe.png`）
 *   与 Windows 非法字符 `< > : " | ? *` → `_`；
 * - 连续的 `..` 折成一个点、开头的点去掉（不留 `.` / `..` / 隐藏文件）；
 * - 头 / 尾的点与空白（含 NBSP / 全角空格等 Unicode 空白）去掉——Windows 会静默吞掉尾部点与空格，隐藏文件头点也不留；
 * - Windows 保留名（CON / NUL / COM1…，按「第一个点之前」判）前面补 `_`；
 * - 限长 {@link MAX_FILE_NAME_BYTES} 个 UTF-8 字节（按码点截、不劈开多字节字符），超长时保留扩展名；
 * - 净化后为空 → `fallback`。
 */
export const sanitizeAttachmentFileName = (
  raw: string,
  fallback = "file",
): string => {
  let name = String(raw ?? "")
    // 控制字符（含 NUL）+ C1 控制符（含 U+0085 NEL）+ 行 / 段分隔符 + 双向控制符
    // （刻意不动 ZWJ / ZWNJ U+200C-D：组合 emoji、波斯 / 印地文要靠它们）
    .replace(UNSAFE_NAME_CHARS_RE, "_")
    .replace(/[\\/]/g, "_")
    .replace(/[<>:"|?*]/g, "_")
    .replace(/\.{2,}/g, ".")
    // 顺序有讲究：先 trim、再去头 / 尾的「点 + 空白」。旧写法先去尾点再 trim——
    // `report.pdf.\u00a0`（NBSP / 全角空格 / BOM 都算 trim 的空白，却不在 `[. ]` 里）去尾点时没匹配、
    // trim 吃掉空白后尾点又露出来；头部 `\u00a0.hidden` 同理会漏成隐藏文件。`\s` 与 trim 的空白集一致。
    .trim()
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "");
  if (utf8Bytes(name) > MAX_FILE_NAME_BYTES) {
    const ext = path.extname(name);
    const keepExt = ext.length > 0 && utf8Bytes(ext) <= MAX_EXT_BYTES ? ext : "";
    const base = name.slice(0, name.length - keepExt.length);
    name =
      truncateToUtf8Bytes(base, MAX_FILE_NAME_BYTES - utf8Bytes(keepExt)) + keepExt;
    // 截断可能让末尾又出现点 / 空白
    name = name.replace(/[.\s]+$/, "");
  }
  if (!name) return fallback;
  const stem = name.split(".")[0] ?? "";
  if (WINDOWS_RESERVED_RE.test(stem.trim())) name = `_${name}`;
  return name;
};

/** messageId → 目录名：只留字母数字 `_` `-`，限长；空则 `unknown` */
const safeDirName = (messageId: string): string => {
  const cleaned = String(messageId ?? "")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, MAX_DIR_NAME_LEN);
  // 纯下划线 / 空没有意义，也避免出现 `.` `..` 之类（上面已剔点，这里只防全空）
  return cleaned.replace(/_/g, "").length > 0 ? cleaned : "unknown";
};

/** 6 位十六进制唯一前缀：同一条消息里同名附件靠它区分（目录内碰撞概率 ~1/1600 万） */
const uniquePrefix = (): string => randomBytes(3).toString("hex");

/**
 * 把已下载到 `downloadedAbs` 的文件挪进 `<bridge>/attachments/<messageId>/<前缀>-<净化名>`，返回新路径。
 * `<bridge>` 取自下载产物所在目录（lark-api.downloadMessageResource 一律写在 bridge 目录顶层）。
 * 失败抛错，由调用方决定降级（router 降级为沿用原下载路径——`dl-*` 名字也不会撞状态文件）。
 */
export const placeAttachment = async (
  downloadedAbs: string,
  fileName: string,
  messageId: string,
): Promise<string> => {
  const bridgeDir = path.dirname(downloadedAbs);
  const dir = path.join(bridgeDir, ATTACHMENTS_DIR_NAME, safeDirName(messageId));
  await fs.mkdir(dir, { recursive: true });
  const dest = path.join(
    dir,
    `${uniquePrefix()}-${sanitizeAttachmentFileName(fileName)}`,
  );
  await fs.rename(downloadedAbs, dest);
  return dest;
};

/** 附件 / 下载残留的保留时长：30 天。保守——会话历史里引用的附件路径在这之内都还读得到 */
export const ATTACHMENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 清扫的最小间隔：6 小时（挂在 30s 轮询上，靠它节流） */
const SWEEP_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * 清扫超过 `maxAgeMs` 的入向附件。范围**只限**：
 * - `<bridge>/attachments/<messageId>/*` 里 mtime 过期的文件（清空后顺手删空的 messageId 目录）；
 * - `<bridge>/dl-*` 顶层残留（改名失败时下载产物原地当附件用；崩在中途的也会留下）——同样按 mtime 过期才删。
 * 不碰 bridge 顶层其它任何文件（bridge-state / card-map / card-seq 等）；符号链接只删链接本身、不跟随。
 * 任何一步出错都吞掉（清扫只是卫生，不能影响桥接）。返回删掉的文件数（单测用）。
 */
export const sweepStaleAttachments = async (
  bridgeDir: string,
  maxAgeMs: number = ATTACHMENT_TTL_MS,
  now: number = Date.now(),
): Promise<number> => {
  let removed = 0;
  const expired = (mtimeMs: number): boolean => now - mtimeMs > maxAgeMs;

  const root = path.join(bridgeDir, ATTACHMENTS_DIR_NAME);
  let msgDirs: Dirent[] = [];
  try {
    msgDirs = await fs.readdir(root, { withFileTypes: true });
  } catch {
    // 目录不存在 = 还没收过附件
  }
  for (const d of msgDirs) {
    const dirPath = path.join(root, d.name);
    try {
      if (!d.isDirectory()) {
        // attachments/ 顶层不该有散文件；有也按同一规则过期清掉（lstat：不跟随符号链接）
        const st = await fs.lstat(dirPath);
        if (expired(st.mtimeMs)) {
          await fs.rm(dirPath, { force: true });
          removed += 1;
        }
        continue;
      }
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      let left = entries.length;
      for (const e of entries) {
        const p = path.join(dirPath, e.name);
        try {
          const st = await fs.lstat(p);
          if (expired(st.mtimeMs)) {
            await fs.rm(p, { recursive: true, force: true });
            removed += 1;
            left -= 1;
          }
        } catch {
          // 单个文件出错不影响其余
        }
      }
      if (left <= 0) await fs.rmdir(dirPath).catch(() => undefined);
    } catch {
      // 单个消息目录出错不影响其余
    }
  }

  try {
    const top = await fs.readdir(bridgeDir, { withFileTypes: true });
    for (const e of top) {
      // 只认 lark-api.downloadMessageResource 的 `dl-<ts>-<key>` 产物；且必须是普通文件 / 符号链接
      if (!e.name.startsWith("dl-") || e.isDirectory()) continue;
      const p = path.join(bridgeDir, e.name);
      try {
        const st = await fs.lstat(p);
        if (expired(st.mtimeMs)) {
          await fs.rm(p, { force: true });
          removed += 1;
        }
      } catch {
        // 同上
      }
    }
  } catch {
    // bridge 目录读不了就算了
  }
  return removed;
};

let lastSweepAt = 0;

/** 单测复位节流 */
export const __resetAttachmentSweepForTest = (): void => {
  lastSweepAt = 0;
};

/**
 * 节流版清扫（≥ 6 小时一次）：挂在 inbound 的 30s 轮询上，进程启动后的第一次轮询就会跑一次。
 * 永不抛、不阻塞调用方（调用方 `void` 即可）。返回是否真的跑了。
 */
export const maybeSweepStaleAttachments = async (
  bridgeDir: string,
  now: number = Date.now(),
): Promise<boolean> => {
  if (now - lastSweepAt < SWEEP_MIN_INTERVAL_MS) return false;
  lastSweepAt = now;
  try {
    const removed = await sweepStaleAttachments(bridgeDir, ATTACHMENT_TTL_MS, now);
    if (removed > 0) {
      console.log(`[feishu-bridge/attachments] 清扫过期附件 ${removed} 个`);
    }
  } catch (err) {
    console.warn(
      "[feishu-bridge/attachments] 清扫失败:",
      err instanceof Error ? err.message : err,
    );
  }
  return true;
};
