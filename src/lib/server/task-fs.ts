/**
 * Server-side 任务持久化层（V1）
 *
 * 数据布局（落 fe-ai-flow 项目自身的 data/ 下、跟着 git ignore 走）：
 *
 *   data/
 *     tasks/
 *       <taskId>/
 *         meta.json        ← 任务元信息（不含 events / artifacts）
 *         events.jsonl     ← 事件流、每行一条 JSON、追加写
 *         spec.md          ← phase 产物（生成后才有）
 *         plan.md
 *         build.md
 *
 * 设计要点：
 * - meta.json + events.jsonl + *.md 三种文件分工明确、各自的写入特性不同：
 *   - meta.json 整体覆盖（次数低、读多写少）
 *   - events.jsonl 追加写（高频、不能整体重写否则丢日志）
 *   - *.md 整体覆盖（一次 phase 一个 artifact）
 * - 这个布局好处是：人能 cat / 编辑器开 / git diff、未来要看历史也清楚
 * - V1 不再 seed mock 任务、首次空列表就是空（避免用户清掉 data/ 后又凭空冒出 mock）
 *
 * 文件名使用安全：
 * - taskId 由 newTaskId() 生成、只用 [a-z0-9_]、不存在路径穿越风险
 * - 但所有外部传入的 id 仍然走 sanitizeId 校验、防止 ../ 之类
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  WORKFLOWS,
  type NewTaskInput,
  type PhaseId,
  type PhaseState,
  type PhaseStatus,
  type Task,
  type TaskContextDoc,
  type TaskContextDocType,
  type TaskEvent,
  type TaskMode,
  type TaskRole,
  type TaskStatus,
  type WorkflowId,
} from "@/lib/types";

// ----------------- 路径常量 -----------------

const DATA_DIR = path.join(process.cwd(), "data", "tasks");
const META_FILE = "meta.json";
const EVENTS_FILE = "events.jsonl";
const ARTIFACTS_DIR = "artifacts";

// V0.2 全 phase 序、UI / hydrate 时用
// （workflow 自己也定义了 phases、但 hydrateTask 不知道是哪条 workflow、就用全集兜底）
// V0.3.3 移除 ship phase、V0.3.4 把 context 合进 plan
const PHASE_ORDER: PhaseId[] = ["plan", "build"];

// ----------------- 工具 -----------------

const newTaskId = (): string =>
  `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const newEventId = (): string =>
  `e_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// 防路径穿越：只允许字母数字下划线
const sanitizeId = (id: string): string => {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`非法 task id: ${id}`);
  }
  return id;
};

const taskDir = (id: string): string =>
  path.join(DATA_DIR, sanitizeId(id));

/**
 * 给 agent prompt 用的 events.jsonl 绝对路径。
 *
 * 为啥要绝对路径：agent 的 cwd 是 task.repoPath（用户的业务仓库）、
 * 而 events.jsonl 在 fe-ai-flow 项目自己的 data/ 下、跨 cwd 必须用绝对路径
 * 否则 agent read_file 时按 cwd 解析直接 ENOENT。
 *
 * 不做 exists 检查、给路径就行（首次启动文件可能还不存在、agent 自己处理）。
 */
export const getEventsLogPath = (taskId: string): string =>
  path.join(taskDir(taskId), EVENTS_FILE);

/**
 * 给 agent prompt 用的 artifacts 目录绝对路径。
 *
 * V0.2 约定 artifact 文件名格式：`<NN>-<phase>.md`、NN 是 phase 在 workflow 里的序号、补 0 到 2 位。
 * agent 用 SDK edit_file 工具写到这个绝对路径下、然后 hydrateTask 时按这套约定读出来。
 *
 * 例如 feishu-story-impl workflow（V0.3.4 起 [plan, build]）：
 *   data/tasks/<id>/artifacts/01-plan.md
 *   data/tasks/<id>/artifacts/02-build.md
 */
export const getArtifactsDir = (taskId: string): string =>
  path.join(taskDir(taskId), ARTIFACTS_DIR);

/**
 * 给 phase 算 artifact 文件相对名（`01-plan.md`、不含目录前缀）。
 *
 * idx 是 phase 在 workflow phases 数组里的位置（0-based）、+1 后 padStart(2,"0")。
 * 如果 idx<0（phase 不在当前 workflow、或者老数据没 workflowId）、不带前缀、退回到 legacy 命名 `<phase>.md`。
 */
const phaseArtifactFilename = (phaseId: PhaseId, idx: number): string => {
  if (idx < 0) return `${phaseId}.md`;
  const padded = String(idx + 1).padStart(2, "0");
  return `${padded}-${phaseId}.md`;
};

/**
 * 给 phase 算 artifact 绝对路径（prompt 里塞给 agent）。
 */
export const getPhaseArtifactPath = (
  taskId: string,
  phaseId: PhaseId,
  idx: number,
): string => path.join(getArtifactsDir(taskId), phaseArtifactFilename(phaseId, idx));

