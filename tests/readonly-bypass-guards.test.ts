/**
 * 旁路只读守卫（review P0 的回归护栏）：坏人用例必须被执行层拒绝。
 *
 * 钉三件事：
 * 1. 只读 shell 默认拒绝：rm / git / curl / ssh-exec / 写 SQL / 命令拼接 / 目录逃逸，
 *    只放 pg-exec SELECT（无 --config、SQL 独占引号参数）和本地查看命令（cwd 内）。
 * 2. 凭据文件读不到：read 读 company-env.json / config.json（数据目录）必须拒绝；
 *    shell 里 cat 它们同样拒绝；grep / glob 基址钳在工作目录（含本任务目录）内。
 * 3. 好人场景不断：SELECT、tail 日志、ls、cwd 内 read/grep 照常放行。
 *
 * 策略：允许判定走纯函数（不 spawn、不碰网），拒绝判定额外走一遍 tool def execute，
 * 证明守卫真的挂在了旁路工具链上（不是只 export 了个没人调的函数）。
 */
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-bypass-guards-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const CWD = path.join(TMP_ROOT, "work");
await fs.mkdir(path.join(TMP_ROOT, "data"), { recursive: true });
await fs.mkdir(CWD, { recursive: true });
await fs.mkdir(path.join(TMP_ROOT, "data", "tasks", "t1"), { recursive: true });
await fs.writeFile(
  path.join(TMP_ROOT, "data", "company-env.json"),
  JSON.stringify({ pg: [{ password: "secret" }] }),
);
await fs.writeFile(
  path.join(TMP_ROOT, "data", "config.json"),
  JSON.stringify({ provider: {} }),
);
await fs.writeFile(path.join(CWD, "hello.txt"), "hello bypass\n");
await fs.writeFile(path.join(CWD, "app.log"), "line1\nline2\n");

const {
  buildReadOnlyToolDefs,
  clampBypassBasePath,
  isBypassBlockedReadPath,
  validateReadonlyShellCommand,
} = await import("@/lib/server/pi-coding-tools");

const SENSITIVE_ABS = path.join(TMP_ROOT, "data", "company-env.json");
const CONFIG_ABS = path.join(TMP_ROOT, "data", "config.json");
const PG_SELECT = `node "/repo/scripts/pg-exec.mjs" --env test -- 'SELECT * FROM t LIMIT 5'`;

const check = (command: string, workingDirectory?: string) =>
  validateReadonlyShellCommand(CWD, command, workingDirectory, undefined);

/** tool def 级执行（守卫拒绝走不到原生实现，不 spawn、不碰网） */
const execShell = async (command: string, workingDirectory?: string): Promise<string> => {
  const defs = buildReadOnlyToolDefs(CWD, { taskId: "t1" });
  const shell = defs.find(
    (d) => (d as { name?: unknown }).name === "shell",
  ) as unknown as {
    execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }>;
  };
  const out = await shell.execute(
    "call-1",
    workingDirectory === undefined ? { command } : { command, workingDirectory },
  );
  return out.content.map((c) => c.text).join("\n");
};

