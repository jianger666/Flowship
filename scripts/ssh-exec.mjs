#!/usr/bin/env node
/**
 * SSH 执行（平台脚本版、跨平台通用）
 *
 * 用法：
 *   node ssh-exec.mjs [--config <company-env.json>] --env <环境名>[:<序号>] [--user <用户>] -- '<远程命令>'
 *   node ssh-exec.mjs --host <主机> [--port <端口>] [--user <用户>] -- '<远程命令>'
 *     --env test:2 表示 test 环境第 2 台服务器（序号从 1 开始）；不写序号取第一台。
 *     --config 显式指定 company-env.json；缺省按 FLOWSHIP_DATA_DIR 或平台数据目录解析。
 *     --env 与 --user 二选一（user 也能在同环境多台里定位，两者同传有歧义）。
 *     -- 之后的整个远程命令必须作为单个带引号的参数传入，否则本地 shell 会先把
 *     引号拆掉、无法安全还原；例如 -- 'grep "hello world" file'。
 *
 * 凭据规则（2026-08-10 用户拍板）：
 *   - `--env`：从公司环境配置（company-env.json）读对应服务器的 user/password 连接；
 *     **只用配置里的密码认证，绝不读取 / 携带本机私钥**（密码失败后再回退去试本机 key，暴露面只会更大）
 *   - `--host`：用本机私钥（~/.ssh/id_ed25519、id_rsa、id_ecdsa）连接，不用密码；主机必须先收录进 known_hosts
 *     （首次用 ssh-keyscan / ssh 核对指纹后写入），防止私钥被中间人套走
 *   - 两种模式都校验 host key：known_hosts 没有该主机或密钥不匹配 → 拒绝连接
 *   - 密码只在本进程内使用，**不进命令行参数 / 日志 / 事件流**
 *   - `--host` 的本机私钥交给 ssh2 前先用 utils.parseKey 预检：带口令 / 解析失败 / 只含公钥的文件直接跳过
 *     （本脚本不交互输入 passphrase，也不使用 ssh-agent）；可用的按文件优先级用 authHandler 逐把尝试，
 *     认证失败时在错误里说明尝试了哪几把、跳过了哪把
 *   - 校验 host key 时，serverHostKey 算法按 known_hosts 里该 host 已记录的 key 类型收窄
 *     （否则服务端同时有多种 key、known_hosts 只记了其中一种时，ssh2 默认偏好序会协商到没记录的那种而被拒）
 *
 * 输出：JSON `{ ok, stdout, stderr, exitCode, error? }`；进程退出码 = 远程命令退出码。
 * 环境变量：`SSH_EXEC_CONFIG` 覆盖 company-env.json 路径（测试用）；`--config` 优先；缺省按 FLOWSHIP_DATA_DIR。
 *   `SSH_EXEC_TIMEOUT_MS` 覆盖远程命令执行超时（毫秒，默认 60000；测试用）。
 */

import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createHmac, timingSafeEqual } from "node:crypto";
import os from "node:os";
import path from "node:path";

// createRequire 引入 ssh2：CJS 通道（测试可用 --require preload 拦截；运行时从本脚本
// 位置解析 node_modules 里的 ssh2——standalone 布局由 assemble-server.mjs 显式补包）
const require = createRequire(import.meta.url);
const { Client, utils: ssh2Utils } = require("ssh2");

const CONNECT_TIMEOUT_MS = 15_000;
// 远程命令执行超时；SSH_EXEC_TIMEOUT_MS 仅供测试缩短（非正整数一律忽略、用默认值）
const EXEC_TIMEOUT_MS =
  Number.isInteger(Number(process.env.SSH_EXEC_TIMEOUT_MS)) &&
  Number(process.env.SSH_EXEC_TIMEOUT_MS) > 0
    ? Number(process.env.SSH_EXEC_TIMEOUT_MS)
    : 60_000;
const OUTPUT_CAP = 200_000;

