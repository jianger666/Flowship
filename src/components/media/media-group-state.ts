"use client";

/** 「同一条消息里的音视频」上下文（只放 context 本体，避免卡片 ↔ 作用域组件互相 import） */

import { createContext, useContext } from "react";

import type { ResolvedMediaRef } from "@/lib/media/media-ref";

export const MediaGroupContext = createContext<ReadonlyArray<ResolvedMediaRef> | null>(null);

/** chip / 卡片 / 链接取所在消息的对比组；不在消息里（产物栏等）为 null */
export const useMediaGroup = (): ReadonlyArray<ResolvedMediaRef> | null => useContext(MediaGroupContext);
