/**
 * 事件凭据脱敏（S03-04 / S16-11 / R1-01 / R1-02）
 *
 * 背景：agent 的命令文本（tool_call）、命令输出（tool_result）会随事件写进 `events.jsonl`
 * （并经 SSE / 飞书 / 诊断包外流），凭据一旦出现在里面就是明文落盘 + 外流。
 * 以前「GitLab 访问」提示让 agent 用 jq/node 从 `config.json` 取 gitToken；现在改成 token 走
 * 环境变量 `FLOWSHIP_GITLAB_TOKEN`（git-token-env.ts）、agent 命令里只引用 `"$FLOWSHIP_GITLAB_TOKEN"`，
 * token 值不再出现在命令文本里、也不用打开 config.json——这是 gitToken 的**根治**手段。
 * 本模块是兜底：agent 仍可能 echo / printenv 该变量，或读 `config.json` / `company-env.json`
 * 取 apiKey、服务器 / PG / Redis 密码，这些精确值落盘 / 推流前一律替换成占位符（gitToken 同样继续脱敏）。
 *
 * 方案（两个入口，值集合共用）：
 *   1. 落盘：所有事件行都经 `task-fs-core.appendEventLine` 落盘——在那里把当前凭据的**精确值**
 *      替换成占位符（原地改事件对象，之后 publish 的也是脱敏版）。
 *   2. 实时推流：`tool_output_delta` / `assistant_delta` / `thinking_delta` 等增量帧不落盘（或延迟
 *      合并后才落盘），不经 appendEventLine——在 `task-stream.publish`（SSE 与飞书回流的唯一
 *      扇出点）推送前对其文本字段脱敏（命中才拷贝改写，未命中零额外开销）。
 * 精确匹配而不是正则猜：不会误伤别的字符串，也不依赖 token 前缀格式。
 *
 * 值集合（各用不同占位符；去重后长值优先，避免短值是长值子串时留下半截明文）：
 *   - `config.json`：`gitToken`、`apiKey`、`customProviders[].apiKey`（[REDACTED:gitToken] / [REDACTED:apiKey]）；
 *     同形状的 `config.json.bak`（上一版）与 `config.json.bak.shrink`（收缩前的完整配置）里的旧凭据同样脱敏——
 *     用户轮换 / 清空 key 之后旧值还躺在备份里，agent 读到备份就会原样外流（见 `FileSlot`）
 *   - `config.json` 里的 `companyEnv` 与 `<dataRoot>/company-env.json`：所有 key 名含
 *     password / passwd / secret / token / apikey 的字符串值（[REDACTED:companyEnv]）
 *   - 进程 env 里 `FLOWSHIP_GITLAB_TOKEN` 的**当前值**（[REDACTED:gitToken]）：它是 agent `printenv` 实际看到的值，
 *     不一定等于 config.json 的 gitToken（会话启动优先用入口带来的 Token）；每次读 env，不缓存值本身
 *   每个文件（config / config.bak / config.bak.shrink / company-env）各有一份按 stat 失效的缓存，只缓存**值集合**（不缓存整个 config 对象）。
 *   长度 < 8 的值不脱敏（精确子串替换会误伤正文里的普通片段）。
 *
 * 编码变体（第四轮 P3）：精确值替换只认原样字节，但现实里有两条泄漏路径会让凭据换个形态出现——
 *   ① URL 里带口令（`postgresql://u:p%40ss@host`、`?key=…`）：口令被 URL 编码；
 *   ② agent 跑 `GIT_TRACE_CURL=1 git …` / `curl -v`：`Authorization: Basic <base64>` 被打进输出
 *      （git 较新版本默认会遮 Authorization 头、`GIT_TRACE_REDACT=0` 可关，`curl -v` 不遮；两条都不能指望）。
 *   所以对集合里每个凭据再补两类变体，**只补「编码后与原值不同」的**（同样 ≥ 8 位），占位符与原值相同：
 *   - `encodeURIComponent(值)`：所有凭据；纯字母数字 / `-_.~` 的 PAT 编码后不变，不产生多余条目；
 *   - gitToken 的 HTTP Basic：`base64("oauth2:" + PAT)`（Flowship 注入的 credential helper 用户名就是 oauth2，
 *     见 team-library.ts 的 INLINE_CREDENTIAL_HELPER）以及仅 PAT 自身的 `base64(PAT)`。
 *     只给 gitToken 加 base64：apiKey / 公司环境密码若走 Basic 是 `用户名:口令`，用户名不可枚举，猜不全。
 *   变体随值集合一起缓存（见 `getEventRedactionReplacements`）：只在 config.json / company-env.json /
 *   env 里的 PAT 变化时重算，热路径不额外 stat / 编码；集合最多 = 原值数 + gitToken×2 + 含特殊字符的凭据数。
 *
 * JSON 转义形态（复查补洞）：口令含 `"` / `\` / 制表符 / 换行时，agent `cat company-env.json` / `cat config.json`
 *   输出的文本里是**转义后的样子**（`pa\"ss\\word`），只认原值抓不到。所以每条凭据还预算了转义形态（`escaped`）：
 *   字符串值里出现它就替换（`replaceSecrets`），且整行预检同时查「转义」与「转义再转义」两层（`lineContainsSecret`）。
 *   它不是新条目、不增加集合规模，只是同一条凭据多查两个子串；`JSON.stringify` 之外的转义风格
 *   （Python `ensure_ascii` 的 `\uXXXX`、PHP 的 `\/`）不覆盖。
 *
 * 局限（剩余风险，未解决）：
 *   - 编码变体只覆盖上面两类、且只认**整段**：分块 / 折行的 base64（`base64` 命令默认 76 列折行、
 *     流式输出被切开）、URL-safe / 无填充 base64、hex / 其它进制 / 二次编码（先 URL 编码再 base64）、
 *     用户名不是 oauth2 的 Basic（`gitlab-ci-token:`、真实用户名 → 整串 base64 不同、也不对齐到 PAT 自身的偏移）、
 *     apiKey / 公司环境密码的 Basic 头、其它库的 URL 编码风格差异（`encodeURIComponent` 不编 `!'()*`，
 *     而 Python `quote` 会编；小写十六进制 `%2f`；`+` 代空格），以及把凭据拆成几段分别打印 —— 都**不覆盖**。
 *     脱敏是事后遮盖、不是隔离：真要让 agent 看不到凭据，只能走 env / credential helper 注入（见上）。
 *   - 已落盘的老 `events.jsonl` 仍是明文，不做迁移。
 *   - 增量流里 token 被切在两个相邻增量帧时，单帧内无法精确匹配（实现「保留末尾 len-1 字符」的
 *     小缓冲要改动各流的收尾 / lease 失主 / 重连快照语义，不够便宜安全）。缓解：累积型消费者
 *     （thinking 快照、飞书 p2p 卡片正文、群回复正文）对**累积文本**再脱敏一次，能抓到跨帧的
 *     完整 token；落盘版（assistant_message / tool_result 整段）也是整段匹配。SSE 浏览器端只会
 *     短暂看到被切开的半截 token，之后落盘版替换为占位符。
 *   - 其它 settings 字段（如 `mcpServers` 的 headers / env 值）语义不明（env 里常是 `production`
 *     这类普通值），不纳入。
 *   - 进程 env 里**除 FLOWSHIP_GITLAB_TOKEN 外**的敏感变量不覆盖：Flowship 自己只往 process.env 注入这一个凭据，
 *     其余（用户启动环境里自带的 `*_TOKEN` / `*_API_KEY` / `AWS_*` 等）来源与语义不可枚举，按变量名猜
 *     （如含 token / secret / password）既会漏、也会误伤普通值（如 `*_TOKEN_URL` 这类放的是地址的变量），
 *     属产品口径决策，不在这里悄悄做。
 *   - agent 本轮上下文 / SDK 自己的会话存储里凭据仍是明文（SDK 内部存储、不在本仓控制范围）；
 *     gitToken 已改 env 注入（命令里只有变量名、不出现值——除非 agent 违规 echo 它）；
 *     apiKey / 公司环境密码仍靠 agent 读文件取，这部分根治同样要改成 env / credential helper 注入。
 *
 * 依赖方向：只依赖 data-root，不 import task-fs-core / task-stream（被它们引用，避免环）。
 */

