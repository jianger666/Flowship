"use client";

/**
 * 公共 hook：图片附件管理（V0.5.4 抽）
 *
 * 复用动机：`event-stream.tsx`（chat 输入框）和 `revise-dialog.tsx`（再聊聊弹窗）
 * 都需要「粘贴 / 拖拽 / 选文件 → 校验 → 缩略图 → 发送 → 清空」这一整套图附件交互。
 * 原本两处各写一遍、约 200 行重复逻辑。
 *
 * 本 hook 收敛：
 *   - state：附图列表 + 拖拽态 + 隐藏 input 的 ref
 *   - handler：粘贴 / 拖拽 / 选文件 / 移除 / 清空
 *   - 校验：mimeType 白名单 / 单图 size / 最大张数（约束跟后端 task-fs.ts 对齐）
 *   - 序列化：`toUploadPayload()` 转成 `ChatReplyImage[]`（直接 POST 用）
 *
 * 调用方只需要：
 *   1. `const { images, isDragging, fileInputRef, ...handlers } = useImageAttach({ disabled })`
 *   2. 把 `handlers.onPaste` 绑到 Textarea、`onDragOver/onDragLeave/onDrop` 绑到包裹容器、
 *      `onFileInputChange` 绑到隐藏 input、`triggerFilePicker()` 给附图按钮
 *   3. 渲染 `images` 缩略图、`removeImage(id)` 处理移除
 *   4. 提交时 `toUploadPayload()` 拿 ChatReplyImage[]、发完调 `reset()`
 *
 * disabled 选项：调用方不可输入时（如 chat 的 task.status !== "awaiting_user"）传 true、
 * 所有 handler 内部短路、避免无效操作。
 */

import { useRef, useState } from "react";
import { toast } from "sonner";

import type { ChatReplyImage } from "@/lib/task-store";

// 图片白名单（跟后端 task-fs.ts 的 ALLOWED_IMAGE_MIME 保持一致）
const DEFAULT_ALLOWED_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);

// 单图上限 10MB（跟后端 task-fs.ts 保持一致、前端先拦防止白白上传）
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
// 默认最多 6 张（跟 chat-reply / phase-ack 后端常量对齐）
const DEFAULT_MAX_IMAGES = 6;

/**
 * 输入框待发送的图片附件、UI 内部状态、发送后清空。
 * - id: React key、本地随机
 * - dataUrl: 完整 data: URL（含 mime 前缀）、给 <img> src 预览用
 * - data: 纯 base64（不带前缀）、发送时塞 POST body
 */
export interface PendingImage {
  id: string;
  file: File;
  dataUrl: string;
  data: string;
  mimeType: string;
}

export interface UseImageAttachOptions {
  // 禁用时所有 handler 短路、用于「未到可输入态」场景（如 chat awaiting_user=false）
  disabled?: boolean;
  // 覆盖默认上限、不传走 DEFAULT_MAX_IMAGES（6）
  maxImages?: number;
  // 覆盖默认单图 size 上限
  maxBytesPerImage?: number;
}

export interface UseImageAttachReturn {
  // 当前附图列表（用于渲染缩略图）
  images: PendingImage[];
  // 拖拽态、true 时输入区高亮提示
  isDragging: boolean;
  // 隐藏 <input type="file"> 的 ref、调用方挂到 input 上
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  // 上限值（调用方渲染「图 N/M」状态文案用）
  maxImages: number;

  // 移除指定 id 的图（点缩略图右上角 X 触发）
  removeImage: (id: string) => void;
  // 清空所有附图（提交成功后 / dialog 关闭时调）
  reset: () => void;
  // 触发隐藏 input file 的 click（绑附图按钮 onClick）
  triggerFilePicker: () => void;

  // 直接绑 Textarea onPaste / 容器 onDragOver/onDragLeave/onDrop / input onChange
  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragLeave: (e: React.DragEvent<HTMLDivElement>) => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  onFileInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;

  // 序列化成上传协议、给 fetch body 用、空列表返 undefined
  toUploadPayload: () => ChatReplyImage[] | undefined;
}

// FileReader.readAsDataURL Promise 化、解出 dataUrl
const readFileAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("读文件失败"));
    reader.readAsDataURL(file);
  });

// 从 dataUrl 切出纯 base64（"data:image/png;base64,xxx" → "xxx"）
const stripDataUrlPrefix = (dataUrl: string): string => {
  const idx = dataUrl.indexOf("base64,");
  return idx >= 0 ? dataUrl.slice(idx + "base64,".length) : dataUrl;
};