// ----------------- 用户上传图片 -----------------
//
// 思路：用户在 chat 里粘贴 / 拖 / 选图 → 前端 base64 → 后端这里落盘到
// data/tasks/<id>/uploads/<uuid>.<ext>、再把绝对路径塞给 wait_for_user 工具的 return text。
// agent 看到路径 → 用 SDK 内置 read_file 读 → SDK 自动检测 image magic bytes →
// 走 vision 通道 → 模型真能看图。
//
// 不用 base64 + MCP image content（实测 SDK 拒收）、改走文件路径 + 内置工具 = 三全其美：
//   - 保单 Run、不破基准
//   - 真 vision、不只是文件名
//   - 不用我们手动处理 resize（SDK 内置）
//
// 安全：mimeType 白名单 + 单图 size 上限 + 落盘文件名只用 uuid（防穿越）
const UPLOADS_DIR = "uploads";

// 允许的图片 mime（agent 实测 read_file 都能 vision、范围跟 Cursor IDE 一致）
const ALLOWED_IMAGE_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

// 单图 ≤ 10 MB（base64 解码后字节）；超了直接拒、避免 OOM / 磁盘爆
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export interface ImageAttachmentInput {
  // 纯 base64（不带 "data:image/png;base64," 前缀）
  data: string;
  mimeType: string;
  // 用户原始文件名（可选、不存盘用、UI 显示用）
  filename?: string;
}

export interface ImageAttachmentSaved {
  // 落盘的绝对路径（agent 用这个 read_file）
  absPath: string;
  // 相对 data/ 的路径（events.jsonl 里存的轻量引用、未来换机器还能用）
  relPath: string;
  mimeType: string;
  bytes: number;
  filename?: string;
}

// uuid（同 newTaskId 风格、不引入新依赖）
const newAttachmentId = (): string =>
  `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// ----------------- 上下文文档 -----------------
//
// V0.3：用户在详情页面板里加 / 删 contextDoc、agent 看清单按需拉。
// type 推断在保存时做、后续只读、不重新推断（避免 content 改了但 type 不一致）。

const newContextDocId = (): string =>
  `ctx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// 推断 contextDoc 类型：
