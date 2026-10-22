/**
 * 服务端 settings（data/config.json）读取 + 脱敏 helper（CR-01 抽出）
 *
 * 动机：
 * - `/api/settings` GET 原来把整份 config.json（含 Cursor API Key / GitLab Token）
 *   原样返回——默认口径改脱敏、全量读取收敛到专门的 `/api/settings/full`。
 * - `/api/preview` 原来信客户端传的 shell command——改为服务端按 repoPath 从
 *   权威 config.json 查 previewCommand、客户端只能选「预览哪个仓」、不能注入命令。
 *
 * 读 config.json 的其它模块（cursor-config / task-runner…）各有自己的窄读取、
 * 这里只收「settings 路由 + preview 命令」这两处新需求、不做大一统重构。
 *
 * 读结果三态分流——ok / missing（仅 ENOENT）/ error（损坏 / 权限等），
 * 避免把「可读失败」当成「首次安装」去 PUT 覆盖。
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import {
  dataRoot,
  hardenPathMode,
  writePrivateFileAtomic,
} from "./data-root";
import { emptyCompanyEnv, isBlankCompanyEnvRow, normalizeCompanyEnv } from "../company-env";
import { sanitizeRepoShellCommand } from "../repo-shell-command";
import { hasUrlUserinfo } from "../custom-provider-url";
import { firstNonLocalRepoPath } from "../unc-path";
import { normalizeMergedSettingsForPatch } from "../settings-legacy";
import type { FeAiFlowSettings } from "../types";

export const settingsFilePath = (): string => path.join(dataRoot(), "config.json");

/**
 * 覆盖写之前的上一份可解析配置（含 API key / PAT，所以与 config.json 同样 0600）。
 * **写**只在本文件内（全仓只有 putSettingsFile 落盘它）；**读 / stat 不止本文件**（第八轮核对 src 目录的结果）：
 *   - event-secret-redact.ts 用 readFileSync 读它，取出里面的旧凭据值做事件脱敏（用户轮换掉旧 key 后旧值还躺在备份里）；
 *   - pi-coding-tools.ts 的旁路读守卫对它做词法拦截（CONFIG_FILE_FAMILY_RE），并 statSync 它做 dev+ino 比对（只 stat、不读内容）。
 * 诊断导出只读固定的 config.json、存储页只枚举 tasks/ 下的目录，都不会把它带出去——
 * 新增「枚举数据目录」的功能时务必排除它。
 *
 * 数据目录里 config.json 的「同族文件」（任何枚举 / 打包 / 外发数据目录的功能都必须整族排除，
 * 排除口径钉在 tests/settings-backup-exclusion.test.ts）：
 *   `config.json.bak`、`config.json.bak.shrink`、`config.json.corrupt-<ts>`、`config.json.tmp.*`。
 */
const settingsBackupPath = (): string => `${settingsFilePath()}.bak`;

/**
 * 「收缩」那一刻之前的完整配置（含当时的 API key / PAT / 公司环境密码；同样 0600）。
 * 之后这些凭据即使被清掉或轮换掉，旧值仍留在它里面，直到下一次收缩写把它覆盖——
 * 注意**轮换本身**（非空 → 另一个非空）不算收缩、不会写它（判据只看「清空」，见 `shrunkSettingsKeys`）。
 * **写**只在本文件内；**读 / stat 与 `.bak` 一样不止本文件**：event-secret-redact.ts 读它做事件脱敏、
 * pi-coding-tools.ts 对它做词法拦截 + statSync dev+ino 比对（详见上面 `.bak` 的说明）。
 * 与 `.bak` 的区别：`.bak` 每次保存都滚（永远是上一版），误清配置后再普通保存一次，好备份就被清空后的状态顶掉；
 * 而它**只被下一次收缩写覆盖**、普通保存不碰——误清之后还能从这里找回 API key 和仓库配置。
 * 副作用（第八轮 L1-06，设计如此、不改）：第二次合法收缩会把上一次的好备份顶掉——误清 repos 之后再清掉 gitToken，
 * 它就变成「repos 已空」的状态，第一次误清前的 repos 找不回来。
 * 判定与写入见 `shrunkSettingsKeys` / `backupSettingsOnShrink`。
 */
const settingsShrinkBackupPath = (): string => `${settingsFilePath()}.bak.shrink`;

/**
 * FeAiFlowSettings 的已知顶层键——只用来粗判「这像不像一份 settings」，不是 schema。
 * `satisfies` 只防拼错键名、不要求穷举：client 每次都整对象 PUT（必带 apiKey / repos / defaultModel
 * 等老字段），新增字段忘了登记也不会让合法保存被拒；而 `{}` / 上游错误体这类对象一个已知键都没有。
 */
const KNOWN_SETTINGS_KEYS = [
  "apiKey",
  "defaultModel",
  "provider",
  "customProviders",
  "jumpIde",
  "submitShortcut",
  "userRole",
  "gitToken",
  "repos",
  "branchTemplate",
  "disabledMcpServers",
  "mcpServers",
  "actionLayout",
  "reuseAgentDefault",
  "agentShellGitBash",
  "isolateWorktreeDefault",
  "disabledSkills",
  "disabledRules",
  "starredModels",
  "meegleProject",
  "feishuChatBridge",
  "feishuBridgeKeepAwake",
  "teamKnowledgeEnabled",
  "companyEnv",
] as const satisfies readonly (keyof FeAiFlowSettings)[];

const isPlainRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** 普通对象、且至少带一个已知 settings 键 */
export const looksLikeSettings = (v: unknown): v is Record<string, unknown> =>
  isPlainRecord(v) &&
  KNOWN_SETTINGS_KEYS.some((k) => Object.prototype.hasOwnProperty.call(v, k));

/**
 * PUT 必带的三个字段及其类型判定。唯一调用方 local-store.putSettings 永远整对象 PUT：
 * `normalizeSettings` 保证 apiKey 是字符串、defaultModel 是对象（`{ id }`）、repos 是数组，
 * 首次安装的 DEFAULT_SETTINGS 同样满足（apiKey: "" / defaultModel: { id: "" } / repos: []）。
 * 用户清 key 的合法做法是「完整对象 + apiKey 置空串」，不是只发一个键。
 */
const REQUIRED_SETTINGS_FIELDS = [
  ["apiKey", (v: unknown): boolean => typeof v === "string"],
  ["defaultModel", (v: unknown): boolean => isPlainRecord(v)],
  ["repos", (v: unknown): boolean => Array.isArray(v)],
] as const satisfies readonly (readonly [
  keyof FeAiFlowSettings,
  (v: unknown) => boolean,
])[];

/**
 * PUT 请求体校验：通过返回 null，否则返回给用户看的中文原因（不回显请求内容）。
 *
 * 为什么必须拦：PUT 是整对象覆盖——
 * - `{}` 会把配置整个清空；`[]` 在盘上还没有 config 时会被原样写成 `[]`，
 *   读侧判损坏（settings_json_invalid），此后所有 PUT 都因 unreadable 被拒、设置页再也存不进去；
 * - 只带一部分键（`{ repos: [] }` / `{ apiKey: "" }` / 一个偏好键）同样是整对象覆盖：config.json 只剩这一个键，
 *   API key / 偏好 / 仓库全丢，再普通保存一次 `.bak` 也被顶掉。所以必须同时带 apiKey（字符串）、
 *   defaultModel（普通对象，非数组 / null）、repos（数组）——只认自有属性。
 *
 * 文案只点名「缺失 / 类型不对」的字段名（我们自己的常量），绝不回显请求里的值。
 */
export const validateSettingsPayload = (body: unknown): string | null => {
  if (!isPlainRecord(body)) return "配置必须是对象";
  if (!looksLikeSettings(body)) {
    return "配置内容不像 settings（不含任何已知字段）、已拒绝写入以免清空现有配置";
  }
  const bad = REQUIRED_SETTINGS_FIELDS.filter(
    ([key, isValid]) =>
      !Object.prototype.hasOwnProperty.call(body, key) || !isValid(body[key]),
  ).map(([key]) => key);
  if (bad.length > 0) {
    return `配置不完整：${bad.join("、")} 缺失或类型不对（PUT 必须是完整配置对象）、已拒绝写入以免清空现有配置`;
  }
  return null;
};

/**
 * 「非空」口径（收缩检测用）：非空串 / 非空数组 / 有自有键的普通对象。
 * 数字、布尔、`null`、`undefined` 一律按「空」——它们不是「一份可找回的凭据 / 列表」。
 */
const isNonEmptySettingValue = (v: unknown): boolean => {
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (isPlainRecord(v)) return Object.keys(v).length > 0;
  return false;
};

/**
 * 顶层「凭据与列表类」键：丢了就得重新到处找、重新填。
 * **刻意不含**所有布尔开关、starredModels、disabledSkills / disabledRules / disabledMcpServers、branchTemplate、
 * defaultModel、userRole 等偏好类键：`.bak.shrink` 只被下一次收缩写覆盖，若随手关个开关、取消个星标、
 * 重新启用个 skill 也算收缩，真正误清 repos / apiKey 之后留下的好备份就会被「repos 已空」的状态顶掉
 * （第七轮实证：默认开启的 teamKnowledgeEnabled true→false 就能把它顶掉）。
 * customProviders / companyEnv 的嵌套清空见下方专项（顶层键数 / 数组长度看不出来）。
 */
const SHRINK_WATCHED_KEYS = [
  "apiKey",
  "gitToken",
  "repos",
  "mcpServers",
  "customProviders",
] as const satisfies readonly (keyof FeAiFlowSettings)[];

/**
 * customProviders 的 apiKey 丢失：previous 里有非空 apiKey 的条目（按 id 对齐），在 next 里整条没了或 apiKey 被清空。
 * 另一条还在时顶层数组仍非空，光看数组长度判不出来；本来就没有 key 的本地端点（apiKey 空串）不算。
 * 没有 id 的条目对不上号、跳过（normalizeSettings 读盘时保证有 id）。
 */
const customProviderApiKeyLost = (
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): boolean => {
  if (!Array.isArray(previous.customProviders)) return false;
  const nextKeyById = new Map<string, string>();
  if (Array.isArray(next.customProviders)) {
    for (const row of next.customProviders) {
      if (isPlainRecord(row) && typeof row.id === "string" && row.id) {
        nextKeyById.set(row.id, typeof row.apiKey === "string" ? row.apiKey : "");
      }
    }
  }
  return previous.customProviders.some(
    (row) =>
      isPlainRecord(row) &&
      typeof row.id === "string" &&
      row.id !== "" &&
      typeof row.apiKey === "string" &&
      row.apiKey !== "" &&
      !nextKeyById.get(row.id),
  );
};

/** companyEnv 的子系统名（servers / pg / redis…），取自 emptyCompanyEnv：新增子系统自动纳入、不用再登记 */
const COMPANY_ENV_SECTIONS = Object.keys(emptyCompanyEnv());