const defaultDataDir = () => {
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "fe-ai-flow",
      "data",
    );
  }
  if (process.platform === "win32") {
    return path.join(
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
      "fe-ai-flow",
      "data",
    );
  }
  return path.join(
    process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"),
    "fe-ai-flow",
    "data",
  );
};

const resolveConfigPath = (explicit) => {
  if (explicit) return explicit;
  if (process.env.SSH_EXEC_CONFIG) return process.env.SSH_EXEC_CONFIG;
  const base = process.env.FLOWSHIP_DATA_DIR || defaultDataDir();
  return path.join(base, "company-env.json");
};

const readServers = async (configPath) => {
  const raw = JSON.parse(await readFile(resolveConfigPath(configPath), "utf8"));
  if (!Array.isArray(raw.servers)) return [];
  return raw.servers
    .filter((s) => !!s && typeof s === "object")
    .map((s) => ({
      env: String(s.env ?? ""),
      host: String(s.host ?? ""),
      port: typeof s.port === "number" ? s.port : 22,
      user: String(s.user ?? ""),
      password:
        typeof s.password === "string" && s.password ? s.password : undefined,
    }))
    .filter((s) => s.host.trim() && s.user.trim());
};

const knownHostsFile = () =>
  process.env.SSH2_KNOWN_HOSTS ||
  path.join(os.homedir(), ".ssh", "known_hosts");

