/**
 * 团队库上传 / 镜像推送前的敏感信息扫描（纯函数）
 *
 * 命中返回脱敏片段（前 3 字符 + ***），绝不回传完整原值。
 * force 闸门：误报时由调用方带 force 跳过阻断。
 */

/** 单条命中（脱敏后、可安全回传 API / UI） */
export type SecretScanHit = {
  /** 相对仓库根的路径 */
  file: string;
  /** 1-based 行号；整文件级命中（如 PRIVATE KEY）也标起始行 */
  line: number;
  /** 命中类型（稳定英文枚举，便于单测 / 前端分支） */
  kind:
    | "credential-key"
    | "private-key"
    | "connection-string"
    | "pgpass"
    | "high-entropy";
  /** 脱敏后的上下文片段（含键名提示，不含完整密文） */
  snippet: string;
};

/** 待扫描文件（调用方已跳过二进制 / 已解码为文本） */
export type SecretScanFile = {
  path: string;
  content: string;
};

/** 值脱敏：前 3 字符 + ***（短于 3 则全 ***） */
export const redactSecretValue = (raw: string): string => {
  const s = raw.trim();
  if (s.length === 0) return "***";
  if (s.length <= 3) return "***";
  return `${s.slice(0, 3)}***`;
};

/**
 * 粗判二进制：含 NUL，或非打印字节占比过高。
 * 调用方也可在读盘时用 Buffer 先判；此处兜底纯字符串输入。
 */
export const isProbablyBinaryText = (content: string): boolean => {
  if (content.includes("\0")) return true;
  if (content.length === 0) return false;
  const sample = content.slice(0, 8192);
  let nonPrintable = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    // 允许常见空白；其余 < 32 或 DEL 计为非打印
    if (c === 9 || c === 10 || c === 13) continue;
    if (c < 32 || c === 127) nonPrintable++;
  }
  return nonPrintable / sample.length > 0.1;
};

/**
 * 明显占位符 / 空值 → 不当作真秘密（避免模板 skill 误报）
 * 例：【填写】、<password>、your-api-key、xxx、***、$ENV
 */
export const isPlaceholderSecretValue = (raw: string): boolean => {
  const v = raw.trim();
  if (!v) return true;
  // 去成对引号再判
  const unquoted =
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
      ? v.slice(1, -1).trim()
      : v;
  if (!unquoted) return true;

  const lower = unquoted.toLowerCase();
  if (
    lower === "xxx" ||
    lower === "xxxx" ||
    lower === "todo" ||
    lower === "fixme" ||
    lower === "changeme" ||
    lower === "placeholder" ||
    lower === "example" ||
    lower === "password" ||
    lower === "secret" ||
    lower === "token" ||
    lower === "null" ||
    lower === "undefined" ||
    lower === "none" ||
    lower === "n/a" ||
    lower === "na"
  ) {
    return true;
  }
  // 全 * / • / x 占位
  if (/^[\s*•xX·]+$/.test(unquoted)) return true;
  // 【填写】/【必填】等中文占位
  if (/^【[^】]*】$/.test(unquoted)) return true;
  // <xxx> / <your-password>
  if (/^<[^<>]+>$/.test(unquoted)) return true;
  // your- / your_ 前缀模板
  if (/^your[-_]/i.test(unquoted)) return true;
  // 环境变量引用
  if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(unquoted)) return true;
  // process.env.FOO
  if (/^process\.env\.[A-Za-z_][A-Za-z0-9_]*$/.test(unquoted)) return true;
  return false;
};

