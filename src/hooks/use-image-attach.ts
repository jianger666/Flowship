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
 *   2. 把 `handlers.onPaste` 交给编辑器 PASTE_COMMAND、`onDragOver/onDragLeave/onDrop` 绑到包裹容器、
 *      `onFileInputChange` 绑到隐藏 input、`triggerFilePicker()` 给附图按钮
 *   3. 渲染 `images` 缩略图、`removeImage(id)` 处理移除
 *   4. 提交时 `toUploadPayload()` 拿 ChatReplyImage[]、发完调 `reset()`
 *
 * disabled 选项：调用方不可输入时（如 chat 的 task.status !== "awaiting_user"）传 true、
 * 所有 handler 内部短路、避免无效操作。
 */

import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";

import type { ImagePayload } from "@/lib/task-store";
import {
  loadAttachmentSnapshot,
  updateAttachmentSnapshot,
  type DraftScope,
  type SnapshotImage,
} from "@/lib/view-memory";

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
interface PendingImage {
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
  /**
   * 附件快照持久化（切页/切任务不丢图）。不传 = 不持久化——
   * 弹窗 / 答题卡这类「关掉就该没了」的输入不该留快照。
   */
  persist?: { scope: DraftScope; id: string } | null;
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
  // 整单替换（切任务回来时从快照恢复用；默认同步写穿快照，restore() 传 skipPersist 做 0 写恢复）
  replaceAll: (images: PendingImage[], opts?: { skipPersist?: boolean }) => void;
  // 清空所有附图（提交成功后 / dialog 关闭时调；restore() 传 skipPersist 只清 UI 不碰快照）
  reset: (opts?: { skipPersist?: boolean }) => void;
  // 触发隐藏 input file 的 click（绑附图按钮 onClick）
  triggerFilePicker: () => void;

  // 直接绑编辑器 PASTE_COMMAND / 容器 onDragOver/onDragLeave/onDrop / input onChange
  // ClipboardEvent 同时覆盖 React 合成事件与 Lexical 原生 paste（两者都有 clipboardData + preventDefault）
  onPaste: (e: {
    clipboardData: DataTransfer | null;
    preventDefault: () => void;
  }) => void;
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragLeave: (e: React.DragEvent<HTMLDivElement>) => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  onFileInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;

