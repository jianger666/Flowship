/**
 * 受限运行身份（P0 硬化 ③）：设计上群答疑旁路 agent 的子进程环境带 `FLOWSHIP_RUN_KIND=restricted`，
 * 脚本侧各自收紧——（目前没有任何路径设置该变量：受限 agent 没有 shell 工具，这里只是纵深防御占位，
 * 本文件钉的是「变量一旦被设置，脚本侧的行为」）
 *
 * - `ssh-exec`：一律拒绝（非 0 退出码 + 中文提示），不读配置、不连任何机器；
 * - `pg-exec`：即使实例配置 `readonly:false` 也按只读执行（词法扫描 + 库侧 BEGIN READ ONLY）。
 *
 * 真 spawn 脚本（preload mock ssh2 / pg）。⚠️ 这是纵深防御、不是边界：环境变量可被 `env -u` 摘掉，
 * 测试里也钉住这一点（摘掉后行为回到非受限）——残余风险的真实边界在「受限 agent 无 shell + prompt 不给凭据路径」，
 * 见 restricted-readonly-wiring / restricted-group-question 测试。
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  effectiveReadonly as effectiveReadonlyRaw,
  isRestrictedRun as isRestrictedRunRaw,
} from "../scripts/pg-exec.mjs";

// .mjs 的默认参数是 process.env，TS 把形参推成 NodeJS.ProcessEnv；测试里传的是最小字典
type EnvDict = Record<string, string | undefined>;
const isRestrictedRun = (env: EnvDict) => isRestrictedRunRaw(env as NodeJS.ProcessEnv);
const effectiveReadonly = (instanceReadonly: boolean | undefined, env: EnvDict) =>
  effectiveReadonlyRaw(instanceReadonly, env as NodeJS.ProcessEnv);

const ROOT = path.resolve(__dirname, "..");
const SSH_SCRIPT = path.join(ROOT, "scripts", "ssh-exec.mjs");
const SSH_PRELOAD = path.join(ROOT, "tests", "helpers", "ssh2-preload.cjs");
const PG_SCRIPT = path.join(ROOT, "scripts", "pg-exec.mjs");
const PG_PRELOAD = path.join(ROOT, "tests", "helpers", "pg-preload.cjs");

const TMP = mkdtempSync(path.join(os.tmpdir(), "restricted-run-scripts-"));
const SSH_CONFIG = path.join(TMP, "ssh-company-env.json");
const PG_CONFIG = path.join(TMP, "pg-company-env.json");
const SSH_DUMP = path.join(TMP, "ssh-dump.json");
const PG_DUMP = path.join(TMP, "pg-dump.json");
const FAKE_HOME = path.join(TMP, "home");

type Result = { ok: boolean; stdout: string; exitCode: number | null; error?: string };

const spawnScript = (
  script: string,
  preload: string,
  args: string[],
  env: Record<string, string | undefined>,
): Promise<{ result: Result; code: number | null }> =>
  new Promise((resolve, reject) => {
    // 先把可能继承自父进程的受限标记清掉，再按用例给的覆盖（undefined = 显式不传）
    const base: Record<string, string | undefined> = { ...process.env };
    delete base.FLOWSHIP_RUN_KIND;
    const merged = { ...base, ...env };
    for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
    execFile(
      process.execPath,
      ["--require", preload, script, ...args],
      { env: merged as NodeJS.ProcessEnv },
      (err, out) => {
        const code =
          err && typeof (err as { code?: unknown }).code === "number"
            ? ((err as { code: number }).code as number)
            : err
              ? -1
              : 0;
        if (err && !out) {
          reject(err);
          return;
        }
        resolve({ result: JSON.parse(out) as Result, code });
      },
    );
  });

const readDump = async (file: string): Promise<Record<string, unknown> | null> => {
  try {
    const raw = await readFile(file, "utf8");
    return raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const runSsh = async (args: string[], env: Record<string, string | undefined> = {}) => {
  await writeFile(SSH_DUMP, "");
  const r = await spawnScript(SSH_SCRIPT, SSH_PRELOAD, args, {
    SSH_EXEC_CONFIG: SSH_CONFIG,
    SSH2_FAKE_DUMP: SSH_DUMP,
    SSH2_KNOWN_HOSTS: path.join(TMP, "known_hosts"),
    HOME: FAKE_HOME,
    USERPROFILE: FAKE_HOME,
    SSH2_FAKE_STDOUT: "hi\n",
    ...env,
  });
  return { ...r, dump: await readDump(SSH_DUMP) };
};

const runPg = async (args: string[], env: Record<string, string | undefined> = {}) => {
  await writeFile(PG_DUMP, "");
  const r = await spawnScript(PG_SCRIPT, PG_PRELOAD, args, {
    PG_EXEC_CONFIG: PG_CONFIG,
    PG_FAKE_DUMP: PG_DUMP,
    ...env,
  });
  return { ...r, dump: await readDump(PG_DUMP) };
};

beforeEach(async () => {
  await mkdir(FAKE_HOME, { recursive: true });
  await writeFile(
    SSH_CONFIG,
    JSON.stringify({
      servers: [{ env: "test", host: "10.0.0.1", port: 22, user: "app", password: "pw-ssh-secret" }],
    }),
  );
  await writeFile(
    PG_CONFIG,
    JSON.stringify({
      pg: [
        {
          env: "dev",
          host: "10.0.3.1",
          port: 5432,
          user: "app_dev",
          password: "pw-pg-secret",
          readonly: false,
        },
      ],
    }),
  );
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("ssh-exec · FLOWSHIP_RUN_KIND=restricted 一律拒绝", () => {
  it("--env 模式：非 0 退出码 + 中文提示，不连机器（dump 为空）、不泄露密码", async () => {
    const { result, code, dump } = await runSsh(["--env", "test", "--", "echo hi"], {
      FLOWSHIP_RUN_KIND: "restricted",
    });
    expect(code).not.toBe(0);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain("受限身份");
    expect(result.error).toContain("禁止使用 ssh-exec");
    expect(dump).toBeNull();
    expect(JSON.stringify(result)).not.toContain("pw-ssh-secret");
  });

  it("--host 模式（本机私钥）同样拒绝", async () => {
    const { result, code, dump } = await runSsh(
      ["--host", "10.0.0.9", "--user", "root", "--", "id"],
      { FLOWSHIP_RUN_KIND: "restricted" },
    );
    expect(code).not.toBe(0);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("受限身份");
    expect(dump).toBeNull();
  });

  it("先拒后读配置：配置文件不存在 / 参数缺失时给的仍是受限拒绝，而不是配置 / 参数错误（不泄露配置存在与否）", async () => {
    const { result, code } = await runSsh([], {
      FLOWSHIP_RUN_KIND: "restricted",
      SSH_EXEC_CONFIG: path.join(TMP, "no-such-config.json"),
    });
    expect(code).not.toBe(0);
    expect(result.error).toContain("受限身份");
  });

  it("标记容忍大小写 / 前后空白（trim + lowercase）", async () => {
    for (const v of ["Restricted", " restricted ", "RESTRICTED"]) {
      const { result, code } = await runSsh(["--env", "test", "--", "echo hi"], {
        FLOWSHIP_RUN_KIND: v,
      });
      expect(code, v).not.toBe(0);
      expect(result.error, v).toContain("受限身份");
    }
  });

  it("对照：未设 / 其它值 → 照常执行（证明上面的拒绝来自该标记，不是脚本本身挂了）", async () => {
    for (const v of [undefined, "", "owner", "restricted-not"]) {
      const { result, code, dump } = await runSsh(["--env", "test", "--", "echo hi"], {
        FLOWSHIP_RUN_KIND: v,
      });
      expect(code, String(v)).toBe(0);
      expect(result.ok, String(v)).toBe(true);
      expect(dump?.password, String(v)).toBe("pw-ssh-secret");
    }
  });
});

describe("pg-exec · FLOWSHIP_RUN_KIND=restricted 强制只读", () => {
  it("readonly:false 的实例：写语句被拒（不连库、非 0 退出、提示受限身份），不泄露密码", async () => {
    for (const sql of [
      "INSERT INTO t VALUES (1)",
      "UPDATE t SET a = 1",
      "DROP TABLE t",
      "SELECT 1; DROP TABLE t",
    ]) {
      const { result, code, dump } = await runPg(["--env", "dev", "--", sql], {
        FLOWSHIP_RUN_KIND: "restricted",
      });
      expect(code, sql).not.toBe(0);
      expect(result.ok, sql).toBe(false);
      expect(result.error, sql).toContain("受限身份");
      expect(dump, sql).toBeNull();
      expect(JSON.stringify(result), sql).not.toContain("pw-pg-secret");
    }
  });

  it("受限身份下 SELECT 仍可用，且走库侧 BEGIN READ ONLY（readonly:false 实例也一样）", async () => {
    const { result, code, dump } = await runPg(["--env", "dev", "--", "SELECT 1"], {
      FLOWSHIP_RUN_KIND: "restricted",
      PG_FAKE_ROWS: JSON.stringify([{ id: 7 }]),
    });
    expect(code).toBe(0);
    expect(result.ok).toBe(true);
    expect(dump?.sql).toBe("SELECT 1");
    // 只读包裹：整串查询里出现 BEGIN READ ONLY
    expect(JSON.stringify(dump)).toContain("BEGIN READ ONLY");
  });

  it("对照：未设标记时 readonly:false 的实例写语句照常放行（证明只读来自受限标记）", async () => {
    const { result, code, dump } = await runPg(["--env", "dev", "--", "INSERT INTO t VALUES (1)"]);
    expect(code).toBe(0);
    expect(result.ok).toBe(true);
    expect(dump?.sql).toBe("INSERT INTO t VALUES (1)");
    expect(JSON.stringify(dump)).not.toContain("BEGIN READ ONLY");
  });
});

describe("pg-exec 判定函数（纯函数）", () => {
  it("isRestrictedRun：只认 restricted（trim + 大小写不敏感）", () => {
    expect(isRestrictedRun({ FLOWSHIP_RUN_KIND: "restricted" })).toBe(true);
    expect(isRestrictedRun({ FLOWSHIP_RUN_KIND: " Restricted\n" })).toBe(true);
    for (const v of [undefined, "", "owner", "restricted2", "unrestricted"]) {
      expect(isRestrictedRun({ FLOWSHIP_RUN_KIND: v })).toBe(false);
    }
    expect(isRestrictedRun({})).toBe(false);
  });

  it("effectiveReadonly：实例只读 或 受限身份 → 只读；两者皆非才可写（实例 readonly 只认严格 true）", () => {
    const restricted = { FLOWSHIP_RUN_KIND: "restricted" };
    expect(effectiveReadonly(false, restricted)).toBe(true);
    expect(effectiveReadonly(undefined, restricted)).toBe(true);
    expect(effectiveReadonly(true, {})).toBe(true);
    expect(effectiveReadonly(false, {})).toBe(false);
  });

  it("残余风险钉住：env -u（摘掉标记）等于非受限——这就是「纵深防御、不是边界」的含义", () => {
    expect(effectiveReadonly(false, {})).toBe(false);
  });
});