/**
 * 子系统里是否有「用户填了内容」的行。刚点「添加」的空白行也会被设置页立即落盘（默认行带 `env: "test"` 等），
 * 添加再删掉它不该算收缩——否则这一来一回就把好备份顶掉了。
 * 「空白行」判定与设置页 company-env-card 共用 company-env.ts 的 isBlankCompanyEnvRow（不要在这里再抄一份名单）。
 */
const hasFilledCompanyEnvRow = (rows: unknown): boolean =>
  Array.isArray(rows) && rows.some((row) => isPlainRecord(row) && !isBlankCompanyEnvRow(row));

/**
 * 取一份 settings 里归一后的 companyEnv，与读盘 / 导入共用 normalizeCompanyEnv：
 * pg / redis / custom / nacos / elk / sls 在旧版是**单个对象**（单实例格式），归一后升级成单元素数组；
 * 缺失 / 类型不对 → 空数组。归一的警告只是为了满足签名，这里丢弃。
 *
 * 为什么判定前要先归一（第八轮 L1-03）：磁盘上还是旧单对象时，`hasFilledCompanyEnvRow`（只认数组）永远判「没内容」，
 * 用户清掉它再保存就不会生成 `.bak.shrink`——旧版配置里的 PG / Redis / Nacos 密码就这样悄悄丢了。
 * 两边（previous 与 next）都归一，是为了对称：只归一 previous 的话，next 若仍是旧单对象（绕过 client 的手写 PUT）、
 * 内容一点没少，会被误报成「子系统被清空」。
 */
const normalizedCompanyEnvSections = (
  settings: Record<string, unknown>,
): Record<string, unknown> =>
  normalizeCompanyEnv(settings.companyEnv) as unknown as Record<string, unknown>;

/** companyEnv 子系统清空：previous 里有内容的子系统，在 next 里没了内容（整个 companyEnv 缺失也算） */
const shrunkCompanyEnvSections = (
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): string[] => {
  const prevEnv = normalizedCompanyEnvSections(previous);
  const nextEnv = normalizedCompanyEnvSections(next);
  return COMPANY_ENV_SECTIONS.filter(
    (k) => hasFilledCompanyEnvRow(prevEnv[k]) && !hasFilledCompanyEnvRow(nextEnv[k]),
  ).map((k) => `companyEnv.${k}`);
};

/**
 * 收缩检测：「凭据与列表类」键（SHRINK_WATCHED_KEYS）在 previous 里「非空」、在 next 里「缺失或空」，
 * 或 customProviders 的 apiKey 丢了 / companyEnv 某个子系统被清空，就算收缩，
 * 返回这些键名（只有键名、不含值，可进日志）。next 取**掩码合并后**的 settings（preserveSecretsOnPut 的输出），
 * 即与最终落盘内容严格对应：client 误把脱敏展示值回写时，掩码被还原成盘上真值，那不是收缩。
 * 注意：判据只看「空 / 非空」，而掩码串本身非空、还原后的真值也非空，所以拿请求体比结论目前恰好一致——
 * 仍按合并后比，是为了判定不依赖「掩码恒非空」这个巧合（日后掩码口径变了也不会漂移）。
 *
 * 已知盲区（与「只看清空」的口径一致）：条目还在、只清了其中某个字段（某个 repo 的配置、某台服务器的密码）不算——
 * 那种改动 `.bak` 能兜一次，`.bak.shrink` 只留给「整块没了」。
 */
const shrunkSettingsKeys = (
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): string[] => {
  const shrunk: string[] = SHRINK_WATCHED_KEYS.filter(
    (k) => isNonEmptySettingValue(previous[k]) && !isNonEmptySettingValue(next[k]),
  );
  if (!shrunk.includes("customProviders") && customProviderApiKeyLost(previous, next)) {
    shrunk.push("customProviders.apiKey");
  }
  shrunk.push(...shrunkCompanyEnvSections(previous, next));
  return shrunk;
};

/**
 * 读 config.json 三态：ok / missing（ENOENT）/ error（损坏、权限等）。
 * error.reason 会原样进 500 响应与日志：只能是 `json_parse[: at position N]` / `settings_json_invalid` /
 * `<errno>: <fs 报错>`（只含路径、不含文件内容），不得拼进文件内容。
 */
export type SettingsReadResult =
  | { status: "ok"; settings: Record<string, unknown> }
  | { status: "missing" }
  | { status: "error"; reason: string };

/**
 * JSON 损坏时备份原文件一次：`config.json.corrupt-<ts>`。
 * 同目录已有任意 `config.json.corrupt-*` 则跳过（避免每次读都再备一份）。
 */
const backupCorruptSettingsOnce = async (raw: string): Promise<void> => {
  const filePath = settingsFilePath();
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const prefix = `${base}.corrupt-`;
  try {
    const entries = await fs.readdir(dir);
    if (entries.some((name) => name.startsWith(prefix))) return;
  } catch {
    // 列目录失败仍尝试备份——宁可多一份也不丢用户数据
  }
  const backupPath = path.join(dir, `${prefix}${Date.now()}`);
  try {
    await fs.writeFile(backupPath, raw, "utf-8");
    await hardenPathMode(backupPath, 0o600);
    console.warn(`[settings-fs] config.json 损坏、已备份到 ${path.basename(backupPath)}`);
  } catch (err) {
    console.warn(
      "[settings-fs] config.json 损坏备份失败:",
      err instanceof Error ? err.message : err,
    );
  }
};

