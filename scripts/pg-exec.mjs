#!/usr/bin/env node
/**
 * PostgreSQL 查询（平台脚本版，对齐 ssh-exec）
 *
 * 用法：
 *   node pg-exec.mjs [--config <company-env.json>] --env <环境名>[:<序号>] [--user <用户>] [--database <库名>] -- '<SQL>'
 *     --env test:2 表示 test 环境第 2 个实例（序号从 1 开始）；不写序号取第一条。
 *     --config 显式指定 company-env.json；缺省按 FLOWSHIP_DATA_DIR 或平台数据目录解析。
 *     --user 与 --env 的 :n 序号二选一。
 *     --database 可选；不传则用该实例的用户名（PostgreSQL 默认）。
 *     -- 之后的整条 SQL 必须作为单个带引号的参数传入。
 *
 * 凭据从 company-env.json 读取，**不进命令行 / 日志 / 输出 JSON**。
 * 实例 readonly（缺省 true）时硬挡写语句（INSERT/UPDATE/DELETE/DDL 等）。
 *
 * 输出：JSON `{ ok, stdout, stderr, exitCode, rowCount?, error? }`；
 * stdout 是 rows 的 JSON 文本。环境变量 `PG_EXEC_CONFIG` 覆盖配置路径（测试用）。
 */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { Client } = require("pg");

const CONNECT_TIMEOUT_MS = 15_000;
const QUERY_TIMEOUT_MS = 60_000;
const OUTPUT_CAP = 200_000;

const WRITE_RE =
  /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|DROP|CREATE|ALTER|GRANT|REVOKE|COPY|VACUUM|REINDEX|CLUSTER|REFRESH|CALL|DO|LOCK|COMMENT)\b/i;

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
  if (process.env.PG_EXEC_CONFIG) return process.env.PG_EXEC_CONFIG;
  const base = process.env.FLOWSHIP_DATA_DIR || defaultDataDir();
  return path.join(base, "company-env.json");
};

const readPgInstances = async (configPath) => {
  const raw = JSON.parse(await readFile(resolveConfigPath(configPath), "utf8"));
  if (!Array.isArray(raw.pg)) return [];
  return raw.pg
    .filter((p) => !!p && typeof p === "object")
    .map((p) => ({
      env: String(p.env ?? ""),
      host: String(p.host ?? ""),
      port: typeof p.port === "number" ? p.port : 5432,
      user: String(p.user ?? ""),
      password:
        typeof p.password === "string" && p.password ? p.password : undefined,
      // 缺省只读（与 CompanyEnvPg / 表单默认对齐）
      readonly: p.readonly !== false,
    }))
    .filter((p) => p.host.trim());
};

/** 去掉注释后再扫写关键字，避免 `-- INSERT` 注释误伤；WITH … INSERT 仍能拦住 */
const isWriteSql = (sql) => {
  const stripped = String(sql)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");
  return WRITE_RE.test(stripped);
};

const ALLOWED_FLAGS = new Set(["config", "env", "user", "database"]);

const parseEnvSelector = (raw) => {
  const value = String(raw ?? "").trim();
  const m = /^(.+):(\d+)$/.exec(value);
  if (!m) return { env: value, index: undefined };
  const index = Number(m[2]);
  if (index < 1) {
    return { error: `--env 的实例序号从 1 开始（收到 ${m[2]}）` };
  }
  return { env: m[1], index };
};

const parseArgs = (argv) => {
  const flags = {};
  const rest = [];
  let afterSep = false;
  for (let i = 0; i < argv.length; i++) {
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
          error: `未知参数 ${a}（只支持 --config/--env/--user/--database，SQL 放 -- 后）`,
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
    }
    if (!afterSep) {
      return { error: `裸参数 ${a} 不被支持（SQL 放在 -- 后）` };
    }
    rest.push(a);
  }

  if (rest.length > 1) {
    return {
      error:
        "SQL 必须作为单个带引号的参数传入（-- '<SQL>'）；多个 token 的引号已被 shell 拆掉，无法安全还原",
    };
  }
  const sql = rest.join(" ").trim();
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
  if (!env) return { error: "必须给 --env" };
  const user = flags.user?.trim() ?? "";
  if (envIndex !== undefined && user) {
    return { error: "--user 与 --env 的 :n 序号二选一（序号已定位到具体实例）" };
  }
  const database = flags.database?.trim() ?? "";
  if (!sql) return { error: "`--` 后必须给 SQL" };
  return { config, env, envIndex, user, database, sql };
};

const fail = (error) => {
  console.log(
    JSON.stringify({ ok: false, stdout: "", stderr: "", exitCode: 1, error }),
  );
  process.exitCode = 1;
};

const capText = (text) => {
  if (text.length <= OUTPUT_CAP) return text;
  return `${text.slice(0, OUTPUT_CAP)}\n…（输出已截断）`;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    fail(args.error);
    return;
  }

  const instances = await readPgInstances(args.config);
  const inEnv = instances.filter((p) => p.env === args.env);
  const entry = args.user
    ? inEnv.find((p) => p.user === args.user)
    : args.envIndex !== undefined
      ? inEnv[args.envIndex - 1]
      : inEnv[0];
  if (!entry) {
    const indexLabel = args.envIndex !== undefined ? `[${args.envIndex}]` : "";
    fail(
      `PostgreSQL 配置不存在（env=${args.env}${indexLabel}${args.user ? `, user=${args.user}` : ""}）；去设置页 → 连接 → 环境配置 → PostgreSQL 检查`,
    );
    return;
  }

  if (entry.readonly && isWriteSql(args.sql)) {
    fail("该实例只读，只允许 SELECT / 只读查询（禁止 INSERT/UPDATE/DELETE/DDL）");
    return;
  }

  const database = args.database || entry.user || "postgres";
  const client = new Client({
    host: entry.host,
    port: entry.port,
    user: entry.user,
    password: entry.password,
    database,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: QUERY_TIMEOUT_MS,
  });

  try {
    await client.connect();
    const result = await client.query(args.sql);
    const rows = Array.isArray(result?.rows) ? result.rows : [];
    const stdout = capText(JSON.stringify(rows, null, 2));
    console.log(
      JSON.stringify({
        ok: true,
        stdout,
        stderr: "",
        exitCode: 0,
        rowCount: typeof result?.rowCount === "number" ? result.rowCount : rows.length,
      }),
    );
    process.exitCode = 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(`PostgreSQL 查询失败（${entry.host}:${entry.port}）：${msg}`);
  } finally {
    await client.end().catch(() => {});
  }
};

main().catch((err) => {
  fail(`脚本异常：${err instanceof Error ? err.message : String(err)}`);
});
