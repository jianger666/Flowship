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
 * 方案（几个入口，值集合共用）：
 *   1. 落盘：所有事件行都经 `task-fs-core.appendEventLine` 落盘——在那里把当前凭据的**精确值**
 *      替换成占位符（原地改事件对象，之后 publish 的也是脱敏版）。
 *   2. 实时推流：`tool_output_delta` / `assistant_delta` / `thinking_delta` 等增量帧不落盘（或延迟
 *      合并后才落盘），不经 appendEventLine——在 `task-stream.publish`（SSE 与飞书回流的唯一
 *      扇出点）推送前对其文本字段脱敏（命中才拷贝改写，未命中零额外开销）。
 *   3. 工具输出全文文件（`tasks/<id>/tool-outputs/<callId>.txt`，UI「加载完整输出」读的那份）：
 *      事件里的 tool_result 只带预览、走第 1 条；全文是另一份文件，不经 appendEventLine，要单独守三道
 *      （实现都在 `tool-result-persist.ts` 与 `GET /api/tasks/[id]/tool-output/[callId]`）：
 *      - 写时：`redactToolOutputText`（对本模块 `redactSecretsInText` 的包装）后再写，文件 0600 / 目录 0700。
 *        fail-closed：脱敏本身抛错 → 不落盘、输出换成「脱敏失败」提示，绝不回退写明文；
 *        输入上限 `TOOL_OUTPUT_REDACT_MAX_CHARS`（16M 字符）——超过的只留头尾各半、各自脱敏，中间换截断提示
 *        （窗口边缘各削掉一条最长凭据的长度，防凭据被窗口切断留半截），任何路径都不输出未脱敏原文。
 *      - 读时：GET 读出文件后再脱敏一遍（覆盖「凭据是写文件之后才配的」「旧版明文」）；脱敏抛错 → 500、不回明文。
 *      - 旧文件迁移：boot recovery 末尾后台一次性把旧版明文就地脱敏（`migrateLegacyToolOutputs`；
 *        每个任务的 `tool-outputs/.redacted-v1` 标记记录当时的凭据条数，条数没增加就不再扫；有预算、
 *        失败吞掉、没配凭据时整个不跑）。
 *   4. 其它外流点（诊断包、飞书出站 / 群消息、子代理过程记录与后台子代理清单、shell 实时输出桥、
 *      累积型快照、排队消息摘要等）各自在出口直接调 `redactSecretsInText` / `redactCopyIfHit`，
 *      不走上面三条；新增外流点请照这个口径补。
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
 *   - 已落盘的老 `events.jsonl` 仍是明文，不做迁移（`tool-outputs/*.txt` 是例外：上面第 3 条有启动期一次性迁移，
 *     因为那份存的是工具输出的整段原文、体量和泄漏面都比事件预览大）。迁移自身的局限：单个超过 64MB 的旧文件跳过
 *     （读时脱敏仍兜住 GET）；只认迁移时已配置的凭据——之前轮换掉、已不在 config 里的旧凭据抹不掉。
 *   - 配了凭据时，超过 `TOOL_OUTPUT_REDACT_MAX_CHARS` 的单条工具输出落盘版只剩头尾（中间被截断提示替换）；
 *     这是为了让脱敏耗时有上界，换来的代价是超大输出的中段在「加载完整输出」里看不到。
 *   - 增量流里 token 被切在两个相邻增量帧时，单帧内无法精确匹配（实现「保留末尾 len-1 字符」的
 *     小缓冲要改动各流的收尾 / lease 失主 / 重连快照语义，不够便宜安全）。缓解：累积型消费者
 *     （thinking 快照、飞书 p2p 卡片正文、群回复正文）对**累积文本**再脱敏一次，能抓到跨帧的
 *     完整 token；落盘版（assistant_message / tool_result 整段）也是整段匹配。SSE 浏览器端只会
 *     短暂看到被切开的半截 token，之后落盘版替换为占位符。
 *   - 其它 settings 字段语义不明（env 里常是 `production` 这类普通值），不纳入。注意 `mcpServers` 的
 *     headers / env 里**键名像凭据**的值、以及落盘的 MCP OAuth token 现在**已纳入**（`[REDACTED:mcpSecret]`，
 *     见下方「MCP server 凭据」一节；键名不像凭据的、长度 < 8 的、`$VAR` 引用不收）。`~/.cursor/mcp.json`
 *     （Cursor 自己的文件，运行时不读它，但 agent 照样能 `cat` 到）的 `mcpServers` 也按同一口径**只读**纳入
 *     （第七轮；候选目录与能力页「从 Cursor 导入」同源，见 cursor-dirs.ts）。
 *   - 进程 env 里**除 FLOWSHIP_GITLAB_TOKEN 外**的敏感变量不覆盖：Flowship 自己只往 process.env 注入这一个凭据，
 *     其余（用户启动环境里自带的 `*_TOKEN` / `*_API_KEY` / `AWS_*` 等）来源与语义不可枚举，按变量名猜
 *     （如含 token / secret / password）既会漏、也会误伤普通值（如 `*_TOKEN_URL` 这类放的是地址的变量），
 *     属产品口径决策，不在这里悄悄做。
 *   - agent 本轮上下文 / SDK 自己的会话存储里凭据仍是明文（SDK 内部存储、不在本仓控制范围）；
 *     gitToken 已改 env 注入（命令里只有变量名、不出现值——除非 agent 违规 echo 它）；
 *     apiKey / 公司环境密码仍靠 agent 读文件取，这部分根治同样要改成 env / credential helper 注入。
 *
 * 依赖方向：只依赖 data-root（及 git-token-env 里的一个常量，该模块对本模块无运行时依赖），
 * 不 import task-fs-core / task-stream / tool-result-persist（它们都引用本模块，避免环）。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { getGlobalCursorDirs } from "./cursor-dirs";