import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import { dataRoot, stripBom } from "./data-root";
// 只取常量：git-token-env 对 settings-fs 只有 type import（编译期擦除），没有运行时依赖，不会成环
import { GITLAB_TOKEN_ENV_NAME } from "./git-token-env";

/** 脱敏占位符（保留是哪类凭据，方便排查「这里原本有个凭据」） */
export const REDACTED_GIT_TOKEN = "[REDACTED:gitToken]";
export const REDACTED_API_KEY = "[REDACTED:apiKey]";
export const REDACTED_COMPANY_ENV = "[REDACTED:companyEnv]";

/**
 * 太短的值不脱敏：精确子串替换会把正文里的普通片段（如用户随手配的 "abc"）误伤成占位符。
 * 真实 GitLab PAT / Cursor API Key 均在 20 位以上。
 */
const MIN_SECRET_LENGTH = 8;

/** 递归深度上限：事件本身是可 JSON 序列化的树，正常远小于此；兜底防畸形深嵌套爆栈 */
const MAX_WALK_DEPTH = 64;

/** 一个待脱敏的凭据：精确值 + 命中后换成的占位符 */
export interface RedactionSecret {
  value: string;
  placeholder: string;
  /**
   * 值在 JSON 字符串里的转义形态（`"` → `\"`、换行 → `\n`）；与原值相同时为空串 = 无需再查一次。
   * 值集合构造时预算好，`lineContainsSecret` / `replaceSecrets` 热路径就不必对每个凭据、每行事件重复
   * `JSON.stringify`；缺省（测试 / 调用方手写的裸对象）时现算。
   * 两处用途：① 整行序列化后是否含凭据（原值在行里就长这样）；② **字符串值里**出现的转义形态——
   * agent `cat company-env.json` / `cat config.json` 时，输出文本里的口令本来就是转义后的样子，
   * 光替换原值抓不到它（口令含 `"` / `\` / 制表符时）。
   */
  escaped?: string;
  /**
   * `escaped` 再被 `JSON.stringify` 一次的形态（`\"` → `\\\"`）；`escaped` 为空串时它也是空串。
   * 为什么要有：上面②那段文本作为 tool_result 的字符串值进事件行时又被转义一层，整行里长的是这个形态，
   * `lineContainsSecret` 的预检只查 `value` / `escaped` 的话永远命中不了，整条事件就原样落盘了。
   * 缺省时现算（同 `escaped`）。
   */
  escapedTwice?: string;
}

