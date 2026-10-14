/**
 * 需求群答疑「回复协议」：答疑 agent 的最终回复 → 群里到底发什么。
 *
 * 为什么有这层：旧设计「答案无条件真 @ 回提问人」让本机机器人与对端机器人互 @ 成环
 *（2026-10-14 对接「安若流年」时 9 轮）。现在改成**由 agent 按提示词自己判断「回不回 / @ 谁」**，
 * 系统只负责把它的决定忠实落地：
 * - `parseGroupReply`：纯函数、绝不抛错，把 agent 的原话解析成 `ParsedGroupReply`（协议四条见 group-contract 头注释）；
 * - `buildGroupReplyRules`：产出写给 agent 看的规矩文本（拼进 prompt 由别处负责）。
 *
 * 只依赖 `group-contract`（类型与常量）+ `group-shared.mentionTag`（@ 标签的唯一出口）。
 */

import {
  GROUP_NEEDS_OWNER_RE,
  GROUP_NO_REPLY_TOKEN,
  GROUP_OWNER_ALIASES,
  type GroupMember,
  type GroupMention,
  type ParsedGroupReply,
} from "./group-contract";
import { mentionTag } from "./group-shared";

export interface ParseGroupReplyCtx {
  /** 群成员清单（真 @ 只认这里的展示名） */
  members: GroupMember[];
  /** 任务属主；`@宿主` / 「需属主确认」都 @ 他。没有就保持原样 / 降级成纯文本 */
  owner?: { openId: string; name: string };
  requester: { openId: string; name: string; isBot: boolean };
  /** 本机机器人自己的 open_id：绝不 @ 自己 */
  selfOpenId?: string;
}

/** 「需属主确认」说明的长度上限（群消息里一行话，不是长文） */
const NEEDS_OWNER_MAX = 200;

const silent = (): ParsedGroupReply => ({
  kind: "silent",
  text: "",
  mentions: [],
  unresolvedAts: [],
});

// ----------------- NO_REPLY 识别 -----------------

/** 成对的包裹引号 / 反引号（首尾必须配对才剥） */
const QUOTE_PAIRS: Record<string, string> = {
  '"': '"',
  "'": "'",
  "`": "`",
  "“": "”",
  "‘": "’",
  "「": "」",
  "『": "』",
};

const FENCE_RE = /^```[^\n]*\n?([\s\S]*?)\n?```$/;

/** 剥掉首尾空白 / 代码围栏 / 成对引号 / 末尾标点，反复直到稳定（模型常常多层包裹：`"NO_REPLY。"`） */
const unwrapSentinelShell = (s: string): string => {
  let cur = s.trim();
  for (let i = 0; i < 10; i++) {
    const prev = cur;
    const fence = FENCE_RE.exec(cur);
    if (fence) cur = (fence[1] ?? "").trim();
    cur = cur.replace(/[。.！!]+$/, "").trim();
    if (cur.length >= 2 && QUOTE_PAIRS[cur[0]] === cur[cur.length - 1]) {
      cur = cur.slice(1, -1).trim();
    }
    if (cur === prev) break;
  }
  return cur;
};

const isSentinel = (s: string): boolean =>
  unwrapSentinelShell(s).toUpperCase() === GROUP_NO_REPLY_TOKEN;

// ----------------- 工具 -----------------

const NEEDS_OWNER_RE_G = new RegExp(
  GROUP_NEEDS_OWNER_RE.source,
  GROUP_NEEDS_OWNER_RE.flags.includes("g")
    ? GROUP_NEEDS_OWNER_RE.flags
    : `${GROUP_NEEDS_OWNER_RE.flags}g`,
);

/** 手写的 at 标签：`<at user_id="ou_x">名字</at>`（属性引号容忍单 / 双） */
const AT_TAG_RE = /<at\s+user_id\s*=\s*["']([^"']*)["']\s*>([\s\S]*?)<\/at>/iy;