import { dataRoot, stripBom } from "./data-root";
// 只取常量：git-token-env 对 settings-fs 只有 type import（编译期擦除），没有运行时依赖，不会成环
import { GITLAB_TOKEN_ENV_NAME } from "./git-token-env";

/** 脱敏占位符（保留是哪类凭据，方便排查「这里原本有个凭据」） */
export const REDACTED_GIT_TOKEN = "[REDACTED:gitToken]";
export const REDACTED_API_KEY = "[REDACTED:apiKey]";
export const REDACTED_COMPANY_ENV = "[REDACTED:companyEnv]";
/** MCP server 的凭据：settings.mcpServers 的 headers / env 里凭据类字段的值 + 落盘的 MCP OAuth token */
export const REDACTED_MCP_SECRET = "[REDACTED:mcpSecret]";

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
type FileSlot =
  | "config"
  | "configBackup"
  | "configBackupShrink"
  | "companyEnv"
  /** `<dataRoot>/mcp-oauth/` 目录（每个 server 一个 json）：按**目录** stat 失效，见 `readMcpOAuthSecretsCached` */
  | "mcpOAuth"
  /**
   * Cursor 全局 `mcp.json`（`getGlobalCursorDirs()` 的第 0 / 1 个候选目录各一个槽；win32 才会有第 2 个候选）。
   * 与 cursor-config 取「第一个能读到的」不同，脱敏**每个候选都收**：宁可多遮、不能漏。
   */
  | "cursorMcp0"
  | "cursorMcp1";

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
    mcpOAuth: RedactionSecret[];
    cursorMcp0: RedactionSecret[];
    cursorMcp1: RedactionSecret[];
    /** 合并时 `FLOWSHIP_GITLAB_TOKEN` 的值：env 变了（会话启动 / 设置保存会改它）就要重算 */
    envToken: string;
    /** 原值集合（去重、长值优先） */
    out: RedactionSecret[];
    /** 原值 + 编码变体（真正用于替换的集合；与 out 同时失效 / 重算，所以变体跟随缓存） */
    expanded: RedactionSecret[];
  } | null;
};