/**
 * configBackup = `config.json.bak`（设置 PUT 覆盖前留的备份，见 settings-fs.putSettingsFile）。
 * 备份里是**上一版**的 apiKey / PAT：用户轮换掉旧 key 后它们仍躺在这个文件里，agent 只要读到它就会原样外流，
 * 而 `config.json` 里已经没有这个值了、只认 config.json 就脱不掉。
 * configBackupShrink = `config.json.bak.shrink`（设置 PUT 判为「收缩」时、写盘之前留的完整配置，见 settings-fs.putSettingsFile）。
 * 「收缩」的判据（settings-fs.ts 的 `shrunkSettingsKeys`，第八轮核对）：
 *   ① `SHRINK_WATCHED_KEYS`（apiKey / gitToken / repos / mcpServers / customProviders）里某个键由非空变成空 / 缺失；
 *   ② customProviders 里某条原本有 apiKey、现在整条没了或 apiKey 被清空（另一条还在时顶层数组仍非空，①看不出来）；
 *   ③ companyEnv 里某个子系统原本有「用户填了内容」的行、现在没有了（旧单对象格式先过 normalizeCompanyEnv 再比）。
 * 偏好开关 / 星标 / disabled* 的变化、以及非空→另一个非空的**轮换**，都不算收缩、不会写它。
 * 它只被下一次收缩写覆盖、普通保存不碰，所以比 `.bak` 活得更久：用户清空 key 时，旧 key 躺在它里面；
 * 而「上一次收缩时记下的旧 key」之后被轮换掉（config.json 里已是新值、`.bak` 也早被后续保存滚掉了）时，也会长期只躺在它里面——同一条泄漏路径。
 */