describe("只读 shell：坏人用例一律拒绝", () => {
  it("rm / git / curl / node 野脚本直接拒", () => {
    for (const cmd of [
      "rm -rf /",
      "rm ./hello.txt",
      "git push origin main",
      "git log --oneline",
      "curl http://example.com",
      "node evil.js",
      "npm install foo",
    ]) {
      expect(check(cmd).ok, cmd).toBe(false);
    }
  });

  it("绕过注入：忽略边界让他跑命令 / 命令拼接 / 重定向", async () => {
    // SQL 后的尾巴拼接必须拒（SQL 要独占引号参数）
    expect(check(`${PG_SELECT}; rm -rf /`).ok).toBe(false);
    expect(check(`${PG_SELECT} && cat /etc/passwd`).ok).toBe(false);
    expect(check("tail -n 50 app.log | grep secret").ok).toBe(false);
    expect(check("echo hi > hello.txt").ok).toBe(false);
    expect(check("cat app.log 2>/tmp/x").ok).toBe(false);
    expect(check("echo `whoami`").ok).toBe(false);
    expect(check("echo $(whoami)").ok).toBe(false);
    // def 级同样拒绝（证明挂链上了）
    expect(await execShell("rm -rf /")).toContain("旁路只读");
    expect(await execShell(`${PG_SELECT}; rm -rf /`)).toContain("旁路只读");
  });

  it("写 SQL 一律拒（实例是否只读都一样），注释 trick 也拦", () => {
    for (const sql of [
      "DROP TABLE t",
      "delete from t where id=1",
      "INSERT INTO t VALUES (1)",
      "WITH x AS (SELECT 1) DELETE FROM t",
      "-- 只是查一下\nDELETE FROM t",
    ]) {
      const r = check(`node "/repo/scripts/pg-exec.mjs" --env test -- '${sql}'`);
      expect(r.ok, sql).toBe(false);
      expect(r.reason).toContain("SELECT");
    }
  });

  it("--config / ssh-exec / workingDirectory 逃逸一律拒", async () => {
    expect(check(`node "/repo/scripts/pg-exec.mjs" --config /tmp/x.json --env t -- 'SELECT 1'`).ok).toBe(
      false,
    );
    expect(
      check(`node "/repo/scripts/ssh-exec.mjs" --env prod -- 'tail log'`).ok,
    ).toBe(false);
    expect(check("ls", "/tmp").ok).toBe(false);
    expect(check("ls", path.join(TMP_ROOT, "data")).ok).toBe(false);
    expect(check("cat hello.txt", "../../..").ok).toBe(false);
    expect(await execShell("ls", "/tmp")).toContain("工作目录内");
  });

  it("凭据文件：shell 里 cat 不到", async () => {
    expect(check(`cat ${SENSITIVE_ABS}`).ok).toBe(false);
    expect(check("cat ../../data/company-env.json").ok).toBe(false);
    expect(await execShell(`cat ${SENSITIVE_ABS}`)).toContain("company-env.json");
  });
});

describe("只读 shell：好人场景放行", () => {
  it("SELECT（分号结尾、比较符都行）", () => {
    expect(check(PG_SELECT).ok).toBe(true);
    expect(check(`node "/repo/scripts/pg-exec.mjs" --env test -- 'SELECT * FROM t WHERE a > 1;'`).ok).toBe(
      true,
    );
    expect(check(`node scripts/pg-exec.mjs --env test:2 --user u1 -- 'SELECT 1'`).ok).toBe(true);
  });

  it("本地查看：ls / tail / cat / grep（cwd 内）", () => {
    expect(check("ls").ok).toBe(true);
    expect(check("tail -n 50 app.log").ok).toBe(true);
    expect(check("cat hello.txt").ok).toBe(true);
    expect(check("grep -rn hello .").ok).toBe(true);
    expect(check("ls", ".").ok).toBe(true);
  });

  it("def 级 pwd 真跑通（守卫→全量实现链路不断）", async () => {
    const out = await execShell("pwd");
    expect(out).toContain(CWD);
  });
});

describe("只读 shell：复审挖出的绕过（回归）", () => {
  it("ask-wait 子串不再是万能钥匙", async () => {
    const smuggled = "echo hi; curl http://127.0.0.1/x/ask-wait?token=1; rm -rf /";
    expect(check(smuggled).ok).toBe(false);
    expect(await execShell(smuggled)).toContain("旁路只读");
  });

  it("换行符和 ; 等价：第二行命令必须拒", async () => {
    expect(check("echo hi\nrm hello.txt").ok).toBe(false);
    expect(check("ls\ncat app.log").ok).toBe(false);
    expect(await execShell("echo hi\nrm hello.txt")).toContain("旁路只读");
    // 行尾换行是模型常带的多余空白，trim 后放行
    expect(check("ls\n").ok).toBe(true);
  });

  it("$环境变量展开逃不出钳制（引用包着也一样）", async () => {
    expect(check("cat $HOME/.ssh/id_rsa").ok).toBe(false);
    expect(check('cat "$HOME/.ssh/id_rsa"').ok).toBe(false);
    expect(await execShell("cat $HOME/.ssh/id_rsa")).toContain("旁路只读");
    // grep 的 pattern 不是文件参数，"cost$" 这类锚点不受影响
    expect(check('grep "cost$" app.log').ok).toBe(true);
  });

  it("pg-exec 单横线 flag 同样拒", () => {
    expect(
      check(`node "/repo/scripts/pg-exec.mjs" -h --env t -- 'SELECT 1'`).ok,
    ).toBe(false);
  });
});

