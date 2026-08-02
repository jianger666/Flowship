/**
 * 团队 wk-harness 本机配置（`~/.wk/config.yaml`）的纯逻辑层
 *
 * 这里只有「文本 ↔ 配置」的纯函数、不碰 fs——所以客户端也能 import 类型和默认值
 * （落盘在 `src/lib/server/wk-config.ts`、那边 import 本文件并 re-export）。
 *
 * 两条硬约束（改之前先读）：
 * 1. **解析 / 生成口径必须跟官方 python 脚本一致**（`wk-delivery-sync.py` 等的
 *    `read_simple_delivery_yaml`）：只认「顶层键 + 一层缩进子键」、值 strip 引号、
 *    不引 YAML 库。用完整 YAML 解析器写出人家读不懂的结构（锚点 / 多行 / 嵌套）、
 *    脚本侧会静默拿不到值。
 * 2. **只改我们管的那几个键**、其余原样保留。注意「段级重写」是不够的：
 *    - `doc_repo` 官方还支持 `provider` / `url` / `default_branch`
 *    - `delivery_hub` 官方还支持 `server_upload` / `operator_source` /
 *      `operator_account` / `artifact_uri_prefix`
 *    这个文件是团队共用的（不用 Flowship 的同事直接手敲），整段重写会把同事配的
 *    这些键悄悄抹掉。所以下面是**键级合并**：认识的键就地改、不认识的键连同注释原样留着。
 */

/**
 * 团队公用的 Delivery Hub 地址——同事都连同一台，没必要每人手填一遍。
 * 换机器时只改这个常量（已经落进各人 `~/.wk/config.yaml` 的旧地址不会被追改、见
 * `server/wk-config.ts` 的播种规则）。
 */
export const DEFAULT_HUB_BASE_URL = "https://harness-delivery.wukongedu.net";

export interface WkConfig {
  /** WK 产出目录的绝对路径（产物写这儿）；未配置为空串 */
  docRepoPath: string;
  /** Delivery Hub 地址 */
  hubBaseUrl: string;
  /** Delivery Hub 鉴权 Token（本机设置页密码框使用） */
  hubToken: string;
  /** Delivery Hub Token 是否已配置 */
  hubTokenConfigured: boolean;
  /** 跑 wk:* 前从 Hub 拉最新产物 */
  requireBaseline: boolean;
  /** 产物变更推回 Hub */
  requireSync: boolean;
}

/**
 * 写盘输入：路径、地址和 Token 由调用方整份提交。
 *
 * 两个 `require_*` 开关**不在其中**——UI 上已经没有开关（2026-07-28 用户拍板
 * 「这是理应开启的」），写文件时固定 true（见 `applyWkConfig`）。用类型挡住，
 * 免得哪天又从别处漏进一个「关」。
 */
export type WkConfigInput = Pick<
  WkConfig,
  "docRepoPath" | "hubBaseUrl" | "hubToken"
>;

export const EMPTY_WK_CONFIG: WkConfig = {
  docRepoPath: "",
  hubBaseUrl: "",
  hubToken: "",
  hubTokenConfigured: false,
  requireBaseline: false,
  requireSync: false,
};

/**
 * 官方 `TRUE_VALUES`（doc-quality-gate.py / wk-hook-guard.py / wk-state.py 三处同款）。
 * 注意含 `required`——同事手写 `require_sync: required` 时官方按「开」执行，
 * 我们少认这个值就会在 UI 上把开关显示成「关」。
 */
const TRUE_VALUES = new Set(["1", "true", "yes", "on", "required"]);

export const isWkTruthy = (v: string | undefined): boolean =>
  v != null && TRUE_VALUES.has(v.trim().toLowerCase());

/**
 * 按官方口径解析：顶层键不缩进、子键缩进一层。
 * 返回 `{ 顶层键: { 子键: 值 } }`，值已去引号。
 */
export const parseSimpleYaml = (
  raw: string,
): Record<string, Record<string, string>> => {
  const out: Record<string, Record<string, string>> = {};
  let section = "";
  for (const line of raw.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^[ \t]/.test(line)) {
      section = line.split(":", 1)[0]!.trim();
      if (section) out[section] ??= {};
      continue;
    }
    if (!section || !line.includes(":")) continue;
    const idx = line.indexOf(":");
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key) out[section]![key] = value;
  }
  return out;
};

/** 解析结果 → 页面需要的非敏感字段；Token 只返回是否配置 */
export const configFromYaml = (raw: string): WkConfig => {
  const parsed = parseSimpleYaml(raw);
  const hub = parsed["delivery_hub"] ?? {};
  const hubToken = (hub["token"] ?? "").trim();
  return {
    docRepoPath: (parsed["doc_repo"]?.["local_path"] ?? "").trim(),
    hubBaseUrl: (hub["base_url"] ?? "").trim(),
    hubToken,
    hubTokenConfigured: Boolean(hubToken),
    requireBaseline: isWkTruthy(hub["require_baseline"]),
    requireSync: isWkTruthy(hub["require_sync"]),
  };
};

// ---------- 生成侧 ----------

/** 新建段时顺手写一行说明，免得同事看到凭空多出来的段一头雾水 */
const SECTION_COMMENT: Record<string, string> = {
  doc_repo: "# Flowship 写入：wk 流程产物的 WK 产出目录",
  delivery_hub: "# Flowship 写入：团队 Delivery Hub",
};

const DEFAULT_INDENT = "  ";