type FileSlot = "config" | "configBackup" | "configBackupShrink" | "companyEnv";

type FileCache = {
  file: string;
  ino: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  size: bigint;
  /** 只缓存值集合——绝不把整个 config / company-env 对象留在内存里 */
  secrets: RedactionSecret[];
};

type CacheHolder = {
  files: Record<FileSlot, FileCache | null>;
  /** 合并结果缓存：两份来源数组引用都没变就直接复用（热路径不重复去重 / 排序） */
  merged: {
    config: RedactionSecret[];
    configBackup: RedactionSecret[];
    configBackupShrink: RedactionSecret[];
    companyEnv: RedactionSecret[];
    /** 合并时 `FLOWSHIP_GITLAB_TOKEN` 的值：env 变了（会话启动 / 设置保存会改它）就要重算 */
    envToken: string;
    /** 原值集合（去重、长值优先） */
    out: RedactionSecret[];
    /** 原值 + 编码变体（真正用于替换的集合；与 out 同时失效 / 重算，所以变体跟随缓存） */
    expanded: RedactionSecret[];
  } | null;
};

// 缓存挂 globalThis：Next dev 多 chunk 下模块级变量不共享（同 task-fs-core 踩过的坑）
// V3：merged 里新增 expanded（编码变体）；V4：新增 configBackup 槽；V5：新增 configBackupShrink 槽。
// 旧形状的缓存对象（dev HMR 残留）不能再复用——缺新槽 / 新字段会让 merged 的引用比对永远不等、或读到 undefined
const CACHE_KEY = "__flowshipEventRedactSecretCacheV5__";
const getCacheHolder = (): CacheHolder => {
  const g = globalThis as unknown as Record<string, CacheHolder | undefined>;
  if (!g[CACHE_KEY]) {
    g[CACHE_KEY] = {
      files: {
        config: null,
        configBackup: null,
        configBackupShrink: null,
        companyEnv: null,
      },
      merged: null,
    };
  }
  return g[CACHE_KEY]!;
};

const pushSecret = (
  out: RedactionSecret[],
  raw: unknown,
  placeholder: string,
): void => {
  if (typeof raw !== "string") return;
  const value = raw.trim();
  if (value.length >= MIN_SECRET_LENGTH) out.push({ value, placeholder });
};

/** companyEnv 里「凭据类」字段的 key 名（password / accessKeySecret / token / apiKey …） */
const CREDENTIAL_KEY_RE = /(password|passwd|secret|token|apikey)/i;

/**
 * 遍历 companyEnv 树（servers / pg / redis / xxljob / nacos / elk / sls / httpApis / custom …），
 * 收集 key 名像凭据的字符串值。按 key 名泛化匹配而不是写死子系统列表：以后新增子系统的
 * password 字段自动覆盖；custom 的 name / content、host / url / note 这类非凭据字段不碰。
 */
const collectCompanyEnvSecrets = (
  node: unknown,
  out: RedactionSecret[],
  depth = 0,
): void => {
  if (!node || typeof node !== "object" || depth > MAX_WALK_DEPTH) return;
  if (Array.isArray(node)) {
    for (const item of node) collectCompanyEnvSecrets(item, out, depth + 1);
    return;
  }
  for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
    if (typeof val === "string") {
      if (CREDENTIAL_KEY_RE.test(key)) pushSecret(out, val, REDACTED_COMPANY_ENV);
    } else {
      collectCompanyEnvSecrets(val, out, depth + 1);
    }
  }
};

