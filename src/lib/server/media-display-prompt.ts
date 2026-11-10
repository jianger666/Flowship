/**
 * 「本地文件展示」提示词段（单一来源，只放**通用核心规则**）：告诉 AI——Flowship 能在对话里直接预览 / 播放本机文件，
 * 向用户展示 / 交付的每个本机文件（成品图片、音视频、文档、网页、导出文件……）都要写完整绝对路径（行内代码），
 * 不要只写文件名、不要「先给目录、再列一串文件名」、不要 `~/` 开头，也别为了展示去 `open` / `open -R` 弹 Finder 或系统播放器。
 *
 * 范围为什么是「展示给用户的本机文件」而不是「音视频」（R7-15）：原来只写「音频 / 视频」，同一条回复里 mp4 有播放入口、
 * 紧跟着的四张 jpg 只写了文件名——渲染端对裸文件名无能为力（`looksLikePath` 要求含 `/`；相对路径按任务 cwd 解析、
 * `~/` 不展开，都会指错地方），**绝对路径是唯一可靠的写法**，所以规则对所有「给用户看的文件」一视同仁。
 * 范围只是「给用户看的产物文件」，不是所有路径：仓库代码引用（`path:line`、从仓库根起算的相对路径）与 action artifact 的写法不变，
 * `prompts/_shared.md` §3 第 5 条的例外也只覆盖展示 / 交付的文件。
 * 函数名 / 常量名（`MEDIA_DISPLAY_*` / `mediaDisplayPromptSection`）为了少改动没有改；skill 仍叫 `media-playback`。
 *
 * 为什么只剩一句核心规则（R7-02）：规则只在会话第一条消息出现一次，长对话里模型会逐渐不照做（实测：同一个会话里 12 条回复写对过
 * 完整路径、4 条只写文件名，用户要「听听」时它只写了文件名、还自己 `open -R` 弹了 Finder）。原来的完整写法 + 反例把预算占满（1186 / 1200
 * 字节），加不进「别只写文件名 / 别用 open 弹窗口」。所以：主提示词压成一句不针对任何场景 / 用词的核心规则，细节（时间段 / 成组 /
 * 支持格式 / 反例）搬进平台 skill `skills/media-playback/SKILL.md`（随包、进 chat / task 的 skill 索引，按需读）。
 * 不做渲染端兜底、不做按关键词的轮次提醒（用户明确不要「专门命中」式的补丁）。
 *
 * 谁用：Chat 的 `buildInitialPrompt`（chat-runner）、任务的 `loadSharedPrompt`（task-prompts，追加在
 * sharedRules 末尾 → 预算 L1，永不被裁、字节计入）。**不要把同一段文字手抄进 prompts/_shared.md**——
 * 纯 md 引不了这个 helper，抄了必漂移（_shared.md §3 第 5 条只有一句指向本段的例外）。
 * 不注入：飞书群答疑只读 prompt（restricted-question）、子代理 prompt、标题生成等与对话界面无关的 prompt
 * （理由与完整清单见 docs/HANDOFF.md「提示词内置」一节）。
 *
 * 这里写的每一句都必须和真实解析器 / 真实界面一致：`tests/media-display-prompt.test.ts` 把本段里的行内代码示例喂给真实的
 * `parseMediaRefToken` / `looksLikePath` / `resolveLocalFileAbsolute`（示例路径解析出的绝对路径必须等于原路径），
 * 并用反例钉住「为什么必须是绝对路径」（裸文件名不是路径、`~/` 不展开）；skill 里的行内代码 / 链接示例也喂给真实的
 * `parseMediaRefToken` / `extractMediaRefsFromMarkdown`，skill 里的扩展名清单与 `VIDEO_EXTS` / `AUDIO_EXTS` 对账——
 * 谁改了解析规则而没改这里 / skill 会红。
 * 篇幅 ≤ 700 字节（测试守着，防膨胀；R7-15 从 500 放宽是因为范围由「音视频」扩到「所有展示给用户的文件」、
 * 多了「不要先给目录再列文件名 / 不要 `~/`」两条反例和一个 jpg 示例；细节仍进 skill，别塞回来）。
 */

export const MEDIA_DISPLAY_PROMPT_TITLE = "## 本地文件展示（Flowship 能在对话里直接预览 / 播放）";

/** 主提示词里指向 skill 的名字（skills/media-playback/SKILL.md 的 `name`） */
export const MEDIA_DISPLAY_SKILL_NAME = "media-playback";

export const mediaDisplayPromptSection = (): string =>
  [
    MEDIA_DISPLAY_PROMPT_TITLE,
    "",
    `向用户展示 / 交付本机文件（成品图片、音视频、文档、网页、导出文件……）时，每个文件都写**完整绝对路径**的行内代码（一个文件一个反引号，里面只放路径）：\`/Users/xxx/out/final.mp4\`、\`/Users/xxx/out/result.jpg\`。不要只写文件名；不要「先给目录、再列一串文件名」；不要 \`~/\` 开头；不要为了展示去 \`open\` / \`open -R\` 弹 Finder 或系统播放器。时间段、成组对比、支持格式等细节读 skill \`${MEDIA_DISPLAY_SKILL_NAME}\`。`,
  ].join("\n");