/** 高熵长串：≥20、至少两类字符、字符多样性够；排除纯重复 */
export const looksHighEntropySecret = (raw: string): boolean => {
  const s = raw.trim().replace(/^['"]|['"]$/g, "");
  if (s.length < 20) return false;
  if (isPlaceholderSecretValue(s)) return false;
  const hasLower = /[a-z]/.test(s);
  const hasUpper = /[A-Z]/.test(s);
  const hasDigit = /\d/.test(s);
  const hasSpecial = /[^a-zA-Z0-9]/.test(s);
  const classes = [hasLower, hasUpper, hasDigit, hasSpecial].filter(
    Boolean,
  ).length;
  if (classes < 2) return false;
  const unique = new Set(s).size;
  if (unique < Math.min(8, Math.floor(s.length * 0.35))) return false;
  return true;
};

/** 行左侧是否像 hash / commit 语境（高熵规则豁免） */
const isHashContextKey = (left: string): boolean =>
  /(?:^|[\s"'`{,.(])(?:sha(?:-?1|-?256|-?512)?|md5|commit(?:[_-]?hash)?|checksum|hash|etag)\s*$/i.test(
    left.trimEnd(),
  );

/** 键名敏感匹配（password / token / api_key …） */
const CREDENTIAL_KEY_RE =
  /(?:^|[\s"'`{,;])((?:password|passwd|pwd|secret|token|api[_-]?key)[a-z0-9_-]*)\s*[:=]\s*(.+)$/i;

/** BEGIN PRIVATE KEY 块 */
const PRIVATE_KEY_RE = /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/;

/** 带账号密码的连接串 */
const CONN_STRING_RE =
  /(?:(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|https?):\/\/)([^/\s:@]+):([^/\s@]+)@/i;

/** .pgpass：host:port:db:user:pass（host/port 可为 *） */
const PGPASS_RE = /^([^:\s]+):(\*|\d+):([^:]*):([^:]*):(.+)$/;

/** `key = longvalue` / `key: longvalue` 里抽高熵值 */
const HIGH_ENTROPY_ASSIGN_RE =
  /([:=])\s*['"]?([A-Za-z0-9+/=_\-.~]{20,})['"]?/;

const pushHit = (
  hits: SecretScanHit[],
  file: string,
  line: number,
  kind: SecretScanHit["kind"],
  label: string,
  secretPart: string,
): void => {
  hits.push({
    file,
    line,
    kind,
    snippet: `${label}${redactSecretValue(secretPart)}`,
  });
};

/**
 * 扫描待上传文本文件列表，返回命中清单（已脱敏）。
 * 二进制内容应在调用前剔除；此处再兜底跳过。
 */
export const scanSensitiveFiles = (
  files: readonly SecretScanFile[],
): SecretScanHit[] => {
  const hits: SecretScanHit[] = [];

  for (const file of files) {
    if (isProbablyBinaryText(file.content)) continue;
    const lines = file.content.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const lineNo = i + 1;
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) {
        // 注释行仍扫 PRIVATE KEY / 连接串（有人把密钥贴进注释）
        if (PRIVATE_KEY_RE.test(line)) {
          pushHit(hits, file.path, lineNo, "private-key", "PRIVATE KEY ", "BEGIN");
        }
        const connInComment = CONN_STRING_RE.exec(line);
        if (connInComment && !isPlaceholderSecretValue(connInComment[2]!)) {
          pushHit(
            hits,
            file.path,
            lineNo,
            "connection-string",
            "连接串口令 ",
            connInComment[2]!,
          );
        }
        continue;
      }

      // 1) PRIVATE KEY
      if (PRIVATE_KEY_RE.test(line)) {
        pushHit(hits, file.path, lineNo, "private-key", "PRIVATE KEY ", "BEGIN");
      }

      // 2) 连接串 user:pass@
      const conn = CONN_STRING_RE.exec(line);
      if (conn && !isPlaceholderSecretValue(conn[2]!)) {
        pushHit(
          hits,
          file.path,
          lineNo,
          "connection-string",
          "连接串口令 ",
          conn[2]!,
        );
      }

      // 3) .pgpass 五行冒号（整行）
      const pg = PGPASS_RE.exec(trimmed);
      if (pg && !isPlaceholderSecretValue(pg[5]!)) {
        // 排除明显非 pgpass 的 URL / 普通路径（要求 port 为数字或 *）
        pushHit(
          hits,
          file.path,
          lineNo,
          "pgpass",
          "pgpass 口令 ",
          pg[5]!,
        );
      }

      // 4) 敏感键名 = 非占位值
      const keyHit = CREDENTIAL_KEY_RE.exec(line);
      if (keyHit) {
        let value = keyHit[2]!.trim();
        // 截到行内注释 / 尾逗号 JSON
        value = value.replace(/,\s*$/, "").replace(/\s+#.*$/, "").replace(/\s+\/\/.*$/, "");
        // JSON 值可能带尾部 }
        if (
          (value.startsWith('"') && value.includes('"', 1)) ||
          (value.startsWith("'") && value.includes("'", 1))
        ) {
          const q = value[0]!;
          const end = value.indexOf(q, 1);
          if (end > 0) value = value.slice(0, end + 1);
        } else {
          // 无引号：取第一个空白前
          const sp = value.search(/\s/);
          if (sp > 0) value = value.slice(0, sp);
          value = value.replace(/[,;]+$/, "");
        }
        if (!isPlaceholderSecretValue(value)) {
          pushHit(
            hits,
            file.path,
            lineNo,
            "credential-key",
            `${keyHit[1]}=`,
            value.replace(/^['"]|['"]$/g, ""),
          );
        }
      }

      // 5) 高熵赋值（排除 hash/commit 语境）
      const assign = HIGH_ENTROPY_ASSIGN_RE.exec(line);
      if (assign) {
        const left = line.slice(0, assign.index);
        const val = assign[2]!;
        if (!isHashContextKey(left) && looksHighEntropySecret(val)) {
          // 已被 credential-key 覆盖的同行不再重复报高熵
          const already = hits.some(
            (h) =>
              h.file === file.path &&
              h.line === lineNo &&
              h.kind === "credential-key",
          );
          if (!already) {
            pushHit(
              hits,
              file.path,
              lineNo,
              "high-entropy",
              "高熵值 ",
              val,
            );
          }
        }
      }
    }
  }

  return hits;
};

/**
 * 闸门：有命中且未 force → 阻断；force 或无命中 → 放行。
 * 纯函数，便于单测「强制上传」出口。
 */
export const gateSensitiveUpload = (
  hits: readonly SecretScanHit[],
  force: boolean,
): { blocked: false } | { blocked: true; hits: SecretScanHit[] } => {
  if (force || hits.length === 0) return { blocked: false };
  return { blocked: true, hits: [...hits] };
};

/** 一行提示（UI / API error 字段） */
export const formatSensitiveScanError = (hits: readonly SecretScanHit[]): string =>
  `发现 ${hits.length} 处疑似敏感信息，已阻断上传`;
