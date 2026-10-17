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
 * 实例 readonly（缺省 true）时：静态扫描挡写语句 + 多语句，并在库侧 `BEGIN READ ONLY` +
 * extended protocol（单语句）强制只读；readonly:false 的实例行为不变。
 *
 * 输出：JSON `{ ok, stdout, stderr, exitCode, rowCount?, error? }`；
 * stdout 是 rows 的 JSON 文本。环境变量 `PG_EXEC_CONFIG` 覆盖配置路径（测试用）。
 */

import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { Client } = require("pg");

const CONNECT_TIMEOUT_MS = 15_000;
const QUERY_TIMEOUT_MS = 60_000;
const OUTPUT_CAP = 200_000;

// ---- 只读 SQL 静态门（本脚本要单文件分发，所以逻辑内联在这里；原先在 src/lib/server 下的 TS 拷贝随只读 shell 守卫在 v1.9.33 删除）----
// 旧实现先正则剥注释再扫关键字，`SELECT '--'; DROP TABLE t` 可绕过。现改词法扫描：按 PostgreSQL 规则
// 识别注释（块注释可嵌套）/ 单引号串（仅 E'..' 认反斜杠转义）/ 双引号标识符 / 美元引用串并抹掉，
// 再扫写关键字、数顶层语句数（只放单条）。这只是第一道防线；实例 readonly 时另在库侧强制只读（见 main）。
/**
 * 写类关键字（含 `SELECT … INTO new_table` 的 INTO）。
 * `COMMENT` 只认「语句开头的 `COMMENT ON`」：`comment` 是极常见的业务表 / 列名（非保留字），裸写 `\bCOMMENT\b` 会把
 * `SELECT comment FROM t` 误拒成「写」，不锚定的 `COMMENT\s+ON` 又会把 `… JOIN comment ON …`（联接条件）误拒（H4-09）；
 * 而 COMMENT 语句文法只有 `COMMENT ON …` 一种形态、且只能做语句的第一个词（两词间只有空白 / 已抹掉的注释），
 * 所以锚在「整段开头或某个 `;` 之后（中间只有空白）」不会放过真 COMMENT 语句；多条语句本来就先被 `statements > 1` 拒掉。
 */
const WRITE_RE =
  /(?:^|;)\s*COMMENT\s+ON\b|\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|DROP|CREATE|ALTER|GRANT|REVOKE|COPY|VACUUM|REINDEX|CLUSTER|REFRESH|CALL|DO|LOCK|INTO)\b/i;

/**
 * 带副作用 / 越权的函数名（匹配「标识符 + 可选空白 + `(`」，大小写不敏感，`schema.` 前缀自然覆盖）。
 * 旁路对 readonly:false 实例没有库侧只读兜底，这些函数在只读事务里也能生效（终止连接、睡眠 DoS、
 * 读服务器文件、改 GUC 解除只读…）或会执行任意 SQL 文本（query_to_xml / dblink），故一律拒。
 */
const SIDE_EFFECT_FN_NAMES = [
  "pg_terminate_backend",
  "pg_cancel_backend",
  "pg_sleep\\w*",
  "pg_\\w*advisory\\w*",
  "setval",
  "nextval",
  "set_config",
  "lo_\\w+",
  "lowrite",
  "pg_read_\\w+",
  "pg_ls_\\w+",
  "pg_stat_file",
  "pg_file_\\w+",
  "pg_reload_conf",
  "pg_rotate_logfile",
  "pg_notify",
  "pg_stat_reset\\w*",
  "pg_logical_\\w+",
  "pg_replication_\\w+",
  "pg_create_\\w+",
  "pg_drop_\\w+",
  "pg_copy_\\w+",
  "pg_promote",
  "pg_switch_wal",
  "pg_wal_replay_\\w+",
  "pg_backup_\\w+",
  "pg_start_backup",
  "pg_stop_backup",
  "pg_import_system_collations",
  "dblink\\w*",
  "query_to_xml\\w*",
  "table_to_xml\\w*",
  "cursor_to_xml\\w*",
  "schema_to_xml\\w*",
  "database_to_xml\\w*",
  "ts_stat",
];
const SIDE_EFFECT_FN_RE = new RegExp(
  `(?<![A-Za-z0-9_$\\u0080-\\uffff])(?:${SIDE_EFFECT_FN_NAMES.join("|")})\\s*\\(`,
  "i",
);

const isIdentChar = (c) =>
  c !== undefined && /[A-Za-z0-9_$\u0080-\uffff]/.test(c);

const DOLLAR_TAG_RE = /^\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/;

