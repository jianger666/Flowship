/**
 * config.json 不可读（服务端 500 `settings_unreadable`）在客户端的口径（F6-03）
 *
 * 背景：config.json 损坏 / 读不了时，/api/settings/full 与 PUT /api/settings 都返回
 * `{ error: "settings_unreadable", reason }`。以前 UI 不认这个错误：设置页显示一份空表单，
 * 保存失败还提示「将自动重试」并排退避重试——可这是需要人去修文件的持久故障，重试永远不会成功。
 * 现在把「读取阶段」的它识别成独立状态：设置页顶部显示明确原因、不展示可误导的空表单、
 * 暂停保存（也就不会再有「保存失败 → 将自动重试」）。
 *
 * 只处理读取阶段（initSettings 的 GET /full）：运行中途某次 PUT 才撞上 unreadable 可能是瞬时错误
 * （Windows 杀软 / 同步盘短暂占住文件），不做粘性暂停，沿用原来的失败 toast + 退避重试。
 *
 * reason 由服务端保证不含文件内容（只有类别 / 出错位置 / fs 报错），这里仍截断长度再展示。
 * 纯逻辑（不依赖 React / DOM），便于单测。
 */

/** 服务端错误体里 `error` 字段的固定值（client 据此分流，不依赖文案） */
export const SETTINGS_UNREADABLE_CODE = "settings_unreadable";

export interface SettingsUnreadable {
  /** 服务端给的类别 / 位置，如 `json_parse: at position 8`、`settings_json_invalid`、`EACCES: …`；可能为空串 */
  reason: string;
}

/** 展示用 reason 的长度上限（fs 报错里带整条路径，够用即可、也防异常长串撑坏布局） */
const REASON_MAX_LEN = 200;

export class SettingsUnreadableError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason ? `${SETTINGS_UNREADABLE_CODE}: ${reason}` : SETTINGS_UNREADABLE_CODE);
    this.name = "SettingsUnreadableError";
    this.reason = reason;
  }
}

/** 从服务端错误体识别 settings_unreadable；不是这个错误（或形状不对）→ null */
export const parseSettingsUnreadable = (
  body: unknown,
): SettingsUnreadable | null => {
  if (!body || typeof body !== "object") return null;
  const b = body as { error?: unknown; reason?: unknown };
  if (b.error !== SETTINGS_UNREADABLE_CODE) return null;
  return {
    reason: typeof b.reason === "string" ? b.reason.slice(0, REASON_MAX_LEN) : "",
  };
};

export interface SettingsUnreadableText {
  /** 横幅标题 */
  headline: string;
  /** 一句话说明原因 + 怎么办（不含文件内容） */
  detail: string;
}

/** reason → 给用户看的中文说明；按类别区分，未知类别回落通用文案 */
export const describeSettingsUnreadable = (
  reason: string,
): SettingsUnreadableText => {
  const headline = "配置文件 config.json 无法读取，设置已暂停保存";
  // 共同的后续指引：不会用空表单覆盖原文件；恢复手段（.bak / .bak.shrink 不一定存在，所以写「如果有」）+ 重新读取的方式。
  // .bak 每次保存都滚、误清配置后再存一次就被顶掉；.bak.shrink 只在清空 API key / 仓库等配置时才写、普通保存不碰，
  // 所以「误清」这类场景要单独点名它
  const next =
    "原文件没有被改动，也不会被空白设置覆盖。可以修复该文件；如果同目录有 config.json.bak（上一次保存前的版本），也可以用它覆盖 config.json。如果之前误清过 API key 或仓库配置，同目录的 config.json.bak.shrink（最近一次清空配置前的完整版本，如果有）里还留着它们，可以从那里找回。处理好后重新进入设置页即可，无需重启。";
  const code = /^([A-Z][A-Z0-9_]+):/.exec(reason)?.[1];
  let cause: string;
  if (reason.startsWith("json_parse")) {
    cause = "文件内容不是合法的 JSON（可能被手动编辑，或写入中途中断导致损坏）。同目录通常还留有 config.json.corrupt-* 副本。";
  } else if (reason === "settings_json_invalid") {
    cause = "文件的最外层不是对象（例如被写成了 [] 或其它内容）。";
  } else if (code === "EACCES" || code === "EPERM") {
    cause = "没有读取该文件的权限（也可能被杀毒软件或其它进程占用）。";
  } else if (code === "EISDIR") {
    cause = "该位置被一个同名目录占用，不是文件。";
  } else {
    cause = "读取该文件失败。";
  }
  return { headline, detail: `${cause}${next}` };
};