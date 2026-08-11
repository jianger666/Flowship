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
 *   - `--env`：从公司环境配置（company-env.json）读对应服务器的 user/password 连接
 *   - `--host`：用本机密钥（~/.ssh）连接；主机必须先收录进 known_hosts
 *     （首次用 ssh-keyscan / ssh 核对指纹后写入），防止私钥被中间人套走
 *   - 两种模式都校验 host key：known_hosts 没有该主机或密钥不匹配 → 拒绝连接
 *   - 密码只在本进程内使用，**不进命令行参数 / 日志 / 事件流**
 *   - 同时传 password + privateKey，ssh2 默认认证顺序（password → privateKey）会
 *     在密码失败时回退本机密钥
 *
 * 输出：JSON `{ ok, stdout, stderr, exitCode, error? }`；进程退出码 = 远程命令退出码。
 * 环境变量：`SSH_EXEC_CONFIG` 覆盖 company-env.json 路径（测试用）；`--config` 优先；缺省按 FLOWSHIP_DATA_DIR。
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
const { Client } = require("ssh2");

const CONNECT_TIMEOUT_MS = 15_000;
const EXEC_TIMEOUT_MS = 60_000;
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
  return new RegExp(`${out}$`);
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

/** 解析 known_hosts 的 host 字段（逗号列表 / [host]:port / 哈希 host） */
const hostFieldMatches = (field, host, port) => {
  const trimmed = field.trim();
  let hostPart = trimmed;
  let entryPort = 22;
  const bracketed = /^\[(.+)\]:(\d+)$/.exec(trimmed);
  const plainPort = /^(.+):(\d+)$/.exec(trimmed);
  if (bracketed) {
    hostPart = bracketed[1];
    entryPort = Number(bracketed[2]);
  } else if (plainPort) {
    hostPart = plainPort[1];
    entryPort = Number(plainPort[2]);
  }
  if (port !== entryPort) return false;
  if (hostPart.startsWith("|1|")) return hashedHostMatches(hostPart, host);
  const patterns = hostPart.split(",").filter(Boolean);
  if (patterns.some((p) => p.startsWith("!") && patternToRegExp(p.slice(1)).test(host))) {
    // 负匹配命中：无论其它正条目怎么配都拒绝
    return false;
  }
  return patterns.some((p) => !p.startsWith("!") && patternToRegExp(p).test(host));
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

const localPrivateKey = async () => {
  for (const name of ["id_ed25519", "id_rsa", "id_ecdsa"]) {
    try {
      return await readFile(path.join(os.homedir(), ".ssh", name), "utf8");
    } catch {
      // 试下一个
    }
  }
  return undefined;
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

const main = async () => {
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

  const privateKey = await localPrivateKey();
  const knownHosts = loadKnownHosts();
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
      conn.end();
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
      const hint = msg.includes("verification")
        ? knownHosts.parsed?.certAuthority?.length
          ? `——known_hosts 未匹配到普通 key（${knownHosts.file}）；@cert-authority 证书校验暂不支持，请先写入具体 key`
          : `——known_hosts 未收录该主机或密钥不匹配（${knownHosts.file}），先核对指纹再写入`
        : msg.includes("authentication")
          ? "——检查服务器密码或本机密钥（ssh-copy-id）"
          : "";
      settle({
        ok: false,
        stdout,
        stderr,
        exitCode,
        error: `SSH 连接失败（${connectOpts.host}:${connectOpts.port}）：${msg}${hint}`,
      });
    });

    conn.connect({
      host: connectOpts.host,
      port: connectOpts.port,
      username: connectOpts.user,
      password: connectOpts.password,
      privateKey,
      hostVerifier: (key) =>
        hostKeyAccepted(
          knownHosts.parsed,
          connectOpts.host,
          connectOpts.port,
          key,
        ),
      readyTimeout: CONNECT_TIMEOUT_MS,
    });
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
