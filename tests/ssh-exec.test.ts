/**
 * ssh-exec（CLI 脚本）测试：spawn 真实脚本 + preload mock ssh2
 * 验证：env 模式密码进 connect、host 模式走密钥、错误不泄露密码、参数校验
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "ssh-exec.mjs");
const PRELOAD = path.join(ROOT, "tests", "helpers", "ssh2-preload.cjs");

const TMP = mkdtempSync(path.join(os.tmpdir(), "ssh-exec-test-"));
const CONFIG_PATH = path.join(TMP, "company-env.json");
const DUMP_PATH = path.join(TMP, "connect-dump.json");

const CONFIG = {
  servers: [
    { env: "dev", host: "10.0.0.2", port: 22, user: "root", password: "pw-dev" },
    { env: "test", host: "10.0.0.1", port: 22, user: "app", password: "pw-test" },
    { env: "test", host: "10.0.0.11", port: 22, user: "app2", password: "pw-test-2" },
  ],
};

type Result = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: string;
};

/** spawn 脚本并读 stdout JSON（非零退出码也正常返回，错误场景脚本按设计 exit 1） */
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
          SSH_EXEC_CONFIG: CONFIG_PATH,
          SSH2_FAKE_DUMP: DUMP_PATH,
          SSH2_KNOWN_HOSTS: path.join(TMP, "known_hosts"),
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
});