const newPendingId = (): string =>
  `att_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

export const useImageAttach = (
  options?: UseImageAttachOptions,
): UseImageAttachReturn => {
  const maxImages = options?.maxImages ?? DEFAULT_MAX_IMAGES;
  const maxBytesPerImage = options?.maxBytesPerImage ?? DEFAULT_MAX_IMAGE_BYTES;

  // 待发送的图片附件列表（粘贴 / 拖拽 / 选文件三种途径添进来）
  const [images, setImages] = useState<PendingImage[]>([]);
  // 拖拽状态：drag over 时整片输入区高亮、给用户视觉反馈
  const [isDragging, setIsDragging] = useState(false);
  // 隐藏 <input type="file">、点击附图按钮触发它
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // 把 File[] 转成 PendingImage[] 加进 images
  // 校验：mimeType 白名单 / 单图 size / 总张数上限（任何一项失败 → toast + 跳过该图）
  const addFiles = async (files: File[]) => {
    if (options?.disabled) return;
    if (files.length === 0) return;
    const remainingSlots = maxImages - images.length;
    if (remainingSlots <= 0) {
      toast.error(`最多附 ${maxImages} 张图、先发送 / 移除几张再加`);
      return;
    }
    const toProcess = files.slice(0, remainingSlots);
    if (files.length > remainingSlots) {
      toast.warning(
        `图太多、超出上限 ${maxImages} 张、已截断到 ${remainingSlots} 张`,
      );
    }
    const additions: PendingImage[] = [];
    for (const file of toProcess) {
      if (!DEFAULT_ALLOWED_MIMES.has(file.type)) {
        toast.error(
          `${file.name || "(未命名)"} 不是支持的图片格式（${file.type || "未知"}）`,
        );
        continue;
      }
      if (file.size > maxBytesPerImage) {
        toast.error(
          `${file.name || "(未命名)"} 太大（${(file.size / 1024 / 1024).toFixed(2)} MB > ${maxBytesPerImage / 1024 / 1024} MB）`,
        );
        continue;
      }
      try {
        const dataUrl = await readFileAsDataUrl(file);
        additions.push({
          id: newPendingId(),
          file,
          dataUrl,
          data: stripDataUrlPrefix(dataUrl),
          mimeType: file.type,
        });
      } catch (err) {
        toast.error(
          `读 ${file.name || "(未命名)"} 失败：${(err as Error).message}`,
        );
      }
    }
    if (additions.length > 0) {
      setImages((prev) => [...prev, ...additions]);
    }
  };

  const removeImage = (id: string) => {
    setImages((prev) => prev.filter((p) => p.id !== id));
  };

  const reset = () => {
    setImages([]);
    setIsDragging(false);
  };

  const triggerFilePicker = () => {
    if (options?.disabled) return;
    fileInputRef.current?.click();
  };

  // 粘贴：clipboardData.items 里可能含 image（截图工具粘贴 / 浏览器右键复制图片）
  // 有 image → 阻止默认 + addFiles。纯文本粘贴不拦、走 Textarea 默认行为
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (options?.disabled) return;
    const items = e.clipboardData?.items;
    if (!items || items.length === 0) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item) continue;
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      void addFiles(files);
    }
  };

  // 拖拽：dragenter / dragover 标 isDragging + preventDefault（不然 drop 不触发）
  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (options?.disabled) return;
    if (e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      setIsDragging(true);
    }
  };
  const onDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    // 子元素 dragleave 会冒泡、用 relatedTarget 判断「真离开了输入区」才置 false
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setIsDragging(false);
  };
  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    if (options?.disabled) return;
    e.preventDefault();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files ?? []).filter((f) =>
      f.type.startsWith("image/"),
    );
    if (files.length > 0) void addFiles(files);
  };

  // 隐藏 input 选完文件回调
  const onFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    void addFiles(files);
    // 清掉 input value、不然连选同一张图不触发 onChange
    e.target.value = "";
  };

  const toUploadPayload = (): ChatReplyImage[] | undefined => {
    if (images.length === 0) return undefined;
    return images.map((p) => ({
      data: p.data,
      mimeType: p.mimeType,
      filename: p.file.name,
    }));
  };

  return {
    images,
    isDragging,
    fileInputRef,
    maxImages,
    removeImage,
    reset,
    triggerFilePicker,
    onPaste,
    onDragOver,
    onDragLeave,
    onDrop,
    onFileInputChange,
    toUploadPayload,
  };
};