/** `config.json`（settings）里的凭据：gitToken / apiKey / 自定义 provider 的 apiKey / companyEnv */
const extractConfigSecrets = (parsed: unknown): RedactionSecret[] => {
  const out: RedactionSecret[] = [];
  if (!parsed || typeof parsed !== "object") return out;
  const cfg = parsed as Record<string, unknown>;
  pushSecret(out, cfg.gitToken, REDACTED_GIT_TOKEN);
  pushSecret(out, cfg.apiKey, REDACTED_API_KEY);
  if (Array.isArray(cfg.customProviders)) {
    for (const p of cfg.customProviders) {
      if (p && typeof p === "object") {
        pushSecret(out, (p as Record<string, unknown>).apiKey, REDACTED_API_KEY);
      }
    }
  }
  collectCompanyEnvSecrets(cfg.companyEnv, out);
  return out;
};

/** `<dataRoot>/company-env.json`：根对象就是 CompanyEnv */
const extractCompanyEnvFileSecrets = (parsed: unknown): RedactionSecret[] => {
  const out: RedactionSecret[] = [];
  collectCompanyEnvSecrets(parsed, out);
  return out;
};

/**
 * 「读不到 / 没配」时返回的共享空集合。必须是**同一个引用**：`resolveMerged` 用来源数组的引用相等判断
 * 「值集合没变、可复用合并结果」，如果每次失败都返回新的 `[]`，没有 company-env.json 的机器
 * （常态）上合并结果永远命中不了缓存，每个事件都会重算一遍（现在还包含编码变体的 base64 / 转义）。
 * 冻结：消费方只读，真有人误改会直接抛错而不是悄悄污染所有后续事件。
 */
const NO_SECRETS = Object.freeze([]) as unknown as RedactionSecret[];

/**
 * 同步读某个凭据文件的值集合（事件写入热路径：只 stat 一次，文件没变就走缓存）。
 * 文件是 tmp+rename 原子写，inode / mtime / ctime / size 任一变化都会触发重读（纳秒精度）。
 * 没配（ENOENT）→ 空集合。读不出来（半写 / 瞬时 EBUSY / 权限 / 手改坏）→ **沿用上一次读成功的凭据**：
 * 不能让一次半写或一次手误，让这一段时间写盘的事件整体不脱敏；一次都没读成功过则与「没配」相同。
 * 失败不动缓存条目：文件一变（stat 指纹不同）下个事件就会重读，半写 / 瞬时 EBUSY 不会被钉成「没有凭据」。
 * 任何情况都不影响事件落盘。
 */
const readSecretsCached = (
  slot: FileSlot,
  fileName: string,
  extract: (parsed: unknown) => RedactionSecret[],
): RedactionSecret[] => {
  const holder = getCacheHolder();
  const file = path.join(dataRoot(), fileName);
  try {
    const st = statSync(file, { bigint: true });
    const hit = holder.files[slot];
    if (
      hit &&
      hit.file === file &&
      hit.ino === st.ino &&
      hit.mtimeNs === st.mtimeNs &&
      hit.ctimeNs === st.ctimeNs &&
      hit.size === st.size
    ) {
      return hit.secrets;
    }
    const secrets = extract(
      JSON.parse(stripBom(readFileSync(file, "utf-8"))) as unknown,
    );
    holder.files[slot] = {
      file,
      ino: st.ino,
      mtimeNs: st.mtimeNs,
      ctimeNs: st.ctimeNs,
      size: st.size,
      secrets,
    };
    return secrets;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      // 文件不存在 = 没配（含用户删了 config.json）：清缓存、空集合
      holder.files[slot] = null;
      return NO_SECRETS;
    }
    // 读不出来 ≠ 没配（半写 / 瞬时 EBUSY / 权限 / 手改坏）：沿用上一次读成功的凭据，缓存条目不动——
    // 文件一变（stat 指纹不同）下个事件就会重读；一次都没读成功过则与「没配」相同。
    // 只沿用**同一个文件**的缓存：数据目录换了（测试 / 多实例）时，别的文件的凭据不能拿来用。
    const prev = holder.files[slot];
    return prev && prev.file === file ? prev.secrets : NO_SECRETS;
  }
};

