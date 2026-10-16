/**
 * SQL 只读静态门（旁路只读 shell 用；scripts/pg-exec.mjs 内有一份同逻辑的 JS 拷贝）
 *
 * 旧实现「先正则剥注释、再扫写关键字」可被引号内的 `--` / `/*` 绕过：
 *   `SELECT '--'; DROP TABLE t` → 剥掉 `--'; DROP TABLE t` 后只剩 `SELECT '` → 放行。
 * 这里改成真正的词法扫描：按 PostgreSQL 规则识别注释（块注释可嵌套）、单引号串
 * （仅 E'..' 才认反斜杠转义）、双引号标识符、美元引用串，把它们从「代码」里抹掉后再：
 *   - 扫写关键字（字面量里的 `'drop'` 不再误伤）；
 *   - 数顶层分号分隔的语句数——只读门只放单条语句（防 `SELECT 1; DROP ...` / `COMMIT; ...`）。
 * 词法扫不闭合（引号 / 注释 / 美元串缺结尾）一律拒绝。
 * 另在词法层拒绝带副作用 / 越权的函数调用（pg_terminate_backend、setval、pg_read_file、dblink…），
 * 旁路对可写实例没有库侧兜底，这道静态门是唯一一道。
 *
 * ⚠️ 这是第一道（静态）防线，不是最终保证：实例 readonly 时 pg-exec 另在库侧
 * `BEGIN READ ONLY` + extended protocol（单语句）强制只读，旁路对可写实例只有这道静态门。
 */

/**
 * 写类关键字（含 `SELECT … INTO new_table` 的 INTO）。
 * `COMMENT` 只认「语句开头的 `COMMENT ON`」：它是 PG 的非保留字、`comment` 是极常见的业务表 / 列名
 * （`SELECT comment FROM t`、`… JOIN comment ON comment.post_id = p.id`），裸写 `\bCOMMENT\b` 会把前者误拒成「写」，
 * 第五轮改成不锚定的 `COMMENT\s+ON` 之后后者仍被误拒（H4-09：`JOIN comment ON …` 拼出的 `comment ON` 是联接条件）。
 * 而 COMMENT 语句的文法只有 `COMMENT ON <对象类型> …` 一种形态、且只能做语句的第一个词（不在 EXPLAIN / PREPARE / CTE 的可包裹语句里），
 * 所以锚在「整段开头或某个 `;` 之后（中间只有空白；扫描后注释已抹成空格，`\s*` 覆盖，前导空语句 `;COMMENT ON …` 也照样命中）」
 * 不会放过任何一条真 COMMENT 语句；多条语句本来就先被 `statements > 1` 拒掉。
 * （同理 LOCK / CALL / CLUSTER / REFRESH 等做列名也会误拒，但它们没有这种固定的第二个词，要改成「只看语句首词」，属设计决策、这里没动——
 *  这仍是黑名单、不是白名单，已知局限不变。）
 * 与 scripts/pg-exec.mjs 的 WRITE_RE 必须保持同步（tests/sql-readonly-guard.test.ts 两份跑同一张表）。
 */
export const WRITE_SQL_RE =
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
export const SIDE_EFFECT_FN_RE = new RegExp(
  `(?<![A-Za-z0-9_$\\u0080-\\uffff])(?:${SIDE_EFFECT_FN_NAMES.join("|")})\\s*\\(`,
  "i",
);

export interface SqlScanResult {
  /** 抹掉注释 / 字符串 / 引号标识符 / 美元串内容后的「纯代码」 */
  code: string;
  /**
   * 同 code，但双引号标识符保留（脱引号）内容——`"pg_sleep"(1)` 与 `pg_sleep(1)` 等价，
   * 函数名检查要看它。内容里的非标识符字符换成 `_`，防 `"x(" ` 之类误报。
   */
  callCode: string;
  /** 出现 `U&"..."`（Unicode 转义标识符，名字不能静态还原） */
  unicodeIdent: boolean;
  /** 顶层非空语句数 */
  statements: number;
  /** 引号 / 块注释 / 美元串没闭合 */
  unterminated: boolean;
}

const isIdentChar = (c: string | undefined): boolean =>
  c !== undefined && /[A-Za-z0-9_$\u0080-\uffff]/.test(c);

const DOLLAR_TAG_RE = /^\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/;

export const scanSql = (input: string): SqlScanResult => {
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

export type ReadonlySqlVerdict =
  | { ok: true }
  | { ok: false; reason: "empty" | "unterminated" | "multi" | "write" | "func" };

/** 只读 SQL 判定：单条、词法闭合、无写类关键字才放行 */
export const checkReadonlySql = (sql: string): ReadonlySqlVerdict => {
  const scan = scanSql(sql);
  if (scan.unterminated) return { ok: false, reason: "unterminated" };
  if (scan.statements === 0) return { ok: false, reason: "empty" };
  if (scan.statements > 1) return { ok: false, reason: "multi" };
  if (WRITE_SQL_RE.test(scan.code)) return { ok: false, reason: "write" };
  if (scan.unicodeIdent || SIDE_EFFECT_FN_RE.test(scan.callCode)) {
    return { ok: false, reason: "func" };
  }
  return { ok: true };
};
