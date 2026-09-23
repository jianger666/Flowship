/**
 * Bash 治理 allowlist 初稿（v3.1 §5.3，件套③）。
 *
 * - 规则 1 只读自由：cat/ls/grep/git status 等纯读；
 * - 规则 2 本地写 = 记账（checkpoint 恢复）、不落 intent（封版纪要修订三1）；
 * - 规则 3 目录围栏：工作目录 + 数据目录之外拒绝；
 * - 规则 4 外发网络 = PATH shim 强制 intent（第一层，精确）+ 命令串启发式兜底（第二层）；
 * - 残余风险（绝对路径/自备二进制绕 shim）列为已知边界，实验 B 判 (c)/(d) 后定是否升级禁用。
 */

export const READONLY_BINARIES = new Set([
  "cat", "ls", "echo", "grep", "rg", "head", "tail", "wc", "diff",
  "git",
]);

export const READONLY_GIT_VERBS = new Set([
  "status", "log", "diff", "show", "rev-parse", "branch", "fetch",
]);

/** 第一层 PATH shim 覆盖的外发二进制（无论命令串怎么变形，以名字解析执行即进 wrapper）。 */
export const EGRESS_BINARIES = new Set([
  "curl", "wget", "ssh", "scp", "nc", "rsync",
]);

export type BashVerdict =
  | { action: "allow-read" }
  | { action: "account-local-write" }
  | { action: "require-intent"; via: "path-shim" | "string-match" }
  | { action: "deny"; reason: "dir-fence" | "egress-uncovered" };

/**
 * B6 残余风险声明（诚实列全，作为将来评估禁用 bash 的对照基准）：
 * 1. 绝对路径调用（/usr/bin/curl）——串解析兜底抓；
 * 2. 自备/静态链接二进制绕过 shim——已知边界，实验 B 判 (d) 后定是否升级禁用；
 * 3. 解释器内联外发（python3 -c 'urllib…' / node -e 'fetch(…)' / ruby/php/perl 同理）——
 *    不经过 EGRESS 二进制名，靠下述 INLINE_EGRESS_RE 启发式抓，漏网即残余；
 * 以上已接受（封版拍板②：先按 (c)+(d) 兜底开工），声明列全不假装没有。
 */
const INLINE_EGRESS_RE =
  /\b(python3?|node|deno|bun|ruby|php|perl)\b[^\n]*(-c|-e|urllib|http\.client|fetch\(|XMLHttpRequest|socket)/i;

const basenameOf = (cmd: string): string => {
  const t = cmd.trim().split(/\s+/)[0] ?? "";
  const b = t.split("/").pop() ?? t;
  return b;
};

const containsEgressName = (command: string): boolean => {
  const lower = command.toLowerCase();
  for (const b of EGRESS_BINARIES) {
    // 启发式：词边界出现即命中（抓 `curl ...`、`$(curl)`、`/usr/bin/curl` 等；变形执行仍由 shim 层兜底）。
    if (new RegExp(`(^|[^a-z])${b}([^a-z]|$)`, "i").test(lower)) return true;
  }
  return false;
};

/**
 * 纯判定：给定 bash 命令串 + 允许目录前缀，返回处置。
 * - git 纯读动词 → allow-read；其余 git 写操作 → account-local-write；
 * - 外发二进制（shim 名单）→ require-intent via path-shim；
 * - 命令串命中外发但走绝对路径等 → require-intent via string-match；
 * - 目标路径超出围栏 → deny。
 */
export const judgeBashCommand = (
  command: string,
  allowedDirs: string[],
  opts: { hasAbsolutePathBypass?: boolean } = {},
): BashVerdict => {
  const cmd = command.trim();
  if (!cmd) return { action: "allow-read" };
  const base = basenameOf(cmd);

  // 目录围栏：出现 `..` 跳出或绝对路径不在允许前缀内 → 拒绝（启发式，精确围栏由 wrapper 层执行）。
  if (/\.\.\//.test(cmd)) return { action: "deny", reason: "dir-fence" };
  const absMatch = cmd.match(/(^|\s)(\/(?:[^\s'"]+))/g);
  if (absMatch) {
    for (const m of absMatch) {
      const p = m.trim();
      // EGRESS 二进制的绝对路径调用是已知残余（串解析兜底抓，见 §5.3），不直接 deny。
      if ([...EGRESS_BINARIES].some((b) => p.endsWith(`/${b}`))) continue;
      const inside = allowedDirs.some((d) => p === d || p.startsWith(`${d}/`));
      if (!inside && !p.startsWith("/usr/bin/") && !p.startsWith("/bin/")) {
        return { action: "deny", reason: "dir-fence" };
      }
    }
  }

  if (EGRESS_BINARIES.has(base)) return { action: "require-intent", via: "path-shim" };
  // B6：解释器内联外发同样进 intent（启发式，漏网列为残余风险）。
  if (INLINE_EGRESS_RE.test(cmd)) return { action: "require-intent", via: "string-match" };
  if (containsEgressName(cmd) || opts.hasAbsolutePathBypass) {
    return { action: "require-intent", via: "string-match" };
  }
  if (base === "git") {
    const verb = cmd.split(/\s+/)[1] ?? "";
    if (READONLY_GIT_VERBS.has(verb)) return { action: "allow-read" };
    return { action: "account-local-write" };
  }
  if (READONLY_BINARIES.has(base)) return { action: "allow-read" };
  // 默认：本地写记账（checkpoint 恢复），不落 intent。
  return { action: "account-local-write" };
};