/**
 * JSON.parse 失败的 reason：只留 `json_parse` + 出错位置，绝不带 V8 的原始 message。
 * 为什么：V8 对 `Unexpected token` 类错误会把出错处附近的原文拼进 message
 * （形如 `...""apiKey": sk-xxxx"... is not valid JSON`），而手改 config.json 漏引号恰恰最容易触发它；
 * reason 会进 500 响应（设置页展示）和服务端日志（main.log → 诊断包），不能夹带密钥片段。
 * 位置数字只取 `\d+`，没有位置的报错（含上述 Unexpected token）就只剩 `json_parse`。
 */
const jsonParseReason = (err: unknown): string => {
  const message = err instanceof Error ? err.message : "";
  const m = /\bat position (\d+)/.exec(message);
  return m ? `json_parse: at position ${m[1]}` : "json_parse";
};

/** 读整份 config.json：ENOENT → missing；JSON 坏 / 权限等 → error（坏 JSON 会先备份） */
export const readSettingsFile = async (): Promise<SettingsReadResult> => {
  const filePath = settingsFilePath();
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return { status: "missing" };
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: "error",
      reason: code ? `${code}: ${message}` : message,
    };
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { status: "ok", settings: parsed as Record<string, unknown> };
    }
    // 根节点不是对象（数组 / 原始类型）= 内容损坏
    await backupCorruptSettingsOnce(raw);
    return { status: "error", reason: "settings_json_invalid" };
  } catch (err) {
    await backupCorruptSettingsOnce(raw);
    return { status: "error", reason: jsonParseReason(err) };
  }
};

// 写链挂 globalThis：Next dev 多 chunk 下 module-level Promise 不共享（同 task-fs-core 踩坑）。
// 审查发现：裸写无互斥时并发 PUT 丢更新——「读盘→合并→写盘」须整段进链。
const SETTINGS_WRITE_CHAIN_KEY = "__flowshipSettingsWriteChainV1__";
const getSettingsWriteChain = (): { current: Promise<unknown> } => {
  const g = globalThis as unknown as Record<
    string,
    { current: Promise<unknown> } | undefined
  >;
  if (!g[SETTINGS_WRITE_CHAIN_KEY]) {
    g[SETTINGS_WRITE_CHAIN_KEY] = { current: Promise.resolve() };
  }
  return g[SETTINGS_WRITE_CHAIN_KEY]!;
};

/** 串行执行 settings 写侧临界区（RMW / 裸写共用同一条链） */
export const withSettingsWriteLock = async <T>(
  fn: () => Promise<T>,
): Promise<T> => {
  const chain = getSettingsWriteChain();
  const run = chain.current.then(fn, fn);
  // 队列指针只关心「上一个是否结束」、错误由调用方消费、不传染下一个
  chain.current = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
};

/**
 * 原子写 config.json（0600 + tmp/rename）。
 * 含 API key / GitLab PAT——写入即收紧权限。
 * 写操作进 globalThis 链；若调用方还要做读改写，请用 withSettingsWriteLock 包住整段 RMW
 *（勿在锁内再调本函数——会同链嵌套死锁）。
 */
export const writeSettingsFileAtomic = async (
  settings: Record<string, unknown>,
): Promise<void> => {
  await withSettingsWriteLock(async () => {
    await writePrivateFileAtomic(
      settingsFilePath(),
      JSON.stringify(settings, null, 2),
    );
  });
};

/**
 * 「可以删」的 tmp 文件名：数据目录顶层 config.json 家族的原子写临时文件，**严格**是 writePrivateFileAtomic 的产物形态
 * `<目标>.tmp.<数字 pid>.<Math.random().toString(36).slice(2)>`（见 data-root.ts）。
 * 目标只认 config.json / config.json.bak / config.json.bak.shrink 三种；`.corrupt-<ts>` 是 writeFile 直写的、没有 tmp 阶段，
 * 别的文件（company-env.json 等）的 tmp 也不归这里管（见 cleanupStaleSettingsTmpFiles 的「作用域」说明）。
 *
 * 为什么不沿用 pi-coding-tools 的 CONFIG_FILE_FAMILY_RE（它的 tmp 分支是 `\.tmp\..+`）：那是**读拦截**口径，宁可多拦；
 * 拿它做**删除**，用户手工留在数据目录里的 `config.json.tmp.my-copy` 也会被删（第八轮实证）。两边口径不同是有意的：
 * 读拦截宽、删除窄——宁可漏删一个遗留 tmp，也不误删用户自己的文件。
 *
 * 随机段字符集 / 长度（已验证）：Node v22.22.1 下 200 万次 `Math.random().toString(36).slice(2)` 全是 `[0-9a-z]`、长度 6–14（采样范围，不是上界）；
 * 取 0.5 → `i`（1 位），取 2^-53 → 21 位全是 `[0-9a-z]`，所以用 `+` 不设长度上限。
 * 唯一不覆盖的形态：`Math.random()` 恰好返回 0 时随机段是空串（2^-52 量级的概率、推演未实测）——那个 tmp 会留着，不会误删别的东西。
 */
const STALE_SETTINGS_TMP_FILE_RE = /^config\.json(?:\.bak(?:\.shrink)?)?\.tmp\.\d+\.[a-z0-9]+$/;

/**
 * 遗留 tmp 的最小年龄：一次原子写从建 tmp 到 rename 只有毫秒级（Windows 上 EPERM 重试也不过秒级），
 * 10 分钟以上的 tmp 只可能是崩溃留下的；留足余量是为了绝不碰另一路正在进行的写。
 */
export const STALE_SETTINGS_TMP_MIN_AGE_MS = 10 * 60 * 1000;