  // 序列化成上传协议、给 fetch body 用、空列表返 undefined
  toUploadPayload: () => ImagePayload[] | undefined;
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

// 快照存的是无 File 的精简形态（File 不可序列化、且发送只用得到 name）；
// dataUrl 不存、用时现拼（跟 data 是同一份 base64，存双份最坏翻倍）。
// 恢复时合成空 File 占位（content 从不用它、只读 name/type）。
const toStored = (p: PendingImage): SnapshotImage => ({
  id: p.id,
  data: p.data,
  mimeType: p.mimeType,
  filename: p.file?.name ?? "",
});

const fromStored = (s: SnapshotImage): PendingImage => {
  const dataUrl = `data:${s.mimeType};base64,${s.data}`;
  return {
    id: s.id,
    file: new File([], s.filename, { type: s.mimeType }),
    dataUrl,
    data: s.data,
    mimeType: s.mimeType,
  };
};

/** 快照形态转回 PendingImage（useRichInput.restore 用；File 合成空占位即可） */
export const snapshotImagesToPending = (
  images: SnapshotImage[],
): PendingImage[] => images.map(fromStored);

// 读快照恢复图片列表；无快照 / 无 persist 返回空（跟以前行为一致）
const restoreImages = (
  persist: { scope: DraftScope; id: string } | null,
): PendingImage[] => {
  if (!persist) return [];
  const snap = loadAttachmentSnapshot(persist.scope, persist.id);
  if (!snap || snap.images.length === 0) return [];
  return snap.images.map(fromStored);
};

// 快照写穿：只换 images、paths 原样保留（走原子更新，跟 paths 侧互不覆盖）
const persistImages = (
  persist: { scope: DraftScope; id: string } | null,
  images: PendingImage[],
): void => {
  if (!persist) return;
  updateAttachmentSnapshot(persist.scope, persist.id, (prev) => ({
    images: images.map(toStored),
    paths: prev?.paths ?? [],
  }));
};

export const useImageAttach = (
  options?: UseImageAttachOptions,
): UseImageAttachReturn => {
  const maxImages = options?.maxImages ?? DEFAULT_MAX_IMAGES;
  const maxBytesPerImage = options?.maxBytesPerImage ?? DEFAULT_MAX_IMAGE_BYTES;
  const persist = options?.persist ?? null;
  // 当前快照 key 的同步镜像：addFiles 跨 await（读文件）后回来可能已切任务——
  // 用调用时刻的 key 写快照、用「key 没变」守 setState，迟到的图只进快照不串屏
  const persistRef = useRef(persist);
  persistRef.current = persist;

  // 待发送的图片附件列表（粘贴 / 拖拽 / 选文件三种途径添进来）；
  // 有 persist 时初值从快照恢复（切页/切任务回来图还在）
  const [images, setImages] = useState<PendingImage[]>(() =>
    restoreImages(persist),
  );
  // images 的同步镜像：addFiles 异步读文件、合并前读 ref 拿最新列表（闭包里的 images 可能陈旧）；
  // 也让 toast 副作用留在回调里、不进 setState updater（updater 必须纯、StrictMode 双调会弹两次，
  // 同 use-path-attach 的 pathsRef 套路）
  const imagesRef = useRef<PendingImage[]>([]);
  imagesRef.current = images;
  // 合并串行闸：粘贴 / 拖拽 / 选文件几乎同时完成时，防止「都基于同一份 ref 快照合并」互相覆盖
  const mergeLockRef = useRef<Promise<void>>(Promise.resolve());
  // 拖拽状态：drag over 时整片输入区高亮、给用户视觉反馈
  const [isDragging, setIsDragging] = useState(false);
  // 隐藏 <input type="file">、点击附图按钮触发它
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // 把 File[] 转成 PendingImage[] 加进 images
  // 校验：mimeType 白名单 / 单图 size / 总张数上限（任何一项失败 → toast + 跳过该图）
  // 去重（#bugfix）：同一次粘贴在剪贴板里常有同图多条 item（Electron / 截图工具常同时带
  // image/png + image/x-png + image/bitmap…）、或同一张图被重复粘贴——这些都必须只算一张，
  // 否则一张图占掉 2~N 个名额、列表被「幽灵重复图」塞满，之后明明只贴了一张却弹「最多附 6 张图」。
  const addFiles = async (files: File[]) => {
    if (options?.disabled) return;
    if (files.length === 0) return;
    // 调用时刻的快照 key：读文件是 async，回来时用户可能已切任务——
    // 快照写调用时刻的 key、setState 只在 key 没变时做，迟到的图不串屏
    const snapScope = persistRef.current?.scope;
    const snapId = persistRef.current?.id;
    const additions: PendingImage[] = [];
    // 本次输入内的去重键（base64 内容）：同一张图多条 item 只取第一条
    const batchSeen = new Set<string>();
    for (const file of files) {
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
        const data = stripDataUrlPrefix(dataUrl);
        if (batchSeen.has(data)) continue;
        batchSeen.add(data);
        additions.push({
          id: newPendingId(),
          file,
          dataUrl,
          data,
          mimeType: file.type,
        });
      } catch (err) {
        toast.error(
          `读 ${file.name || "(未命名)"} 失败：${(err as Error).message}`,
        );
      }
    }
    if (additions.length === 0) return;

    // 合并串行化：同一时刻只有一个合并读/写 imagesRef、再 setImages 绝对列表——
    // 既保并发粘贴不互相覆盖，又不把副作用写进 setState updater
    mergeLockRef.current = mergeLockRef.current.then(() => {
      // 合并基准：有快照 key 时以调用时刻那份快照为准（切任务后 imagesRef 可能已是新任务的）；
      // 无 key（弹窗类）沿用原 imagesRef 逻辑
      const hasSnapKey = !!snapScope && !!snapId;
      const current: PendingImage[] =
        hasSnapKey && snapScope && snapId
          ? (loadAttachmentSnapshot(snapScope, snapId)?.images.map(fromStored) ?? [])
          : imagesRef.current;
      // 对已附图按内容去重：同一张图已经挂着就不重复占名额
      const existing = new Set(current.map((p) => p.data));
      const fresh = additions.filter((a) => !existing.has(a.data));
      const dup = additions.length - fresh.length;
      const room = maxImages - current.length;
      if (room <= 0) {
        toast.error(`最多附 ${maxImages} 张图、先发送 / 移除几张再加`);
        return;
      }
      const kept = fresh.slice(0, room);
      if (kept.length === 0) {
        toast.info(`已忽略 ${dup} 张重复图片`);
        return;
      }
      const next = current.concat(kept);
      // 切任务后回来的迟到合并：只写旧任务快照、不碰当前屏幕（防串任务）
      const stillCurrent =
        !hasSnapKey ||
        (persistRef.current?.scope === snapScope &&
          persistRef.current?.id === snapId);
      if (stillCurrent) {
        imagesRef.current = next;
        setImages(next);
      }
      if (hasSnapKey && snapScope && snapId) {
        persistImages({ scope: snapScope, id: snapId }, next);
      }
      if (fresh.length > room) {
        toast.warning(
          `图太多、超出上限 ${maxImages} 张、已截断到 ${kept.length} 张`,
        );
      } else if (dup > 0) {
        toast.info(`已忽略 ${dup} 张重复图片`);
      }
    });
  };