const patternToRegExp = (pattern) => {
  let out = "^";
  for (const ch of pattern) {
    if (ch === "*") out += ".*";
    else if (ch === "?") out += ".";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // 主机名大小写不敏感（OpenSSH 匹配前会把 host 转小写）
  return new RegExp(`${out}$`, "i");
};

/** OpenSSH hashed known_hosts 条目：`|1|base64(salt)|base64(HMAC-SHA1(salt, host))` */
const hashedHostMatches = (field, host) => {
  const parts = field.split("|");
  if (parts.length < 4 || parts[1] !== "1") return false;
  const salt = Buffer.from(parts[2], "base64");
  const expected = Buffer.from(parts[3], "base64");
  if (salt.length === 0 || expected.length === 0) return false;
  const actual = createHmac("sha1", salt).update(host).digest();
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

/**
 * OpenSSH 拿来跟 known_hosts 条目匹配 / 哈希的「主机串」：22 端口是裸 host，其它端口是 `[host]:port`
 * （裸 IPv6 条目因此不会被误当成 host:port；`[host]:22` 显式写法仍认——条目本身点名了端口）。
 * 非 22 端口只会匹配 `[host]:port` 形式的条目，22 端口条目绝不会放行别的端口（fail-closed）。
 */
const knownHostsNames = (host, port) => {
  const h = host.toLowerCase();
  return port === 22 ? [h, `[${h}]:22`] : [`[${h}]:${port}`];
};

/**
 * 解析 known_hosts 的 host 字段：哈希 host（`|1|salt|hash`，不可与逗号列表混用）
 * 或逗号分隔的 pattern 列表（每项各自可带 `!` 取反、通配符、`[host]:port`）
 */
const hostFieldMatches = (field, host, port) => {
  const trimmed = field.trim();
  const names = knownHostsNames(host, port);
  if (trimmed.startsWith("|1|")) {
    return names.some((n) => hashedHostMatches(trimmed, n));
  }
  const hit = (pattern) => {
    const re = patternToRegExp(pattern);
    return names.some((n) => re.test(n));
  };
  const patterns = trimmed.split(",").filter(Boolean);
  if (patterns.some((p) => p.startsWith("!") && hit(p.slice(1)))) {
    // 负匹配命中：无论其它正条目怎么配都拒绝
    return false;
  }
  return patterns.some((p) => !p.startsWith("!") && hit(p));
};

/** known_hosts 行格式：`[marker] hostnames keytype base64-key [comment]` */
const parseKnownHosts = (text) => {
  const entries = { regular: [], revoked: [], certAuthority: [] };
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const fields = line.split(/\s+/);
    if (fields.length < 3) continue;
    let marker;
    let idx = 0;
    if (fields[0].startsWith("@")) {
      marker = fields[0];
      idx = 1;
    }
    const entry = {
      host: fields[idx],
      keyType: fields[idx + 1],
      keyB64: fields[idx + 2],
    };
    if (!entry.host || !entry.keyType || !entry.keyB64) continue;
    if (marker === "@revoked") {
      entries.revoked.push(entry);
    } else if (marker === "@cert-authority") {
      entries.certAuthority.push(entry);
    } else if (!marker) {
      entries.regular.push(entry);
    }
    // 其它未知 marker 保守跳过：不当作普通主机条目、也不放行
  }
  return entries;
};

const loadKnownHosts = () => {
  const file = knownHostsFile();
  try {
    return { file, parsed: parseKnownHosts(readFileSync(file, "utf8")) };
  } catch {
    return { file, parsed: null };
  }
};

/** ssh2 的 hostVerifier 收到 raw key blob（含算法名的二进制），与 known_hosts base64 解码逐字节比 */
const hostKeyAccepted = (known, host, port, key) => {
  if (!known) return false;
  const offered = Buffer.isBuffer(key)
    ? key
    : Buffer.from(String(key ?? ""), "utf8");
  const matches = (entry) =>
    hostFieldMatches(entry.host, host, port) &&
    Buffer.from(entry.keyB64, "base64").equals(offered);
  // @revoked 优先级最高：即使同一把 key 也写进了普通条目，仍拒绝
  if (known.revoked.some(matches)) return false;
  if (known.regular.some(matches)) return true;
  // @cert-authority 需要完整证书链校验，这里不伪支持；保守拒绝
  return false;
};

/** ssh2 serverHostKey 的默认偏好序（不含 ssh-dss）；收窄时在这个顺序上过滤，保持与默认一致的优先级 */
const HOST_KEY_ALGO_ORDER = [
  "ssh-ed25519",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "rsa-sha2-512",
  "rsa-sha2-256",
  "ssh-rsa",
];

/** known_hosts 的 key 类型 → ssh2 serverHostKey 算法名（一把 RSA key 对应三种签名算法）；不认识的类型 → 空 */
const algosOfKeyType = (keyType) =>
  keyType === "ssh-rsa"
    ? ["rsa-sha2-512", "rsa-sha2-256", "ssh-rsa"]
    : HOST_KEY_ALGO_ORDER.includes(keyType)
      ? [keyType]
      : [];

/** known_hosts 里**匹配该 host:port 的普通条目**记录的 key 类型（@revoked / @cert-authority 不算） */
const knownHostKeyTypes = (known, host, port) => {
  if (!known) return [];
  const types = new Set();
  for (const entry of known.regular) {
    if (hostFieldMatches(entry.host, host, port)) types.add(entry.keyType);
  }
  return [...types];
};

/**
 * 按已记录的 key 类型收窄 serverHostKey：只让服务端在「用户已信任的类型」里选，
 * 不再因为 ssh2 默认偏好序先协商到没记录的类型（比如服务端 ed25519 + RSA 都有、known_hosts 只记了 RSA）而被拒。
 * 返回 undefined = 不收窄（host 不在 known_hosts / 只有 revoked、CA、ssh2 不支持的类型）——
 * 此时走默认列表，hostVerifier 照旧 fail-closed 拒绝。收窄只缩小可协商范围，hostVerifier 仍逐字节比对 key，不放宽任何校验。
 */
const hostKeyAlgorithms = (keyTypes) => {
  const wanted = new Set(keyTypes.flatMap(algosOfKeyType));
  const list = HOST_KEY_ALGO_ORDER.filter((a) => wanted.has(a));
  return list.length > 0 ? list : undefined;
};

/** 本机候选私钥文件名（按优先级）；仅 --host 模式使用 */
const LOCAL_KEY_NAMES = ["id_ed25519", "id_rsa", "id_ecdsa"];

/**
 * 预检一把私钥 ssh2 能不能直接用：返回 undefined = 可用，否则返回「跳过原因」。
 * 背景：ssh2 的 Client.connect 对 privateKey 解析失败（含带口令且没给 passphrase）会**同步 throw**，
 * 整条连接都建不起来——所以必须在交给 ssh2 之前自己筛掉。
 * 原因文案只用固定中文，不回显 ssh2 的报错原文 / 任何密钥内容。
 */
const privateKeyUnusableReason = (text) => {
  let parsed;
  try {
    parsed = ssh2Utils.parseKey(text);
  } catch {
    return "无法解析";
  }
  if (parsed instanceof Error) {
    return /passphrase|encrypted/i.test(parsed.message)
      ? "带口令（本脚本无法交互输入 passphrase）"
      : "无法解析（格式不支持或文件损坏）";
  }
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  try {
    // 与 ssh2 connect 的校验一致：只含公钥的文件 getPrivatePEM() 为 null，会被 ssh2 整体拒绝
    if (!key || key.getPrivatePEM() === null) return "不含有效私钥";
  } catch {
    return "无法解析";
  }
  return undefined;
};

/**
 * 读本机 ~/.ssh 下所有候选私钥，**按文件优先级返回全部 ssh2 能直接用的**（`keys`，交给 authHandler 逐把尝试）；
 * 带口令 / 解析失败 / 只含公钥的跳过并记录（`skipped`，只记文件名 + 原因，不含任何密钥内容）。
 * 只在 --host 模式调用：--env 模式不读本机私钥。
 */
const localPrivateKeys = async () => {
  const keys = [];
  const skipped = [];
  for (const name of LOCAL_KEY_NAMES) {
    let text;
    try {
      text = await readFile(path.join(os.homedir(), ".ssh", name), "utf8");
    } catch {
      continue; // 文件不存在 / 不可读：试下一个
    }
    const reason = privateKeyUnusableReason(text);
    if (reason === undefined) keys.push({ name, text });
    else skipped.push({ name, reason });
  }
  return { keys, skipped };
};

/**
 * 认证失败的提示（不含任何凭据内容）：
 * - --env：只用环境配置里的密码，提示去检查配置；不提本机私钥
 * - --host：只用本机私钥，说明按顺序尝试了哪几把 / 跳过了哪几把；没有可用私钥时说明本脚本不支持口令私钥与 ssh-agent
 */
const authFailureHint = (mode, { keys, skipped }) => {
  if (mode === "env") {
    return "——检查环境配置里该服务器的用户名 / 密码（设置页 → 连接 → 环境配置 → 服务器）；--env 模式只用配置里的密码认证，不使用本机私钥";
  }
  const skippedText = skipped.length
    ? `；已跳过不可用的本机私钥：${skipped.map((s) => `${s.name}（${s.reason}）`).join("、")}`
    : "";
  if (keys.length === 0) {
    return `——未找到可用的本机私钥（${LOCAL_KEY_NAMES.map((n) => `~/.ssh/${n}`).join(" / ")}）；本脚本只用无口令私钥，不支持带口令私钥和 ssh-agent${skippedText}`;
  }
  return `——已按顺序尝试本机私钥 ${keys.map((k) => k.name).join("、")}，均被服务器拒绝；请确认对应公钥已写入服务器（ssh-copy-id）${skippedText}`;
};

/** 累积阶段就限流：达到上限后丢弃后续 chunk，避免大输出或挂起时内存暴涨 */
const appendCapped = (current, chunk, overflow) => {
  if (overflow) return { text: current, overflow: true };
  const remaining = OUTPUT_CAP - current.length;
  if (chunk.length <= remaining) {
    return { text: current + chunk, overflow: false };
  }
  return {
    text: `${current}${chunk.slice(0, remaining)}\n…（输出已截断）`,
    overflow: true,
  };
};

const ALLOWED_FLAGS = new Set(["config", "env", "host", "port", "user"]);

/** 解析 --env 的 `环境名[:序号]`：序号 1 起，只认末尾数字（环境名本身可含冒号） */
const parseEnvSelector = (raw) => {
  const value = String(raw ?? "").trim();
  const m = /^(.+):(\d+)$/.exec(value);
  if (!m) return { env: value, index: undefined };
  const index = Number(m[2]);
  if (index < 1) {
    return { error: `--env 的服务器序号从 1 开始（收到 ${m[2]}）` };
  }
  return { env: m[1], index };
};

/** 解析 CLI：只认白名单 flag；第一个 `--` 之后必须是单个带引号的远程命令参数 */
const parseArgs = (argv) => {
  const flags = {};
  const rest = [];
  let i = 0;
  let afterSep = false;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      if (afterSep) {
        rest.push(a);
        continue;
      }
      afterSep = true;
      continue;
    }
    if (!afterSep && a.startsWith("--")) {
      const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
      if (!m || !ALLOWED_FLAGS.has(m[1])) {
        return {
          error: `未知参数 ${a}（只支持 --config/--env/--host/--port/--user，远程命令放 -- 后）`,
        };
      }
      const name = m[1];
      let value = m[2];
      if (value === undefined) {
        const next = argv[i + 1];
        if (
          next === undefined ||
          next === "--" ||
          (next.startsWith("--") && /^--[a-z]/.test(next))
        ) {
          return { error: `参数 --${name} 缺值` };
        }
        value = next;
        i++;
      }
      flags[name] = value;
      continue;
    } else {
      if (!afterSep) {
        return { error: `裸参数 ${a} 不被支持（远程命令放在 -- 后）` };
      }
      rest.push(a);
    }
  }

  const cmd = rest.join(" ").trim();
  if (rest.length > 1) {
    return {
      error:
        "远程命令必须作为单个带引号的参数传入（-- '<remote command>'）；多个 token 的引号已被 shell 拆掉，无法安全还原",
    };
  }
  const host = flags.host?.trim() ?? "";
  const user = flags.user?.trim() ?? "";
  const config = flags.config?.trim() ?? "";
  if (flags.config !== undefined && !config) {
    return { error: "--config 不能为空" };
  }
  let env = flags.env?.trim() ?? "";
  let envIndex;
  if (env) {
    const parsed = parseEnvSelector(env);
    if (parsed.error) return { error: parsed.error };
    env = parsed.env;
    envIndex = parsed.index;
  }
  if (env && host) return { error: "--env 与 --host 不能同时使用" };
  if (!env && !host) return { error: "必须给 --env 或 --host 之一" };
  if (envIndex !== undefined && user) {
    return { error: "--user 与 --env 的 :n 序号二选一（序号已定位到具体服务器）" };
  }
  let port;
  if (flags.port !== undefined) {
    if (!host) {
      return { error: "--port 只在 --host 模式生效（--env 从配置读端口）" };
    }
    port = Number(flags.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { error: `--port 必须是 1-65535 的整数（收到 ${flags.port}）` };
    }
  }
  if (!cmd) return { error: "`--` 后必须给远程命令" };
  return { config, env, envIndex, host, port, user, cmd };
};