export interface CleanupStaleTmpOptions {
  /** 当前时间（ms），测试注入；默认 Date.now() */
  now?: number;
  /** 早于这个年龄才清（ms），默认 STALE_SETTINGS_TMP_MIN_AGE_MS */
  minAgeMs?: number;
}

/**
 * 启动时清掉崩溃遗留的 config.json 原子写临时文件。
 *
 * 为什么：writePrivateFileAtomic 在「写 tmp → rename」之间崩溃，tmp 会永远留在数据目录里，
 * 内容是明文 API key / PAT；脱敏源（event-secret-redact）只覆盖 config / .bak / .bak.shrink 三个槽，不含 tmp。
 *
 * 只删：数据目录**顶层**、文件名严格匹配 STALE_SETTINGS_TMP_FILE_RE（writePrivateFileAtomic 的真实产物形态，
 * 不是读拦截那个宽口径）、`lstat` 确认是**普通文件**（不跟随软链、目录 / 软链一律不碰）、mtime 早于阈值。
 * 幂等；任何失败只 warn 文件名（不含内容）、绝不抛。
 * 不进 settings 写锁：它只碰早已被放弃的旧 tmp，与正在进行的写（新 tmp）互不相交。
 *
 * 作用域（已知缺口）：只管 config.json 家族。`company-env.json.tmp.<pid>.<rand>`（writeCompanyEnvFile 同样经
 * writePrivateFileAtomic 写出）崩溃遗留后里面同样是明文的服务器 / PG / Redis 等密码，**目前没有任何地方清它**
 * （全仓没有别的 tmp 清理器；pi-coding-tools 的旁路读拦截对 company-env.json 也只认精确文件名、不含它的 tmp）。
 * tests/settings-tmp-cleanup.test.ts 把它钉成「保留」，钉的是这个作用域、不是「它不含凭据」。要补就把 company-env.json
 * 加进目标集合，并同步评估读拦截。
 *
 * @returns 实际删除的个数
 */
