/**
 * task 消息注入（task-question-inject）与待送达队列（task-talk-queue）共用的两样东西。
 *
 * 单独成叶子模块（只引 node:crypto）的原因：task-question-inject 静态引 task-talk-queue（入队），
 * task-talk-queue 重放时才动态引 task-question-inject（避免成环）。这两样东西两边都要用——
 * 放任何一侧，另一侧要么成环、要么复制一份然后日后改一边漏一边。
 */

import { createHash } from "node:crypto";

/**
 * 「忙、稍后再试」类 409 的结构化标记（响应体 `{ error, code: "task_busy" }`）。
 *
 * 为什么不靠文案子串：队列重放（drain）遇 409 要分「还忙 → 放回队首等下一轮」与「别的原因 →
 * 丢弃并写 info」。早先重放判忙（现为 task-talk-queue 的 `classifyReplayConflict`）只认文案里的
 * 「正在跑 / 等它说完」，新增的忙类文案（在途等待
 * 超时的「还在处理中」）认不出，被当「非忙」丢弃——而第一次直送可能随后失败，这条消息就此丢了
 * （第七轮 K2-03）。文案是给人看的、会改；判忙必须认标记。
 *
 * 只给**会自己恢复**的 409 打：agent 还在跑、同一条消息上一次发送还在处理中、**停止中**
 * （lifecycle=stopping：stop 收尾结束后自己放开）。停止中是第八轮 L3-02 补的——第七轮 K2-03 起初不打，
 * 结果 stop 窗口里在飞的群来源重放被当「非忙」丢弃（tests/task-talk-queue-r8.test.ts 有复现）。停止中的 409 额外带 `phase: "stopping"`（{@link TASK_INJECT_PHASE_STOPPING}），
 * 让队列区分来源：stop 的清队语义是「只清 app 来源、群来源保留」，所以重放遇到它时 app 来源**不放回**。
 * 不打标记的：删除中 / 终结中 / reopening（重放也不会好）、stop **已完成**后才撞上的「状态已变请重发」
 * （此时 lifecycle 已放开、只剩 opGen 变化）、队列已满、chat 型不支持——这些重放不会自己好。
 */
export const TASK_INJECT_BUSY_CODE = "task_busy";

/** 「停止中」忙类 409 的 `phase` 取值（响应体 `{ error, code: "task_busy", phase: "stopping" }`），见 {@link TASK_INJECT_BUSY_CODE} */
export const TASK_INJECT_PHASE_STOPPING = "stopping";

/**
 * 请求正文指纹（sha256 hex）：对**真正会被注入**的内容取稳定哈希——trim 后的文本、图片列表
 * （data / mimeType / filename）、路径附件、skill 引用。不含 clientSentAt（每次重试都变）、
 * bootArgs / forceModel（凭据与路由、不是正文）、clientItemId 本身。
 *
 * 并进 key 而不是只存在表项里：同 id 不同正文天然落到不同表项——
 * - 不会被当成重复吞掉真正的新消息（只比 id 的老行为）；
 * - 也不会互相覆盖（A、B 各自的重发都仍能去重，没有「覆盖表项后旧正文的重发被当新消息」的洞）。
 * 为什么安全：客户端（talk-send-attempt）只在内容完全一致时才复用 id，同 id 配不同正文本就
 * 不该出现（出现 = bug / 异常 / 恶意）；命中去重必须 id 与指纹同时一致，等价于「这一条的逐字重发」。
 * 只存哈希、不存原文：表常驻内存，且图片 base64 可达数 MB。
 * 各字段带长度前缀，字段 / 元素边界无歧义（text "ab" + 无附件 与 text "a" + 附件 ["b"] 不撞）。
 *
 * 三处共用同一口径：空闲直送的在途 / 已送达两张表的 key、排队路径的去重（第七轮 K2-04）、
 * 直送成功后摘掉队列里同一条（第七轮 K2-05）。
 */
export const fingerprintTaskQuestionBody = (rawBody: unknown): string => {
  const objOf = (v: unknown): Record<string, unknown> =>
    v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const listOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const h = createHash("sha256");
  const put = (tag: string, v: unknown): void => {
    const s = typeof v === "string" ? v : "";
    h.update(`${tag}${s.length}:`);
    h.update(s);
  };
  const b = objOf(rawBody);
  // 与注入端同口径：`(body.text ?? "").trim()`
  put("t", typeof b.text === "string" ? b.text.trim() : "");
  const images = listOf(b.images);
  h.update(`I${images.length};`);
  for (const raw of images) {
    const im = objOf(raw);
    put("d", im.data);
    put("m", im.mimeType);
    put("f", typeof im.filename === "string" ? im.filename.trim() : "");
  }
  const attachments = listOf(b.attachments);
  h.update(`A${attachments.length};`);
  for (const p of attachments) put("p", p);
  const skills = listOf(b.skills);
  h.update(`S${skills.length};`);
  for (const raw of skills) {
    const sk = objOf(raw);
    put("n", sk.name);
    put("a", sk.absPath);
  }
  return h.digest("hex");
};