/** 未识别 `@xxx` 里 xxx 的终止符：空白 + 中英文标点 */
const TOKEN_STOP_RE = /[\s,，.。!！?？:：;；、()（）[\]【】{}<>《》"'“”‘’`~@＠]/;

const isAsciiWord = (ch: string | undefined): boolean =>
  !!ch && /^[A-Za-z0-9_]$/.test(ch);

const isAt = (ch: string): boolean => ch === "@" || ch === "＠";

const normalizeSpaces = (s: string): string => s.replace(/\s+/g, " ").trim();

/** 按码点截断；超长时最后一个字符换成省略号，总长不超过 max */
const clip = (s: string, max: number): string => {
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  return `${chars.slice(0, max - 1).join("")}…`;
};

/**
 * 说明里若混进手写 at 标签，压成纯文本 `@名字`——说明是补在正文末尾、不再走 @ 解析，
 * 不洗的话模型能借这行夹带任意 open_id。
 */
const sanitizeExplain = (s: string): string =>
  s.replace(/<at\b[^>]*>([\s\S]*?)<\/at>/gi, "@$1").replace(/<\/?at\b[^>]*>/gi, "");

interface Target {
  /** 目标 open_id；空串 = 认得名字但没法落成真 @（别名 + 无属主） */
  openId: string;
  /** 真 @ 标签里展示的名字 */
  display: string;
}

interface Candidate extends Target {
  /** 正文里需要紧跟 @ 的字面名字 */
  match: string;
}

/**
 * 解析 agent 的最终回复。纯函数、绝不抛错（内部任何异常都按 silent 处理——宁可群里没声音，
 * 也不发出一条没经过协议校验的原文，比如夹带伪造 open_id 的 at 标签）。
 */
export const parseGroupReply = (
  raw: string,
  ctx: ParseGroupReplyCtx,
): ParsedGroupReply => {
  try {
    return parseInner(typeof raw === "string" ? raw : "", ctx);
  } catch {
    return silent();
  }
};

const parseInner = (raw: string, ctx: ParseGroupReplyCtx): ParsedGroupReply => {
  const input = raw.trim();
  if (!input || isSentinel(input)) return silent();

  // 1) 单独成行的 NO_REPLY：模型手滑夹在正文里，剔掉这些行其余照发（不整条吞）
  let body = input
    .split(/\r?\n/)
    .filter((line) => !isSentinel(line))
    .join("\n");

  // 2) 「需属主确认」标记：取第一条非空说明，所有标记从正文剥掉
  let needsOwner: string | undefined;
  let strippedMarker = false;
  body = body.replace(NEEDS_OWNER_RE_G, (_m, explain: string) => {
    strippedMarker = true;
    if (needsOwner === undefined) {
      const e = clip(
        normalizeSpaces(sanitizeExplain(String(explain ?? ""))),
        NEEDS_OWNER_MAX,
      );
      if (e) needsOwner = e;
    }
    return "";
  });
  if (strippedMarker) {
    // 标记通常独占一行，剥掉后会留下空行 / 行尾空格
    body = body.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  }

  // 3) @ 解析
  const owner =
    ctx.owner && ctx.owner.openId.trim()
      ? { openId: ctx.owner.openId.trim(), name: ctx.owner.name ?? "" }
      : undefined;
  const selfOpenId = ctx.selfOpenId?.trim() || "";

  const nameOf = new Map<string, string>(); // openId → 展示名（可信来源）
  const candidates: Candidate[] = [];
  const addMember = (openId: string, name: string) => {
    const id = openId.trim();
    if (!id) return;
    const display = name.trim();
    if (!nameOf.get(id)) nameOf.set(id, display);
    if (display) candidates.push({ match: display, openId: id, display });
  };
  for (const m of ctx.members ?? []) addMember(m.openId, m.name ?? "");
  if (owner) addMember(owner.openId, owner.name);
  addMember(ctx.requester?.openId ?? "", ctx.requester?.name ?? "");
  if (selfOpenId && !nameOf.has(selfOpenId)) nameOf.set(selfOpenId, "");
  for (const alias of GROUP_OWNER_ALIASES) {
    candidates.push({
      match: alias,
      openId: owner?.openId ?? "",
      display: owner?.name?.trim() || nameOf.get(owner?.openId ?? "") || alias,
    });
  }

  const mentions: GroupMention[] = [];
  const seen = new Set<string>();
  const addMention = (openId: string, name: string) => {
    if (seen.has(openId)) return;
    seen.add(openId);
    mentions.push({ openId, name });
  };
  const unresolved: string[] = [];
  const addUnresolved = (name: string) => {
    if (name && !unresolved.includes(name)) unresolved.push(name);
  };

  /** 在 pos（@ 之后）处找最长匹配；同长度下指向不同 openId = 歧义 */
  const matchAt = (
    text: string,
    pos: number,
  ): { cand: Candidate; ambiguous: boolean } | null => {
    let bestLen = 0;
    let hits: Candidate[] = [];
    for (const c of candidates) {
      const len = c.match.length;
      if (len < bestLen || len === 0) continue;
      if (!text.startsWith(c.match, pos)) continue;
      // 纯 ASCII 名字加词边界：成员 `Bob` 不该吃掉 `@Bobby`
      const last = c.match[len - 1];
      if (isAsciiWord(last) && isAsciiWord(text[pos + len])) continue;
      if (len > bestLen) {
        bestLen = len;
        hits = [c];
      } else {
        hits.push(c);
      }
    }
    if (!hits.length) return null;
    const ids = new Set(hits.map((h) => h.openId));
    // 同 openId 的多条命中（成员 + 属主重复登记）取信息更全的一条
    const cand = hits.find((h) => h.openId && h.display) ?? hits[0];
    return { cand, ambiguous: ids.size > 1 };
  };

  let out = "";
  for (let i = 0; i < body.length; ) {
    const ch = body[i];

    // 手写 at 标签：id 可信才保留，否则退化成纯文本（防伪造 / 防幻觉 id）
    if (ch === "<") {
      AT_TAG_RE.lastIndex = i;
      const tag = AT_TAG_RE.exec(body);
      if (tag) {
        const id = tag[1].trim();
        const inner = tag[2].trim();
        const trusted = nameOf.get(id);
        if (id && id === selfOpenId) {
          out += inner || nameOf.get(id) || "";
        } else if (id && trusted !== undefined) {
          const display = trusted || inner;
          out += mentionTag(id, display);
          addMention(id, display.trim() || "你");
        } else {
          if (inner) {
            out += `@${inner}`;
            addUnresolved(inner);
          }
        }
        i += tag[0].length;
        continue;
      }
    }

    if (isAt(ch)) {
      const hit = matchAt(body, i + 1);
      if (hit && hit.ambiguous) {
        addUnresolved(hit.cand.match);
        out += ch;
        i += 1;
        continue;
      }
      if (hit) {
        const { cand } = hit;
        if (!cand.openId) {
          // 认得是 `@宿主` 但本任务没有属主 → 保持原样
          addUnresolved(cand.match);
          out += ch;
          i += 1;
          continue;
        }
        if (cand.openId === selfOpenId) {
          out += cand.display; // 不许 @ 自己：只留文本
        } else {
          out += mentionTag(cand.openId, cand.display);
          addMention(cand.openId, cand.display.trim() || "你");
        }
        i += 1 + cand.match.length;
        continue;
      }
      // 认不出：原样保留；邮箱 / 手机号里的 @（前一个字符是 ASCII 字母数字）不算「@ 某人」
      const prev = i > 0 ? body[i - 1] : "";
      if (!/[A-Za-z0-9._-]/.test(prev)) {
        let j = i + 1;
        while (j < body.length && !TOKEN_STOP_RE.test(body[j])) j++;
        addUnresolved(body.slice(i + 1, j));
      }
      out += ch;
      i += 1;
      continue;
    }

    out += ch;
    i += 1;
  }
  let text = out.trim();

  // 4) 需属主确认：补一行；owner 已被正文 @ 过就不重复 @
  if (needsOwner) {
    let line: string;
    if (owner) {
      const already = seen.has(owner.openId);
      if (already) {
        line = `需要你确认：${needsOwner}`;
      } else {
        const display = owner.name.trim() || nameOf.get(owner.openId) || "";
        if (owner.openId !== selfOpenId) {
          addMention(owner.openId, display || "你");
          line = `${mentionTag(owner.openId, display)} 需要你确认：${needsOwner}`;
        } else {
          line = `需要属主确认：${needsOwner}`;
        }
      }
    } else {
      line = `需要属主确认：${needsOwner}`;
    }
    text = text ? `${text}\n${line}` : line;
  }

  if (!text) return silent();

  // 5) 契约第 4 条：一个真 @ 都没有 → 真人提问人补 @；机器人不补（有意防环）
  if (mentions.length === 0 && ctx.requester && !ctx.requester.isBot) {
    const rid = ctx.requester.openId?.trim() || "";
    const rname = ctx.requester.name ?? "";
    text = `${mentionTag(rid, rname)} ${text}`;
    if (rid && rid !== selfOpenId) {
      addMention(rid, rname.trim() || "你");
    }
  }

  return {
    kind: "send",
    text: text.trim(),
    mentions,
    unresolvedAts: unresolved,
    ...(needsOwner ? { needsOwner } : {}),
  };
};

// ----------------- 给 agent 看的规矩 -----------------

/**
 * 答疑 agent 的「回复守则」（中文行，由调用方拼进 prompt）。
 * 写成给聪明同事的工作守则、不是法条；哨兵 / 标记写法一律引用 group-contract 常量。
 */
export const buildGroupReplyRules = (opts: {
  requesterIsBot: boolean;
}): string[] => {
  const [ownerAlias] = GROUP_OWNER_ALIASES;
  const noReply = GROUP_NO_REPLY_TOKEN;
  const needsOwnerMark = "[[需属主确认：一句话说明要属主定什么]]";

  const lines: string[] = [
    "## 你的回复会原文发到群里",
    "- 你的**最终回复就是发到群里的原文**：只有最后一段（所有工具调用之后的那段文字）会被发出。中途别写「我先查一下……」之类旁白，查完再一次性给出自包含的最终答复。",
    "- 对方没看过你的过程，也看不到 Flowship，更不认识内部事件序号、act_ 编号、SDK 报错、事件流、日志路径——这些一律不要出现在回复里，也不要建议对方「去 Flowship 看」。",
    "",
    "## 要不要回",
    `- 对方只是确认 / 复述 / 汇报「收到」、系统提示（比如「这轮没跑成功」）、转述别人的话，并且没有问你任何问题 → 整段回复只写 \`${noReply}\`（原样，不加任何别的字）。`,
    "- 别为了礼貌回「收到」「好的」。" +
      (opts.requesterIsBot
        ? "这次提问方是机器人，尤其要克制——两个机器人互相客气会无限循环下去，对方没提实质问题就沉默。"
        : "尤其对机器人：两个机器人互相客气会无限循环，对方没提实质问题就沉默。"),
    "",
    "## @ 谁",
    opts.requesterIsBot
      ? "- 提问方是机器人。它问了实质问题时，**必须在正文里写 `@它的名字`**（名字与「群里的人」清单完全一致），否则它看不见你的回答；它没问实质问题就回 `" +
        noReply +
        "`。"
      : "- 提问方是真人：正文里不用写 @，系统会自动 @ 他。",
    "- 想让别的人 / 机器人看见哪句话，就在那句话里写 `@名字`（同样要与「群里的人」清单完全一致）。",
    `- \`@${ownerAlias}\` = 任务属主本人。`,
    "- 一条消息里只 @ 真正需要行动或需要看见的人，别顺手 @ 一圈。",
    "",
    "## 不替属主拍板",
    "- 接口契约取舍、口径、范围、上线 / 发布 / 部署这类需要属主决定的事，不要替他答应。先给对方一个明确的说法（比如「这个要宿主确认，已转告」），再另起一行写：",
    `  \`${needsOwnerMark}\``,
    "  系统会把这行从群消息里去掉、@ 属主，并在属主的 Flowship 里提醒他。",
    "- 自己能凭产出文档 / 代码事实答的，照常答，别什么都推给属主。",
    "",
    "## 说话要有依据",
    "- 只陈述有依据的事实；查不到就说查不到 / 不确定，不要编。",
    "- 你是只读答疑身份，**没改过任何文件**——说「已改好」「已提交」之类之前先想清楚，别把没做过的事说成做了。",
    "",
    "## 风格",
    "- 直接讲结论，短句；必要时用 markdown 列表。不要复述对方的问题。",
    "- 不要自称「答疑 agent / 助手」，用第一人称，代表宿主团队的前端同学说话即可。",
  ];
  return lines;
};