/** Flowship 注入的 git credential helper 用的 HTTP Basic 用户名（见 team-library.ts 的 INLINE_CREDENTIAL_HELPER） */
const GIT_BASIC_AUTH_USER = "oauth2";

const base64Of = (raw: string): string =>
  Buffer.from(raw, "utf8").toString("base64");

/** 值在 JSON 字符串里的转义形态；与原值相同返回空串（见 `RedactionSecret.escaped`） */
const distinctJsonEscape = (value: string): string => {
  const escaped = JSON.stringify(value).slice(1, -1);
  return escaped === value ? "" : escaped;
};

/**
 * 一个凭据的编码变体取值（可能与原值相同 / 过短，由调用方过滤）：
 * - URL 编码：所有凭据；
 * - HTTP Basic base64：只给 gitToken（占位符判定）——`oauth2:<PAT>` 与 PAT 自身两种。
 */
const encodedVariantValues = (secret: RedactionSecret): string[] => {
  const out: string[] = [];
  try {
    out.push(encodeURIComponent(secret.value));
  } catch {
    // 值里有落单的代理对（畸形 UTF-16）：encodeURIComponent 会抛 URIError，跳过这个变体即可
  }
  if (secret.placeholder === REDACTED_GIT_TOKEN) {
    out.push(
      base64Of(`${GIT_BASIC_AUTH_USER}:${secret.value}`),
      base64Of(secret.value),
    );
  }
  return out;
};

/**
 * 原值集合 → 实际用于替换的集合（原值 + 编码变体，各条预算好 JSON 转义形态）。
 * 变体只在「编码后与原值不同、满足最小长度、且不与任何已有值重复」时加入（重复时原值优先，
 * 占位符不被抢）；整体按长度降序重排，长值先换。纯函数、只在值集合变化时调用一次（结果被缓存）。
 */
const expandWithEncodedVariants = (raw: RedactionSecret[]): RedactionSecret[] => {
  const seen = new Set(raw.map((s) => s.value));
  const variants: RedactionSecret[] = [];
  for (const s of raw) {
    for (const value of encodedVariantValues(s)) {
      if (value.length < MIN_SECRET_LENGTH || seen.has(value)) continue;
      seen.add(value);
      variants.push({ value, placeholder: s.placeholder });
    }
  }
  const all = [...raw, ...variants].map((s) => {
    const escaped = distinctJsonEscape(s.value);
    // escaped 非空时必含反斜杠，再转义一层必然不同（恒非空）；为空（绝大多数凭据）就不用算
    return { ...s, escaped, escapedTwice: escaped === "" ? "" : distinctJsonEscape(escaped) };
  });
  // Array.prototype.sort 稳定：同长度时原值仍在变体前面
  all.sort((a, b) => b.value.length - a.value.length);
  return all;
};

/**
 * 合并各处来源并缓存（原值集合 + 带变体的替换集合一起算、一起失效）。
 * 缓存键 = config / configBackup / configBackupShrink / companyEnv 四份来源数组的引用（文件 stat 没变就是同一个数组）
 * + env 里 PAT 的当前值。
 */
