/**
 * 富输入「提交四件套」的组装（纯函数、不碰 React）
 *
 * 从 `use-rich-input` 抽出来的原因：这段是四处输入（chat 输入岛 / task 跟 AI 说 /
 * 推进弹窗 / 答题卡）与四条后端通道之间的实际契约——空值语义（空数组必须是
 * `undefined`、否则 body 里多出空字段）、正文 trim、skill 上限截断——却因为夹在
 * hook 里而完全测不到。挪到 lib 后可以直接单测。
 */

import { MAX_SKILL_REFS } from "@/lib/protocol-signals";
import type { ImagePayload } from "@/lib/task-store";

/** 提交时要交给 API 的四件套（空的一律 undefined、直接进 body 不用再判） */
export interface RichInputPayload {
  /** 用户原文（已 trim）。skill / 文件引用以 `/name`、`@rel/path` 内联其中 */
  text: string;
  images?: ImagePayload[];
  /** 原生 picker 选的文件 / 目录绝对路径 */
  attachments?: string[];
  /** `/` 引用到的 skill（指引由服务端拼进 agent 消息、不进用户气泡） */
  skillRefs?: Array<{ name: string; absPath: string }>;
}

export interface BuildRichInputPayloadInput {
  value: string;
  /** 已转成上传形态的图（调用方给空数组表示没有图） */
  images: ImagePayload[];
  /** 路径附件（调用方在 enablePaths=false 时给空数组） */
  paths: readonly string[];
  /** 正文里解析出的 skill 引用（顺序即出现顺序） */
  skillRefs: ReadonlyArray<{ name: string; absPath: string }>;
}

export interface BuildRichInputPayloadResult {
  payload: RichInputPayload;
  /**
   * skill 引用超上限、已截断到前 MAX_SKILL_REFS 个。
   * 调用方据此 toast——纯函数自己不弹提示。
   */
  skillOverflow: boolean;
}

/**
 * 组装提交载荷：正文 trim、空集合一律 undefined、skill 按 `MAX_SKILL_REFS` 截断。
 *
 * 截断而不是报错：服务端用同一个上限校验，不截的话第 9 个 `/skill` 会让整条消息
 * 400、把正文和附件一起赔进去。
 */
export const buildRichInputPayload = (
  input: BuildRichInputPayloadInput,
): BuildRichInputPayloadResult => {
  const refs = input.skillRefs.slice(0, MAX_SKILL_REFS);
  return {
    payload: {
      text: input.value.trim(),
      images: input.images.length > 0 ? input.images : undefined,
      attachments: input.paths.length > 0 ? [...input.paths] : undefined,
      skillRefs:
        refs.length > 0
          ? refs.map((s) => ({ name: s.name, absPath: s.absPath }))
          : undefined,
    },
    skillOverflow: input.skillRefs.length > refs.length,
  };
};
