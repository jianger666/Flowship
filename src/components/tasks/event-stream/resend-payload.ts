"use client";

/**
 * 「把某条 user_reply 原样再发一遍」的载荷复建（单一来源）
 *
 * 重发 / 重新生成 / 错误卡重试都是同一件事：拿一条历史 user_reply，把它当新消息发到末尾
 * （架构是 append-only 持久会话、做不了 fork 截断）。原文之外还得把当时贴的图和选的路径
 * 附件一起带回来，否则 agent 看到的上下文跟用户以为自己重发的不是同一条。
 *
 * 图片存在 uploads 静态目录、发送接口要 base64——这里负责回读并转码；取不到的图跳过、
 * 由调用方决定是否提示（重发一半图比整条发不出去强）。
 *
 * ⚠️ event-stream.tsx 里 `handleResend` 目前还有一份同逻辑的内联实现（该文件当时被
 * 并行改动占用、没能一起收口）。以本模块为准、那份内联实现应迁移过来。
 */

import { fetchSkills, resolveSkillReferences } from "@/components/slash-skills";
import { pathBasename } from "@/lib/path-utils";
import type { ImagePayload } from "@/lib/task-store";
import type { TaskEvent } from "@/lib/types";

import {
  extractUserReplyAttachments,
  extractUserReplyImages,
} from "./utils";

/** uploads 静态文件 → base64 ImagePayload；取不到（404 / 网络失败）返 null */
const fetchUploadAsPayload = async (
  taskId: string,
  absPath: string,
  mimeType: string,
  filename?: string,
): Promise<ImagePayload | null> => {
  try {
    const name = pathBasename(absPath);
    const res = await fetch(
      `/api/tasks/${encodeURIComponent(taskId)}/uploads/${encodeURIComponent(name)}`,
    );
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]!);
    }
    return { data: btoa(binary), mimeType, filename };
  } catch {
    return null;
  }
};

export interface ResendPayload {
  text: string;
  images?: ImagePayload[];
  attachments?: string[];
  skillRefs?: Array<{ name: string; absPath: string }>;
  /** 有图没能回读（调用方可据此提示「部分附图未能重发」） */
  imagesPartial: boolean;
}

/**
 * 从一条 user_reply 事件复建重发载荷。
 * skill 引用按原文重新解析（skill 列表可能已变、以当下真实存在的为准）。
 */
export const buildResendPayload = async (
  taskId: string,
  ev: TaskEvent,
): Promise<ResendPayload> => {
  const text = ev.text;

  const skills = await fetchSkills();
  const refs = resolveSkillReferences(text, skills);
  const skillRefs =
    refs.length > 0
      ? refs.map((s) => ({ name: s.name, absPath: s.absPath }))
      : undefined;

  let images: ImagePayload[] | undefined;
  let imagesPartial = false;
  const imgs = extractUserReplyImages(ev.meta);
  if (imgs.length > 0) {
    const payloads = await Promise.all(
      imgs.map((img) =>
        fetchUploadAsPayload(taskId, img.absPath, img.mimeType, img.filename),
      ),
    );
    const ok = payloads.filter((p): p is ImagePayload => p != null);
    if (ok.length > 0) images = ok;
    imagesPartial = ok.length < imgs.length;
  }

  const atts = extractUserReplyAttachments(ev.meta);
  const attachments =
    atts.length > 0 ? atts.map((a) => a.absPath) : undefined;

  return { text, images, attachments, skillRefs, imagesPartial };
};

/** 倒着找最后一条用户消息（重发 / 重试的原文来源） */
export const findLastUserReply = (
  events: readonly TaskEvent[],
): TaskEvent | undefined => {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.kind === "user_reply") return events[i]!;
  }
  return undefined;
};