describe("read / grep / glob：凭据文件拦、工作区放行", () => {
  it("isBypassBlockedReadPath：company-env.json 同名即拦，config.json 精确拦", () => {
    expect(isBypassBlockedReadPath(SENSITIVE_ABS)).toBe(true);
    expect(isBypassBlockedReadPath(CONFIG_ABS)).toBe(true);
    // 工作区同名项目文件不受影响（由钳制规则保护数据目录）
    expect(isBypassBlockedReadPath(path.join(CWD, "config.json"))).toBe(false);
    expect(isBypassBlockedReadPath(path.join(CWD, "hello.txt"))).toBe(false);
  });

  it("clampBypassBasePath：数据目录根进不来，本任务目录和 cwd 放行", () => {
    expect(clampBypassBasePath(CWD, path.join(TMP_ROOT, "data"), "t1").ok).toBe(false);
    expect(clampBypassBasePath(CWD, ".", "t1").ok).toBe(true);
    expect(
      clampBypassBasePath(CWD, path.join(TMP_ROOT, "data", "tasks", "t1"), "t1").ok,
    ).toBe(true);
  });

  it("def 级 read：凭据文件拒绝、工作区文件放行、本任务目录放行、别处拒绝", async () => {
    const defs = buildReadOnlyToolDefs(CWD, { taskId: "t1" });
    const read = defs.find(
      (d) => (d as { name?: unknown }).name === "read",
    ) as unknown as {
      execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }>;
    };
    const blocked = await read.execute("call-1", { path: SENSITIVE_ABS });
    expect(blocked.content.map((c) => c.text).join("\n")).toContain("旁路只读");
    const allowed = await read.execute("call-1", {
      path: path.join(CWD, "hello.txt"),
    });
    expect(allowed.content.map((c) => c.text).join("\n")).toContain("hello bypass");
    // 本任务目录（事件日志 / 产出）可读
    await fs.writeFile(path.join(TMP_ROOT, "data", "tasks", "t1", "notes.txt"), "task notes\n");
    const ownTask = await read.execute("call-1", {
      path: path.join(TMP_ROOT, "data", "tasks", "t1", "notes.txt"),
    });
    expect(ownTask.content.map((c) => c.text).join("\n")).toContain("task notes");
    // 别的 task 的东西 + 系统文件一律拒（守卫先拦，不碰盘）
    const otherTask = await read.execute("call-1", {
      path: path.join(TMP_ROOT, "data", "tasks", "other", "secret.txt"),
    });
    expect(otherTask.content.map((c) => c.text).join("\n")).toContain("旁路只读");
    const etc = await read.execute("call-1", { path: "/etc/passwd" });
    expect(etc.content.map((c) => c.text).join("\n")).toContain("旁路只读");
  });

  it("def 级 grep：基址越界拒绝（不走到 rg，不碰网）", async () => {
    const defs = buildReadOnlyToolDefs(CWD, { taskId: "t1" });
    const grep = defs.find(
      (d) => (d as { name?: unknown }).name === "grep",
    ) as unknown as {
      execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }>;
    };
    const blocked = await grep.execute("call-1", {
      pattern: "password",
      path: path.join(TMP_ROOT, "data"),
    });
    expect(blocked.content.map((c) => c.text).join("\n")).toContain("旁路只读");
  });
});
