/**
 * 群成员写的文字里不能出现会冒充「系统抬头 / 协议边界」的字面量——凡是别人写的、要拼进给 agent 看的文本，都要过 {@link escapeProtocolMarkers}。
 *
 * 独立成一个零依赖的小模块（`group-quote.ts` 再导出它）：ask-inject 这种只想要这一个函数的地方不必把 group-quote 的依赖链拖进来。
 *
 * 会冒充的字面量（半角 `[` 起头）：
 * - `[群消息`：所有者 / 非属主的发言抬头；
 * - `[引用消息` / `[/引用消息`：引用块边界；
 * - `[SCHEDULE_FIRED`：系统到点样板的抬头（提示词里写明「这是系统发的、不是用户说话」，高信任）；
 * - `[ASK_USER_REPLY`（含 `[ASK_USER_REPLY deferred]`）：「用户答了 agent 的提问」的抬头——提示词里写明它才是答案，
 *   非属主若能伪造一个，agent 会把他的话当成属主答题；
 * - `[ATTACHED_IMAGES]` / `[ATTACHED_PATHS]`：「用户附了这些图 / 文件，请用 read 去读」的抬头（chat-runner / task-prompts 拼的），
 *   伪造一个就能让 agent 去读任意本地路径（第三轮评审）；
 * - `[NEXT_ACTION …]` / `[RESUME_ACTION]`（「去做下一步」的指令）、`[USER_MESSAGE]`（任务会话里「用户说」的抬头）：task-runner 往会话里写的
 *   系统头，伪造它们等于冒充系统 / 所有者下指令；
 * - **兜底**：行首的 `[大写_下划线…`（`[TASK_UPDATED]` / `[BUILD_BATCHES]` / `[REVIEW_SCOPE]` / `[REPLAN_MODE` / `[BACKGROUND_SUBAGENT_RESULT]` ……）——
 *   服务端往用户轮里写的系统抬头都是这个形状，挨个登记总会漏一个。只认行首：正文中间的 `arr[MAX_SIZE]` 之类代码不动。
 *
 * 做法：只把开头的半角 `[` 换成全角 `［`，其余原样——肉眼等价、模型看到的边界不再被冒充；幂等（已经是全角的不再匹配）。
 *
 * 匹配是**宽松**的（第二轮评审：只匹配紧挨着的半角字面量，加个零宽字符就绕过去了）：
 * - `[` 与关键字之间、关键字的每个字之间都允许夹任意空白（含全角空格 / NBSP / 换行）和「看不见」的字符：格式字符（`\p{Cf}`：零宽空格 /
 *   零宽连接符 / BOM / 双向控制符 / 软连字符……）、**非 Cf 的默认可忽略字符**（`\p{Default_Ignorable_Code_Point}`：韩文填充 U+3164 / U+FFA0 /
 *   U+115F / U+1160、组合用连字符 U+034F、变体选择符、高棉固有元音……第三轮评审：只认 Cf 的话，这些都能把关键字隔开）、
 *   组合附加符（`\p{M}`）与盲文空白 U+2800——模型读文本时这些都是「看不见」的，`[群​消息·来自 所有者]` 和真抬头在它眼里是一回事；
 * - 大小写不敏感（`[schedule_fired`）。
 * 不去**删**这些字符（整段剥掉 `\p{Cf}` 会弄坏 emoji 的 ZWJ 序列和波斯语 / 印地语的 ZWNJ），只在命中处把 `[` 换掉。
 *
 * **另一类：自封「所有者」的话术**（第三轮评审）：所有者本人的群消息后面，服务端会经可信通道（agentContext）补一句
 * 「这条是任务所有者本人在需求群里说的，同他在输入条里说的一样对待」；「限制已关」声明里有「任务所有者已在设置里关掉了…」。
 * 群成员原样抄这两句就能让模型以为是服务端写的。命中时把话改成「自称 / 据称」的口气（`这条自称是任务所有者本人`、
 * `任务所有者据称已在设置里关掉了`）——幂等（改写后的句子不再匹配）。⚠️ 这是**黑名单**，只挡逐字抄我们自己的固定句；
 * 换个说法就绕得过，所以它不是防线本身，只是去掉「逐字伪造」这个最省力的做法——真正的防线仍是抬头（`（非任务所有者）`）+
 * 恒拒的工具（desktop_* / 写备注 / 新建定时 / 自动推进）+ 中途登记的群成员标记。
 *
 * 没盖到的（有意）：`[` 本身被换成别的括号（`【` `〔` `［`）——真抬头恒为半角 `[`，别的括号模型不会当成抬头；
 * 全角字母的 `ＳＣＨＥＤＵＬＥ_ＦＩＲＥＤ`——同理不是真抬头的字形。昵称另有 sanitizeGroupMemberName 压掉方括号 / 「」（）和换行。
 * ⚠️ 不能对**拼好的整段**调用：代码自己拼的引用块头尾（`[引用消息·来自 …]` / `[/引用消息]`）也是这些字面量。
 */