// 缓存挂 globalThis：Next dev 多 chunk 下模块级变量不共享（同 task-fs-core 踩过的坑）
// V3：merged 里新增 expanded（编码变体）；V4：新增 configBackup 槽；V5：新增 configBackupShrink 槽；V6：新增 mcpOAuth 槽；V7：新增 cursorMcp0 / cursorMcp1 槽。
// 旧形状的缓存对象（dev HMR 残留）不能再复用——缺新槽 / 新字段会让 merged 的引用比对永远不等、或读到 undefined
const CACHE_KEY = "__flowshipEventRedactSecretCacheV7__";
const getCacheHolder = (): CacheHolder => {
  const g = globalThis as unknown as Record<string, CacheHolder | undefined>;
  if (!g[CACHE_KEY]) {
    g[CACHE_KEY] = {
      files: {
        config: null,
        configBackup: null,
        configBackupShrink: null,
        companyEnv: null,
        mcpOAuth: null,
        cursorMcp0: null,
        cursorMcp1: null,
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

/**
 * MCP server 凭据（headers / env / 顶层 url）。只纳入**键名像凭据**的值，不是整个 headers / env 一锅端（env 里常是 `production` / `true` 这类普通值，
 * `Content-Type: application/json` 之类的头也 ≥ 8 位，整锅端会满屏误码）：
 *   - 键名含 password / passwd / pwd / secret / token / api-key / access-key / private-key / credential /
 *     authorization / cookie / bearer / signature，或独立的 `auth` / `key` / `dsn` / `jwt` / `sig` 词
 *     （`X-Auth`、`MY_AUTH_KEY`、`MAPS_KEY`、`SENTRY_DSN`、URL 里的 `?sig=`），或以 `session` 开头的词
 *     （`X-Session` / `SESSION_ID` / `sessionId`），或驼峰词尾（`appKey` / `userSession` / `userJwt`）；
 *   - 键名以 url / uri / endpoint / host / path / file / dir / name / type / expires / ttl 结尾的**整串不收**
 *     （`TOKEN_URL` / `API_KEY_FILE` 放的是地址 / 路径，不是秘密本身）；
 *   - 值是环境变量引用（`$FOO` / `${FOO}` / `${env:FOO}` / `{{ FOO }}` / `%FOO%`）的不收——那不是明文；
 *     `Bearer ${TOKEN}` 这类「认证方案 + 引用」同理整条不收（字面量 `${TOKEN}` 不是秘密，收了会把它打印的地方全涂掉）；
 *   - 长度 < MIN_SECRET_LENGTH 的不收（pushSecret 统一把关：`true` / `1` / 短串不会被当密钥）。
 * `Authorization: Bearer <令牌>` 这类带认证方案前缀的头，整串与令牌本身各收一条（agent 打印时两种写法都可能出现）。
 *
 * `args` 数组（stdio server 的命令行参数）：URL 形态参数里的 userinfo 密码 / 凭据名 query 参数、凭据名旗标的值（`--api-key xxx` /
 * `--token=xxx`）、`KEY=VALUE`、`--header "Name: value"`，细则见 {@link collectMcpArgSecrets}；query 参数名额外认裸 `sign`。
 *
 * **URL 形态的值**（不论键名，含 `DATABASE_URL` 这类被 `*_URL` 豁免的键、以及 server 顶层 `url`）：不收整条 URL（它多半只是地址），
 * 只抽 ① userinfo 里的**密码**段（`postgres://user:<密码>@host`）；② 凭据名 query 参数的**值**（`?token=` / `?api_key=` / `?sig=` …，
 * 判定与键名同一口径）。密码 / 参数值是 `$FOO` 之类引用的不收；解码前后的写法各收一条。
 */
const MCP_CREDENTIAL_KEY_RE =
  /(password|passwd|pwd|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|credential|authorization|cookie|bearer|signature|(?:^|[-_.])(?:auth|key|dsn|jwt|sig)(?:$|[-_.])|(?:^|[-_.])session)/i;
/** 驼峰词尾：`appKey` / `sessionId` / `userJwt`（上面那条带 i 标志，吃不到大小写边界，单列且大小写敏感） */
const MCP_CREDENTIAL_CAMEL_KEY_RE = /[a-z0-9](?:Key|Session|Dsn|Jwt)(?:$|[A-Z_.-])/;
const MCP_NON_SECRET_KEY_SUFFIX_RE =
  /(?:url|uri|endpoint|host|path|file|dir|name|type|expires?|ttl|timeout|interval|method|mode)$/i;
const ENV_REFERENCE_VALUE_RE =
  /^(?:\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|\{\{[^{}]*\}\}|%[A-Za-z_][A-Za-z0-9_]*%)$/;
const AUTH_SCHEME_PREFIX_RE = /^(?:Bearer|Basic|Token|Digest)\s+(.+)$/i;
const URL_VALUE_RE = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i;

const isMcpCredentialKey = (key: string): boolean =>
  (MCP_CREDENTIAL_KEY_RE.test(key) || MCP_CREDENTIAL_CAMEL_KEY_RE.test(key)) &&
  !MCP_NON_SECRET_KEY_SUFFIX_RE.test(key);

const safeDecodeURIComponent = (v: string): string => {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
};

/** 引用占位（含 URL 里被百分号编码的 `%24%7BFOO%7D`）→ 不是明文 */
const isEnvReference = (v: string): boolean =>
  ENV_REFERENCE_VALUE_RE.test(v.trim()) || ENV_REFERENCE_VALUE_RE.test(safeDecodeURIComponent(v).trim());

/** query 参数名：键名规则 + 裸 `sign`（`?sign=` / `?Sign=` / `?SIGN=` 是常见的签名参数；`signature` / `sig` 键名规则已含） */
const isMcpQueryCredentialKey = (key: string): boolean =>
  isMcpCredentialKey(key) || /^sign$/i.test(key);

/** userinfo 里「密码」位置常见的占位字面量（真正的令牌放在用户名位置） */
const USERINFO_PLACEHOLDER_PASSWORDS: ReadonlySet<string> = new Set([
  "x-oauth-basic",
  "x-access-token",
  "x-token-auth",
  "oauth2",
  "x",
]);

const pushUrlPart = (out: RedactionSecret[], raw: string): void => {
  if (!raw || isEnvReference(raw)) return;
  pushSecret(out, raw, REDACTED_MCP_SECRET);
  const decoded = safeDecodeURIComponent(raw);
  if (decoded !== raw) pushSecret(out, decoded, REDACTED_MCP_SECRET);
};

/** URL 形态的值：只抽 userinfo 密码 + 凭据名 query 参数的值，绝不整条收 */
const pushUrlCredentials = (out: RedactionSecret[], raw: string): void => {
  const value = raw.trim();
  if (!URL_VALUE_RE.test(value)) return;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return;
  }
  pushUrlPart(out, url.password);
  // `https://<令牌>@host/…`（GitHub / GitLab 的 PAT 常这么写）：没有密码段时 userinfo 里唯一的那段可能就是凭据。
  // 有密码时用户名只是账号名（`postgres://app_user:<密码>@h`）；没有密码但用户名像账号名（`ssh://deploy_user@h`）也不收：
  // 只收「≥ 16 位、字母数字混合」的（PAT / API key 的形态），避免把 `deploy_user` 之类到处涂掉。
  // 密码段是约定俗成的占位字面量时（`https://<PAT>:x-oauth-basic@github.com`、`oauth2` / `x-access-token` / `x`），令牌同样在用户名位置。
  if (
    (!url.password || USERINFO_PLACEHOLDER_PASSWORDS.has(url.password.toLowerCase())) &&
    /^[\w.~%-]{16,}$/.test(url.username) &&
    /\d/.test(url.username) &&
    /[A-Za-z]/.test(url.username)
  ) {
    pushUrlPart(out, url.username);
  }
  const q = value.indexOf("?");
  if (q < 0) return;
  const hash = value.indexOf("#", q);
  const query = value.slice(q + 1, hash >= 0 ? hash : undefined);
  for (const part of query.split("&")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    if (!isMcpQueryCredentialKey(safeDecodeURIComponent(part.slice(0, eq)))) continue;
    pushUrlPart(out, part.slice(eq + 1));
  }
};

const pushMcpKeyedValue = (
  out: RedactionSecret[],
  key: string,
  raw: unknown,
): void => {
  if (typeof raw !== "string") return;
  const value = raw.trim();
  if (!value) return;
  // URL 形态的值不论键名都抽凭据（`DATABASE_URL` 这类被键名后缀豁免的也要抽）
  pushUrlCredentials(out, value);
  if (!isMcpCredentialKey(key)) return;
  if (ENV_REFERENCE_VALUE_RE.test(value)) return;
  const scheme = AUTH_SCHEME_PREFIX_RE.exec(value);
  // `Bearer ${TOKEN}` / `Basic %TOKEN%`：方案 + 引用，不是明文，整条不收
  if (scheme && ENV_REFERENCE_VALUE_RE.test(scheme[1].trim())) return;
  pushSecret(out, value, REDACTED_MCP_SECRET);
  if (scheme) pushSecret(out, scheme[1], REDACTED_MCP_SECRET);
};

/** args 数组最多看多少项 / 单项最多多长（超了整项跳过）：配置里的 args 通常几项、几十字节，封顶只是防畸形输入拖慢 */
const MCP_ARGS_MAX_COUNT = 256;
const MCP_ARGS_MAX_LENGTH = 64 * 1024;
/** 旗标形态：`-v` / `--token` / `--token=abc`（用来判断「裸旗标后面跟的是值还是另一个旗标」） */
const MCP_FLAG_LIKE_RE = /^--?[A-Za-z][\w-]*(?:=|$)/;
/** 带 `Name: value` 形态值的旗标（mcp-remote 的 `--header "Authorization: Bearer …"`、curl 风格 `-H`） */
const MCP_HEADER_FLAG_RE = /^(?:--[Hh]eaders?|-H)$/;
/** 值是 `KEY=VALUE` 的环境变量旗标（`--env=API_TOKEN=xxx`、`--env-var=…`；空格分隔的 `--env KEY=VAL` 下一项本来就是 KEY=VALUE，走通用分支） */
const MCP_ENV_FLAG_RE = /^(?:env|environment|env-var|set-env)$/i;
/** curl 风格的 basic auth 旗标，值是 `user:password`（只收冒号之后的密码段，没有冒号的是账号名，不收） */
const MCP_BASIC_AUTH_FLAG_RE = /^(?:-u|--user|--proxy-user)$/;

const pushMcpBasicAuth = (out: RedactionSecret[], raw: string): void => {
  const value = stripMcpQuotes(raw.trim());
  const i = value.indexOf(":");
  if (i < 0) return;
  const password = value.slice(i + 1);
  if (!password || ENV_REFERENCE_VALUE_RE.test(password.trim())) return;
  pushSecret(out, password, REDACTED_MCP_SECRET);
};

/** 单趟、线性的「像 shell 那样」切词：空白分隔，引号内的空白不切；引号本身保留（交给 stripMcpQuotes） */
const splitMcpArgTokens = (text: string): string[] => {
  const tokens: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      if (cur) tokens.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur) tokens.push(cur);
  return tokens;
};

/** 去掉整个 token 外层的一对引号，以及 `--flag="value"` 里值外层的引号 */
const stripMcpQuotes = (v: string): string =>
  v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0] ? v.slice(1, -1) : v;

const pushMcpHeaderPair = (out: RedactionSecret[], raw: string): void => {
  const m = /^([^:=\s]+)\s*[:=]\s*(.*)$/s.exec(raw.trim());
  if (m) pushMcpKeyedValue(out, m[1]!, m[2]!.trim());
};

/**
 * `mcpServers.<x>.args`：命令行参数里的凭据。只认三种形态（都不整条收，避免误伤普通参数）：
 * - URL 形态的 token（`server-postgres postgresql://u:p@h/db` 里的 `postgresql://…`）：userinfo 密码 + 凭据名 query 参数；
 * - 凭据名旗标的值：`--api-key xxx`（下一项）/ `--token=xxx`（`=` 之后）/ `--password "a b"`；旗标名按 headers / env 同一套键名规则判定
 *   （`--key-file` / `--keyboard-layout` / `--token-url` 这类路径 / 非凭据不收），值是 `$VAR` / `${VAR}` / `%VAR%` 引用的不收，
 *   值长得像另一个旗标（`--token --verbose`）说明这个旗标没带值，不收；
 * - `KEY=VALUE`（`-e API_TOKEN=xxx` / `DATABASE_URL=postgres://u:p@h/db`）：按键名规则同上；
 * - `--header` / `-H` 的下一项 `Name: value`（mcp-remote 常用）：按 header 键名规则；
 * - `-u` / `--user` / `--proxy-user`（curl 风格，仅当命令 / 参数里有 curl、wget 等才认，docker 的 `-u user:group` 不是密码）的 `user:password`：只收冒号后的密码段；
 *   `--env=KEY=VALUE`：按 KEY 判定；
 * - URL userinfo 只有一段（`https://<令牌>@host`，没有密码）：这一段就是凭据，收。
 * 单项里带空白的（`["-c", "npx srv --token abc"]`）按引号感知切词后同样处理。单趟扫描、有数量 / 长度封顶，线性。
 */
const collectMcpArgSecrets = (args: unknown, out: RedactionSecret[], opts: { basicAuth?: boolean } = {}): void => {
  if (!Array.isArray(args)) return;
  const basicAuth = opts.basicAuth === true;
  let pendingKey: string | null = null; // 上一个 token 是凭据名裸旗标 → 本 token 是它的值
  let pendingHeader = false; // 上一个 token 是 --header / -H → 本 token 是 `Name: value`
  let pendingBasic = false; // 上一个 token 是 -u / --user / --proxy-user → 本 token 是 `user:password`
  const handle = (rawToken: string): void => {
    const t = stripMcpQuotes(rawToken);
    if (pendingHeader) {
      pendingHeader = false;
      pushMcpHeaderPair(out, t);
      return;
    }
    if (pendingBasic) {
      pendingBasic = false;
      if (!MCP_FLAG_LIKE_RE.test(t)) {
        pushMcpBasicAuth(out, t);
        return;
      }
    }
    if (pendingKey !== null) {
      const key = pendingKey;
      pendingKey = null;
      if (!MCP_FLAG_LIKE_RE.test(t)) {
        pushMcpKeyedValue(out, key, t);
        return;
      }
    }
    if (MCP_HEADER_FLAG_RE.test(t)) {
      pendingHeader = true;
      return;
    }
    if (basicAuth && MCP_BASIC_AUTH_FLAG_RE.test(t)) {
      pendingBasic = true;
      return;
    }
    const eq = t.indexOf("=");
    if (t.startsWith("-")) {
      const name = t.replace(/^-+/, "");
      if (eq > 0) {
        // --flag=value：value 外层可能还带引号（--token="abc"）
        const flag = t.slice(0, eq);
        const value = stripMcpQuotes(t.slice(eq + 1));
        const flagName = flag.replace(/^-+/, "");
        const valueEq = value.indexOf("=");
        if (MCP_HEADER_FLAG_RE.test(flag)) pushMcpHeaderPair(out, value);
        else if (basicAuth && MCP_BASIC_AUTH_FLAG_RE.test(flag)) pushMcpBasicAuth(out, value);
        else if (MCP_ENV_FLAG_RE.test(flagName) && valueEq > 0) {
          // `--env=API_TOKEN=xxx`：值本身是 KEY=VALUE，按键名规则判定
          pushMcpKeyedValue(out, value.slice(0, valueEq), stripMcpQuotes(value.slice(valueEq + 1)));
        } else pushMcpKeyedValue(out, flagName, value);
      } else if (name && isMcpCredentialKey(name)) {
        pendingKey = name;
      }
      return;
    }
    if (URL_VALUE_RE.test(t)) {
      pushUrlCredentials(out, t);
      return;
    }
    if (eq > 0) pushMcpKeyedValue(out, t.slice(0, eq), stripMcpQuotes(t.slice(eq + 1)));
  };
  let count = 0;
  for (const item of args) {
    if (++count > MCP_ARGS_MAX_COUNT) break;
    if (typeof item !== "string" || item.length > MCP_ARGS_MAX_LENGTH) {
      pendingKey = null;
      pendingHeader = false;
      pendingBasic = false;
      continue;
    }
    const text = item.trim();
    if (!text) continue;
    // `--header` 的下一项整条就是 `Name: value`（含空白），不能先切词
    if (pendingHeader) {
      pendingHeader = false;
      pushMcpHeaderPair(out, stripMcpQuotes(text));
      continue;
    }
    // 凭据名裸旗标的下一项整条就是它的值（数组形态里值可以含空白：`["--password", "a b c"]`），也不切词
    if (pendingKey !== null) {
      const key = pendingKey;
      pendingKey = null;
      if (!MCP_FLAG_LIKE_RE.test(text)) {
        pushMcpKeyedValue(out, key, stripMcpQuotes(text));
        continue;
      }
    }
    if (!/\s/.test(text)) {
      handle(text);
      continue;
    }
    // 带空白的一项：数组形态的整项 `--flag=带 空白 的值` 先按整项收一次，再按 shell 字符串（`["-c", "npx srv --token abc"]`）切词收一遍
    const eq = text.indexOf("=");
    if (text.startsWith("-") && eq > 0 && !/\s/.test(text.slice(0, eq))) handle(text);
    for (const tok of splitMcpArgTokens(text)) handle(tok);
  }
};

/**
 * `-u` / `--user` 在 curl / wget / httpie 里是 `user:password`，在 docker 里是 `user:group`（`-u appuser:appgroup`）。
 * 只有命令本身是 curl 类、或参数里出现 `curl` / `wget`（`sh -c "curl -u …"`）才按 basic auth 收，免得把组名当密码到处涂掉。
 */
const isCurlLikeMcpServer = (cfg: Record<string, unknown>): boolean => {
  if (typeof cfg.command === "string" && /(?:^|[\\/])(?:curl|wget|http|https|xh)(?:\.exe)?$/i.test(cfg.command.trim())) {
    return true;
  }
  return (
    Array.isArray(cfg.args) &&
    cfg.args.some((a) => typeof a === "string" && a.length <= MCP_ARGS_MAX_LENGTH && /\b(?:curl|wget)\b/.test(a))
  );
};

/** `settings.mcpServers`：`{ <name>: { url?: string, args?: string[], headers?: Record, env?: Record, … } }`；形状不对的静默跳过 */
const collectMcpServerSecrets = (servers: unknown, out: RedactionSecret[]): void => {
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return;
  for (const server of Object.values(servers as Record<string, unknown>)) {
    if (!server || typeof server !== "object") continue;
    const cfg = server as Record<string, unknown>;
    // http / sse 型 server 的地址本身可能带 `?token=` / userinfo
    if (typeof cfg.url === "string") pushUrlCredentials(out, cfg.url);
    collectMcpArgSecrets(cfg.args, out, { basicAuth: isCurlLikeMcpServer(cfg) });
    for (const field of ["headers", "env"] as const) {
      const bag = cfg[field];
      if (!bag || typeof bag !== "object" || Array.isArray(bag)) continue;
      for (const [key, val] of Object.entries(bag as Record<string, unknown>)) {
        pushMcpKeyedValue(out, key, val);
      }
    }
  }
};

/**
 * 落盘的 MCP OAuth 记录（`<dataRoot>/mcp-oauth/<sha256>.json`，见 mcp-oauth.ts 的 OAuthRecord）里的凭据：
 * `tokens.access_token` / `refresh_token` / `id_token` 与 DCR 的 `client.client_secret`。
 * 不 import mcp-oauth（本模块依赖方向受限，见文件头），按落盘形状读。
 */
const extractMcpOAuthRecordSecrets = (parsed: unknown): RedactionSecret[] => {
  const out: RedactionSecret[] = [];
  if (!parsed || typeof parsed !== "object") return out;
  const rec = parsed as Record<string, unknown>;
  const tokens = rec.tokens;
  if (tokens && typeof tokens === "object") {
    const t = tokens as Record<string, unknown>;
    pushSecret(out, t.access_token, REDACTED_MCP_SECRET);
    pushSecret(out, t.refresh_token, REDACTED_MCP_SECRET);
    pushSecret(out, t.id_token, REDACTED_MCP_SECRET);
  }
  const client = rec.client;
  if (client && typeof client === "object") {
    pushSecret(out, (client as Record<string, unknown>).client_secret, REDACTED_MCP_SECRET);
  }
  return out;
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
  collectMcpServerSecrets(cfg.mcpServers, out);
  return out;
};

/** Cursor 全局 `mcp.json`：根对象 `{ mcpServers: { … } }`，口径与 settings.mcpServers 完全一致 */
const extractCursorMcpFileSecrets = (parsed: unknown): RedactionSecret[] => {
  const out: RedactionSecret[] = [];
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  collectMcpServerSecrets((parsed as Record<string, unknown>).mcpServers, out);
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
  const file = path.join(dataRoot(), fileName);
  return readSecretsCachedAt(slot, file, () =>
    extract(JSON.parse(stripBom(readFileSync(file, "utf-8"))) as unknown),
  );
};

/**
 * `readSecretsCached` 的通用内核：按 `file`（文件或目录）的 stat 指纹缓存 `load()` 的结果。
 * `load` 抛错的处理同上（ENOENT = 没配；其它 = 沿用上一次读成功的值、不动缓存条目）。
 */
const readSecretsCachedAt = (
  slot: FileSlot,
  file: string,
  load: () => RedactionSecret[],
): RedactionSecret[] => {
  const holder = getCacheHolder();
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
    const secrets = load();
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

/**
 * `<dataRoot>/mcp-oauth/*.json` 里的 token（目录里每个 server 一个文件）。缓存按**目录** stat 失效：
 * 记录文件是 tmp + rename 原子写（mcp-oauth.ts 的 writePrivateFileAtomic），任何新建 / 续期 / 清除都会改目录的
 * mtime / ctime，所以热路径只多一次 stat；目录没变就复用上次的值集合（同一个数组引用，`resolveMerged` 靠引用比对）。
 * 单个文件 JSON 损坏 → 跳过该文件（不抛，免得坏文件让每个事件都重读整个目录）；读文件抛 ENOENT 以外的错（半写 / EBUSY / 权限）
 * → 整体抛出，由 `readSecretsCachedAt` 沿用上一次的值、不动缓存，下次再试。
 */
const readMcpOAuthSecretsCached = (): RedactionSecret[] => {
  const dir = path.join(dataRoot(), "mcp-oauth");
  return readSecretsCachedAt("mcpOAuth", dir, () => {
    const out: RedactionSecret[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      let text: string;
      try {
        text = readFileSync(path.join(dir, name), "utf-8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") continue; // 读目录之后被删了
        throw err;
      }
      try {
        out.push(...extractMcpOAuthRecordSecrets(JSON.parse(stripBom(text)) as unknown));
      } catch {
        // 坏 JSON：跳过这一个文件
      }
    }
    return out;
  });
};

/** Cursor 全局 `mcp.json` 的体积上限：真实文件是几 KB；超过它多半不是配置文件，不读、不解析（沿用上一次的值） */
const CURSOR_MCP_JSON_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Cursor 全局 `mcp.json` 里的 MCP 凭据（只读；缓存按文件 stat 失效，热路径每槽只多一次 stat）。
 * `index` = 候选目录下标：该下标没有候选（非 win32 只有 1 个）→ 清槽、返回空集合。
 * 文件不存在 / 读不出来的处理同 `readSecretsCachedAt`（ENOENT = 没配；其它沿用上次读成功的值）。
 */
const readCursorMcpSecretsCached = (index: 0 | 1): RedactionSecret[] => {
  const slot: FileSlot = index === 0 ? "cursorMcp0" : "cursorMcp1";
  const holder = getCacheHolder();
  const dir = getGlobalCursorDirs()[index];
  if (!dir) {
    holder.files[slot] = null;
    return NO_SECRETS;
  }
  const file = path.join(dir, "mcp.json");
  // 上一次读成功的值（同一个文件才算）：坏文件 / 超大文件沿用它——并且**记下这次的 stat 指纹**，文件不再变就不再读
  const prev = holder.files[slot];
  const prevSecrets = prev && prev.file === file ? prev.secrets : NO_SECRETS;
  return readSecretsCachedAt(slot, file, () => {
    // 这是 Cursor 自己的文件（不是我们 tmp+rename 原子写的）：可能半写、可能被手改坏、可能被塞进超大文件。
    // 不能让它每个事件帧都 read + parse 一遍（config.json 系的「读不出来就不记指纹」是因为它们是原子写、坏文件罕见）。
    if (statSync(file).size > CURSOR_MCP_JSON_MAX_BYTES) return prevSecrets;
    const text = stripBom(readFileSync(file, "utf-8"));
    try {
      return extractCursorMcpFileSecrets(JSON.parse(text) as unknown);
    } catch (err) {
      if (err instanceof SyntaxError) return prevSecrets; // 坏 JSON：记指纹、沿用上次的值；文件一变（含写完整）就会重读
      throw err; // 其它（EBUSY / 权限）：交给 readSecretsCachedAt 的通用处理，不记指纹、下次再试
    }
  });
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
 * 缓存键 = config / configBackup / configBackupShrink / companyEnv / mcpOAuth / cursorMcp0 / cursorMcp1 七份来源数组的引用（文件 stat 没变就是同一个数组）
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
  const mcpOAuth = readMcpOAuthSecretsCached();
  const cursorMcp0 = readCursorMcpSecretsCached(0);
  const cursorMcp1 = readCursorMcpSecretsCached(1);
  const envToken = process.env[GITLAB_TOKEN_ENV_NAME]?.trim() ?? "";
  const m = holder.merged;
  if (
    m &&
    m.config === config &&
    m.configBackup === configBackup &&
    m.configBackupShrink === configBackupShrink &&
    m.companyEnv === companyEnv &&
    m.mcpOAuth === mcpOAuth &&
    m.cursorMcp0 === cursorMcp0 &&
    m.cursorMcp1 === cursorMcp1 &&
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
    ...mcpOAuth,
    ...cursorMcp0,
    ...cursorMcp1,
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
    mcpOAuth,
    cursorMcp0,
    cursorMcp1,
    envToken,
    out,
    expanded: expandWithEncodedVariants(out),
  };
  holder.merged = merged;
  return merged;
};

/**
 * 当前需要脱敏的凭据**原值**集合（config.json + config.json.bak + config.json.bak.shrink + company-env.json + MCP OAuth 记录 + Cursor 全局 mcp.json + 进程 env 里的 GitLab PAT 合并）。
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
