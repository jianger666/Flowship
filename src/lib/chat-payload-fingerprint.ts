/**
 * R35-2 / R36：chat 消息 payload 指纹（client / server 唯一契约）
 *
 * 算法：`JSON.stringify([text, imagePaths, attachmentPaths, skills])` → FNV-1a 短 hash。
 * 身份仲裁只认 itemId + fingerprint，文案不参与。
 *
 * imagePaths：两端统一 `imageKeysFromPayloads`（filename 或 mime+len）；
 * server claim 优先信 client POST 的 `payloadFingerprint`，缺失时用本函数兜底。
 */

export type ChatSkillRef = { name: string; absPath: string };

export type ChatPayloadFingerprintInput = {
  text: string;
  imagePaths: readonly string[];
  attachmentPaths: readonly string[];
  skills: readonly ChatSkillRef[];
};

/** FNV-1a 32-bit → 8 位 hex（浏览器 / Node 同步可用，避免 SubtleCrypto 异步） */
export const shortStableHash = (input: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
};

/**
 * R35-2：规范化 skills（固定键序），避免 JSON key 顺序漂移导致指纹不一致。
 */
export const normalizeSkillsForFingerprint = (
  skills: readonly ChatSkillRef[],
): Array<{ name: string; absPath: string }> =>
  skills.map((s) => ({ name: s.name, absPath: s.absPath }));

/** R35-2：与 server 对齐的 payload 指纹 */
export const computeChatPayloadFingerprint = (
  input: ChatPayloadFingerprintInput,
): string => {
  const canonical = JSON.stringify([
    input.text,
    [...input.imagePaths],
    [...input.attachmentPaths],
    normalizeSkillsForFingerprint(input.skills),
  ]);
  return shortStableHash(canonical);
};

/**
 * R35-2：ImagePayload → imagePaths 键（发送前尚无落盘 path）。
 * 优先 filename；否则 mimeType + data 长度（不把整段 base64 打进指纹）。
 */
export const imageKeysFromPayloads = (
  images?: ReadonlyArray<{
    data: string;
    mimeType: string;
    filename?: string;
  }>,
): string[] =>
  (images ?? []).map((img, i) => {
    const name = img.filename?.trim();
    if (name) return name;
    return `${img.mimeType}:len${img.data.length}:${i}`;
  });

/** 从发送参数算指纹（chat-view / sendChatReply 共用） */
export const fingerprintFromChatSendArgs = (args: {
  text: string;
  images?: ReadonlyArray<{
    data: string;
    mimeType: string;
    filename?: string;
  }>;
  attachments?: readonly string[];
  skills?: readonly ChatSkillRef[];
}): string =>
  computeChatPayloadFingerprint({
    text: args.text,
    imagePaths: imageKeysFromPayloads(args.images),
    attachmentPaths: [...(args.attachments ?? [])],
    skills: args.skills ?? [],
  });
