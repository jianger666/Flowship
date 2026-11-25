/**
 * 电脑操作审计日志：AI 在这台电脑上做过什么，一条一行 JSON，按天分文件，只存在本机。
 *
 * 目的：用户回来后能核对「AI 动过什么」（尤其是锁屏期间自动解锁的那几次）。
 *
 * 写什么 / 不写什么（隐私）：
 * - 键白名单：只有下面列出的字段会落盘，其余一律丢弃。这样即使上游不小心把 `text` / `password` 塞进了条目，也进不了文件。
 * - 输入的文字只记长度（chars），不记内容；截图不落盘；窗口标题不落盘。
 * - 日志写失败（磁盘满 / 权限）静默吞掉：审计不能影响电脑操作本身。
 *
 * 保留：默认 14 天；单天文件超过 5MB 就不再追加（防止异常循环把磁盘写满）。
 */
import fs from "node:fs";
import path from "node:path";

const ALLOWED_KEYS = new Set([
  "type", // session / action / unlock_step
  "kind", // begin / unlocked / relocked / user_took_over …
  "taskId",
  "op",
  "at",
  "ok",
  "code",
  "ms",
  "x",
  "y",
  "x2",
  "y2",
  "button",
  "count",
  "dx",
  "dy",
  "key", // 组合键名（如 cmd+c），不是输入的文字
  "chars", // 输入的字符数
  "app", // 打开 / 前台的应用名
  "reason",
  "name", // 解锁步骤名
  "unlockedByUs",
  "relocked",
  "locked",
  "error",
]);

const MAX_STRING = 200;
export const MAX_DAY_FILE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_RETENTION_DAYS = 14;

const pad2 = (n) => String(n).padStart(2, "0");
const dayName = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

/**
 * 只留白名单里的键，字符串截断，丢掉对象 / 函数（审计条目必须是扁平的）
 * @param {unknown} entry
 * @returns {Record<string, string | number | boolean>}
 */
export const sanitizeEntry = (entry) => {
  /** @type {Record<string, string | number | boolean>} */
  const out = {};
  if (entry === null || typeof entry !== "object") return out;
  for (const [k, v] of Object.entries(entry)) {
    if (!ALLOWED_KEYS.has(k)) continue;
    if (typeof v === "string") out[k] = v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}…` : v;
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "boolean") out[k] = v;
  }
  return out;
};

/**
 * @param {{
 *   dir: string,
 *   now?: () => number,
 *   retentionDays?: number,
 *   log?: (msg: string) => void,
 *   fsImpl?: Pick<typeof fs.promises, "appendFile" | "mkdir" | "readdir" | "unlink" | "stat">,
 * }} deps
 */
export const createAuditLog = ({ dir, now = Date.now, retentionDays = DEFAULT_RETENTION_DAYS, log = () => {}, fsImpl = fs.promises }) => {
  let dirReady = false;
  /** 天 → 已写入的估计字节数（避免每次都 stat） */
  const sizes = new Map();
  let chain = Promise.resolve();

  const ensureDir = async () => {
    if (dirReady) return;
    await fsImpl.mkdir(dir, { recursive: true, mode: 0o700 });
    dirReady = true;
  };

  /** 追加一条（串行化，保证行不交错）。返回的 Promise 永不 reject */
  const write = (entry) => {
    const rec = { at: now(), ...sanitizeEntry(entry) };
    const line = `${JSON.stringify(rec)}\n`;
    // 上限和累计值都按字节算（一个汉字 3 字节）：以前这里拿字符数 line.length 去比字节累计值，含中文的条目会多写出 ~3 倍的余量（第三轮评审）
    const lineBytes = Buffer.byteLength(line);
    chain = chain
      .then(async () => {
        await ensureDir();
        const day = dayName(rec.at);
        let size = sizes.get(day);
        const file = path.join(dir, `${day}.jsonl`);
        if (size === undefined) {
          size = await fsImpl
            .stat(file)
            .then((s) => s.size)
            .catch(() => 0);
        }
        if (size + lineBytes > MAX_DAY_FILE_BYTES) {
          sizes.set(day, size);
          return;
        }
        await fsImpl.appendFile(file, line, { encoding: "utf8", mode: 0o600 });
        sizes.set(day, size + lineBytes);
      })
      .catch((err) => {
        log(`[desktop-audit] 写审计日志失败（已忽略）：${err?.message || err}`);
      });
    return chain;
  };

  /** 删除超过保留天数的日志文件 */
  const prune = async () => {
    try {
      const names = await fsImpl.readdir(dir);
      const cutoff = dayName(now() - retentionDays * 24 * 3600 * 1000);
      for (const name of names) {
        const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
        if (m && m[1] < cutoff) await fsImpl.unlink(path.join(dir, name)).catch(() => {});
      }
    } catch (err) {
      if (err?.code !== "ENOENT") log(`[desktop-audit] 清理旧日志失败（已忽略）：${err?.message || err}`);
    }
  };

  /** 等待已排队的写入落盘（测试 / 退出时用） */
  const flush = () => chain;

  return { write, prune, flush, dir };
};