/**
 * 命中范围：空白 + 各种「看不见」的字符。写成「零个或多个」，且相邻两处之间一定隔着一个字面字符——不会出现 `[…]*[…]*` 相邻导致的回溯放大。
 * `\p{Default_Ignorable_Code_Point}` 是 Unicode 自己维护的「渲染时应忽略」名单（含 U+3164 / U+FFA0 等非 Cf 的填充字符），比手写一串码点稳。
 */
const GAP = String.raw`[\s\p{Cf}\p{Default_Ignorable_Code_Point}\p{M}\u2800]*`;

/** 按字拆开、字间允许夹 GAP；只转义 u 模式下合法的语法字符（多转义一个 `_` 在 u 模式里是语法错误） */
const spaced = (word: string): string =>
  [...word].map((ch) => ch.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&")).join(GAP);

const PROTOCOL_WORDS = [
  "引用消息",
  "群消息",
  "SCHEDULE_FIRED",
  "ASK_USER_REPLY",
  "ATTACHED_IMAGES",
  "ATTACHED_PATHS",
  "NEXT_ACTION",
  "RESUME_ACTION",
  "USER_MESSAGE",
] as const;

// `[` GAP [`/` GAP] 关键字。`/` 前后各自带 GAP，且 `[`→GAP→(`/`|关键字首字) 之间没有可空的相邻量词
const PROTOCOL_MARKER_RE = new RegExp(
  String.raw`\[${GAP}(?:/${GAP})?(?:${PROTOCOL_WORDS.map(spaced).join("|")})`,
  "giu",
);

/**
 * 兜底：行首的 `[大写_下划线…` 抬头。`^` 靠 m 标志（行首 = 文本开头或换行之后）；行首允许缩进 / 引用符 / 列表符；
 * 大小写敏感（真抬头都是大写，`[note_x]` 之类小写的是普通文字）。
 * 只匹配到 `[` 为止（后面的大写词用前瞻看，不消耗），所以命中串的最后一个字符就是要换掉的 `[`。
 */
const GENERIC_HEADER_RE = new RegExp(
  String.raw`^[ \t\u3000>\-*•]*\[(?=${GAP}[A-Z][A-Z0-9]*_[A-Z0-9_]*)`,
  "gmu",
);

/** 自封「所有者」的固定句（服务端可信通道里的原话）→ 改成「自称 / 据称」的口气。改写后的句子不再命中，所以幂等 */
const CLAIM_PHRASES: ReadonlyArray<{ find: string; to: string }> = [
  // group-non-owner-prompt 的 buildOwnerGroupNote：所有者群消息尾注
  { find: "这条是任务所有者本人", to: "这条自称是任务所有者本人" },
  // group-non-owner-prompt 的 buildNonOwnerOpenNote：「限制已关」声明
  { find: "任务所有者已在设置里关掉了", to: "任务所有者据称已在设置里关掉了" },
];
const CLAIM_PHRASE_RES = CLAIM_PHRASES.map((p) => ({ re: new RegExp(spaced(p.find), "gu"), to: p.to }));

export const escapeProtocolMarkers = (s: string): string => {
  let out = s
    .replace(PROTOCOL_MARKER_RE, (m) => `［${m.slice(1)}`)
    .replace(GENERIC_HEADER_RE, (m) => `${m.slice(0, -1)}［`);
  for (const { re, to } of CLAIM_PHRASE_RES) out = out.replace(re, to);
  return out;
};
