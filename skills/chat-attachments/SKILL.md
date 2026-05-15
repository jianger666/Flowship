---
name: chat-attachments
description: >-
  处理 fe-ai-flow chat 模式下用户附的图片 / 文件 / 目录。
  当 `wait_for_user` 工具的返回文本里出现 `[ATTACHED_IMAGES]` 或 `[ATTACHED_PATHS]` 标记时、
  请 read 本 skill。这两个标记后面跟的是用户希望你跟他的文字消息一起检查的绝对路径列表。
---

# fe-ai-flow Chat 用户附件处理

用户在 fe-ai-flow chat UI 里可以**附两类东西**、`wait_for_user` 返回的 text 会拼对应标记段：

## A. `[ATTACHED_IMAGES]`：图片（粘贴 / 拖拽 / 选文件）

当 `wait_for_user` return text 末尾出现 `[ATTACHED_IMAGES]` 段、紧跟一行行绝对路径：

```
[ATTACHED_IMAGES] 用户附了以下图片、请用 `read_file` 工具逐一读取（SDK 内置 read_file 会把图片转成 vision、你能直接看到图像内容）：
  1. /Users/.../tasks/<id>/uploads/att_xxx.png
  2. /Users/.../tasks/<id>/uploads/att_yyy.jpg
```

**必须做的事**：

1. 对**每张图**用 SDK 内置 `read_file` 工具读它的绝对路径
2. SDK 内置 `read_file` 对图片文件有 vision 处理：
   - 检测 magic bytes 自动走 image 通道
   - 自动 resize 优化大小、把像素喂给你
   - 读完你就**真的看到了图片像素内容**
3. 然后基于图 + 用户的文字消息一起回复

## B. `[ATTACHED_PATHS]`：任意文件 / 目录路径（用户用 FsPickerDialog 选的）

当 `wait_for_user` return text 末尾出现 `[ATTACHED_PATHS]` 段：

```
[ATTACHED_PATHS] 用户附了以下文件 / 目录路径、按需用 `read_file` / `grep` / `glob` 读取（路径已是绝对路径、直接用）：
  1. /Users/foo/repo/src/auth/login.ts
  2. /Users/foo/repo/docs/
```

**必须做的事**：

1. 这些是**真实存在**的绝对路径（fe-ai-flow 后端已校验）、直接用就行
2. **文件路径**：用 `read_file` 读内容、然后基于内容 + 用户问题回复
3. **目录路径**：先用 `read_file` 或 list 命令看看里面有啥、再决定要不要 `grep` / `glob` 进一步探索
4. 一般用户附了路径就是想让你**针对这些位置**回答问题、别再去仓库别处找

## A / B 通用的不要做的事

- 不要尝试用 base64 / data URL 自己解析图（SDK 已经处理）
- 不要说「我没法看图 / 我看不到附件 / 请用文字描述」——你完全能读路径
- 不要质疑路径合不合法、直接读就行（路径是 fe-ai-flow 后端校验过的绝对路径）
- 不要把 `[ATTACHED_IMAGES]` / `[ATTACHED_PATHS]` 字面回贴给用户、这是内部协议、用户看不到也不需要看到
