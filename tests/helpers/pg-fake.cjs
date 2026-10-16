/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * pg mock（pg-exec CLI 测试用）：把 Client 构造参数 dump 到文件，按环境变量假装查询。
 */
const fs = require("node:fs");

const dumpOpts = (opts) => {
  const dump = process.env.PG_FAKE_DUMP;
  if (!dump) return;
  try {
    fs.writeFileSync(dump, JSON.stringify(opts));
  } catch {
    // dump 失败不阻塞
  }
};

// 事务控制语句（pg-exec 只读实例会包 BEGIN READ ONLY / ROLLBACK）只进 queries 流水、不覆盖 sql
const TX_CONTROL_RE = /^(BEGIN READ ONLY|ROLLBACK)$/;

const dumpSql = (sql, queryMode) => {
  const dump = process.env.PG_FAKE_DUMP;
  if (!dump) return;
  try {
    const raw = fs.readFileSync(dump, "utf8");
    const obj = raw.trim() ? JSON.parse(raw) : {};
    obj.queries = [...(obj.queries ?? []), { sql, queryMode: queryMode ?? "simple" }];
    if (!TX_CONTROL_RE.test(sql)) {
      obj.sql = sql;
      obj.queryMode = queryMode ?? "simple";
    }
    fs.writeFileSync(dump, JSON.stringify(obj));
  } catch {
    // dump 失败不阻塞
  }
};

class FakeClient {
  constructor(opts) {
    this.opts = opts;
    dumpOpts(opts);
  }
  connect() {
    if (process.env.PG_FAKE_MODE === "connect-fail") {
      return Promise.reject(new Error("password authentication failed for user \"app\""));
    }
    return Promise.resolve();
  }
  query(input) {
    // 兼容 query(text) 与 query({ text, queryMode })
    const sql = typeof input === "string" ? input : input.text;
    const queryMode = typeof input === "string" ? "simple" : input.queryMode;
    dumpSql(sql, queryMode);
    if (TX_CONTROL_RE.test(sql)) return Promise.resolve({ rows: [], rowCount: null });
    if (process.env.PG_FAKE_MODE === "query-fail") {
      return Promise.reject(new Error("relation \"nope\" does not exist"));
    }
    let rows = [{ id: 1, name: "ok" }];
    if (process.env.PG_FAKE_ROWS) {
      rows = JSON.parse(process.env.PG_FAKE_ROWS);
    }
    return Promise.resolve({
      rows,
      rowCount: rows.length,
      fields: [{ name: "id" }, { name: "name" }],
    });
  }
  end() {
    return Promise.resolve();
  }
}

exports.Client = FakeClient;
