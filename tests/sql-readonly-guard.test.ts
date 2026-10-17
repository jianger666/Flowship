/**
 * 只读 SQL 静态门（S15-01）：词法扫描、不再「先剥注释再扫关键字」。
 *
 * 覆盖 scripts/pg-exec.mjs 的 checkReadonlySql：
 * 1. 绕过 / 写 / 多语句 / 未闭合 → 拒；
 * 2. 正常 SELECT / 带注释 SELECT / WITH 仍放行。
 * （v1.9.33 起只剩 pg-exec.mjs 这一份实现：原先 src/lib/server/sql-readonly-guard.ts 的 TS 拷贝只服务于只读 shell 守卫，
 * 随它一起删了，「两份同表防漂移」的对照也就没有了。）
 * pg-exec CLI 的库侧只读（BEGIN READ ONLY + extended protocol）见 tests/pg-exec.test.ts。
 */
import { describe, expect, it } from "vitest";

import { checkReadonlySql as checkMjs } from "../scripts/pg-exec.mjs";

type Verdict = { ok: boolean; reason?: string };

const REJECT: Array<[string, string]> = [
  // 引号里的 -- 不是注释：旧实现会把 `--'; DROP TABLE t` 整段当注释剥掉
  ["SELECT '--'; DROP TABLE t", "multi"],
  ["SELECT '/*'; DROP TABLE t; --*/", "multi"],
  ["SELECT 1; DROP TABLE t", "multi"],
  // 解除只读 / 提交后再写
  ["COMMIT; DROP TABLE t", "multi"],
  ["SET TRANSACTION READ WRITE; DELETE FROM t", "multi"],
  ["SELECT 1; SELECT 2", "multi"],
  // 写语句、CTE 写、SELECT INTO
  ["DROP TABLE t", "write"],
  ["delete from t where id=1", "write"],
  ["WITH x AS (SELECT 1) DELETE FROM t", "write"],
  ["-- 只是查一下\nDELETE FROM t", "write"],
  ["/* hi */ INSERT INTO t VALUES (1)", "write"],
  ["SELECT * INTO t2 FROM t", "write"],
  // COMMENT 只在 `COMMENT ON …` 这一个语法形态下是写语句（见 ALLOW 里的 `comment` 列名）：
  // 注释 / 换行 / 大小写夹在 COMMENT 与 ON 之间，抹掉注释后仍是 `COMMENT ON`，一样要拒
  ["COMMENT ON TABLE t IS 'x'", "write"],
  ["comment on column t.c is 'x'", "write"],
  ["COMMENT /* x */ ON TABLE t IS 'x'", "write"],
  ["COMMENT\n-- x\nON TABLE t IS 'x'", "write"],
  ["COMMENT\t\r\n  ON TABLE t IS NULL", "write"],
  // H4-09：COMMENT 语句只会出现在「语句开头」。开头可以有空白 / 注释 / 空语句（前导 `;`），都不能让它漏过
  ["  \n COMMENT ON TABLE t IS 'x'", "write"],
  ["-- 先注释一下\nCOMMENT ON TABLE t IS 'x'", "write"],
  ["/* hi */COMMENT ON TABLE t IS 'x'", "write"],
  [";COMMENT ON TABLE t IS 'x'", "write"],
  ["; ;  COMMENT ON COLUMN t.comment IS 'x'", "write"],
  ["comment on table comment is 'x'", "write"],
  // 反斜杠：普通串里 `\` 是字面，`'\'` 就是完整字符串，后面的 DROP 是真语句
  ["SELECT '\\'; DROP TABLE t; --'", "multi"],
  // E'' 串里 `\'` 才是转义：字符串一直吞到结尾都没闭合 → 拒
  ["SELECT E'\\'; DROP TABLE t; --", "unterminated"],
  // 美元串、嵌套块注释
  ["SELECT $$x$$; DROP TABLE t", "multi"],
  ["SELECT 1 /* a /* b */ ; DROP TABLE t */ ; DROP TABLE t", "multi"],
  // 没闭合
  ["SELECT 'abc", "unterminated"],
  ["SELECT 1 /* never closed", "unterminated"],
  ["SELECT $a$ never closed", "unterminated"],
  ["", "empty"],
  ["-- 只有注释", "empty"],
  // R4-02：PostgreSQL 把 \r 也当行尾，`--` 注释到 \r 就结束，之后的 `;` 是真分号
  ["SELECT 1 --\r; DROP TABLE t", "multi"],
  ["SELECT 1 --\r\n; DROP TABLE t", "multi"],
  ["SELECT 1 -- x\rDROP TABLE t", "write"],
  // R4-03：带副作用 / 越权函数（不含任何写关键字，旧门全放行）
  ...[
    "SELECT pg_terminate_backend(123)",
    "SELECT pg_cancel_backend(123)",
    "SELECT pg_sleep(1000)",
    "SELECT pg_sleep_for('5 minutes')",
    "SELECT setval('s', 1)",
    "SELECT nextval('s')",
    "SELECT pg_advisory_lock(1)",
    "SELECT pg_try_advisory_xact_lock(1)",
    "SELECT lo_import('/etc/passwd')",
    "SELECT lo_export(1, '/tmp/x')",
    "SELECT lo_unlink(1)",
    "SELECT pg_read_file('/etc/passwd')",
    "SELECT pg_read_binary_file('/etc/passwd')",
    "SELECT * FROM pg_ls_dir('.')",
    "SELECT pg_reload_conf()",
    "SELECT dblink('host=x', 'select 1')",
    "SELECT dblink_exec('host=x', 'select 1')",
    "SELECT set_config('transaction_read_only', 'off', false)",
    "SELECT query_to_xml('select 1', true, true, '')",
    // 大小写 / 空白 / 注释 / schema 前缀 / 引号标识符形态
    "SELECT PG_TERMINATE_BACKEND(1)",
    "SELECT Pg_Sleep (1)",
    "SELECT pg_sleep\n\t(1)",
    "SELECT pg_sleep/* x */(1)",
    "SELECT pg_catalog.pg_sleep(1)",
    "SELECT pg_catalog . pg_sleep(1)",
    'SELECT "pg_sleep"(1)',
    'SELECT pg_catalog."pg_sleep"(1)',
    'SELECT "pg_catalog"."pg_terminate_backend"(1)',
    "SELECT 1 WHERE (SELECT pg_sleep(1)) IS NULL",
    // U&"..." 的名字靠转义还原，静态读不出来 → 直接拒
    'SELECT U&"pg\\0073leep"(1)',
  ].map((sql): [string, string] => [sql, "func"]),
];

