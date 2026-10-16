/**
 * task 输入条的发送幂等键（clientItemId）。
 *
 * 为什么要有：服务端 task 待送达队列按 clientItemId（+ 正文指纹）去重（见 server/task-talk-queue 的
 * enqueueTalkMessage），空闲直送也按 (id + 正文指纹) 去重（见 server/task-question-inject），
 * 输入条若不传——POST 已入队 / 已送达但响应丢了（网络抖动 / 超时）时，
 * 用户按回车重发就会把同一句话排两遍 / 注入两遍。现已由输入条每次发送带上本模块给的 id。
 *
 * 语义（都是为了「只在确实是同一条时才复用 id」）：
 * - 同一次输入失败后重试 → 复用同一个 id，服务端据此认出是同一条；
 * - 成功（含 202 入队）后清掉，下一条换新 id；
 * - 失败后用户改了内容（正文 / 图 / 路径 / skill / 显式模型任一变化）→ 换新 id：
 *   服务端去重是 (id + 正文指纹)——正文 / 图 / 路径 / skill 变了，同 id 也不会被当重复吞掉；
 *   但**显式模型不在服务端指纹里**（它是路由、不是正文），同 id 同正文只换模型，服务端仍认作
 *   重复。所以客户端这一层的「内容变就换 id」仍是必需的，两层互为兜底（服务端比内容只是防
 *   异常 / 旧客户端 / 恶意的同 id 带新正文，不替代这里）；
 * - 按 task 隔离、记在模块级而不是组件 ref：顶栏切「工作台 / 对话」会卸载输入条，
 *   fetch 还在飞、草稿也还在，回来再按回车仍要认得出是同一条。
 */

import { shortStableHash } from "@/lib/chat-payload-fingerprint";
import { allocClientChatQueueItemId } from "@/lib/chat-pending-reconcile";

export interface TalkSendFingerprintInput {
  text: string;
  images?: ReadonlyArray<{ data: string; mimeType: string; filename?: string }>;
  /** 原生 picker 选的文件 / 目录绝对路径 */
  attachments?: readonly string[];
  skills?: ReadonlyArray<{ name: string; absPath: string }>;
  /** 显式指定模型的 key（空串 = 没指定）：换模型是另一条请求，不能被旧 id 吞掉 */
  modelKey?: string;
}

/**
 * 内容指纹：图只留「mime + 文件名 + 长度 + 内容 hash」，不把整段 base64 留在内存里。
 * 比的是完整字符串、不再二次 hash——复用 id 的代价是静默丢内容，宁可不要任何碰撞可能。
 */
export const talkSendFingerprint = (input: TalkSendFingerprintInput): string =>
  JSON.stringify([
    input.text,
    (input.images ?? []).map((img) => [
      img.mimeType,
      img.filename ?? "",
      img.data.length,
      shortStableHash(img.data),
    ]),
    [...(input.attachments ?? [])],
    (input.skills ?? []).map((s) => [s.name, s.absPath]),
    input.modelKey ?? "",
  ]);

interface Attempt {
  itemId: string;
  fingerprint: string;
}

const attempts = new Map<string, Attempt>();

/**
 * 取本次发送要带的 clientItemId：该 task 上一次尚未成功的发送内容完全一致就复用，否则发新号。
 * 发新号会顶掉旧记录（同一 task 同时只认最近一次未成功的发送）。
 */
export const claimTalkClientItemId = (
  taskId: string,
  input: TalkSendFingerprintInput,
  alloc: () => string = allocClientChatQueueItemId,
): string => {
  const fingerprint = talkSendFingerprint(input);
  const prev = attempts.get(taskId);
  if (prev && prev.fingerprint === fingerprint) return prev.itemId;
  const itemId = alloc();
  attempts.set(taskId, { itemId, fingerprint });
  return itemId;
};

/**
 * 发送成功（含 202 入队）后调用：下一条发送换新 id。
 * 按 id 比对再清，防止晚到的旧回调把后来的新一条的记录误删。
 */
export const settleTalkClientItemId = (
  taskId: string,
  itemId: string,
): void => {
  if (attempts.get(taskId)?.itemId === itemId) attempts.delete(taskId);
};

/** 仅供测试：清空模块级记录 */
export const __resetTalkSendAttemptsForTest = (): void => {
  attempts.clear();
};