const resolveMerged = (): NonNullable<CacheHolder["merged"]> => {
  const holder = getCacheHolder();
  const config = readSecretsCached("config", "config.json", extractConfigSecrets);
  const configBackup = readSecretsCached(
    "configBackup",
    "config.json.bak",
    extractConfigSecrets,
  );
  const configBackupShrink = readSecretsCached(
    "configBackupShrink",
    "config.json.bak.shrink",
    extractConfigSecrets,
  );
  const companyEnv = readSecretsCached(
    "companyEnv",
    "company-env.json",
    extractCompanyEnvFileSecrets,
  );
  const envToken = process.env[GITLAB_TOKEN_ENV_NAME]?.trim() ?? "";
  const m = holder.merged;
  if (
    m &&
    m.config === config &&
    m.configBackup === configBackup &&
    m.configBackupShrink === configBackupShrink &&
    m.companyEnv === companyEnv &&
    m.envToken === envToken
  ) {
    return m;
  }
  const envSecrets: RedactionSecret[] = [];
  pushSecret(envSecrets, envToken, REDACTED_GIT_TOKEN);
  const seen = new Set<string>();
  const out: RedactionSecret[] = [];
  // 同值先到先得：config > configBackup > configBackupShrink——备份里没轮换的值与当前值相同，占位符以更新的来源为准
  for (const s of [
    ...envSecrets,
    ...config,
    ...configBackup,
    ...configBackupShrink,
    ...companyEnv,
  ]) {
    if (seen.has(s.value)) continue;
    seen.add(s.value);
    out.push(s);
  }
  out.sort((a, b) => b.value.length - a.value.length);
  const merged = {
    config,
    configBackup,
    configBackupShrink,
    companyEnv,
    envToken,
    out,
    expanded: expandWithEncodedVariants(out),
  };
  holder.merged = merged;
  return merged;
};

/**
 * 当前需要脱敏的凭据**原值**集合（config.json + config.json.bak + config.json.bak.shrink + company-env.json + 进程 env 里的 GitLab PAT 合并）。
 * 同值只留一条（先到先得：gitToken > apiKey > companyEnv）；长值在前，
 * 保证「短值恰好是长值子串」时先替换长的、不留半截明文。
 * 实际脱敏用的是 `getEventRedactionReplacements`（原值 + 编码变体）；这里只给「有哪些凭据」。
 *
 * 为什么要把 `process.env.FLOWSHIP_GITLAB_TOKEN` 的**当前值**也算进来：agent `printenv` 看到的是 env 里的值，
 * 而 env 值不一定等于 config.json 的 gitToken——会话启动时 `resolveSessionGitToken` 优先用入口带来的 Token
 * （任务页输入条由前端带、尚未保存进 config.json 的新 Token 也可能走这条），此时 config.json 里是旧值或没有，
 * 只按 config.json 脱敏就会让 `printenv` 输出里的 PAT 原样落进 events.jsonl / 推流。
 * 每次读 env（不缓存值本身，只在缓存键里比对）：同步 env 的调用点随时会改它。
 */
export const getEventRedactionSecrets = (): RedactionSecret[] =>
  resolveMerged().out;

/**
 * 实际用于替换 / 命中检测的集合 = 原值 + 编码变体（URL 编码、gitToken 的 Basic base64，见头注释）。
 * 与 `getEventRedactionSecrets` 同一份缓存、同时失效：凭据没变时每次调用都返回**同一个数组引用**，
 * 事件热路径（`serializeEventLineRedacted` / `task-stream.publish`）上不重复编码、不重复排序。
 */
export const getEventRedactionReplacements = (): RedactionSecret[] =>
  resolveMerged().expanded;

/**
 * 序列化后的事件行里是否含任一凭据。
 * 查三种形态（凭据含引号 / 反斜杠 / 控制字符时才有后两种，其余凭据只是一次 includes）：
 *   - 原值（凭据在字符串值里原样出现，行里没有需要转义的字符时）；
 *   - JSON 转义形态（原值进事件行被转义一层）；
 *   - 转义形态再转义一层（agent `cat` 出来的 JSON 文本——里面的口令已是转义形态——作为字符串值进事件行又被转义一层）。
 */
