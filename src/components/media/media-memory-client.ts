/**
 * 播放器记忆的浏览器端单例（localStorage）。
 * 访问 localStorage 本身可能抛（隐私模式 / 被禁用）：拿不到就退化成纯内存，播放器照常工作。
 */

import { createMediaMemory, type MediaMemory } from "@/lib/media/media-memory";

let instance: MediaMemory | null = null;

export const getMediaMemory = (): MediaMemory => {
  if (instance) return instance;
  let storage: Storage | null = null;
  try {
    storage = typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    storage = null;
  }
  instance = createMediaMemory(storage);
  return instance;
};