/** 段内 `  key: value` 行；`m[1]` 缩进、`m[2]` 键（缩进注释不匹配、会被当普通行留着） */
const ENTRY_LINE = /^([ \t]+)([^:#\s][^:]*):/;

/**
 * 值的写法：默认**不加引号**。
 *
 * 官方脚本读值是「冒号后整段 trim + strip 掉首尾引号」、不做反转义——所以加双引号
 * 反而危险：Windows 路径 `C:\Users\x` 用 JSON.stringify 会写成 `"C:\\Users\\x"`、
 * 官方 strip 完拿到的是带双反斜杠的错路径。不加引号则原样回读。
 * 只有「真 YAML 解析器会误读」的形态才用单引号（单引号内反斜杠是字面量、语义仍一致）。
 */
const renderScalar = (raw: string): string => {
  const v = raw.trim();
  if (!v) return "''";
  const needsQuote = /^["'#&*!|>%@`]/.test(v) || v.includes(" #");
  return needsQuote ? `'${v.replace(/'/g, "''")}'` : v;
};

const renderEntry = (
  key: string,
  value: string | boolean,
  indent: string,
): string =>
  `${indent}${key}: ${typeof value === "boolean" ? String(value) : renderScalar(value)}`;

/**
 * 找顶层段的行区间。
 * `end` = 属于该段的最后一行下标（段体 = 后续缩进行；中间夹的空行 / 注释行只有在
 * 后面还有缩进行时才算段内，段尾的空行和注释留给下一段、不吞）。
 */
const findSection = (
  lines: string[],
  name: string,
): { start: number; end: number } | null => {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!line.trim() || /^[ \t]/.test(line) || line.trimStart().startsWith("#")) {
      continue;
    }
    if (line.split(":", 1)[0]!.trim() !== name) continue;
    let end = i;
    for (let j = i + 1; j < lines.length; j += 1) {
      const l = lines[j]!;
      if (!l.trim() || l.trimStart().startsWith("#")) continue;
      if (!/^[ \t]/.test(l)) break;
      end = j;
    }
    return { start: i, end };
  }
  return null;
};

/**
 * 把一个段的托管键写进去：段内认识的键就地改 / 删，不认识的键与注释原样保留；
 * 段不存在就追加到文件末尾；托管键被删光（段里一个键都不剩）就整段移除。
 */
const upsertSection = (
  lines: string[],
  section: string,
  entries: Array<[string, string | boolean | null]>,
): string[] => {
  const found = findSection(lines, section);

  if (!found) {
    const fresh = entries.filter(
      (e): e is [string, string | boolean] => e[1] !== null,
    );
    if (fresh.length === 0) return lines;
    const out = [...lines];
    while (out.length > 0 && !out[out.length - 1]!.trim()) out.pop();
    if (out.length > 0) out.push("");
    out.push(
      SECTION_COMMENT[section]!,
      `${section}:`,
      ...fresh.map(([k, v]) => renderEntry(k, v, DEFAULT_INDENT)),
    );
    return out;
  }

  const managed = new Map(entries);
  const head = lines.slice(0, found.start);
  const body = lines.slice(found.start + 1, found.end + 1);
  const tail = lines.slice(found.end + 1);

  const written = new Set<string>();
  const nextBody: string[] = [];
  // 缩进沿用文件里已有的写法（同事用 4 空格就跟着 4 空格）
  let indent = DEFAULT_INDENT;
  for (const line of body) {
    const m = ENTRY_LINE.exec(line);
    if (m) indent = m[1]!;
    const key = m?.[2]?.trim();
    if (!key || !managed.has(key)) {
      nextBody.push(line);
      continue;
    }
    written.add(key);
    const value = managed.get(key)!;
    if (value !== null) nextBody.push(renderEntry(key, value, indent));
  }
  for (const [key, value] of entries) {
    if (value === null || written.has(key)) continue;
    nextBody.push(renderEntry(key, value, indent));
  }

  // 段里一个键都不剩 → 连段头带我们自己写的那行说明一起删掉
  if (!nextBody.some((l) => ENTRY_LINE.test(l))) {
    while (
      head.length > 0 &&
      head[head.length - 1]!.trim() === SECTION_COMMENT[section]
    ) {
      head.pop();
    }
    return [...head, ...tail];
  }
  return [...head, lines[found.start]!, ...nextBody, ...tail];
};

/**
 * 把配置合进已有文件内容、返回新内容（纯函数、`writeWkConfig` 的核心）。
 *
 * 有地址时 `require_baseline` / `require_sync` **固定写 true**——「运行前拉最新产物」
 * 和「产物变更推回 Hub」是接入 Hub 的题中之义，设置页不再给开关。
 *
 * 地址留空时三个 `delivery_hub` 键一起删：官方 `wk-delivery-baseline.py` 在
 * `require_baseline` 为真但缺 `base_url` 时直接 `FAIL: delivery hub URL missing`、
 * 会把 `wk:*` 命令挡死——留个「开着但没地址」的半截配置比不配还糟。
 * （反过来说，清空地址 = 整段不接入 Hub、baseline 那趟网络请求也不会跑。）
 */
export const applyWkConfig = (existing: string, cfg: WkConfigInput): string => {
  const docPath = cfg.docRepoPath.trim();
  const hubUrl = cfg.hubBaseUrl.trim();
  const hubEntries: Array<[string, string | boolean | null]> = hubUrl
    ? [
        ["base_url", hubUrl],
        ["require_baseline", true],
        ["require_sync", true],
      ]
    : [
        ["base_url", null],
        ["require_baseline", null],
        ["require_sync", null],
      ];

  hubEntries.push(["token", cfg.hubToken.trim() || null]);

  const plan: Array<[string, Array<[string, string | boolean | null]>]> = [
    ["doc_repo", [["local_path", docPath || null]]],
    ["delivery_hub", hubEntries],
  ];

  let lines = existing.split("\n");
  for (const [section, entries] of plan) {
    lines = upsertSection(lines, section, entries);
  }
  const body = lines.join("\n").trim();
  return body ? `${body}\n` : "";
};