export const lineContainsSecret = (
  line: string,
  secrets: RedactionSecret[],
): boolean =>
  secrets.some(({ value, escaped, escapedTwice }) => {
    if (line.includes(value)) return true;
    const esc = escaped ?? distinctJsonEscape(value);
    if (esc === "") return false;
    if (line.includes(esc)) return true;
    const twice = escapedTwice ?? distinctJsonEscape(esc);
    return twice !== "" && line.includes(twice);
  });

const replaceSecrets = (text: string, secrets: RedactionSecret[]): string => {
  let out = text;
  for (const { value, placeholder, escaped } of secrets) {
    // 先换转义形态再换原值：转义形态比原值长且含反斜杠，先换原值有可能把它啃出半截（`\n` 前面多一个 `\` 之类）。
    // 这里处理的是「字符串值里出现的转义形态」——`cat company-env.json` 的输出里口令就是这个样子，
    // 只换原值会让含 `"` / `\` / 制表符的口令原样落盘（见 RedactionSecret.escaped）。
    const esc = escaped ?? distinctJsonEscape(value);
    if (esc !== "" && out.includes(esc)) out = out.split(esc).join(placeholder);
    if (out.includes(value)) out = out.split(value).join(placeholder);
  }
  return out;
};

/**
 * 原地把事件对象里所有字符串值中的凭据替换成占位符（递归对象 / 数组）。
 * 原地改是有意的：同一个事件对象随后会被 publish，让 SSE / 飞书看到的也是脱敏版。
 * 只处理 value，不处理 key（key 是事件结构字段名，不会是凭据）。
 */
export const redactSecretsInPlace = (
  value: unknown,
  secrets: RedactionSecret[],
  depth = 0,
): void => {
  if (!value || typeof value !== "object" || depth > MAX_WALK_DEPTH) return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const item = value[i] as unknown;
      if (typeof item === "string") value[i] = replaceSecrets(item, secrets);
      else redactSecretsInPlace(item, secrets, depth + 1);
    }
    return;
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const item = obj[key];
    if (typeof item === "string") obj[key] = replaceSecrets(item, secrets);
    else redactSecretsInPlace(item, secrets, depth + 1);
  }
};

/**
 * 事件落盘入口用：返回最终要写入的一行 JSON（不含换行）。
 * 命中凭据 → 原地脱敏事件对象后重新序列化；没命中 → 零额外开销（复用首次序列化）。
 */
export const serializeEventLineRedacted = (ev: unknown): string => {
  const line = JSON.stringify(ev);
  const secrets = getEventRedactionReplacements();
  if (secrets.length === 0 || !lineContainsSecret(line, secrets)) return line;
  redactSecretsInPlace(ev, secrets);
  return JSON.stringify(ev);
};

/**
 * 纯文本脱敏（流式增量 / 累积文本用）：没配凭据或没命中 → 原样返回同一个字符串，零拷贝。
 * 热路径成本 = 两次 stat（缓存命中时）+ 每个凭据（含编码变体）一次 includes。
 */
export const redactSecretsInText = (text: string): string => {
  if (!text) return text;
  const secrets = getEventRedactionReplacements();
  return secrets.length === 0 ? text : replaceSecrets(text, secrets);
};

/**
 * 不可原地改的对象（已经 publish 给别人、或调用方还要留着原值）用：
 * 命中凭据才深拷贝并脱敏返回新对象，没命中返回**原对象本身**（零拷贝）。
 * value 必须是可 JSON 序列化的树（事件 / 推流帧都是）；序列化失败 → 原样返回（不阻断推流）。
 */
export const redactCopyIfHit = <T>(value: T): T => {
  const secrets = getEventRedactionReplacements();
  if (secrets.length === 0) return value;
  let line: string;
  try {
    line = JSON.stringify(value);
  } catch {
    return value;
  }
  if (typeof line !== "string" || !lineContainsSecret(line, secrets)) return value;
  const clone = JSON.parse(line) as T;
  redactSecretsInPlace(clone, secrets);
  return clone;
};
