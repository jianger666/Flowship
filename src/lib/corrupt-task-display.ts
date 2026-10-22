/**
 * 「损坏任务 → 展示文案」纯函数（侧栏底部的「N 个任务数据损坏」提示用；无 React / server 依赖，可在 node 测）
 *
 * 背景（F3-02）：任务 meta.json 损坏后，列表接口会把它从 tasks 里拿掉、点进去显示「任务不存在」，
 * 用户不知道发生了什么。服务端已经把它们单独放进 `corrupt` 数组（见 corrupt-task.ts），
 * 这里负责把一条 CorruptTaskInfo 变成人话：哪个任务、为什么、接下来该怎么办。
 *
 * 恢复说明必须与服务端行为一致（不能多承诺）——见 task-fs 的 restoreMetaFromBackup：
 *  - 只在**启动期**（boot recovery）用 meta.json.bak 恢复，运行中不会动文件 → 文案说「重启应用会自动…」；
 *  - 只对**内容损坏**（空 / 非 JSON / schema 不合）恢复；读文件本身失败（read_error）可能只是瞬时 I/O 故障，
 *    服务端不据此恢复，所以即使 backupValid 为 true 也不能说「会自动恢复」（服务端实际恒给 false，这里再兜一道）。
 */

import type { CorruptTaskInfo, CorruptTaskKind } from "./corrupt-task";

/** 恢复路径：auto = 重启自动用备份恢复；retry = 可能是暂时故障；manual = 没备份、要手动修 */
export type CorruptRecoveryKind = "auto" | "retry" | "manual";

export interface CorruptTaskDisplay {
  id: string;
  /** 一句话原因（服务端 reason 压成单行并限长；缺失时按类别兜底） */
  reason: string;
  recoveryKind: CorruptRecoveryKind;
  /** 接下来怎么办（一句话） */
  recovery: string;
  /**
   * meta.json 绝对路径——仅在需要用户自己动手 / 排查（retry / manual）时给；
   * auto 恢复时给 null：重启就好，别引导用户去手改文件。
   */
  metaPath: string | null;
}

/** 单条原因的字数上限：schema 不合时服务端会拼最多 3 个出错字段，侧栏弹层里一行半就够了 */
export const CORRUPT_REASON_MAX_CHARS = 120;

/** 侧栏提示条文案 */
export const corruptSummaryText = (count: number): string =>
  `${count} 个任务数据损坏`;

/** 服务端没给 reason（或全是空白）时的兜底原因，按类别 */
const FALLBACK_REASON: Record<CorruptTaskKind, string> = {
  empty: "meta.json 是空文件",
  invalid_json: "meta.json 不是合法 JSON",
  schema_mismatch: "meta.json 格式不符合当前版本",
  read_error: "读取 meta.json 失败",
};

/** 压成单行 + 限长（按字符、不拆 UTF-16 代理对） */
const toOneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : flat;
};

export const describeCorruptTask = (info: CorruptTaskInfo): CorruptTaskDisplay => {
  const reason =
    toOneLine(info.reason ?? "", CORRUPT_REASON_MAX_CHARS) ||
    FALLBACK_REASON[info.kind] ||
    FALLBACK_REASON.read_error;
  const metaPath = info.metaPath?.trim() ? info.metaPath : null;

  // 只有「内容损坏 + 备份有效」才会被启动期恢复；read_error 一律不承诺
  if (info.backupValid && info.kind !== "read_error") {
    return {
      id: info.id,
      reason,
      recoveryKind: "auto",
      recovery: "重启应用会自动用备份恢复",
      metaPath: null,
    };
  }

  if (info.kind === "read_error") {
    return {
      id: info.id,
      reason,
      recoveryKind: "retry",
      recovery: "可能只是暂时读取失败，稍后再看；一直如此请检查该文件的权限与磁盘",
      metaPath,
    };
  }

  return {
    id: info.id,
    reason,
    recoveryKind: "manual",
    recovery: "没有可用备份，需要手动修复该文件",
    metaPath,
  };
};