/**
 * 受限运行身份（设计上：需求群非属主「旁路答疑」agent 的子进程环境会带 `FLOWSHIP_RUN_KIND=restricted`）。
 * 目前没有任何路径设置该变量（受限 agent 没有 shell 工具、Cursor SDK 也没有 env 选项），这里是纵深防御占位；
 * 哪天给受限 agent 放开 shell，必须先把注入点接上。
 * 该身份下本脚本一律拒绝——不看 --env / --host、不读配置、不连任何机器：
 * 群里任何人 @ 机器人都能驱动旁路 agent，不能让它拿公司环境密码（--env）或属主本机私钥（--host）去登服务器。
 * ⚠️ 这是纵深防御、不是边界：环境变量由调用方进程树继承，能 `env -u FLOWSHIP_RUN_KIND` 的 shell 可以绕过；
 * 主防线是受限 agent 根本没有 shell 工具、且 prompt 里不给 company-env.json 路径 / 本脚本用法。
 */
// 注意：本脚本顶层直接 main()（无 isDirectRun 守卫），所以这里不 export——测试走子进程（见 tests/restricted-run-scripts.test.ts）
const isRestrictedRun = (env = process.env) =>
  String(env.FLOWSHIP_RUN_KIND ?? "").trim().toLowerCase() === "restricted";

