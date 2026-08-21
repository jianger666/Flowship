/**
 * pg-exec（CLI 脚本）测试：spawn 真实脚本 + preload mock pg
 * 验证：env 模式密码进 Client、只读挡写、错误不泄露密码、参数校验
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "pg-exec.mjs");
const PRELOAD = path.join(ROOT, "tests", "helpers", "pg-preload.cjs");

const TMP = mkdtempSync(path.join(os.tmpdir(), "pg-exec-test-"));
const CONFIG_PATH = path.join(TMP, "company-env.json");
const DUMP_PATH = path.join(TMP, "connect-dump.json");

const CONFIG = {
  pg: [
    {
      env: "dev",
      host: "10.0.3.1",
      port: 5432,
      user: "app_dev",
      password: "pw-dev",
      readonly: false,
    },
    {
      env: "test",
      host: "10.0.3.20",
      port: 5432,
      user: "readonly",
      password: "pw-test",
      readonly: true,
    },
    {
      env: "test",
      host: "10.0.3.21",
      port: 5432,
      user: "app2",
      password: "pw-test-2",
      readonly: false,
    },
  ],
};

type Result = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  rowCount?: number;
  error?: string;
};

const run = async (
  args: string[],
  env: Record<string, string> = {},
): Promise<{ result: Result; dump: Record<string, unknown> | null }> => {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      process.execPath,
      ["--require", PRELOAD, SCRIPT, ...args],
      {
        env: {
          ...process.env,
          PG_EXEC_CONFIG: CONFIG_PATH,
          PG_FAKE_DUMP: DUMP_PATH,
          ...env,
        },
      },
      (err, out) => {
        if (err && !out) reject(err);
        else resolve(out ?? "");
      },
    );
  });
  let dump: Record<string, unknown> | null = null;
  try {
    const raw = await readFile(DUMP_PATH, "utf8");
    if (raw.trim()) dump = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    dump = null;
  }
  await writeFile(DUMP_PATH, "").catch(() => {});
  return { result: JSON.parse(stdout) as Result, dump };
};

beforeEach(async () => {
  await mkdir(TMP, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(CONFIG));
  await writeFile(DUMP_PATH, "").catch(() => {});
});

describe("pg-exec CLI", () => {
  it("env 模式：密码从配置读取进 Client、stdout 是 rows JSON", async () => {
    const { result, dump } = await run(
      ["--env", "dev", "--", "SELECT 1"],
      { PG_FAKE_ROWS: JSON.stringify([{ id: 7 }]) },
    );
    expect(result.ok).toBe(true);
    expect(result.rowCount).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual([{ id: 7 }]);
    expect(dump?.password).toBe("pw-dev");
    expect(dump?.user).toBe("app_dev");
    expect(dump?.host).toBe("10.0.3.1");
    expect(dump?.database).toBe("app_dev");
    expect(dump?.sql).toBe("SELECT 1");
  });

  it("只读实例：SELECT 放行、INSERT 不连库", async () => {
    const read = await run(["--env", "test", "--", "SELECT * FROM t"]);
    expect(read.result.ok).toBe(true);
    expect(read.dump?.sql).toBe("SELECT * FROM t");

    const write = await run(["--env", "test", "--", "INSERT INTO t VALUES (1)"]);
    expect(write.result.ok).toBe(false);
    expect(write.result.error).toContain("只读");
    expect(write.dump).toBeNull();
    expect(JSON.stringify(write.result)).not.toContain("pw-");
  });

  it("只读：注释里的 INSERT 不误伤，WITH … INSERT 仍拦住", async () => {
    const comment = await run([
      "--env",
      "test",
      "--",
      "SELECT 1 -- INSERT INTO t",
    ]);
    expect(comment.result.ok).toBe(true);

    const cte = await run([
      "--env",
      "test",
      "--",
      "WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x",
    ]);
    expect(cte.result.ok).toBe(false);
    expect(cte.result.error).toContain("只读");
  });

  it("可写实例允许 INSERT", async () => {
    const { result, dump } = await run([
      "--env",
      "dev",
      "--",
      "INSERT INTO t VALUES (1)",
    ]);
    expect(result.ok).toBe(true);
    expect(dump?.sql).toContain("INSERT");
  });

  it("--database 覆盖默认库名", async () => {
    const { dump } = await run([
      "--env",
      "dev",
      "--database",
      "crm",
      "--",
      "SELECT 1",
    ]);
    expect(dump?.database).toBe("crm");
  });

  it("--config 显式指定配置文件，优先于 PG_EXEC_CONFIG", async () => {
    const customPath = path.join(TMP, "custom-env.json");
    await writeFile(
      customPath,
      JSON.stringify({
        pg: [
          {
            env: "test",
            host: "10.0.3.99",
            port: 5432,
            user: "ops",
            password: "pw-custom",
            readonly: false,
          },
        ],
      }),
    );
    const { dump } = await run(
      ["--config", customPath, "--env", "test", "--", "SELECT 1"],
      { PG_EXEC_CONFIG: path.join(TMP, "missing.json") },
    );
    expect(dump?.host).toBe("10.0.3.99");
    expect(dump?.user).toBe("ops");
    expect(dump?.password).toBe("pw-custom");
  });

  it("--env 带 :n 序号：选择同环境第 N 个实例", async () => {
    const first = await run(["--env", "test:1", "--", "SELECT 1"]);
    expect(first.dump?.host).toBe("10.0.3.20");
    expect(first.dump?.password).toBe("pw-test");

    const second = await run(["--env", "test:2", "--", "SELECT 1"]);
    expect(second.dump?.host).toBe("10.0.3.21");
    expect(second.dump?.user).toBe("app2");
    expect(second.dump?.password).toBe("pw-test-2");
  });

  it("user 覆盖选择对应条目", async () => {
    const { dump } = await run([
      "--env",
      "test",
      "--user",
      "app2",
      "--",
      "SELECT 1",
    ]);
    expect(dump?.user).toBe("app2");
    expect(dump?.password).toBe("pw-test-2");
  });

  it("--user 与 --env 序号同传 → 拒绝歧义", async () => {
    const { result } = await run([
      "--env",
      "test:2",
      "--user",
      "app2",
      "--",
      "SELECT 1",
    ]);
    expect(result.error).toContain("二选一");
  });

  it("env 不存在 → 可读错误、无密码泄露", async () => {
    const { result, dump } = await run(["--env", "prod", "--", "SELECT 1"]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("PostgreSQL 配置不存在");
    expect(JSON.stringify(result)).not.toContain("pw-");
    expect(dump).toBeNull();
  });

  it("认证失败 → 错误信息不含密码", async () => {
    const { result } = await run(["--env", "dev", "--", "SELECT 1"], {
      PG_FAKE_MODE: "connect-fail",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("authentication");
    expect(result.error).not.toContain("pw-dev");
  });

  it("参数校验：缺 --env / 缺 SQL / 未知 flag / 裸参数", async () => {
    const noEnv = await run(["--", "SELECT 1"]);
    expect(noEnv.result.error).toContain("--env");

    const noSql = await run(["--env", "test"]);
    expect(noSql.result.error).toContain("SQL");

    const unknown = await run(["--env", "test", "--bogus", "x", "--", "SELECT 1"]);
    expect(unknown.result.error).toContain("未知参数");

    const bare = await run(["--env", "test", "SELECT 1"]);
    expect(bare.result.error).toContain("裸参数");
  });

  it("SQL 拆成多个 token → 拒绝并提示用单个带引号参数", async () => {
    const { result } = await run(["--env", "dev", "--", "SELECT", "1"]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("单个带引号的参数");
  });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});
