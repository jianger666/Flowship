/**
 * 错误卡「按失败类型给中文说明 + 对应入口」（纯函数、无 React；第二轮 review V3-03）
 *
 * 用户最常撞到的几类失败（限流 / 鉴权 / 模型不可用 / 上下文超长 / 额度 / 网络），
 * 错误卡以前只展示英文原串 + 查看详情 / 复制 / 重试——看不懂、也不知道该去哪改；
 * 鉴权类还把「重试」摆成主按钮（同模型同 key 必然再败）。
 *
 * - {@link classifyErrorText}：错误文本 → { kind, title, hint }（中文、业务口径、不含协议词 / 英文原串）；
 * - {@link planErrorActions}：按类给入口（去设置 / 开新对话）与「重试」的主次；
 * - {@link buildErrorCardModel}：卡片要画的几段（正文 / 建议 / 详情 / 复制串）。
 * 原串始终保留在「查看详情」与「复制」里，只是不再占正文。
 *
 * 判定口径（拿不准一律 unknown、保持原样展示——误导比不翻译更伤）：
 * - 「误判成本高」的类（鉴权 / 额度 / 模型 / 上下文：会引导去设置、降级重试）规则严格；
 *   「误判成本低」的类（限流 / 网络：都是「稍后重试」）宽松一点；
 * - 数字状态码必须有上下文（status / HTTP / code / 「401 Unauthorized」），端口 / 行号 / 文件名不算；
 * - 只扫开头 {@link MAX_SCAN} 个字符（诊断串可能几十万字符、关键字都在头部）；
 * - 服务端已改写成友好中文的整句（连接断 / SDK 放弃本轮）不二次归类，保持原文案。
 *
 * 优先级（先命中先赢，顺序有讲究）：上下文超长 → 额度 → 模型不可用 → 鉴权 → 限流 → 网络。
 * 例：OpenAI 余额不足也返 429 → 额度必须先于限流；「模型不存在或无权访问」是模型问题不是 Key 问题 →
 * 模型先于鉴权；按分钟 token 限速（TPM）是限流、不是上下文超长 → 有速率窗口特征时让位。
 */

export type ErrorKind =
  | "rate_limit"
  | "auth"
  | "model_unavailable"
  | "context_overflow"
  | "quota"
  | "network"
  | "unknown";

export interface ErrorClassification {
  kind: ErrorKind;
  /** 中文一句标题（unknown 为空串） */
  title: string;
  /** 中文一句建议（unknown 为空串） */
  hint: string;
}

export interface ClassifyOpts {
  /** 事件流形态：chat 有「开新对话」、task 没有；默认 chat */
  mode?: "chat" | "task";
}

/** 只扫开头这么多字符：诊断串（含 SDK 字段 JSON、堆栈）可能几十万字符，关键字都在头部 */
const MAX_SCAN = 6000;

// —— 服务端已改写成友好中文的整句：不再二次归类（文案出处：server/sdk-error.ts，tests 钉着别漂） ——
const PASSTHROUGH_RES: readonly RegExp[] = [
  // 不带 ^ 锚点（R2-01）：答疑 / 群答疑 / 唤醒等路径会在这句前面加「答疑失败：」之类的前缀，
  // 锚了行首就放行不了、整句里的「用量已用完」被判成账户额度不足并推「去设置」——服务端刻意不下这个断言
  /本轮异常结束——可能是长连接断开/,
  /SDK 在断线续接时连续多次都没能继续/,
  /SDK 连续多次连接失败，已放弃本轮/,
];

// —— HTTP 状态码（必须带上下文）——
const STATUS_CTX_RES: readonly RegExp[] = [
  // HTTP 429 / status: 429 / "status":429 / status code 403 / "code": 429 / error 401 / 状态码 401
  /(?:\bhttp(?:\/[\d.]+)?|\bstatus(?:[ _]?code)?|\bcode|\berror|\berr|\bresponse|状态码|错误码|响应码)[ \t"']{0,3}[:=：]?[ \t"']{0,3}(\d{3})(?!\d)/gi,
  // 429 Too Many Requests / 401 Unauthorized / 502 Bad Gateway …（状态码紧跟状态短语）
  /(?:^|[\s[(])(\d{3})[\])]?[ \t]+(?:unauthorized|forbidden|too many requests|payment required|bad gateway|service unavailable|gateway time-?out|request entity too large|payload too large|overloaded)/gim,
  // [429] / (401)
  /[[(](\d{3})[\])]/g,
];

const extractStatusCodes = (s: string): Set<number> => {
  const out = new Set<number>();
  for (const re of STATUS_CTX_RES) {
    for (const m of s.matchAll(re)) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) out.add(n);
    }
  }
  return out;
};

