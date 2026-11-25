/**
 * 自动解锁「冷却截止时刻」的落盘（会话 session.mjs 注入使用；macOS / Windows 共用）。
 *
 * 为什么要落盘：「一次错误即停」是为了不让 AI 把一个错误的开机密码反复输进去（连续输错会触发账户锁定）。
 * 冷却只放在内存里的话，输错之后**重启 / 崩溃重启 / 自动更新 relaunch** 冷却就清零，下一次请求会再输一遍同样的错密码
 *（第二轮评审 P1-1）。Windows 解锁组件的冷却一直是落盘的（state.txt，见 protocol.mjs 的 COOLDOWN_SECONDS），这里让会话层对齐。
 *
 * 只存一个时间戳（不含任何密码 / 用户内容）。文件放在 userData 下自己的目录里（userData 本来就按正式 / test 实例分开），
 * 权限 0600、目录 0700（Windows 上 mode 被忽略，靠 userData 本身的 ACL）；写入走「临时文件 + rename」，不会留下写了一半的文件。
 *
 * 读 / 写的失败语义由调用方（session）决定：
 * - `load()`：文件不存在 = 0（没失败过）；读不了 / 读不懂 = **抛错**（调用方按「一整段冷却」处理，fail-closed——
 *   不能把一个坏掉的记录当成「没失败过」）；
 * - `save(until)`：写失败抛错；怎么处理由调用方（session 的 persistCooldown）按场合定，**不是一律只记日志**：
 *   · 输密码**之前**的预写（armUnlockCooldown）：写不进去 = 冷却没有落盘保证，调用方把内存里的冷却回滚、**拒绝这次解锁**、不输密码
 *     （fail-closed：宁可不解锁，也不在冷却没落盘的情况下输密码）；
 *   · 输错后的结算 / 解开后的撤销 / 重置：只记日志、不抛不重试——结算时内存里的冷却照样生效、盘上留着的是预写的那一段（重启后冷却仍在，只是早结束一点）；
 *     撤销 / 重置时内存已是 0、盘上还留着旧冷却（重启后多出一次冷却，方向也是 fail-closed）。
 *   `until <= 0` 写成 `{ until: 0 }`（不删文件——删除失败的话旧的冷却会在下次启动「复活」；覆盖写 0 失败了也是同样的问题，但少一种失败方式）。
 */
import fs from "node:fs";
import path from "node:path";

const FORMAT_VERSION = 1;

/**
 * @param {{
 *   file: string,
 *   fsImpl?: Pick<typeof fs, "readFileSync" | "writeFileSync" | "renameSync" | "mkdirSync" | "unlinkSync">,
 *   pid?: number,
 * }} deps
 * @returns {{ load: () => number, save: (until: number) => void, file: string }}
 */
export const createCooldownStore = ({ file, fsImpl = fs, pid = process.pid }) => {
  const load = () => {
    let raw;
    try {
      raw = fsImpl.readFileSync(file, "utf8");
    } catch (err) {
      if (err?.code === "ENOENT") return 0;
      throw new Error(`读取冷却记录失败（${err?.code || err?.message || "未知错误"}）`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("冷却记录内容读不懂");
    }
    const until = parsed?.until;
    if (parsed?.v !== FORMAT_VERSION || typeof until !== "number" || !Number.isFinite(until) || until < 0) {
      throw new Error("冷却记录内容读不懂");
    }
    return until;
  };

  const save = (until) => {
    const value = Number.isFinite(until) && until > 0 ? Math.floor(until) : 0;
    fsImpl.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${pid}.tmp`;
    try {
      fsImpl.writeFileSync(tmp, JSON.stringify({ v: FORMAT_VERSION, until: value }), { mode: 0o600 });
      fsImpl.renameSync(tmp, file);
    } catch (err) {
      try {
        fsImpl.unlinkSync(tmp);
      } catch {
        /* 临时文件没了 / 删不掉都无所谓 */
      }
      throw err;
    }
  };

  return { load, save, file };
};