//   - http:// / https:// 开头 → url
//   - 看起来像绝对路径（/ 开头）→ path（不 stat、避免 IO + 跨 OS 差异）
//   - 否则 → text
const inferContextDocType = (content: string): TaskContextDocType => {
  const t = content.trim();
  if (/^https?:\/\//i.test(t)) return "url";
  // macOS / Linux 绝对路径。Windows 暂时不特殊处理（项目目前只在 mac 上跑）
  if (t.startsWith("/")) return "path";
  return "text";
};

/**
 * 加一条 contextDoc。type 自动推断、id / createdAt 自动生成。
 * 调用方只给 { title, content }、保证 title.trim().length > 0 / content.trim().length > 0。
 */
export const addContextDoc = async (
  taskId: string,
  input: { title: string; content: string },
): Promise<Task | null> =>
  withTaskLock(taskId, async () => {
    const meta = await readMeta(taskId);
    if (!meta) return null;
    const title = input.title.trim();
    const content = input.content.trim();
    if (title.length === 0 || content.length === 0) {
      throw new Error("title / content 不能为空");
    }
    const doc: TaskContextDoc = {
      id: newContextDocId(),
      title,
      content,
      type: inferContextDocType(content),
      createdAt: Date.now(),
    };
    meta.contextDocs = [...(meta.contextDocs ?? []), doc];
    meta.updatedAt = Date.now();
    await writeMeta(meta);
    return await hydrateTask(meta);
  });

/**
 * 删一条 contextDoc。找不到对应 id 不报错、返回最新 task（前端 UI 上 idempotent）。
 */
export const removeContextDoc = async (
  taskId: string,
  docId: string,
): Promise<Task | null> =>
  withTaskLock(taskId, async () => {
    const meta = await readMeta(taskId);
    if (!meta) return null;
    const before = meta.contextDocs ?? [];
    const after = before.filter((d) => d.id !== docId);
    if (after.length === before.length) {
      // 没找到、直接返回不动数据
      return await hydrateTask(meta);
    }
    meta.contextDocs = after;
    meta.updatedAt = Date.now();
    await writeMeta(meta);
    return await hydrateTask(meta);
  });

/**
 * 保存一组上传图片到 data/tasks/<id>/uploads/、返回每张的绝对路径 + 元信息。
 *
 * 失败语义：单张失败直接抛、调用方负责 400 返回（不做部分成功）。
 *   - mimeType 不在白名单 → throw
 *   - base64 解码失败 → throw
 *   - 单图超 size 上限 → throw
 */
export const saveImageAttachments = async (
  taskId: string,
  images: ImageAttachmentInput[],
): Promise<ImageAttachmentSaved[]> => {
  if (images.length === 0) return [];
  sanitizeId(taskId);
  const uploadsDir = path.join(taskDir(taskId), UPLOADS_DIR);
  await fs.mkdir(uploadsDir, { recursive: true });

  const saved: ImageAttachmentSaved[] = [];
  for (const img of images) {
    const ext = ALLOWED_IMAGE_MIME[img.mimeType.toLowerCase()];
    if (!ext) {
      throw new Error(
        `不支持的图片 mimeType=${img.mimeType}（仅允许 ${Object.keys(
          ALLOWED_IMAGE_MIME,
        ).join(", ")}）`,
      );
    }
    let buf: Buffer;
    try {
      buf = Buffer.from(img.data, "base64");
    } catch (err) {
      throw new Error(
        `图片 base64 解码失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (buf.length === 0) {
      throw new Error("图片解码后为空、检查上传数据");
    }
    if (buf.length > MAX_IMAGE_BYTES) {
      throw new Error(
        `图片过大：${(buf.length / 1024 / 1024).toFixed(2)} MB（上限 ${MAX_IMAGE_BYTES / 1024 / 1024} MB）`,
      );
    }
    const id = newAttachmentId();
    const filename = `${id}.${ext}`;
    const absPath = path.join(uploadsDir, filename);
    const relPath = path.relative(path.join(process.cwd(), "data"), absPath);
    await fs.writeFile(absPath, buf);
    saved.push({
      absPath,
      relPath,
      mimeType: img.mimeType.toLowerCase(),
      bytes: buf.length,
      filename: img.filename,
    });
  }
  return saved;
};

const ensureDataDir = async (): Promise<void> => {
  await fs.mkdir(DATA_DIR, { recursive: true });
};

const exists = async (p: string): Promise<boolean> => {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
};

// ----------------- 元信息读写 -----------------

// meta.json 里不存 events 和 phase.artifact、那两块单独走文件
type MetaPhaseState = Omit<PhaseState, "artifact">;
interface TaskMeta {
  id: string;
  title: string;
  // 任务模式（V1 加、老数据没 → hydrate 时按 plan 兜底）
  mode?: TaskMode;
  // V0.2 plan 模式下的 workflow 标识（feishu-story-impl 等）
  workflowId?: WorkflowId;
  repoPath: string;
  // V0.2 主要入口（飞书 story / 项目链接）
  // V0.4 起 chat 模式建任务也复用这个字段、统一以 feishuStoryUrl 为起点
  feishuStoryUrl?: string;
  swaggerUrl?: string;
  description?: string;
  // 创建时附的额外文档 / 路径（绝对路径）
  attachedDocs?: string[];
  // V0.3：任务级上下文文档清单（详情页面板里增删）
  // - 飞书 story URL 在 createTask 时自动作为第一条（title="飞书 story"）
  // - 老数据没此字段、hydrate 时按 [] 兜底
  contextDocs?: TaskContextDoc[];
  // 任务级 MCP 黑名单（按 server 名）、空/undefined = 全开
  disabledMcpServers?: string[];
  // V0.4：任务角色（决定 agent 以哪种视角读 story / 出方案）
  // - 老数据没此字段、hydrate 时按 "fe" 兜底（V0.4 之前只支持前端）
  // - 当前 enum 单值 "fe"、未来扩 be / data / mobile / qa（详见 docs/MULTI-ROLE.md）
  role?: TaskRole;
  status: TaskStatus;
  currentPhase: PhaseId;
  phases: Record<PhaseId, MetaPhaseState>;
  // 老数据可能没这个字段、读时按 false 兜底
  archived?: boolean;
  createdAt: number;
  updatedAt: number;
  // V0.3.5 加：上一个 SDK Agent 的 id、给 /resume-waiting 路由用
  //   - 跑 plan workflow 时 plan-runner 持久化、agent 创建后立刻写
  //   - shell long-poll 连接断 / anti-loop 踩了 / agent 退出 run、UI 上「继续监听」按钮调
  //     /resume-waiting 路由用这个 id 走 Agent.resume + send 继续等用户 ack
  //   - +1 send 配额、但只在异常路径才付出、绝大多数顺路 ack 不花
  lastAgentId?: string;
}

// 自动归档：completed / failed 且 7 天没动 → archived=true
const AUTO_ARCHIVE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const shouldAutoArchive = (meta: TaskMeta): boolean => {
  if (meta.archived) return false;
  if (meta.status !== "completed" && meta.status !== "failed") return false;
  return Date.now() - meta.updatedAt > AUTO_ARCHIVE_AFTER_MS;
};

// ----------------- per-task mutex（防 read-modify-write race）-----------------
//
// 背景：appendEvent / patchPhase 等是 SDK 消息高频路径、每条 agent 消息都触发一次
// read meta → mutate → write meta。两个写并发时：
//   - lost update：T1 改了 phase.status、T2 没拿到改的、用旧值覆盖
//   - read empty：以前 writeMeta 不是原子、写一半时另一边 readMeta 拿到空字符串
//                 JSON.parse("") → "Unexpected end of JSON input"、整段 workflow crash
//
// 修法：
//   1. writeMeta 改原子写（tmp file + rename、POSIX 保证同目录 rename atomic）
//   2. 同一 taskId 的 read-modify-write 整体串行化、用下面这个 mutex
//   3. readMeta 加防御性容错、读到空 / 损坏时报清楚错（而不是 JSON.parse 抛裸异常）
//
// mutex 实现：Map<taskId, lastPromise>、新来的 enqueue 到尾巴上、链尾完成时清空。
// 同进程内、Next.js 单进程跑就够；多进程要锁文件、但本项目不会跑多进程。
const taskLocks = new Map<string, Promise<unknown>>();

const withTaskLock = async <T>(
  taskId: string,
  fn: () => Promise<T>,
): Promise<T> => {
  const previous = taskLocks.get(taskId) ?? Promise.resolve();
  // 用 then(fn, fn) 让 fn 总是在前置完成后跑、不管前置成功失败、互不传染错误
  const next = previous.then(fn, fn);
  taskLocks.set(taskId, next);
  try {
    return await next;
  } finally {
    // 链尾清理：如果 lock 还指着我（说明后面没人 enqueue）、删掉防内存泄漏
    if (taskLocks.get(taskId) === next) {
      taskLocks.delete(taskId);
    }
  }
};

const readMeta = async (id: string): Promise<TaskMeta | null> => {
  const p = path.join(taskDir(id), META_FILE);
  if (!(await exists(p))) return null;
  const raw = await fs.readFile(p, "utf-8");
  // 防御：极端 race 或上次进程被 kill 时可能读到空 / 不完整内容
  // 之前 JSON.parse("") 直接抛 "Unexpected end of JSON input" 整段 workflow crash
  // 现在改成 throw 带 taskId / 文件长度 / 头 200 字符的友好错误、上层能定位
  if (raw.trim().length === 0) {
    throw new Error(
      `meta.json 为空 taskId=${id}（可能上次进程写一半挂了、检查 data/tasks/${id}/）`,
    );
  }
  try {
    return JSON.parse(raw) as TaskMeta;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `meta.json 解析失败 taskId=${id}：${msg}\n` +
        `文件长度=${raw.length}、前 200 字符=${raw.slice(0, 200)}`,
    );
  }
};

const writeMeta = async (meta: TaskMeta): Promise<void> => {
  const dir = taskDir(meta.id);
  await fs.mkdir(dir, { recursive: true });
  const finalPath = path.join(dir, META_FILE);
  // 原子写：先写 tmp、再 rename 到 final
  //   - POSIX 保证同目录内 rename 是 atomic（要么旧的、要么新的、不会读到一半）
  //   - tmp 文件名加 pid + 随机后缀、避免同进程并发写互相覆盖 tmp
  //   - Linux ext4 / macOS APFS / Windows NTFS 都支持
  const tmpPath = `${finalPath}.tmp.${process.pid}.${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  try {
    await fs.writeFile(tmpPath, JSON.stringify(meta, null, 2), "utf-8");
    await fs.rename(tmpPath, finalPath);
  } catch (err) {
    // 写失败 / rename 失败、尽量清掉 tmp、不留垃圾
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
};

// ----------------- 事件流 -----------------

const readEvents = async (id: string): Promise<TaskEvent[]> => {
  const p = path.join(taskDir(id), EVENTS_FILE);
  if (!(await exists(p))) return [];
  const raw = await fs.readFile(p, "utf-8");
  // 容错：jsonl 一行一条、空行 / 损坏行跳过、不让一条坏数据拖垮整个事件流
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as TaskEvent;
      } catch {
        return null;
      }
    })
    .filter((x): x is TaskEvent => x !== null);
};

const appendEventLine = async (
  id: string,
  ev: TaskEvent,
): Promise<void> => {
  const dir = taskDir(id);
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(
    path.join(dir, EVENTS_FILE),
    JSON.stringify(ev) + "\n",
    "utf-8",
  );
};

// ----------------- 产物 -----------------

// 读 artifact：先按 V0.2 约定的 `artifacts/<NN>-<phase>.md`、退回到 V1 的 `<phase>.md`
//
// 为什么允许 fallback：
//   - V0.2 之前的 plan task 写的就是 `plan.md` / `build.md` 在 task 根
//   - 这些老数据还想保留可读、不强制迁移
//
// idx 是 phase 在当前 workflow phases 数组里的位置（0-based、-1 表示不在）
const readArtifact = async (
  taskId: string,
  phaseId: PhaseId,
  idx: number,
): Promise<{ filename: string; content: string } | undefined> => {
  const dir = taskDir(taskId);
  const candidates: Array<{ filename: string; absPath: string }> = [];
  // V0.2 路径优先
  if (idx >= 0) {
    const newName = phaseArtifactFilename(phaseId, idx);
    candidates.push({
      filename: `${ARTIFACTS_DIR}/${newName}`,
      absPath: path.join(dir, ARTIFACTS_DIR, newName),
    });
  }
  // V1 legacy 路径兜底
  candidates.push({
    filename: `${phaseId}.md`,
    absPath: path.join(dir, `${phaseId}.md`),
  });
  for (const c of candidates) {
    if (await exists(c.absPath)) {
      const content = await fs.readFile(c.absPath, "utf-8");
      return { filename: c.filename, content };
    }
  }
  return undefined;
};

export const writeArtifact = async (
  taskId: string,
  phaseId: PhaseId,
  idx: number,
  content: string,
): Promise<void> => {
  if (idx < 0) {
    // 不在当前 workflow 里：写 legacy 位置
    const dir = taskDir(taskId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${phaseId}.md`), content, "utf-8");
    return;
  }
  const dir = path.join(taskDir(taskId), ARTIFACTS_DIR);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, phaseArtifactFilename(phaseId, idx)),
    content,
    "utf-8",
  );
};

// ----------------- 高阶接口（拼装 Task） -----------------

// 兼容老数据：V0 时代的 task 可能 currentPhase="spec" / phases.spec.* 都还在
// V1 砍掉 spec 后、这些数据如果原样吐给 UI、phases[currentPhase] 会拿 undefined 崩
// 兜底策略：currentPhase 不在 PHASE_ORDER 里就强制改 plan、phases 用 PHASE_ORDER 里的项 + meta.phases 同名项
// 旧的 spec phase 状态会丢、但任务本身能继续走 plan→build
//
// V0.3.4 PHASE_ORDER 只剩 [plan, build]、老任务里 currentPhase="context"/"ship" 都会被强制改 plan
// 老 artifact 文件名（01-context.md / 02-plan.md / 03-build.md）跟新结构对不上、
// 读不到老 artifact——用户偏好"不写兼容代码、老任务作废重跑"、所以这里不做迁移
const sanitizeCurrentPhase = (p: string): PhaseId =>
  PHASE_ORDER.includes(p as PhaseId) ? (p as PhaseId) : "plan";

// 把 meta.workflowId 转成实际 workflow.phases 数组
// 老数据没 workflowId、或者 chat 模式：返回 PHASE_ORDER 全集兜底（hydrateTask 读 artifact 时也不会漏）
const resolveWorkflowPhases = (meta: TaskMeta): PhaseId[] => {
  if (meta.workflowId && WORKFLOWS[meta.workflowId]) {
    return WORKFLOWS[meta.workflowId].phases;
  }
  return PHASE_ORDER;
};

const hydrateTask = async (meta: TaskMeta): Promise<Task> => {
  const events = await readEvents(meta.id);
  const phases = {} as Record<PhaseId, PhaseState>;
  const workflowPhases = resolveWorkflowPhases(meta);
  // hydrate 全集 phase（V0.3.4 起 2 个）、artifact 索引按当前 workflow 算
  for (const pid of PHASE_ORDER) {
    const idx = workflowPhases.indexOf(pid);
    const artifact = await readArtifact(meta.id, pid, idx);
    const metaPhase = meta.phases[pid] ?? { id: pid, status: "pending" };
    phases[pid] = { ...metaPhase, artifact };
  }
  return {
    id: meta.id,
    title: meta.title,
    // 老数据没 mode 字段、按 plan 兜底（V1 之前的数据都是 plan 模式）
    mode: meta.mode ?? "plan",
    workflowId: meta.workflowId,
    // V0.4：老数据没 role 字段、按 "fe" 兜底（V0.4 之前只支持前端、安全推断）
    role: meta.role ?? "fe",
    repoPath: meta.repoPath,
    feishuStoryUrl: meta.feishuStoryUrl,
    swaggerUrl: meta.swaggerUrl,
    description: meta.description,
    attachedDocs: meta.attachedDocs,
    contextDocs: meta.contextDocs ?? [],
    disabledMcpServers: meta.disabledMcpServers,
    status: meta.status,
    currentPhase: sanitizeCurrentPhase(meta.currentPhase),
    phases,
    events,
    archived: meta.archived ?? false,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    lastAgentId: meta.lastAgentId,
  };
};

const buildEmptyPhases = (): Record<PhaseId, MetaPhaseState> => ({
  plan: { id: "plan", status: "pending" },
  build: { id: "build", status: "pending" },
});

// ----------------- 进程冷启动恢复（chat 僵尸任务） -----------------
//
// ## 背景
// chat 任务的 agent 全靠 wait_for_user MCP 工具阻塞活在一次 SDK Run 里、
// 整段对话依赖进程内的 pendingMap / runningChats（chat-mcp / chat-runner）状态。
// 进程重启（Ctrl+C / crash / serverless 冷启）→ 这些 in-memory 状态全丢、
// 但 meta.json 里 status 还是 `running` / `awaiting_user`、UI 看起来仍在等、
// 用户发消息进来 submitUserMessage 直接 false、消息默默丢。
//
// ## 解决思路
// 进程冷启动时（即 globalThis flag 没置）扫一遍所有 task：
//   - status in (running, awaiting_user) 的 → 一律标 failed
//   - 同时 append 一条 error 事件、解释清楚原因 + 引导用户「重新启动 Chat」
//
// ## 为什么"冷启动 = globalThis flag 没置"是对的
// Next.js dev hot reload 不会重启 node 进程、globalThis 持续 → flag 还在 → 不重跑（✅）
// Ctrl+C 重启 dev / 生产进程崩溃重启 → globalThis 重置 → 第一次访问触发 recovery（✅）
//
// ## 触发时机
// listTasks / getTask 顶部 await 一次。任何用户访问入口都会经过这两个之一。
// 用 globalThis flag + 单 promise 锁、保证整个进程生命周期只跑一次、并发调用共享同一个 promise。

const RECOVERY_FLAG = "__feAiFlowBootRecoveryPromise__";

const runBootRecovery = async (): Promise<void> => {
  await ensureDataDir();
  let ids: string[];
  try {
    const entries = await fs.readdir(DATA_DIR, { withFileTypes: true });
    ids = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    console.warn("[task-fs] boot recovery: 读 DATA_DIR 失败", err);
    return;
  }

  let recovered = 0;
  for (const id of ids) {
    let meta: TaskMeta | null;
    try {
      meta = await readMeta(id);
    } catch (err) {
      console.warn(`[task-fs] boot recovery: 读 meta 失败 id=${id}`, err);
      continue;
    }
    if (!meta) continue;
    if (meta.status !== "running" && meta.status !== "awaiting_user") continue;

    // 写一条 error 事件、给用户讲清楚状况（UI 通过 EventStream 直接展示）
    const event: TaskEvent = {
      id: newEventId(),
      ts: Date.now(),
      kind: "error",
      text:
        meta.mode === "chat"
          ? "[boot-recovery] Web 进程已重启、Chat agent 上下文已丢失、本段对话不能继续。点顶部「重新启动 Chat」开始新一段会话（注意：会按 SDK 重新计费一次）。"
          : "[boot-recovery] Web 进程已重启、agent 上下文已丢失、本次 phase 不能继续。请到任务详情手动重启对应 phase。",
    };
    try {
      await appendEventLine(id, event);
    } catch (err) {
      console.warn(`[task-fs] boot recovery: 追加 error 事件失败 id=${id}`, err);
      continue;
    }

    meta.status = "failed";
    meta.updatedAt = event.ts;
    try {
      await writeMeta(meta);
      recovered++;
    } catch (err) {
      console.warn(`[task-fs] boot recovery: 写 meta 失败 id=${id}`, err);
    }
  }

  if (recovered > 0) {
    console.log(
      `[task-fs] boot recovery: 标记 ${recovered} 个僵尸 chat/plan 任务为 failed`,
    );
  }
};

/**
 * 进程级一次性的"僵尸任务恢复"。
 *
 * - 第一次调用：触发实际扫描、返回 promise、占住 globalThis flag
 * - 并发调用：共享同一个 promise（不重复扫）
 * - 后续调用：拿到已 resolved 的 promise、立即返回
 *
 * 失败不抛：内部 try/catch 吞掉、避免拖垮调用方（listTasks / getTask）。
 */
export const ensureBootRecovery = async (): Promise<void> => {
  const g = globalThis as unknown as Record<string, Promise<void> | undefined>;
  if (g[RECOVERY_FLAG]) {
    await g[RECOVERY_FLAG];
    return;
  }
  // 先占位再 await、防止并发同时进入触发两次扫
  const promise = runBootRecovery().catch((err) => {
    console.error("[task-fs] boot recovery 顶层异常（已吞）：", err);
  });
  g[RECOVERY_FLAG] = promise;
  await promise;
};

// ----------------- 公开 API -----------------

export const listTasks = async (): Promise<Task[]> => {
  await ensureBootRecovery();
  await ensureDataDir();
  const entries = await fs.readdir(DATA_DIR, { withFileTypes: true });
  const ids = entries.filter((e) => e.isDirectory()).map((e) => e.name);

  const tasks: Task[] = [];
  for (const id of ids) {
    // readMeta 现在自身会对空 / 损坏文件 throw、这里 try/catch 兜底
    // 让单个坏 task 不拖垮整个列表（前端体验：坏的 task 就是不显示、其他正常）
    let meta: TaskMeta | null;
    try {
      meta = await readMeta(id);
    } catch (err) {
      console.warn(`[task-fs] listTasks: 读 meta 失败 id=${id}`, err);
      continue;
    }
    if (!meta) continue;

    // lazy 自动归档：completed/failed 且 7 天没动 → 改写 meta.json
    // 不改 updatedAt（自动归档不算用户操作）
    // 包 withTaskLock：避免跟 appendEvent / patchPhase 同时跑撞车
    if (shouldAutoArchive(meta)) {
      await withTaskLock(id, async () => {
        // lock 内重新读一次、避免上面读到旧值已被改
        const fresh = await readMeta(id);
        if (fresh && shouldAutoArchive(fresh)) {
          fresh.archived = true;
          await writeMeta(fresh);
        }
      });
      // 这次循环里的 meta.archived 也同步、不然 hydrateTask 出来还是 false
      meta.archived = true;
    }

    tasks.push(await hydrateTask(meta));
  }
  return tasks;
};

export const getTask = async (id: string): Promise<Task | null> => {
  // 用户可能直接打开任务详情页 / 调 chat-reply 等单 task 接口、
  // 没经过 listTasks、所以这里也要触发一次 boot recovery
  await ensureBootRecovery();
  const meta = await readMeta(id);
  if (!meta) return null;
  return await hydrateTask(meta);
};

// 给 chat 模式不填 title 的任务生成默认占位标题
// 格式：「未命名对话 MM-DD HH:mm」、便于在任务列表里区分
// 不带秒：用户连点也基本不会撞标题、秒级精度信息量没必要
const buildDefaultChatTitle = (now: number): string => {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `未命名对话 ${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export const createTask = async (input: NewTaskInput): Promise<Task> => {
  const now = Date.now();
  // V0.2：默认 mode=plan、默认 workflow=feishu-story-impl（公司主要场景）
  // 老 V1 调用方传 mode=chat 时 workflowId 不写、走自由对话
  const mode: TaskMode = input.mode ?? "plan";
  const workflowId: WorkflowId | undefined =
    mode === "plan" ? (input.workflowId ?? "feishu-story-impl") : undefined;
  // currentPhase：plan 模式取 workflow.phases[0]、chat 模式占位用 plan
  const firstPhase: PhaseId =
    workflowId && WORKFLOWS[workflowId]
      ? WORKFLOWS[workflowId].phases[0]!
      : "plan";
  // V0.3：初始化 contextDocs（V0.4 起 plan/chat 一视同仁、统一以 feishuStoryUrl 为起点）
  // - feishuStoryUrl：落「飞书 story」（plan 必填、chat 选填、字段意义都是「飞书项目链接」）
  // - description：落「补充说明」
  const initialContextDocs: TaskContextDoc[] = [];
  if (input.feishuStoryUrl && input.feishuStoryUrl.trim()) {
    initialContextDocs.push({
      id: newContextDocId(),
      title: "飞书 story",
      content: input.feishuStoryUrl.trim(),
      type: "url",
      createdAt: now,
    });
  }
  if (input.description && input.description.trim()) {
    initialContextDocs.push({
      id: newContextDocId(),
      title: "补充说明",
      content: input.description.trim(),
      type: "text",
      createdAt: now,
    });
  }

  // V0.4：chat 模式所有字段选填
  // - title 不填：用「未命名对话 MM-DD HH:mm」占位
  // - repoPath 不填：用 os.homedir()（agent 默认 cwd 在用户 home、不绑特定项目）
  // plan 模式保持原约束（title + repoPath + feishuStoryUrl 必填、上层 API 路由校验）
  const finalTitle =
    input.title && input.title.trim()
      ? input.title.trim()
      : mode === "chat"
        ? buildDefaultChatTitle(now)
        : input.title;
  const finalRepoPath =
    input.repoPath && input.repoPath.trim()
      ? input.repoPath.trim()
      : mode === "chat"
        ? os.homedir()
        : input.repoPath;

  const meta: TaskMeta = {
    id: newTaskId(),
    title: finalTitle,
    mode,
    workflowId,
    // V0.4：role 默认 "fe"（当前 enum 只这一个值、UI 可选但实际只有这个选项）
    // 未来扩枚举（be / data / mobile / qa）时、UI 选择器会暴露多个值、这里也按 input 取
    role: input.role ?? "fe",
    repoPath: finalRepoPath,
    feishuStoryUrl: input.feishuStoryUrl,
    swaggerUrl: input.swaggerUrl,
    description: input.description,
    attachedDocs: input.attachedDocs,
    contextDocs: initialContextDocs,
    // 黑名单空数组当 undefined 存、保持 hydrate 出来「全开 = falsy」语义一致
    disabledMcpServers:
      input.disabledMcpServers && input.disabledMcpServers.length > 0
        ? input.disabledMcpServers
        : undefined,
    status: "draft",
    currentPhase: firstPhase,
    phases: buildEmptyPhases(),
    archived: false,
    createdAt: now,
    updatedAt: now,
  };
  await writeMeta(meta);
  return await hydrateTask(meta);
};

/**
 * 更新任务级 MCP 黑名单（chat 模式实时改、plan 模式下次启动生效）
 *
 * - servers：禁用的 server 名列表（必须是 settings 里存在的、否则无意义但不报错）
 * - undefined / 空数组：本任务用全量 MCP
 * - 不写事件、不动 updatedAt（属于配置变更不算业务进展、避免污染时间线）
 *
 * 限制：已经在跑的 SDK Run 改这个不会热生效——MCP 在 SDK 启动时一次性传入、
 * 改完后下一次启动（chat 重启 / plan 失败重跑）才会按新配置生效。
 */
export const setTaskDisabledMcpServers = async (
  id: string,
  servers: string[] | undefined,
): Promise<Task | null> =>
  withTaskLock(id, async () => {
    const meta = await readMeta(id);
    if (!meta) return null;
    // 空数组当 undefined 存、保持 hydrate 出来的语义一致（全开 = falsy）
    meta.disabledMcpServers =
      servers && servers.length > 0 ? servers : undefined;
    await writeMeta(meta);
    return await hydrateTask(meta);
  });

// V0.3.5: 持久化最近一次 SDK Agent 的 id、给 /resume-waiting 用
// 在 plan-runner Agent.create 成功后立刻调一次写下去、不动 updatedAt（避免污染时间线）。
export const setTaskLastAgentId = async (
  id: string,
  agentId: string | undefined,
): Promise<void> =>
  withTaskLock(id, async () => {
    const meta = await readMeta(id);
    if (!meta) return;
    meta.lastAgentId = agentId;
    await writeMeta(meta);
  });

// 单独的归档 patch：不写事件、不动 updatedAt（保持"最后业务动作"语义）
export const setTaskArchived = async (
  id: string,
  archived: boolean,
): Promise<Task | null> =>
  withTaskLock(id, async () => {
    const meta = await readMeta(id);
    if (!meta) return null;
    meta.archived = archived;
    await writeMeta(meta);
    return await hydrateTask(meta);
  });

export const deleteTask = async (id: string): Promise<boolean> => {
  const dir = taskDir(id);
  if (!(await exists(dir))) return false;
  await fs.rm(dir, { recursive: true, force: true });
  return true;
};

// 仅追加事件 + bump updatedAt、不在这里改 phase 状态（那是状态机的事）
//
// 这是 SDK 消息回调高频路径（每条 agent message / tool call 都会调一次）、
// 跟 patchPhase 等其他写 meta 的逻辑容易并发撞车、所以整体串行化（per-task mutex）
export const appendEvent = async (
  taskId: string,
  ev: Omit<TaskEvent, "id" | "ts">,
): Promise<Task | null> =>
  withTaskLock(taskId, async () => {
    const meta = await readMeta(taskId);
    if (!meta) return null;
    const event: TaskEvent = {
      id: newEventId(),
      ts: Date.now(),
      ...ev,
    };
    await appendEventLine(taskId, event);
    meta.updatedAt = event.ts;
    await writeMeta(meta);
    return await hydrateTask(meta);
  });

// 状态推进 helper：把 phase / task 状态打到指定值
// 真状态机会更复杂（spec 完成 → plan 自动 pending → user ack → 进 plan running...）
// V1 这里支持「按需修改」：
//   - 同时给 phaseId + status：改对应 phase 状态
//   - 给 taskStatus：改 task 顶层状态
//   - 给 currentPhase：换当前 phase
//   - 三个字段都可选、调用方按需要传
// 主要是给"用户回复后 task 回 running"这种「只动 task 不动 phase」的语义留口子
interface PatchPhaseInput {
  phaseId?: PhaseId;
  status?: PhaseStatus;
  taskStatus?: TaskStatus;
  currentPhase?: PhaseId;
}

export const patchPhase = async (
  taskId: string,
  input: PatchPhaseInput,
): Promise<Task | null> =>
  withTaskLock(taskId, async () => {
    const meta = await readMeta(taskId);
    if (!meta) return null;
    const now = Date.now();

    // 改 phase 状态（必须 phaseId + status 同时给）
    if (input.phaseId && input.status) {
      const prevPhase = meta.phases[input.phaseId];
      meta.phases[input.phaseId] = {
        ...prevPhase,
        status: input.status,
        startedAt:
          input.status === "running" && !prevPhase.startedAt
            ? now
            : prevPhase.startedAt,
        endedAt:
          input.status === "ack" || input.status === "failed"
            ? now
            : prevPhase.endedAt,
      };
    }
    if (input.taskStatus) meta.status = input.taskStatus;
    if (input.currentPhase) meta.currentPhase = input.currentPhase;
    meta.updatedAt = now;
    await writeMeta(meta);
    return await hydrateTask(meta);
  });
