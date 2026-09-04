/**
 * super-prompt 预算裁剪（B2 分级版、纯函数、无 IO）
 *
 * 分级（补丁后终版、删除 vs 压缩二分）：
 *   - L0 永不碰：不压缩、不删除（firstActionDirective / currentActionPlaybook /
 *     taskId-title-repo 等小段）。凡进裁剪池一律不许用它。
 *   - L1 永不整段删、但允许压缩：sharedRules（连压缩都不做、全文永留）、
 *     rulesSection（全文→标题列表算压缩、允许；整段删除不允许）。
 *   - L2 允许压缩、压缩完还超才删：skillsSection、gitlab/lark/companyEnv。
 *   - L3 先砍：contextDocs 正文、actionHistory 用户指令。顺序永远 L3 → L2 → 停。
 *
 * fail-open：L3+L2 全删完还超，保留 L0/L1 原样返回 overBudget=true，
 * 调用方记 error 放行，绝不把 agent 搞瞎。
 */

export const PROMPT_BUDGET_BYTES = 100 * 1024;

export type PromptSectionTier = 0 | 1 | 2 | 3;

export type PromptSection = {
  name: string;
  tier: PromptSectionTier;
  /** 全量正文 */
  content: string;
  /** 全量字节（调用方用 promptBytesOf 算好传入、单测可手工注水） */
  bytes: number;
  /** 压缩版正文（没有 = 不可压缩） */
  compressedContent?: string;
  /** 压缩版字节（有 compressedContent 时必填） */
  compressedBytes?: number;
  /**
   * 被删掉时的替代句（补丁2：绝不留空占位、必须告诉 agent 去哪按需读）。
   * 不传则用通用占位。
   */
  droppedPlaceholder?: string;
};

export type DroppedSection = {
  name: string;
  /** 相对“进入删除阶段时”的版本省了多少字节（压缩过的按压缩版算） */
  savedBytes: number;
  wasCompressed: boolean;
};

export type PromptBudgetResult = {
  contents: Record<string, string>;
  dropped: DroppedSection[];
  /** 用了压缩版的段名（含后来又被删的——以 dropped 为准判断最终形态） */
  compressed: string[];
  perSectionBytes: Record<string, number>;
  totalBytes: number;
  overBudget: boolean;
  budget: number;
};

export const promptBytesOf = (s: string): number =>
  Buffer.byteLength(s, "utf-8");

const genericPlaceholder = (name: string): string =>
  `（${name} 已因 prompt 预算裁剪，需要时按任务元信息按需读取原文）`;

export const applyPromptBudget = (
  sections: PromptSection[],
  budget: number = PROMPT_BUDGET_BYTES,
): PromptBudgetResult => {
  const contents: Record<string, string> = {};
  const perSectionBytes: Record<string, number> = {};
  const compressed: string[] = [];
  const dropped: DroppedSection[] = [];

  // 当前形态：先全量
  const cur = new Map<
    string,
    { tier: PromptSectionTier; content: string; bytes: number; def: PromptSection; isCompressed: boolean }
  >();
  for (const s of sections) {
    cur.set(s.name, {
      tier: s.tier,
      content: s.content,
      bytes: s.bytes,
      def: s,
      isCompressed: false,
    });
  }
  const totalOf = (): number => {
    let t = 0;
    for (const v of cur.values()) t += v.bytes;
    return t;
  };

  let total = totalOf();
  if (total <= budget) {
    for (const [name, v] of cur) {
      contents[name] = v.content;
      perSectionBytes[name] = v.bytes;
    }
    return { contents, dropped, compressed, perSectionBytes, totalBytes: total, overBudget: false, budget };
  }

  // 压缩阶段：L0 永不压缩；L1/L2/L3 有压缩版就上
  for (const [name, v] of cur) {
    const def = v.def;
    if (def.tier === 0) continue;
    if (def.compressedContent === undefined) continue;
    const cb =
      def.compressedBytes ?? promptBytesOf(def.compressedContent);
    if (cb >= v.bytes) continue;
    v.content = def.compressedContent;
    v.bytes = cb;
    v.isCompressed = true;
    compressed.push(name);
  }
  total = totalOf();
  if (total <= budget) {
    for (const [name, v] of cur) {
      contents[name] = v.content;
      perSectionBytes[name] = v.bytes;
    }
    return { contents, dropped, compressed, perSectionBytes, totalBytes: total, overBudget: false, budget };
  }

  // 删除阶段：L3 先（按当前字节从大到小）、再 L2；L0/L1 永不进池
  const candidates = [...cur.entries()]
    .filter(([, v]) => v.tier === 3 || v.tier === 2)
    .sort((a, b) => {
      if (a[1].tier !== b[1].tier) return b[1].tier - a[1].tier;
      return b[1].bytes - a[1].bytes;
    });
  for (const [name, v] of candidates) {
    if (total <= budget) break;
    const placeholder = v.def.droppedPlaceholder ?? genericPlaceholder(name);
    const pb = promptBytesOf(placeholder);
    if (pb >= v.bytes) continue;
    dropped.push({
      name,
      savedBytes: v.bytes - pb,
      wasCompressed: v.isCompressed,
    });
    v.content = placeholder;
    v.bytes = pb;
    total -= dropped[dropped.length - 1].savedBytes;
  }

  for (const [name, v] of cur) {
    contents[name] = v.content;
    perSectionBytes[name] = v.bytes;
  }
  return {
    contents,
    dropped,
    compressed,
    perSectionBytes,
    totalBytes: total,
    overBudget: total > budget,
    budget,
  };
};