const ALLOW: string[] = [
  "SELECT 1",
  "SELECT * FROM t LIMIT 5",
  "SELECT * FROM t WHERE a > 1;",
  "SELECT 1 -- INSERT INTO t",
  "SELECT /* DROP TABLE t */ 1",
  "SELECT 1 /* a /* nested */ DELETE */",
  "WITH x AS (SELECT 1 AS a) SELECT * FROM x",
  "WITH x AS (SELECT 1) SELECT * FROM x -- trailing\n",
  // 字面量 / 引号标识符里出现关键字、分号、注释符都不算
  "SELECT 'DROP TABLE t; --'",
  "SELECT 'it''s; DELETE'",
  "SELECT \"drop\" FROM \"insert\"",
  "SELECT $$a; DROP TABLE t$$",
  "SELECT $tag$ x ' y $tag$",
  // E'' 里 `\'` 是转义，整句只是一个字符串字面量
  "SELECT E'a\\'; DROP TABLE t'",
  "EXPLAIN SELECT * FROM t",
  "SHOW server_version",
  // `comment` 是极常见的业务列名（PG 里是非保留字）：只有 `COMMENT ON …` 才是写语句，裸列名不能误拒
  "SELECT comment FROM t",
  "SELECT t.comment, u.comment FROM t JOIN u ON t.id = u.id",
  "SELECT * FROM t WHERE comment IS NOT NULL ORDER BY comment",
  "SELECT id, comment AS remark FROM orders",
  // H4-09：`comment` 作表名 / CTE 名时，JOIN 之后紧跟 `ON` 会拼出 `comment ON`，但那是联接条件、不是 COMMENT 语句
  "SELECT * FROM post p JOIN comment ON comment.post_id = p.id",
  "SELECT * FROM post p LEFT JOIN comment ON comment.post_id = p.id WHERE p.id = 1",
  "SELECT * FROM post p inner join comment\n  on comment.post_id = p.id",
  "SELECT * FROM post p JOIN comment /* 联接评论 */ ON comment.post_id = p.id",
  "SELECT * FROM post p JOIN comment -- 评论表\n ON comment.post_id = p.id",
  "SELECT * FROM post p FULL OUTER JOIN comment ON true",
  "SELECT * FROM post p CROSS JOIN LATERAL (SELECT 1) x JOIN comment ON comment.post_id = p.id",
  "WITH comment AS (SELECT 1 AS post_id) SELECT * FROM post p JOIN comment ON comment.post_id = p.id",
  "SELECT * FROM post p JOIN comment AS c ON c.post_id = p.id",
  "SELECT * FROM post p JOIN comment USING (post_id)",
  "SELECT 1 WHERE EXISTS (SELECT 1 FROM post p JOIN comment ON comment.post_id = p.id);",
  // 标识符里的 $ 不是美元串起点
  "SELECT a$b FROM t",
  // \r 结尾的行注释之后的正常代码
  "SELECT 1 --x\rFROM t",
  "SELECT 1 -- x\r\n",
  // R4-03 防误伤：函数名只在「代码里的标识符 + (」才算
  "SELECT 'pg_sleep(1)'",
  "SELECT $$pg_terminate_backend(1)$$",
  "SELECT 1 -- pg_sleep(1)",
  "SELECT /* nextval('s') */ 1",
  "SELECT nextval FROM t",
  "SELECT a AS setval FROM t",
  'SELECT "pg_sleep" FROM t',
  'SELECT "weird (name", "pg_sleep(" FROM t',
  "SELECT pg_sleep_count, setval_total, dblinks FROM t",
  "SELECT my_nextval(1) FROM t",
  "SELECT count(*) FROM lo_stats",
  "SELECT pg_size_pretty(pg_database_size('x'))",
  "SELECT current_setting('server_version'), now(), coalesce(a, 0) FROM t",
  "SELECT * FROM t WHERE id IN (1, 2) AND name = 'pg_read_file(x)'",
];

describe("checkReadonlySql（scripts/pg-exec.mjs）", () => {
  const impls: Array<[string, (sql: string) => Verdict]> = [["mjs", checkMjs as (sql: string) => Verdict]];

  for (const [name, check] of impls) {
    it(`[${name}] 绕过 / 写 / 多语句 / 未闭合 → 拒`, () => {
      for (const [sql, reason] of REJECT) {
        const v = check(sql);
        expect(v.ok, sql).toBe(false);
        expect(v.reason, sql).toBe(reason);
      }
    });

    it(`[${name}] 正常 SELECT / 带注释 / WITH / 字面量含关键字 → 放行`, () => {
      for (const sql of ALLOW) {
        expect(check(sql), sql).toEqual({ ok: true });
      }
    });
  }
});