/**
 * SDK 错误字段里的 gRPC / connect code（只在带「SDK error fields」段时才认，防随手一段 JSON 误判）：
 * 16 unauthenticated / 7 permission denied / 8 resource exhausted / 14 unavailable / 4 deadline exceeded
 */
const grpcCodeOf = (s: string): number | null => {
  if (!s.includes("SDK error fields")) return null;
  const m = /"code"\s*:\s*(\d{1,2})(?!\d)/.exec(s);
  return m ? Number(m[1]) : null;
};

/** 速率窗口特征（按分钟 / 秒 / 小时、TPM / RPM）：命中说明是限速、不是上下文超长 / 额度用完 */
const RATE_WINDOW_RE =
  /per[ _-]?(?:min(?:ute)?|sec(?:ond)?|hour)\b|\b(?:tpm|rpm)\b|每分钟|每秒/i;

const CONTEXT_RES: readonly RegExp[] = [
  /context[_ ]length[_ ]exceeded/i,
  /maximum context length/i,
  /context (?:window|length)[^\n]{0,40}(?:exceed|too (?:long|large)|overflow|\bfull\b)/i,
  /(?:exceed|over)\w*[^\n]{0,40}context (?:window|length|limit)/i,
  /prompt is too long/i,
  /input is too long/i,
  /exceeds? the maximum number of tokens/i,
  /input token count[^\n]{0,40}exceeds/i,
  /(?:exceed\w*|over) (?:the )?(?:model'?s? )?token limit|token limit (?:exceeded|reached)/i,
  /request entity too large|payload too large|content too large/i,
  /too many tokens/i,
  /上下文(?:长度|窗口)?(?:已)?(?:超(?:出|过|限)?|过长|太长|溢出|已满)/,
  /超出(?:了)?(?:模型)?(?:最大)?(?:上下文|长度限制)/,
  /(?:对话|内容|输入|消息|提示词?)(?:太|过)长/,
  /token(?:s)?\s*(?:数|数量)?\s*(?:已)?(?:超出|超过|超限)/i,
];

const QUOTA_STRONG_RES: readonly RegExp[] = [
  /insufficient[_ ]quota/i,
  /insufficient (?:balance|funds|credits?)/i,
  /out of (?:credits?|quota)/i,
  /credit balance (?:is )?too low/i,
  /payment required/i,
  /billing (?:hard )?limit/i,
  /exceeded your current quota/i,
  /(?:hit|reached|exceeded) your (?:usage|monthly|spend(?:ing)?) limit/i,
  /\busage limit\b/i,
  /(?:spend|spending) limit/i,
  /(?:credits?|balance) (?:exhausted|depleted|used up)/i,
  /余额不足|额度(?:不足|已用完|用完|用尽|耗尽|超限)|欠费|账户余额|请充值|需要充值|(?:用量|额度)(?:已)?(?:超出|超限|用完)/,
];

/** 「quota」单词本身太泛：必须与 exceed / limit 等同现，且不是磁盘配额 / 速率窗口 / 资源耗尽（那是限流） */
const isWeakQuota = (s: string): boolean =>
  /\bquota\b/i.test(s) &&
  /exceed|exhaust|reach|limit|used up|insufficient/i.test(s) &&
  !/disk quota|edquot/i.test(s) &&
  !/resource[_ ]exhausted/i.test(s) &&
  !RATE_WINDOW_RE.test(s);

const MODEL_RES: readonly RegExp[] = [
  /model[_ ]?not[_ ]?found/i,
  /(?:unknown|invalid|unsupported|unrecognized) model\b/i,
  /you (?:do not|don't) have access to (?:the |this )?model/i,
  /\bmodels?\b[^\n]{0,80}(?:does not exist|doesn't exist|is not found|was not found|not found|not available|isn't available|not supported|is unavailable|(?:has been|was|is) (?:deprecated|decommissioned|retired|removed|discontinued)|no longer (?:available|supported))/i,
  /not supported for generatecontent/i,
  /模型[^\n]{0,12}(?:不存在|不可用|未找到|找不到|已下线|已停用|已废弃|不支持|未开通|无权|没有权限)/,
  /(?:找不到|不存在|无权使用|没有权限(?:访问|使用)?|不支持)(?:该|此|这个|当前|所选)?模型/,
];

const AUTH_RES: readonly RegExp[] = [
  /invalid[_ -]?api[_ -]?key/i,
  /incorrect api key/i,
  /api[ _-]?key (?:is |was )?(?:invalid|expired|revoked|missing|not (?:valid|found|provided|set))/i,
  /(?:no|missing) api[ _-]?key/i,
  /invalid x-api-key/i,
  /\bunauthori[sz]ed\b/i,
  /\bunauthenticated\b/i,
  /authentication (?:error|failed|failure|required)/i,
  /failed to authenticate/i,
  /(?:invalid|expired|revoked) (?:access |auth |bearer |session |api |oauth )token/i,
  /invalid credentials?|bad credentials|credentials? (?:are |is )?(?:invalid|expired)/i,
  /\[(?:unauthenticated|permission_denied)\]/i,
  /country, region, or territory not supported/i,
  /(?:api[ _-]?key|密钥|令牌|token|凭据|凭证)[^\n]{0,8}(?:无效|错误|不正确|已过期|过期|失效|缺失|未配置|不存在)/i,
  /(?:无效|错误|非法)的?\s*(?:api[ _-]?key|密钥|令牌|token|凭据|凭证)/i,
  /鉴权(?:失败|错误|不通过)|认证(?:失败|错误|不通过)|身份验证(?:失败|错误)/,
  /未授权|未登录|登录(?:已)?(?:过期|失效)/,
];

/** git / ssh / npm 的「认证失败」不是模型凭据：命中这些语境时鉴权类不判（落 unknown，原样展示） */
const AUTH_EXCLUDE_RE =
  /\b(?:git|gitlab|github|ssh|publickey|npm|registry)\b|fatal:|remote:|git@/i;

const RATE_RES: readonly RegExp[] = [
  /\brate[ _-]?limit/i,
  /too many requests/i,
  /overloaded/i,
  RATE_WINDOW_RE,
  /throttl(?:ed|ing)/i,
  /resource[_ ]exhausted/i,
  /please try again in \d/i,
  /retry-after/i,
  /(?:at|over) capacity|capacity (?:exceeded|limit)/i,
  /请求(?:过于|太|过)(?:频繁|多)|请求频繁|请求(?:次数|频率)(?:过多|过高|太高|超限|受限)|频率(?:超限|过高|限制|太高)|速率限制|限流|太多请求|服务(?:繁忙|过载|拥挤)|负载过高|访问量过大/,
];

const NETWORK_RES: readonly RegExp[] = [
  /\b(?:econnreset|econnrefused|econnaborted|etimedout|enotfound|eai_again|epipe|enetunreach|ehostunreach)\b/i,
  /socket hang up/i,
  /fetch failed/i,
  /network (?:error|request failed)/i,
  /connection (?:error|reset|refused|closed|lost|timed out)/i,
  /\bund_err_\w+/i,
  /other side closed/i,
  /(?:request|connection|read|socket|response) timed out/i,
  /timed out (?:while|after|waiting)/i,
  /timeout of \d+\s*ms exceeded/i,
  /bad gateway|gateway time-?out/i,
  /service unavailable/i,
  /(?:currently|temporarily) unavailable/i,
  /unable to connect|failed to connect/i,
  /\bgetaddrinfo\b/i,
  /self[- ]signed certificate|unable to verify the first certificate|certificate has expired|ssl routines/i,
  /\[(?:unavailable|deadline_exceeded|aborted)\]/i,
  /the server had an error while processing your request/i,
  /"type"\s*:\s*"api_error"/i,
  /网络(?:异常|错误|中断|不可用|故障|连接|请求失败)|(?:请求|连接)超时|连接(?:被重置|被拒绝|中断|断开)|无法连接|连不上/,
];

const anyMatch = (res: readonly RegExp[], s: string): boolean =>
  res.some((re) => re.test(s));

const hasCode = (codes: Set<number>, ...wanted: number[]): boolean =>
  wanted.some((c) => codes.has(c));

const classifyKind = (text: string): ErrorKind => {
  if (typeof text !== "string" || !text.trim()) return "unknown";
  const s = text.slice(0, MAX_SCAN);
  if (anyMatch(PASSTHROUGH_RES, s)) return "unknown";

  const codes = extractStatusCodes(s);
  const grpc = grpcCodeOf(s);
  const rateWindow = RATE_WINDOW_RE.test(s);

  // 1) 上下文超长：有速率窗口特征（TPM 之类）是限流、让位
  if ((anyMatch(CONTEXT_RES, s) || codes.has(413)) && !rateWindow) {
    return "context_overflow";
  }
  // 2) 额度：必须先于限流（OpenAI 余额不足也返 429）
  if (anyMatch(QUOTA_STRONG_RES, s) || codes.has(402) || isWeakQuota(s)) {
    return "quota";
  }
  // 3) 模型不可用：先于鉴权（「不存在或无权访问」是模型问题）
  if (anyMatch(MODEL_RES, s)) return "model_unavailable";
  // 4) 鉴权
  if (
    !AUTH_EXCLUDE_RE.test(s) &&
    (anyMatch(AUTH_RES, s) ||
      hasCode(codes, 401, 403) ||
      grpc === 16 ||
      grpc === 7)
  ) {
    return "auth";
  }
  // 5) 限流 / 服务繁忙
  if (anyMatch(RATE_RES, s) || hasCode(codes, 429, 529) || grpc === 8) {
    return "rate_limit";
  }
  // 6) 网络 / 服务暂时不可用
  if (
    anyMatch(NETWORK_RES, s) ||
    hasCode(codes, 502, 503, 504) ||
    grpc === 14 ||
    grpc === 4
  ) {
    return "network";
  }
  return "unknown";
};

// 文案：中文、业务口径；不含协议词 / 状态码 / 英文原串（API Key 是设置页里的业务词）
const COPY: Record<
  Exclude<ErrorKind, "unknown" | "context_overflow">,
  { title: string; hint: string }
> = {
  rate_limit: {
    title: "请求太频繁，模型服务暂时限流",
    hint: "稍等几十秒再试；经常遇到的话，可以换一个模型，或减少同时进行的任务。",
  },
  auth: {
    title: "模型服务拒绝了当前凭据",
    hint: "API Key 可能无效、已过期，或没有这个模型的使用权限。到设置里检查并更新后再试——不改直接重试，结果还是一样。",
  },
  model_unavailable: {
    title: "当前模型不可用",
    hint: "这个模型可能不存在、没有开通或已下线。换一个模型后再试，也可以到设置里检查模型列表。",
  },
  quota: {
    title: "账户额度不足或已用完",
    hint: "到模型服务商那边充值或查看用量；也可以在设置里换一个可用的提供方或 API Key。",
  },
  network: {
    title: "网络或模型服务暂时不可用",
    hint: "检查网络和代理后再试；服务端临时故障一般过一会儿就能恢复。",
  },
};

const CONTEXT_COPY = {
  title: "内容太长，超出了模型一次能处理的范围",
  chat: "对话内容超过了模型一次能处理的长度。开一个新对话继续，或换一个上下文更大的模型；直接重试会得到同样的结果。",
  task: "任务内容超过了模型一次能处理的长度。换一个上下文更大的模型后再试；直接重试会得到同样的结果。",
} as const;

/** 错误文本 → 分类 + 中文标题 / 建议（unknown 的 title / hint 为空串） */
export const classifyErrorText = (
  text: string,
  opts: ClassifyOpts = {},
): ErrorClassification => {
  const kind = classifyKind(text);
  if (kind === "unknown") return { kind, title: "", hint: "" };
  if (kind === "context_overflow") {
    return {
      kind,
      title: CONTEXT_COPY.title,
      hint: opts.mode === "task" ? CONTEXT_COPY.task : CONTEXT_COPY.chat,
    };
  }
  return { kind, ...COPY[kind] };
};

export interface ErrorActionPlan {
  /** 「去设置」入口（focus 交给 settingsUrl）；null = 不给 */
  settings: { focus: string } | null;
  /** 「开新对话」入口（只有 chat 形态的上下文超长给） */
  newChat: boolean;
  /**
   * 「重试」/「重新推进」的视觉权重。
   * secondary = 降级：鉴权 / 额度 / 模型不可用 / 上下文超长这几类，同模型同 key 同上下文重试必然再败，
   * 不能摆成主按钮误导；但也不隐藏——用户去设置改完 Key 回来要能直接点，隐藏会逼他重打一遍。
   */
  retry: "primary" | "secondary";
}

/**
 * 按失败类型给入口。「换模型」没有做成按钮：输入条底栏的模型下拉就在卡片下方，
 * 但事件流与输入条之间没有现成的「聚焦模型选择器」通道、不为这个新造跨组件通信，只在建议文案里说。
 */
export const planErrorActions = (
  kind: ErrorKind,
  opts: { mode: "chat" | "task" },
): ErrorActionPlan => {
  switch (kind) {
    case "auth":
    case "quota":
    case "model_unavailable":
      // 凭据 / 提供方 / 模型列表都在设置页「模型」栏
      return { settings: { focus: "model" }, newChat: false, retry: "secondary" };
    case "context_overflow":
      return { settings: null, newChat: opts.mode === "chat", retry: "secondary" };
    default:
      return { settings: null, newChat: false, retry: "primary" };
  }
};

/** 原始诊断段的分隔标题（复制出去时也带上、贴给别人一眼分得清哪段是哪段） */
export const ERROR_DETAIL_HEADING = "--- 原始诊断 ---";

export interface ErrorCardModel {
  classification: ErrorClassification;
  /** 正文主句：命中分类 = 中文标题；否则原文 */
  headline: string;
  /** 命中分类时的一句建议；否则 "" */
  hint: string;
  /** 「查看详情」展开的原始诊断；空串 = 没有值得展开的（不画「查看详情」） */
  diagnostic: string;
  /** 复制出去的整份 */
  copyText: string;
}

/**
 * 卡片要画的几段。
 * - 未命中分类：口径与旧版一致——正文原样；detail 非空且不等于正文才单开详情；
 * - 命中分类：正文换成中文标题 + 建议，**原串（及 detail 里的补充）放进详情**，不再丢。
 * 分类先看正文、不命中再看 detail（连接断那种正文是友好句子，状态码 / code 只在 detail 的 SDK 字段里）。
 */
export const buildErrorCardModel = (
  text: string,
  detail: string,
  opts: ClassifyOpts = {},
): ErrorCardModel => {
  const body = typeof text === "string" ? text : "";
  const bodyTrim = body.trim();
  const det = typeof detail === "string" ? detail.trim() : "";
  const detailDiffers = det !== "" && det !== bodyTrim;

  let classification = classifyErrorText(body, opts);
  if (classification.kind === "unknown" && detailDiffers) {
    classification = classifyErrorText(det, opts);
  }

  if (classification.kind === "unknown") {
    return {
      classification,
      headline: body,
      hint: "",
      diagnostic: detailDiffers ? det : "",
      copyText: detailDiffers
        ? `${body}\n\n${ERROR_DETAIL_HEADING}\n${det}`
        : body,
    };
  }

  // 原串放进详情：detail 已包含正文 → 只留 detail；正文已包含 detail → 只留正文；否则两段都留
  let diagnostic = bodyTrim;
  if (detailDiffers) {
    if (det.includes(bodyTrim)) diagnostic = det;
    else if (bodyTrim.includes(det)) diagnostic = bodyTrim;
    else diagnostic = `${bodyTrim}\n\n${det}`;
  }
  return {
    classification,
    headline: classification.title,
    hint: classification.hint,
    diagnostic,
    copyText: `${classification.title}\n${classification.hint}\n\n${ERROR_DETAIL_HEADING}\n${diagnostic}`,
  };
};