  const removeImage = (id: string) => {
    const next = imagesRef.current.filter((p) => p.id !== id);
    imagesRef.current = next;
    setImages(next);
    const p = persistRef.current;
    if (p) persistImages(p, next);
  };

  // 整单替换（切任务回来时从快照恢复用；默认同步写穿快照，restore() 传 skipPersist 做 0 写恢复）
  const replaceAll = useCallback(
    (images: PendingImage[], opts?: { skipPersist?: boolean }) => {
      const p = persistRef.current;
      imagesRef.current = images;
      setImages(images);
      if (!opts?.skipPersist && p) persistImages(p, images);
    },
    [],
  );

  // useCallback（稳定引用）：调用方要把它放进 useEffect 依赖（切 task 时清附件），
  // 每次 render 换个新函数会让那个 effect 每帧都跑一遍、把用户正在打的内容清掉
  //（use-path-attach 的回调同理，全是稳定引用）。
  // 有 persist 时同步写穿空快照（保留 paths 那半）：快照==state 的不变式由本 hook自己保证，
  // 不依赖调用方“记得调 rich.reset”。restore() 恢复时传 skipPersist、只清 UI 不碰快照
  //（快照已提前读出来了，写穿是多余的 0 写优化 + 不污染 LRU）。
  const reset = useCallback((opts?: { skipPersist?: boolean }) => {
    imagesRef.current = [];
    setImages([]);
    setIsDragging(false);
    const p = persistRef.current;
    if (!opts?.skipPersist && p) persistImages(p, []);
  }, []);

  const triggerFilePicker = () => {
    if (options?.disabled) return;
    fileInputRef.current?.click();
  };

  // 粘贴：clipboardData.items 里可能含 image（截图工具粘贴 / 浏览器右键复制图片）
  // 有 image → 阻止默认 + addFiles。纯文本粘贴不拦、走编辑器默认行为
  const onPaste = (e: {
    clipboardData: DataTransfer | null;
    preventDefault: () => void;
  }) => {
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

  const toUploadPayload = (): ImagePayload[] | undefined => {
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
    replaceAll,
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