export const scanSql = (input) => {
  const sql = String(input);
  let code = "";
  let callCode = "";
  let i = 0;
  let unterminated = false;
  let unicodeIdent = false;
  while (i < sql.length) {
    const c = sql[i];
    const n = sql[i + 1];
    // 行注释
    if (c === "-" && n === "-") {
      // PostgreSQL 词法里 \r 与 \n 都是行尾：`--<CR>; DROP` 的 `;` 已在注释之外
      const eol = sql.slice(i).search(/[\r\n]/);
      i = eol < 0 ? sql.length : i + eol;
      code += " ";
      callCode += " ";
      continue;
    }
    // 块注释（PostgreSQL 允许嵌套）
    if (c === "/" && n === "*") {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      if (depth > 0) unterminated = true;
      code += " ";
      callCode += " ";
      continue;
    }
    // 单引号串：只有 E'..' 才把反斜杠当转义（standard_conforming_strings 默认 on，普通串里 `\` 是字面）
    if (c === "'") {
      const prev = sql[i - 1];
      const escapeString =
        (prev === "E" || prev === "e") && !isIdentChar(sql[i - 2]);
      i++;
      let closed = false;
      while (i < sql.length) {
        if (escapeString && sql[i] === "\\") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) unterminated = true;
      code += "''";
      callCode += "''";
      continue;
    }
    // 双引号标识符（`""` 为转义）
    if (c === '"') {
      if (sql[i - 1] === "&" && /[Uu]/.test(sql[i - 2] ?? "") && !isIdentChar(sql[i - 3])) {
        unicodeIdent = true;
      }
      i++;
      let closed = false;
      let name = "";
      while (i < sql.length) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            name += '"';
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        name += sql[i];
        i++;
      }
      if (!closed) unterminated = true;
      code += '""';
      callCode += ` ${name.replace(/[^A-Za-z0-9_$\u0080-\uffff]/g, "_")}`;
      continue;
    }
    // 美元引用串 $tag$ ... $tag$（`a$b` 这类标识符内的 $ 不算起始）
    if (c === "$" && !isIdentChar(sql[i - 1])) {
      const m = DOLLAR_TAG_RE.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end < 0) {
          unterminated = true;
          i = sql.length;
        } else {
          i = end + tag.length;
        }
        code += "''";
        callCode += "''";
        continue;
      }
    }
    code += c;
    callCode += c;
    i++;
  }
  const statements = code.split(";").filter((s) => s.trim().length > 0).length;
  return { code, callCode, statements, unterminated, unicodeIdent };
};

/** 只读 SQL 判定：单条、词法闭合、无写类关键字才放行 */
export const checkReadonlySql = (sql) => {
  const scan = scanSql(sql);
  if (scan.unterminated) return { ok: false, reason: "unterminated" };
  if (scan.statements === 0) return { ok: false, reason: "empty" };
  if (scan.statements > 1) return { ok: false, reason: "multi" };
  if (WRITE_RE.test(scan.code)) return { ok: false, reason: "write" };
  if (scan.unicodeIdent || SIDE_EFFECT_FN_RE.test(scan.callCode)) {
    return { ok: false, reason: "func" };
  }
  return { ok: true };
};

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

const READONLY_REJECT_REASON = {
  multi: "只允许单条语句（禁止用分号拼多条）",
  unterminated: "SQL 里的引号 / 注释 / $$ 没有闭合",
  empty: "SQL 为空",
  write: "禁止 INSERT/UPDATE/DELETE/DDL/SELECT INTO",
  func: "禁止带副作用 / 越权的函数（pg_terminate_backend、pg_sleep、setval/nextval、pg_read_file、lo_*、dblink、set_config 等）",
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

  if (entry.readonly) {
    const verdict = checkReadonlySql(args.sql);
    if (!verdict.ok) {
      fail(
        `该实例只读，只允许单条 SELECT / 只读查询（${READONLY_REJECT_REASON[verdict.reason]}）`,
      );
      return;
    }
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
    let result;
    if (entry.readonly) {
      // 库侧强制只读（不依赖上面的静态扫描）：
      // ① BEGIN READ ONLY：写操作 / DDL 由服务端拒绝；
      // ② extended protocol（Parse/Bind）：服务端只接受单条语句，`a; b`、`COMMIT; DROP ...`、
      //    `SET TRANSACTION READ WRITE; ...` 这类多语句拼接直接报错——用户语句里即使有
      //    COMMIT / SET ... READ WRITE，也是本事务里的最后一条、之后没有可执行的写。
      await client.query("BEGIN READ ONLY");
      try {
        result = await client.query({ text: args.sql, queryMode: "extended" });
      } finally {
        await client.query("ROLLBACK").catch(() => {});
      }
    } else {
      result = await client.query(args.sql);
    }
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

// 仅当被 `node pg-exec.mjs` 直接执行时才跑 main（被测试 import 判定函数时不连库、不读 argv）
const isDirectRun = () => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isDirectRun()) {
  main().catch((err) => {
    fail(`脚本异常：${err instanceof Error ? err.message : String(err)}`);
  });
}