describe("ssh-exec CLI", () => {
  it("env 模式：密码从配置读取进 connect、stdout 收集", async () => {
    const { result, dump } = await run(
      ["--env", "test", "--", "echo hi"],
      { SSH2_FAKE_STDOUT: "hi\n" },
    );
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("hi\n");
    expect(dump?.password).toBe("pw-test");
    expect(dump?.username).toBe("app");
    expect(dump?.host).toBe("10.0.0.1");
  });

  it("大 stdout 完整进入 JSON（不因提前 exit 截断）", async () => {
    const big = "x".repeat(150_000);
    const { result } = await run(["--env", "test", "--", "cat big.log"], {
      SSH2_FAKE_STDOUT: big,
    });
    expect(result.ok).toBe(true);
    expect(result.stdout.length).toBe(big.length);
    expect(result.stdout).toBe(big);
  });

  it("超大 stdout 在累积阶段截断、JSON 体积有界", async () => {
    const big = "y".repeat(500_000);
    const { result } = await run(["--env", "test", "--", "cat huge.log"], {
      SSH2_FAKE_STDOUT: big,
    });
    expect(result.ok).toBe(true);
    expect(result.stdout.length).toBeLessThan(210_000);
    expect(result.stdout).toContain("输出已截断");
  });

  it("user 覆盖选择对应条目", async () => {
    const { dump } = await run(["--env", "test", "--user", "app", "--", "ls"]);
    expect(dump?.username).toBe("app");
    expect(dump?.password).toBe("pw-test");
  });

  it("--config 显式指定配置文件，优先于 SSH_EXEC_CONFIG", async () => {
    const customPath = path.join(TMP, "custom-env.json");
    await writeFile(
      customPath,
      JSON.stringify({
        servers: [
          {
            env: "test",
            host: "10.0.0.99",
            port: 22,
            user: "ops",
            password: "pw-custom",
          },
        ],
      }),
    );
    const { result, dump } = await run(
      ["--config", customPath, "--env", "test", "--", "ls"],
      { SSH_EXEC_CONFIG: path.join(TMP, "missing.json") },
    );
    expect(result.ok).toBe(true);
    expect(dump?.host).toBe("10.0.0.99");
    expect(dump?.username).toBe("ops");
    expect(dump?.password).toBe("pw-custom");
  });

  it("--env 带 :n 序号：选择同环境第 N 台服务器", async () => {
    const first = await run(["--env", "test:1", "--", "ls"]);
    expect(first.dump?.host).toBe("10.0.0.1");
    expect(first.dump?.password).toBe("pw-test");

    const second = await run(["--env", "test:2", "--", "ls"]);
    expect(second.dump?.host).toBe("10.0.0.11");
    expect(second.dump?.username).toBe("app2");
    expect(second.dump?.password).toBe("pw-test-2");
  });

  it("--env 序号非法或越界 → 可读错误", async () => {
    const zero = await run(["--env", "test:0", "--", "ls"]);
    expect(zero.result.error).toContain("序号从 1 开始");

    const outOfRange = await run(["--env", "test:9", "--", "ls"]);
    expect(outOfRange.result.error).toContain("服务器配置不存在");
  });

  it("--user 与 --env 序号同传 → 拒绝歧义", async () => {
    const { result } = await run([
      "--env",
      "test:2",
      "--user",
      "app",
      "--",
      "ls",
    ]);
    expect(result.error).toContain("二选一");
  });

  it("host 模式：走本机密钥（connect 无 password）、仍可执行", async () => {
    const { result, dump } = await run(
      ["--host", "192.168.1.50", "--user", "ops", "--", "uptime"],
      { SSH2_FAKE_STDOUT: "up" },
    );
    expect(result.ok).toBe(true);
    expect(dump?.host).toBe("192.168.1.50");
    expect(dump?.username).toBe("ops");
    expect(dump?.password).toBeUndefined();
  });

  it("env 不存在 → 可读错误、无密码泄露", async () => {
    const { result, dump } = await run(["--env", "prod", "--", "ls"]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("服务器配置不存在");
    expect(JSON.stringify(result)).not.toContain("pw-");
    expect(dump).toBeNull();
  });

  it("认证失败 → 错误信息不含密码", async () => {
    const { result } = await run(["--env", "test", "--", "ls"], {
      SSH2_FAKE_MODE: "auth-fail",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("authentication");
    expect(result.error).not.toContain("pw-test");
  });

  it("参数校验：缺 --env/--host 或缺命令都报错", async () => {
    const noTarget = await run(["--", "ls"]);
    expect(noTarget.result.error).toContain("--env 或 --host");

    const noCmd = await run(["--env", "test"]);
    expect(noCmd.result.error).toContain("远程命令");
  });

  it("参数校验：未知 flag、双模式、非法端口、裸参数都拒绝", async () => {
    const unknown = await run(["--env", "test", "--bogus", "x", "--", "ls"]);
    expect(unknown.result.error).toContain("未知参数");

    const both = await run(["--env", "test", "--host", "h", "--", "ls"]);
    expect(both.result.error).toContain("不能同时使用");

    const badPort = await run(["--host", "h", "--port", "abc", "--", "ls"]);
    expect(badPort.result.error).toContain("1-65535");

    const portWithEnv = await run(["--env", "test", "--port", "2222", "--", "ls"]);
    expect(portWithEnv.result.error).toContain("--host 模式");

    const bare = await run(["--env", "test", "--user", "root", "ls"]);
    expect(bare.result.error).toContain("裸参数");
  });

  it("带引号的单个远程命令原样透传（含再出现的 --）", async () => {
    const { result, dump } = await run([
      "--env",
      "test",
      "--",
      "git checkout -- README.md",
    ]);
    expect(result.ok).toBe(true);
    expect(dump?.cmd).toBe("git checkout -- README.md");
  });

  it("远程命令拆成多个 token → 拒绝并提示用单个带引号参数", async () => {
    const { result } = await run([
      "--env",
      "test",
      "--",
      "grep",
      "hello world",
      "file",
    ]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("单个带引号的参数");
  });

  it("host key 校验：known_hosts 匹配放行、不匹配拒绝", async () => {
    const knownHosts = path.join(TMP, "known_hosts");
    const hostKey =
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICi+npzd79xkDoP4gPqozCU6HcKyRKmHfwZKy3i2isKj";
    await writeFile(knownHosts, `10.0.0.1 ${hostKey}\n`);

    const ok = await run(["--env", "test", "--", "ls"], {
      SSH2_FAKE_MODE: "host-verify",
      SSH2_FAKE_HOST_KEY: hostKey,
      SSH2_KNOWN_HOSTS: knownHosts,
    });
    expect(ok.result.ok).toBe(true);

    await writeFile(knownHosts, "10.0.0.1 ssh-rsa AAAAB3NzaC1yc2EAAAAFAKE\n");
    const rejected = await run(["--env", "test", "--", "ls"], {
      SSH2_FAKE_MODE: "host-verify",
      SSH2_FAKE_HOST_KEY: hostKey,
      SSH2_KNOWN_HOSTS: knownHosts,
    });
    expect(rejected.result.ok).toBe(false);
    expect(rejected.result.error).toContain("known_hosts");
  });

  it("host key 校验：支持 [host]:port、通配和负匹配语义", async () => {
    const knownHosts = path.join(TMP, "known_hosts");
    const hostKey =
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICi+npzd79xkDoP4gPqozCU6HcKyRKmHfwZKy3i2isKj";
    const common = { SSH2_FAKE_MODE: "host-verify", SSH2_FAKE_HOST_KEY: hostKey };

    await writeFile(knownHosts, `[10.0.0.1]:22 ${hostKey}\n`);
    const bracketed = await run(["--env", "test", "--", "ls"], {
      ...common,
      SSH2_KNOWN_HOSTS: knownHosts,
    });
    expect(bracketed.result.ok).toBe(true);

    await writeFile(knownHosts, `10.0.0.* ${hostKey}\n`);
    const wildcard = await run(["--env", "test", "--", "ls"], {
      ...common,
      SSH2_KNOWN_HOSTS: knownHosts,
    });
    expect(wildcard.result.ok).toBe(true);

    await writeFile(knownHosts, `!10.0.0.*,10.0.0.1 ${hostKey}\n`);
    const negated = await run(["--env", "test", "--", "ls"], {
      ...common,
      SSH2_KNOWN_HOSTS: knownHosts,
    });
    expect(negated.result.ok).toBe(false);
    expect(negated.result.error).toContain("known_hosts");
  });

  it("known_hosts：@revoked 优先于普通条目、同 host 其它 key 不受影响", async () => {
    const knownHosts = path.join(TMP, "known_hosts");
    const hostKey =
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICi+npzd79xkDoP4gPqozCU6HcKyRKmHfwZKy3i2isKj";
    const common = { SSH2_FAKE_MODE: "host-verify", SSH2_FAKE_HOST_KEY: hostKey };
    const keyB64 = hostKey.split(/\s+/)[1];

    await writeFile(
      knownHosts,
      `@revoked 10.0.0.1 ssh-ed25519 ${keyB64}\n10.0.0.1 ${hostKey}\n`,
    );
    const revoked = await run(["--env", "test", "--", "ls"], {
      ...common,
      SSH2_KNOWN_HOSTS: knownHosts,
    });
    expect(revoked.result.ok).toBe(false);
    expect(revoked.result.error).toContain("known_hosts");

    await writeFile(
      knownHosts,
      `@revoked 10.0.0.1 ssh-rsa AAAAB3NzaC1yc2EAAAAFAKE\n10.0.0.1 ${hostKey}\n`,
    );
    const otherKey = await run(["--env", "test", "--", "ls"], {
      ...common,
      SSH2_KNOWN_HOSTS: knownHosts,
    });
    expect(otherKey.result.ok).toBe(true);
  });

  it("known_hosts：@cert-authority / 未知 marker 不当作普通 key 放行", async () => {
    const knownHosts = path.join(TMP, "known_hosts");
    const hostKey =
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICi+npzd79xkDoP4gPqozCU6HcKyRKmHfwZKy3i2isKj";
    const common = { SSH2_FAKE_MODE: "host-verify", SSH2_FAKE_HOST_KEY: hostKey };

    await writeFile(knownHosts, `@cert-authority 10.0.0.1 ${hostKey}\n`);
    const caOnly = await run(["--env", "test", "--", "ls"], {
      ...common,
      SSH2_KNOWN_HOSTS: knownHosts,
    });
    expect(caOnly.result.ok).toBe(false);
    expect(caOnly.result.error).toContain("known_hosts");

    await writeFile(knownHosts, `@mystery 10.0.0.1 ${hostKey}\n`);
    const mystery = await run(["--env", "test", "--", "ls"], {
      ...common,
      SSH2_KNOWN_HOSTS: knownHosts,
    });
    expect(mystery.result.ok).toBe(false);
  });

  it("Channel 中途 error → 约定 JSON，不抛未捕获异常", async () => {
    const { result } = await run(["--env", "test", "--", "ls"], {
      SSH2_FAKE_MODE: "stream-error",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("远程命令执行失败");
    expect(result.error).toContain("remote channel exploded");
  });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});