export const cleanupStaleSettingsTmpFiles = async (
  opts: CleanupStaleTmpOptions = {},
): Promise<number> => {
  let removed = 0;
  try {
    const dir = path.dirname(settingsFilePath());
    const now = opts.now ?? Date.now();
    const minAgeMs = opts.minAgeMs ?? STALE_SETTINGS_TMP_MIN_AGE_MS;
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (err) {
      // 数据目录还不存在（首次启动）不是故障
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        console.warn(
          "[settings-fs] 清理遗留 config.json 临时文件：列目录失败（不阻断）:",
          err instanceof Error ? err.message : err,
        );
      }
      return 0;
    }
    for (const name of names) {
      if (!STALE_SETTINGS_TMP_FILE_RE.test(name)) continue;
      const full = path.join(dir, name);
      try {
        const st = await fs.lstat(full);
        if (!st.isFile()) continue;
        if (now - st.mtimeMs <= minAgeMs) continue;
        await fs.unlink(full);
        removed += 1;
      } catch (err) {
        // 别处先清掉了（并发启动 / 手工删）不算失败
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") continue;
        console.warn(
          `[settings-fs] 清理遗留临时文件 ${name} 失败（不阻断）:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    if (removed > 0) {
      console.log(`[settings-fs] 已清理 ${removed} 个崩溃遗留的 config.json 原子写临时文件`);
    }
  } catch (err) {
    console.warn(
      "[settings-fs] 清理遗留 config.json 临时文件异常（不阻断）:",
      err instanceof Error ? err.message : err,
    );
  }
  return removed;
};

/**
 * 启动幂等迁移（instrumentation-node 启动时调用）：已存在的 config.json 收紧为 0600；
 * 并清掉崩溃遗留的 config.json 原子写临时文件（含明文凭据，见 cleanupStaleSettingsTmpFiles）。
 * 两步各自失败只 warn、不阻断启动；日志不含文件内容。
 */
export const hardenConfigFilePerms = async (): Promise<void> => {
  await hardenPathMode(settingsFilePath(), 0o600);
  await cleanupStaleSettingsTmpFiles();
};

// 秘钥掩码：留前 4 位 + 长度（跟 diagnostics 的脱敏口径一致——够对「配没配 / 是不是那把」、不泄本体）
const maskSecret = (v: unknown): string => {
  if (typeof v !== "string" || v.length === 0) return "";
  return `${v.slice(0, 4)}…（已脱敏、长度 ${v.length}）`;
};

/**
 * settings 对象脱敏（apiKey / gitToken 掩码、其余原样）。
 * `/api/settings` GET / PUT 响应的默认口径；client 初始化用 `/api/settings/full`。
 */
export const maskSettingsSecrets = (
  settings: Record<string, unknown>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {
    ...settings,
    apiKey: maskSecret(settings.apiKey),
    gitToken: maskSecret(settings.gitToken),
  };
  // 自定义 provider 的 apiKey 同级别脱敏（baseUrl / format 非敏感、保留原样）
  const cps = settings.customProviders;
  if (Array.isArray(cps)) {
    out.customProviders = cps.map((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return row;
      const c = row as Record<string, unknown>;
      return { ...c, apiKey: maskSecret(c.apiKey) };
    });
  }
  return out;
};

// 掩码特征（maskSecret 的产物）——PUT 进来带这个 = client 把脱敏展示值当真值回写了
const MASK_MARKER = "已脱敏";

/**
 * PUT 掩码兜底：进来的 apiKey / gitToken 带脱敏掩码（maskSecret 产物）→ 保留盘上真值。
 *
 * 只拦「client 误把脱敏展示值当真值回写」这一种明确坏数据——掩码串写进盘、agent 直接全挂。
 * **空值不拦**（用户拍板「自己清 key 是合法操作」）：清空放行。
 */
export const preserveSecretsOnPut = (
  incoming: Record<string, unknown>,
  current: Record<string, unknown> | null,
): { settings: Record<string, unknown>; preserved: string[] } => {
  if (!current) return { settings: incoming, preserved: [] };
  const preserved: string[] = [];
  const out = { ...incoming };
  for (const key of ["apiKey", "gitToken"] as const) {
    const cur = typeof current[key] === "string" ? (current[key] as string) : "";
    if (!cur) continue; // 盘上本来就没有、不管
    const inc = typeof out[key] === "string" ? (out[key] as string) : "";
    if (inc.includes(MASK_MARKER)) {
      out[key] = cur;
      preserved.push(key);
    }
  }
  // 自定义 provider 列表：按 id 对齐，client 误把脱敏展示值当真值回写时保留盘上真值
  const incList = out.customProviders;
  const curList = current.customProviders;
  if (Array.isArray(incList) && Array.isArray(curList)) {
    const curById = new Map<string, Record<string, unknown>>();
    for (const row of curList) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const c = row as Record<string, unknown>;
      if (typeof c.id === "string" && c.id) curById.set(c.id, c);
    }
    out.customProviders = incList.map((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return row;
      const inc = row as Record<string, unknown>;
      const id = typeof inc.id === "string" ? inc.id : "";
      const cur = id ? curById.get(id) : undefined;
      const curKey = typeof cur?.apiKey === "string" ? cur.apiKey : "";
      const incKey = typeof inc.apiKey === "string" ? inc.apiKey : "";
      if (curKey && incKey.includes(MASK_MARKER)) {
        preserved.push(`customProviders.${id}.apiKey`);
        return { ...inc, apiKey: curKey };
      }
      return inc;
    });
  }
  return { settings: out, preserved };
};

/**
 * 覆盖写之前把「当前仍可解析的 config.json」存成 config.json.bak（0600、原子写，同 config.json）。
 *
 * - 序列化 readSettingsFile 刚解析出来的 previous，而不是再读一遍原文件：省一次 IO、没有两次读之间被改的窗口，
 *   格式也与应用自己写出的一致。
 * - 不含任何已知键的旧配置（手改残留的 `{}` 等）不备份：它没有可找回的内容，反而会顶掉一份好备份。
 * - 备份失败只 warn、不阻断保存：.bak 是兜底而不是前置条件，不能因为它让设置页整个存不进去
 *   （同 data-root「权限收紧是 best-effort、不能阻断业务写」口径）。日志只含错误信息、不含内容。
 * - 只留一份（上一个版本）：连续两次保存后 .bak 就是倒数第二个版本。
 */
const backupSettingsBeforeOverwrite = async (
  previous: Record<string, unknown>,
): Promise<void> => {
  if (!looksLikeSettings(previous)) return;
  try {
    await writePrivateFileAtomic(
      settingsBackupPath(),
      JSON.stringify(previous, null, 2),
    );
  } catch (err) {
    console.warn(
      "[settings-fs] 覆盖前备份 config.json.bak 失败（继续保存）:",
      err instanceof Error ? err.message : err,
    );
  }
};

/**
 * 收缩写之前把 previous（收缩前的完整配置）原子写成 config.json.bak.shrink（0600，writePrivateFileAtomic）。
 *
 * - 只在 putSettingsFile 判定「收缩」时调用；**只有下一次收缩写会覆盖它**，普通保存不碰——
 *   误清配置之后再普通保存一次，`.bak` 就被清空后的状态顶掉，好备份只剩它。
 * - 备份失败只 warn、不阻断保存（同 `.bak` 口径：兜底不是前置条件）。日志只含键名 / 错误信息，不含任何值。
 * - 调用方必须已在 withSettingsWriteLock 内；这里直接 writePrivateFileAtomic、不嵌套 writeSettingsFileAtomic。
 */
const backupSettingsOnShrink = async (
  previous: Record<string, unknown>,
  shrunkKeys: string[],
): Promise<void> => {
  try {
    await writePrivateFileAtomic(
      settingsShrinkBackupPath(),
      JSON.stringify(previous, null, 2),
    );
    console.warn(
      `[settings-fs] 检测到配置收缩（${shrunkKeys.join("、")} 被清空 / 删除）、已先备份到 config.json.bak.shrink`,
    );
  } catch (err) {
    console.warn(
      "[settings-fs] 收缩前备份 config.json.bak.shrink 失败（继续保存）:",
      err instanceof Error ? err.message : err,
    );
  }
};

/**
 * PUT 语义的读改写：读盘 → 掩码兜底合并 → 原子写，整段串行化。
 * route 侧副作用（收件箱缓存失效 / shell 偏好）放在外层、拿 previous 比对即可。
 *
 * 落盘次序（都在同一把写锁内）：判定收缩 → 收缩则先写 `.bak.shrink` → 再滚 `.bak` → 最后写 config.json。
 * 任一备份失败只 warn；主写失败时两份备份都已是覆盖前的配置、config.json 仍是原样。
 */
type PutSettingsFileResult =
  | {
      status: "ok";
      settings: Record<string, unknown>;
      previous: Record<string, unknown> | null;
    }
  | { status: "unreadable"; reason: string };

/** 写锁内的整对象写：校验 → 读盘 → 掩码兜底 → 收缩备份 / .bak → 原子写（PUT 与 PATCH 共用） */
const putSettingsFileLocked = async (
  incoming: Record<string, unknown>,
): Promise<PutSettingsFileResult> => {
  // route 已前置校验；这里是唯一落盘入口上的兜底——日后别的调用方绕过 route 也写不进 `{}` / `[]`
  const invalid = validateSettingsPayload(incoming);
  if (invalid) throw new Error(invalid);
  const currentResult = await readSettingsFile();
  if (currentResult.status === "error") {
    // 损坏 / 读不了：在备份之前就返回——坏文件既不会被覆盖、也不会顶掉一份好的 .bak
    return { status: "unreadable" as const, reason: currentResult.reason };
  }
  const previous =
    currentResult.status === "ok" ? currentResult.settings : null;
  const { settings } = preserveSecretsOnPut(incoming, previous);
  sanitizeSettingsReposShellCommands(settings);
  if (previous) {
    // 收缩判定用掩码合并 + 净化后的 settings（见 shrunkSettingsKeys）；先写 .bak.shrink、再滚 .bak
    const shrunk = shrunkSettingsKeys(previous, settings);
    if (shrunk.length > 0) await backupSettingsOnShrink(previous, shrunk);
    // 覆盖前先留一份：误写（客户端 bug / 手滑）之后还有路可以找回 API key 和仓库配置
    await backupSettingsBeforeOverwrite(previous);
  }
  // 直接写盘、不走 writeSettingsFileAtomic（避免同链嵌套死锁）
  await writePrivateFileAtomic(
    settingsFilePath(),
    JSON.stringify(settings, null, 2),
  );
  return { status: "ok" as const, settings, previous };
};

export const putSettingsFile = async (
  incoming: Record<string, unknown>,
): Promise<PutSettingsFileResult> =>
  withSettingsWriteLock(() => putSettingsFileLocked(incoming));

/** PATCH 不能碰的键名（原型污染） */
const FORBIDDEN_PATCH_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * 校验字段级补丁体：`{ patch: { key: value… }, remove?: string[] }`，patch / remove 至少有一个非空。
 * 返回错误文案或 null。
 */
export const validateSettingsPatch = (body: unknown): string | null => {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "补丁必须是对象 { patch, remove? }";
  }
  const { patch, remove } = body as { patch?: unknown; remove?: unknown };
  if (
    patch !== undefined &&
    (typeof patch !== "object" || patch === null || Array.isArray(patch))
  ) {
    return "patch 必须是对象";
  }
  if (
    remove !== undefined &&
    (!Array.isArray(remove) || remove.some((k) => typeof k !== "string"))
  ) {
    return "remove 必须是字符串数组";
  }
  const patchKeys = patch ? Object.keys(patch) : [];
  const removeKeys = (remove as string[] | undefined) ?? [];
  if (patchKeys.length + removeKeys.length === 0) return "补丁为空";
  if (patch && Object.prototype.hasOwnProperty.call(patch, "customProviders")) {
    const bad = validateCustomProvidersInput((patch as Record<string, unknown>).customProviders);
    if (bad) return bad;
  }
  for (const k of [...patchKeys, ...removeKeys]) {
    if (FORBIDDEN_PATCH_KEYS.has(k)) return `不允许的字段名：${k}`;
  }
  // apiKey / defaultModel / repos 是「完整配置」的必备三项：可以改值（清 key = 空串），不能整键删除
  for (const k of removeKeys) {
    if (k === "apiKey" || k === "defaultModel" || k === "repos") {
      return `不能删除必备字段：${k}`;
    }
  }
  return null;
};

/**
 * 本次**写入**的 customProviders 里有没有地址带用户名 / 密码的条目（第四轮 Q2-06）：有 → 返回给用户看的原因。
 * 之前「拒收」只是设置页的红字，服务端照存；含 userinfo 的地址 Node fetch 会直接抛错并把整串（含密钥）回显到页面 / 日志。
 * 只校验**调用方这次要写的值**（PUT 的整包 / PATCH 里的 customProviders），不校验合并后的盘上内容——
 * 否则盘上已有的旧坏条目会让用户改任何无关开关都被 400 挡住。文案只点名提供方显示名、绝不回显地址。
 */
export const validateCustomProvidersInput = (value: unknown): string | null => {
  if (!Array.isArray(value)) return null;
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const { baseUrl, name } = row as { baseUrl?: unknown; name?: unknown };
    if (typeof baseUrl === "string" && hasUrlUserinfo(baseUrl)) {
      const label = typeof name === "string" && name.trim() ? `「${name.trim()}」` : "";
      return `提供方${label}的接口地址里带了用户名 / 密码：请把密钥填到 API Key，不要写进地址（已拒绝保存）`;
    }
  }
  return null;
};

/**
 * 本次**写入**的 repos 里有没有「新加的」UNC / WSL / 非本机磁盘路径（第五轮 Q4-01 服务端兜底）：有 → 返回给用户看的原因。
 * 设置页登记仓库时已经在前端拒收，但 API 谁都能调（脚本 / 旧页面 / 手改请求），不挡的话这类路径会躺进 config.json，
 * 之后 repo-branches / 建任务都 400、被前端吞成「非 git 仓库」。
 * 只拒**盘上原本没有的**路径：旧配置里已经存在的 UNC 仓库（升级前登记的）仍随整包 PUT 原样带回——
 * 逐条校验会让用户改任何无关开关都被 400 挡住（与 {@link validateCustomProvidersInput} 同口径），也保留用户自己删掉它的路。
 * @param incoming 这次要写的 repos 值（PUT 整包里的 repos / PATCH 的 patch.repos）；不是数组 → 不校验（交给其它校验）
 * @param existing 盘上当前的 repos（读失败 / 没有就传 undefined = 全部视为新增）
 */
export const validateNewRepoPaths = (
  incoming: unknown,
  existing: unknown,
  platform: string = process.platform,
): string | null => {
  if (!Array.isArray(incoming)) return null;
  const known = new Set<string>();
  if (Array.isArray(existing)) {
    for (const r of existing) {
      const p = (r as { path?: unknown } | null)?.path;
      if (typeof p === "string") known.add(p);
    }
  }
  const added: string[] = [];
  for (const r of incoming) {
    const p = (r as { path?: unknown } | null)?.path;
    if (typeof p === "string" && !known.has(p)) added.push(p);
  }
  return firstNonLocalRepoPath(added, platform)?.reason ?? null;
};

/**
 * 字段级补丁（第三轮 D1-01）：在**同一把写锁内**读盘 → 只替换补丁里的键 → 走与 PUT 完全相同的
 * 校验 / 掩码兜底 / 收缩备份 / `.bak` / 原子写。
 *
 * 为什么不是整对象 PUT：客户端缓存可能早已陈旧（浏览器标签 / 带外恢复 config.json），整包 PUT 会把别处
 * 刚改的 key 轮换、仓库删除整体还原。补丁只动本次改的字段，其余以盘上最新为准。
 * 盘上没有 config.json（missing）→ 拒绝：补丁没有「基线」可言，让客户端先完成初始化。
 */
export const patchSettingsFile = async (args: {
  patch?: Record<string, unknown>;
  remove?: readonly string[];
}): Promise<PutSettingsFileResult | { status: "missing" }> =>
  withSettingsWriteLock(async () => {
    const current = await readSettingsFile();
    if (current.status === "error") {
      return { status: "unreadable" as const, reason: current.reason };
    }
    if (current.status !== "ok") return { status: "missing" as const };
    const merged: Record<string, unknown> = { ...current.settings };
    for (const [k, v] of Object.entries(args.patch ?? {})) merged[k] = v;
    for (const k of args.remove ?? []) delete merged[k];
    // 合并后先按客户端 normalizeSettings 同口径补全 / 升级，再走与 PUT 相同的校验：
    // ① 盘上缺 apiKey / defaultModel / repos 之一（或 defaultModel 是旧字符串）不再让每次保存恒 400（Q2-03；
    //    旧整包 PUT 因客户端发全字段而自愈）；② 退役键 / 旧单槽 customProvider 在这里清掉、升级，
    //    删光提供方后旧单槽不「复活」（Q2-05）
    return putSettingsFileLocked(
      normalizeMergedSettingsForPatch(merged, {
        touchedKeys: new Set([...Object.keys(args.patch ?? {}), ...(args.remove ?? [])]),
        customProvidersExplicit:
          Object.prototype.hasOwnProperty.call(args.patch ?? {}, "customProviders") ||
          (args.remove ?? []).includes("customProviders"),
      }),
    );
  });

/**
 * PUT 落盘前归一 per-repo 依赖初始化命令（setupCommand）：单行、限长、丢弃脏值。
 * 与 client normalizeSettings 同口径（共用 sanitizeRepoShellCommand）；
 * previewCommand 保持原有宽松行为、不在这里动。
 */
const sanitizeSettingsReposShellCommands = (
  settings: Record<string, unknown>,
): void => {
  if (!Array.isArray(settings.repos)) return;
  settings.repos = settings.repos.map((r) => {
    if (!r || typeof r !== "object") return r;
    const row = { ...(r as Record<string, unknown>) };
    const sanitized = sanitizeRepoShellCommand(row.setupCommand);
    if (sanitized === undefined) delete row.setupCommand;
    else row.setupCommand = sanitized;
    return row;
  });
};

const getRepoShellCommandFromDisk = async (
  repoPath: string,
  field: "previewCommand" | "setupCommand",
): Promise<string | null> => {
  const result = await readSettingsFile();
  const settings = result.status === "ok" ? result.settings : null;
  const repos = Array.isArray(settings?.repos)
    ? (settings.repos as Array<{ path?: unknown; previewCommand?: unknown; setupCommand?: unknown }>)
    : [];
  const repo = repos.find((r) => r?.path === repoPath);
  const raw = repo?.[field];
  const cmd = typeof raw === "string" ? raw.trim() : "";
  return cmd || null;
};

/**
 * 按仓库路径查设置页配的「预览启动命令」（CR-01：/api/preview 唯一命令来源）。
 * 没配 / 配置文件缺失 / 读失败 → null（route 拒绝启动预览）。
 */
export const getRepoPreviewCommand = async (
  repoPath: string,
): Promise<string | null> => getRepoShellCommandFromDisk(repoPath, "previewCommand");

/**
 * 按仓库路径查设置页配的「依赖初始化命令」——worktree 克隆 node_modules 不可用时的兜底。
 * 没配 / 空白 / 配置文件缺失 / 读失败 → null（不执行、回退 agent 自装）。
 */
export const getRepoSetupCommand = async (
  repoPath: string,
): Promise<string | null> =>
  // 读出来再过一遍 PUT 同口径的净化：唯一落盘入口 putSettingsFile 已经净化过，这里挡的是手改 config.json
  // 写进去的多行 / 超长值——它们会被原样送进 shell，且「截断」或「只取首行」都可能变成另一条完全不同的命令，
  // 所以一律整条丢弃、回退 agent 自装（与 sanitizeRepoShellCommand 注释里的设计一致）。
  sanitizeRepoShellCommand(
    await getRepoShellCommandFromDisk(repoPath, "setupCommand"),
  ) ?? null;