const RESTRICTED_REFUSAL =
  "受限身份（群答疑旁路）禁止使用 ssh-exec：不能通过 SSH 登录任何服务器。请把需要执行的操作转给任务属主确认";

const main = async () => {
  if (isRestrictedRun()) {
    console.log(
      JSON.stringify({
        ok: false,
        stdout: "",
        stderr: "",
        exitCode: 1,
        error: RESTRICTED_REFUSAL,
      }),
    );
    process.exitCode = 1;
    return;
  }
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.log(
      JSON.stringify({ ok: false, stdout: "", stderr: "", exitCode: 1, error: args.error }),
    );
    process.exitCode = 1;
    return;
  }

  let connectOpts;
  if (args.host) {
    // 任意主机：本机密钥
    connectOpts = {
      host: args.host,
      port: args.port ?? 22,
      user: args.user ?? os.userInfo().username,
    };
  } else {
    // 公司环境：从配置读凭据
    const servers = await readServers(args.config);
    const inEnv = servers.filter((s) => s.env === args.env);
    const entry = args.user
      ? inEnv.find((s) => s.user === args.user)
      : args.envIndex !== undefined
        ? inEnv[args.envIndex - 1]
        : inEnv[0];
    if (!entry) {
      const indexLabel = args.envIndex !== undefined ? `[${args.envIndex}]` : "";
      console.log(
        JSON.stringify({
          ok: false,
          stdout: "",
          stderr: "",
          exitCode: 1,
          error: `服务器配置不存在（env=${args.env}${indexLabel}${args.user ? `, user=${args.user}` : ""}）；去设置页 → 连接 → 环境配置 → 服务器 检查`,
        }),
      );
      process.exitCode = 1;
      return;
    }
    connectOpts = {
      host: entry.host,
      port: entry.port,
      user: entry.user,
      password: entry.password,
    };
  }

  const mode = args.host ? "host" : "env";
  // 只有 --host 模式才读本机私钥；--env 模式只用配置里的密码（不读 ~/.ssh，也就没有「回退去试别的 key」）
  const localKeys =
    mode === "host" ? await localPrivateKeys() : { keys: [], skipped: [] };
  const knownHosts = loadKnownHosts();
  const knownKeyTypes = knownHostKeyTypes(
    knownHosts.parsed,
    connectOpts.host,
    connectOpts.port,
  );
  const serverHostKey = hostKeyAlgorithms(knownKeyTypes);
  const conn = new Client();
  const result = await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let stdoutOverflow = false;
    let stderrOverflow = false;
    let exitCode = null;
    let settled = false;
    let timer;

    const settle = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        conn.end();
      } catch {
        // end 失败不阻塞结果返回
      }
      const destroy = () => {
        try {
          conn.destroy();
        } catch {
          // 已销毁 / 无 socket：忽略
        }
      };
      if (r.ok) {
        // 成功路径保持优雅关闭；对端迟迟不断 TCP 时 1s 后强制 destroy，不让已打印 JSON 的进程挂住
        //（unref：正常退出时不被这个定时器拖住）
        setTimeout(destroy, 1000).unref();
      } else {
        // 超时 / 连接 / 通道错误：连接可能是半死的——end() 只是礼貌地发 DISCONNECT，
        // 对端不响应时 socket 不会关、会把本进程留在事件循环里，所以直接 destroy 兜底
        destroy();
      }
      resolve(r);
    };

    conn.on("ready", () => {
      timer = setTimeout(
        () =>
          settle({
            ok: false,
            stdout,
            stderr,
            exitCode,
            error: "SSH 命令执行超时",
          }),
        EXEC_TIMEOUT_MS,
      );
      conn.exec(args.cmd, (err, stream) => {
        if (err || !stream) {
          settle({
            ok: false,
            stdout,
            stderr,
            exitCode,
            error: `远程命令执行失败：${err?.message ?? "未知错误"}`,
          });
          return;
        }
        stream.on("data", (d) => {
          const next = appendCapped(stdout, d.toString(), stdoutOverflow);
          stdout = next.text;
          stdoutOverflow = next.overflow;
        });
        stream.stderr.on("data", (d) => {
          const next = appendCapped(stderr, d.toString(), stderrOverflow);
          stderr = next.text;
          stderrOverflow = next.overflow;
        });
        const streamError = (err) => {
          settle({
            ok: false,
            stdout,
            stderr,
            exitCode,
            error: `远程命令执行失败：${err?.message ?? String(err)}`,
          });
        };
        stream.on("error", streamError);
        stream.stderr.on("error", streamError);
        stream.on("close", (code) => {
          exitCode = code ?? null;
          settle({
            ok: exitCode === 0,
            stdout,
            stderr,
            exitCode,
          });
        });
      });
    });

    conn.on("error", (err) => {
      const msg = err.message ?? String(err);
      // hostVerifier 返回 false 时 ssh2 报 `Host denied (verification failed)`；
      // 握手里的「signature verification failed」是签名校验失败、不是 known_hosts 的问题，别混在一起
      const hint = /host denied|host key verification/i.test(msg)
        ? knownHosts.parsed?.certAuthority?.length
          ? `——known_hosts 未匹配到普通 key（${knownHosts.file}）；@cert-authority 证书校验暂不支持，请先写入具体 key`
          : `——known_hosts 未收录该主机或密钥不匹配（${knownHosts.file}），先核对指纹再写入；非 22 端口的条目要写成 [host]:port${connectOpts.port === 22 ? "" : `（本次端口 ${connectOpts.port}，条目应为 [${connectOpts.host}]:${connectOpts.port} <key 类型> <key>）`}`
        : /no matching host key format/i.test(msg)
          ? `——服务端没有提供 known_hosts 里已记录的 host key 类型（${knownKeyTypes.join("、") || "无记录"}），可能服务器换过 key；用 ssh-keyscan 重新核对指纹后写入 known_hosts（${knownHosts.file}）`
          : msg.includes("authentication")
            ? authFailureHint(mode, localKeys)
            : "";
      settle({
        ok: false,
        stdout,
        stderr,
        exitCode,
        error: `SSH 连接失败（${connectOpts.host}:${connectOpts.port}）：${msg}${hint}`,
      });
    });

    try {
      conn.connect({
        host: connectOpts.host,
        port: connectOpts.port,
        username: connectOpts.user,
        password: connectOpts.password,
        // --host：本机私钥逐把交给 ssh2 尝试（privateKey 选项一次只能给一把，authHandler 数组才能按顺序逐把试；
        // 前一把被服务器拒绝才会试下一把，无效的 key ssh2 会自己跳过）
        ...(localKeys.keys.length > 0
          ? {
              authHandler: localKeys.keys.map((k) => ({
                type: "publickey",
                username: connectOpts.user,
                key: k.text,
              })),
            }
          : {}),
        ...(serverHostKey ? { algorithms: { serverHostKey } } : {}),
        hostVerifier: (key) =>
          hostKeyAccepted(
            knownHosts.parsed,
            connectOpts.host,
            connectOpts.port,
            key,
          ),
        readyTimeout: CONNECT_TIMEOUT_MS,
      });
    } catch (err) {
      // ssh2 的 connect 会对非法配置同步 throw（key 解析失败、算法名不支持等）：
      // 走约定 JSON 的连接失败，而不是外层 catch 的「脚本异常」
      settle({
        ok: false,
        stdout,
        stderr,
        exitCode,
        error: `SSH 连接失败（${connectOpts.host}:${connectOpts.port}）：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  console.log(JSON.stringify(result));
  process.exitCode = result.exitCode ?? 1;
};

main().catch((err) => {
  console.log(
    JSON.stringify({
      ok: false,
      stdout: "",
      stderr: "",
      exitCode: 1,
      error: `脚本异常：${err instanceof Error ? err.message : String(err)}`,
    }),
  );
  process.exitCode = 1;
});
