/**
 * 「本地音视频展示」提示词段（单一来源）：告诉 AI——Flowship 能在对话里直接播放本机的音视频，
 * 以及要怎么写，用户才点得开。
 *
 * 谁用：Chat 的 `buildInitialPrompt`（chat-runner）、任务的 `loadSharedPrompt`（task-prompts，追加在
 * sharedRules 末尾 → 预算 L1，永不被裁、字节计入）。**不要把同一段文字手抄进 prompts/_shared.md**——
 * 纯 md 引不了这个 helper，抄了必漂移（_shared.md §3 第 5 条只有一句指向本段的例外）。
 * 不注入：飞书群答疑只读 prompt（restricted-question）、子代理 prompt、标题生成等与对话界面无关的 prompt
 * （理由与完整清单见 docs/HANDOFF.md「提示词内置」一节）。
 *
 * 这里写的每一句都必须和真实解析器 / 真实界面一致：`tests/media-display-prompt.test.ts` 把本段里的行内代码示例
 * 和链接示例喂给真实的 `parseMediaRefToken` / `extractMediaRefsFromMarkdown`，谁改了解析规则而没改这里会红。
 * 只写已验证的行为；没验证的（裸路径不加反引号会不会变入口、任务产物文档里有没有媒体卡片）不写。
 *
 * 扩展名清单从 `VIDEO_EXTS` / `AUDIO_EXTS` 插值，不手写。篇幅 ≤ 1200 字节（测试守着，防膨胀）。
 */

import { AUDIO_EXTS, VIDEO_EXTS } from "@/lib/media/media-kind";

export const MEDIA_DISPLAY_PROMPT_TITLE = "## 本地音视频展示（Flowship 能在对话里直接播放）";

export const mediaDisplayPromptSection = (): string =>
  [
    MEDIA_DISPLAY_PROMPT_TITLE,
    "",
    "要让用户看 / 听本机文件，用**行内代码**写路径，一个文件一个反引号、里面**只放路径**：`/Users/xxx/out/preview_720p.mp4`。也可用 markdown 链接 [成片](/Users/xxx/out/final.mp4)（链接只认绝对路径）；行内代码的相对路径按任务工作目录解析，要带目录（光写 `a.mp4` 不认）。",
    `- 支持：${[...VIDEO_EXTS, ...AUDIO_EXTS].join(" ")}（文件须已写入磁盘）。给用户看的视频用 H.264 + AAC 的 mp4；mkv / avi 不会变成播放器，HEVC 浏览器播不了（请用户点「系统播放器打开」），别声称能直接播。`,
    "- 时间段：路径后加 `#t=起,止`（秒），如 `/Users/xxx/a.mp4#t=12.4,15`；只给起点写 `/Users/xxx/a.mp4#t=12.4`。点开从起点播，到止点暂停。",
    "- 对比类内容放同一条回复：自动成组，数字键 1–9 切换；定稿后末尾自动出媒体卡片，不用再贴。",
    "- 不要：围栏代码块、图片语法、video 标签、http(s) 链接、`~/Movies/a.mp4`——都不会变成播放器；文件名避开 # 和单引号。只在用户需要看 / 听时引用。",
  ].join("\n");
