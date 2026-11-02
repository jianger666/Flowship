/**
 * 桥接 JSON 状态文件（card-map.json / bridge-state.json）的「读改写专用」读取
 *
 * 为什么单独一个读法：这两份文件的读改写（RMW）都是「读出整份 → 改一点 → 原子写回整份」。
 * 若读失败一律当空，下一次写就会拿「空 + 一条新数据」覆盖盘上其实完好的整份历史
 * （card-map 500 条回复锚定 / bridge-state 2000 条去重 id + 对话指针 + 已结束集合）。
 * 所以 RMW 要区分三种情况（纯读取的 getter 仍保持宽松：读不出来就当空，不中断消息处理）：
 * - 文件不存在（ENOENT，首次启动）→ 返回 null，调用方从空开始；
 * - 内容坏了（JSON 解析失败 / 不是对象，如被截断、手改坏）→ 反复读也不会好：
 *   原样改名 `<file>.corrupt-<ts>` 留证后返回 null（从空继续，不卡死在坏文件上；人还能手工恢复）；
 * - 合法 JSON 对象、但字段类型不对（调用方传 validate 判定，如 `entries` 不是数组）→ 不能「悄悄当空」：
 *   **复制**一份 `<file>.corrupt-<ts>` 留证（不是改名——整份重置会把其它完好字段也丢掉），
 *   调用方照常按字段规整、保住能用的部分，坏字段随下一次写盘被覆盖，但原样留着可查；
 * - 其它读错误（EACCES / EBUSY / EMFILE / EIO / EISDIR…，多半是瞬时的）→ 抛错，调用方放弃这次写，
 *   绝不拿「空」去覆盖一份可能完好的文件。
 */

import { promises as fs } from "node:fs";
import path from "node:path";

/** `.corrupt-<ts>` 留证文件最多保留几份（只留最近的）：反复损坏 / 反复结构错时不让数据目录无限攒 */
export const MAX_CORRUPT_COPIES = 5;

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * 只留最近 MAX_CORRUPT_COPIES 份 `<file>.corrupt-<ts>`；清理失败不影响主流程。
 * @param keep 刚写下的留证文件（完整路径）：无论时间戳排第几都不删——墙钟被回拨时 `Date.now()` 可能比旧的还小，
 *   按时间戳排序会把刚留下的证据立刻淘汰掉。
 */
const pruneCorruptCopies = async (file: string, keep?: string): Promise<void> => {
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.corrupt-`;
  let stamped: Array<{ n: string; ts: number }>;
  try {
    // 只清「后缀是纯数字时间戳」的——那才是本模块自己写的格式。
    // 只看前缀的话，用户手留的 `.corrupt-manual-backup` 之类会被当 ts=0 最先删掉
    stamped = (await fs.readdir(dir))
      .filter((n) => n.startsWith(prefix) && /^\d+$/.test(n.slice(prefix.length)))
      .map((n) => ({ n, ts: Number(n.slice(prefix.length)) }))
      .sort((a, b) => b.ts - a.ts);
  } catch {
    return; // 卫生性清理，吞掉
  }
  const keepName = keep ? path.basename(keep) : null;
  // 刚写的那份先占一个名额，其余再按时间戳从新到旧补满
  const retained = new Set<string>(keepName ? [keepName] : []);
  for (const { n } of stamped) {
    if (retained.size >= MAX_CORRUPT_COPIES) break;
    retained.add(n);
  }
  for (const { n } of stamped.filter((x) => !retained.has(x.n))) {
    // 每条各自 try/catch：某份删不掉（Windows 上被杀软 / 预览占用的 EBUSY / EPERM）不该让后面更旧的也留着
    try {
      await fs.rm(path.join(dir, n), { force: true });
    } catch {
      // 删不掉的留到下次损坏时再清
    }
  }
};

/**
 * 读 JSON 对象文件（RMW 用）。
 * @param label 日志 / 错误前缀，如 `card-map`
 * @param validate 可选：对解析出的对象做字段类型校验；返回 false = 结构不对（复制留证后仍返回该对象，由调用方规整）
 * @returns 解析出的对象；null = 文件不存在或已被隔离（调用方当空 store 处理）
 * @throws 读文件失败（非 ENOENT）、或坏文件隔离失败——此时不要写盘
 */
export const readJsonObjectForWrite = async (
  file: string,
  label: string,
  validate?: (obj: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown> | null> => {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return null;
    throw new Error(
      `${label} 读盘失败（${code ?? "未知错误"}），放弃本次写入以免覆盖已有数据: ${errMsg(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (validate && !validate(obj)) {
      // 字段类型不对：留一份原样副本再继续（见文件头）；留证失败只 warn，不挡主流程
      const copy = `${file}.corrupt-${Date.now()}`;
      try {
        await fs.copyFile(file, copy);
        console.warn(`[feishu-bridge/${label}] 文件结构异常（字段类型不对），已留证为 ${copy}，按字段规整后继续`);
        await pruneCorruptCopies(file, copy);
      } catch (err) {
        console.warn(`[feishu-bridge/${label}] 文件结构异常且留证失败（继续）: ${errMsg(err)}`);
      }
    }
    return obj;
  }

  // 内容坏了：留证再从空继续
  const quarantined = `${file}.corrupt-${Date.now()}`;
  try {
    await fs.rename(file, quarantined);
  } catch (err) {
    throw new Error(
      `${label} 内容已损坏且隔离失败，放弃本次写入: ${errMsg(err)}`,
    );
  }
  console.warn(`[feishu-bridge/${label}] 文件内容损坏，已隔离为 ${quarantined}，从空状态继续`);
  await pruneCorruptCopies(file, quarantined);
  return null;
};
