/**
 * ssh-exec（CLI 脚本）测试：spawn 真实脚本 + preload mock ssh2
 * 验证：env 模式密码进 connect、host 模式走密钥、错误不泄露密码、参数校验
 */
import { execFile } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "ssh-exec.mjs");
const PRELOAD = path.join(ROOT, "tests", "helpers", "ssh2-preload.cjs");

// 真实 ssh2 只用来生成测试密钥（脚本本身在 preload 下走 fake）
const { utils: ssh2Utils } = createRequire(import.meta.url)("ssh2") as {
  utils: {
    generateKeyPairSync: (
      type: string,
      opts?: Record<string, unknown>,
    ) => { private: string; public: string };
  };
};

const TMP = mkdtempSync(path.join(os.tmpdir(), "ssh-exec-test-"));
const CONFIG_PATH = path.join(TMP, "company-env.json");
const DUMP_PATH = path.join(TMP, "connect-dump.json");
// 假 HOME：脚本读 ~/.ssh 找本机私钥，测试里绝不能碰到开发机真实密钥
const FAKE_HOME = path.join(TMP, "home");
const FAKE_SSH_DIR = path.join(FAKE_HOME, ".ssh");

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

/**
 * 把「假 ssh 的 stdout」写进文件、返回路径（配合 SSH2_FAKE_STDOUT_FILE）。
 * 不能用环境变量传大输出：Linux 单个环境变量上限 128KB（MAX_ARG_STRLEN），
 * 150KB / 500KB 的 env 会让 spawn 直接 E2BIG（macOS 没这个限制，本机跑不出来、CI 的 Linux 才红）。
 */
const writeFakeStdoutFile = async (content: string): Promise<string> => {
  const file = path.join(TMP, "fake-stdout.txt");
  await writeFile(file, content);
  return file;
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
          HOME: FAKE_HOME,
          USERPROFILE: FAKE_HOME,
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

/** 重置假 ~/.ssh 并写入给定文件（文件名 → 内容） */
const setLocalKeys = async (files: Record<string, string> = {}) => {
  await rm(FAKE_SSH_DIR, { recursive: true, force: true });
  await mkdir(FAKE_SSH_DIR, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(FAKE_SSH_DIR, name), content);
  }
};

beforeEach(async () => {
  await mkdir(TMP, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(CONFIG));
  await setLocalKeys();
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
      SSH2_FAKE_STDOUT_FILE: await writeFakeStdoutFile(big),
    });
    expect(result.ok).toBe(true);
    expect(result.stdout.length).toBe(big.length);
    expect(result.stdout).toBe(big);
  });

  it("超大 stdout 在累积阶段截断、JSON 体积有界", async () => {
    const big = "y".repeat(500_000);
    const { result } = await run(["--env", "test", "--", "cat huge.log"], {
      SSH2_FAKE_STDOUT_FILE: await writeFakeStdoutFile(big),
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

  describe("本机私钥：只在 --host 模式读取、按顺序逐把交给 ssh2、带口令 / 不可解析的跳过", () => {
    const encryptedKey = () =>
      ssh2Utils.generateKeyPairSync("ed25519", {
        passphrase: "local-passphrase-secret",
        cipher: "aes256-cbc",
      }).private;
    const plainKey = (type = "ed25519") =>
      ssh2Utils.generateKeyPairSync(
        type,
        type === "ecdsa" ? { bits: 256 } : undefined,
      ).private;
    /** dump 里 authHandler 数组的 key 序列（host 模式逐把尝试的私钥） */
    const authKeys = (dump: Record<string, unknown> | null): string[] =>
      ((dump?.authHandler as { type: string; key: string }[] | undefined) ?? []).map(
        (a) => a.key,
      );
    const hostArgs = ["--host", "192.168.1.50", "--user", "ops", "--", "ls"];

    it("--env 模式绝不带本机私钥：~/.ssh 里有可用私钥也只用配置里的密码（R1-12）", async () => {
      await setLocalKeys({
        id_ed25519: plainKey(),
        id_rsa: encryptedKey(),
        id_ecdsa: plainKey("ecdsa"),
      });
      const { result, dump } = await run(["--env", "test", "--", "ls"], {
        SSH2_FAKE_STDOUT: "ok",
      });
      expect(result.error).toBeUndefined();
      expect(result.ok).toBe(true);
      expect(dump?.password).toBe("pw-test");
      expect(dump?.privateKey).toBeUndefined();
      expect(dump?.authHandler).toBeUndefined();
    });

    it("--env 模式认证失败：提示指向环境配置里的密码，不提本机私钥 / ssh-copy-id / 跳过列表", async () => {
      await setLocalKeys({ id_ed25519: encryptedKey(), id_rsa: plainKey() });
      const { result } = await run(["--env", "test", "--", "ls"], {
        SSH2_FAKE_MODE: "auth-fail",
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("authentication");
      expect(result.error).toContain("环境配置");
      expect(result.error).not.toContain("ssh-copy-id");
      expect(result.error).not.toContain("id_ed25519");
      expect(result.error).not.toContain("id_rsa");
      expect(result.error).not.toContain("pw-test");
    });

    it("--host 模式：无口令私钥以 authHandler 形式逐把交给 ssh2（不再单把 privateKey）", async () => {
      const key = plainKey();
      await setLocalKeys({ id_ed25519: key });
      const { result, dump } = await run(hostArgs);
      expect(result.ok).toBe(true);
      expect(dump?.password).toBeUndefined();
      expect(dump?.privateKey).toBeUndefined();
      expect(dump?.authHandler).toEqual([
        { type: "publickey", username: "ops", key },
      ]);
    });

    it("--host 模式：带口令 / 不可解析的跳过，其余可用的按文件优先级逐把全部交给 ssh2", async () => {
      const ed = plainKey();
      const ec = plainKey("ecdsa");
      await setLocalKeys({
        id_ed25519: ed,
        id_rsa: encryptedKey(),
        id_ecdsa: ec,
      });
      const { result, dump } = await run(hostArgs);
      expect(result.ok).toBe(true);
      // 顺序 = id_ed25519 → id_ecdsa（id_rsa 带口令被跳过）；ssh2 逐把尝试，前一把被拒才试下一把
      expect(authKeys(dump)).toEqual([ed, ec]);

      // 第一把带口令、第二把垃圾内容、第三把可用 → 只剩第三把
      await setLocalKeys({
        id_ed25519: encryptedKey(),
        id_rsa: "-----BEGIN GARBAGE-----\nnot a key\n",
        id_ecdsa: ec,
      });
      const second = await run(hostArgs);
      expect(second.result.ok).toBe(true);
      expect(authKeys(second.dump)).toEqual([ec]);
    });

    it("--host 模式：只有公钥内容的文件也跳过（不交给 ssh2）", async () => {
      const pub = ssh2Utils.generateKeyPairSync("ed25519").public;
      await setLocalKeys({ id_ed25519: pub });
      const { result, dump } = await run(hostArgs);
      expect(result.ok).toBe(true);
      expect(dump?.authHandler).toBeUndefined();
      expect(dump?.privateKey).toBeUndefined();
    });

    it("--host 模式只有带口令私钥 → 认证失败时给出清晰提示，且不泄露任何凭据", async () => {
      const key = encryptedKey();
      await setLocalKeys({ id_ed25519: key });
      const { result, dump } = await run(hostArgs, { SSH2_FAKE_MODE: "auth-fail" });
      expect(result.ok).toBe(false);
      expect(dump?.authHandler).toBeUndefined();
      // 不是「脚本异常」，而是带原因的连接失败
      expect(result.error).not.toContain("脚本异常");
      expect(result.error).toContain("id_ed25519");
      expect(result.error).toContain("口令");
      // --host 模式没有密码这回事：提示不能再说「检查服务器密码」
      expect(result.error).not.toContain("服务器密码");
      const raw = JSON.stringify(result);
      expect(raw).not.toContain("local-passphrase-secret");
      expect(raw).not.toContain("BEGIN OPENSSH PRIVATE KEY");
      expect(raw).not.toContain(key.split("\n")[1]);
    });

    it("--host 模式认证失败：提示已按顺序尝试了哪几把、让用户 ssh-copy-id 对应公钥", async () => {
      await setLocalKeys({
        id_ed25519: plainKey(),
        id_rsa: encryptedKey(),
        id_ecdsa: plainKey("ecdsa"),
      });
      const { result } = await run(hostArgs, { SSH2_FAKE_MODE: "auth-fail" });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("id_ed25519");
      expect(result.error).toContain("id_ecdsa");
      expect(result.error).toContain("ssh-copy-id");
      expect(result.error).toContain("id_rsa（带口令");
      expect(result.error).not.toContain("服务器密码");
    });

    it("--host 模式没有任何可用私钥 → 认证失败提示「未找到可用的本机私钥」并说明不支持口令私钥 / agent", async () => {
      await setLocalKeys();
      const { result } = await run(hostArgs, { SSH2_FAKE_MODE: "auth-fail" });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("未找到可用的本机私钥");
      expect(result.error).toContain("agent");
      expect(result.error).not.toContain("服务器密码");
    });
  });

  describe("连接 / 超时 / 失败提示（P3）", () => {
    it("conn.connect 同步 throw → 约定 JSON 的连接失败，不是「脚本异常」", async () => {
      const { result } = await run(["--env", "test", "--", "ls"], {
        SSH2_FAKE_MODE: "connect-throw",
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("SSH 连接失败（10.0.0.1:22）");
      expect(result.error).toContain("fake connect exploded");
      expect(result.error).not.toContain("脚本异常");
      expect(result.exitCode).toBeNull();
    });

    it("远程命令超时 → 报超时并 destroy 连接（end() 对挂死的对端不够）", async () => {
      const { result, dump } = await run(["--env", "test", "--", "sleep 999"], {
        SSH2_FAKE_MODE: "exec-hang",
        SSH_EXEC_TIMEOUT_MS: "300",
      });
      expect(result.ok).toBe(false);
      expect(result.error).toBe("SSH 命令执行超时");
      expect(dump?.destroyed).toBe(true);
    });

    it("连接阶段报错（认证失败）也 destroy 兜底；成功路径保持优雅关闭、不强杀", async () => {
      const failed = await run(["--env", "test", "--", "ls"], {
        SSH2_FAKE_MODE: "auth-fail",
      });
      expect(failed.dump?.destroyed).toBe(true);

      const ok = await run(["--env", "test", "--", "ls"]);
      expect(ok.result.ok).toBe(true);
      // 成功时进程会在 destroy 兜底定时器（unref、1s）触发前就正常退出
      expect(ok.dump?.destroyed).toBeUndefined();
    });

    it("known_hosts 校验失败的提示：说明非 22 端口要写成 [host]:port", async () => {
      await writeFile(
        path.join(TMP, "known_hosts"),
        "10.0.0.1 ssh-rsa AAAAB3NzaC1yc2EAAAAFAKE\n",
      );
      const { result } = await run(["--env", "test", "--", "ls"], {
        SSH2_FAKE_MODE: "host-verify",
        SSH2_KNOWN_HOSTS: path.join(TMP, "known_hosts"),
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("known_hosts");
      expect(result.error).toContain("[host]:port");
    });

    it("握手阶段「签名校验失败」不是 known_hosts 问题，不误报 known_hosts 提示", async () => {
      const { result } = await run(["--env", "test", "--", "ls"], {
        SSH2_FAKE_MODE: "sig-fail",
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("signature verification failed");
      expect(result.error).not.toContain("known_hosts");
    });
  });

  describe("serverHostKey 按 known_hosts 里该 host 已记录的 key 类型收窄（R1-13）", () => {
    const ed25519Line =
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICi+npzd79xkDoP4gPqozCU6HcKyRKmHfwZKy3i2isKj";
    const rsaLine = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQFAKERSAFAKERSA";
    const ecdsaLine =
      "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYFAKEECDSA";
    const knownHostsPath = path.join(TMP, "known_hosts");
    const bothKeys = JSON.stringify({
      "ssh-ed25519": ed25519Line,
      "ssh-rsa": rsaLine,
    });
    const algos = (dump: Record<string, unknown> | null) =>
      (dump?.algorithms as { serverHostKey?: string[] } | undefined)
        ?.serverHostKey;
    const connectEnv = (serverKeys: string) => ({
      SSH2_FAKE_MODE: "host-verify",
      SSH2_FAKE_SERVER_KEYS: serverKeys,
      SSH2_KNOWN_HOSTS: knownHostsPath,
    });

    it("known_hosts 只记了 RSA、服务端两种 key 都有 → 只提供 RSA 算法，握手协商到已信任的 key 而被放行", async () => {
      await writeFile(knownHostsPath, `10.0.0.1 ${rsaLine}\n`);
      const { result, dump } = await run(
        ["--env", "test", "--", "ls"],
        connectEnv(bothKeys),
      );
      // 默认顺序 ssh2 会先协商 ed25519 → 与 known_hosts 里的 RSA 对不上被拒（可用性 bug）
      expect(result.error).toBeUndefined();
      expect(result.ok).toBe(true);
      expect(algos(dump)).toEqual(["rsa-sha2-512", "rsa-sha2-256", "ssh-rsa"]);
    });

    it("记了多种类型 → 按 ssh2 默认偏好序保留这些类型", async () => {
      await writeFile(
        knownHostsPath,
        `10.0.0.1 ${rsaLine}\n10.0.0.1 ${ecdsaLine}\n10.0.0.1 ${ed25519Line}\n`,
      );
      const { result, dump } = await run(
        ["--env", "test", "--", "ls"],
        connectEnv(bothKeys),
      );
      expect(result.ok).toBe(true);
      expect(algos(dump)).toEqual([
        "ssh-ed25519",
        "ecdsa-sha2-nistp256",
        "rsa-sha2-512",
        "rsa-sha2-256",
        "ssh-rsa",
      ]);
    });

    it("[host]:port / 哈希条目也参与收窄；别的 host / 别的端口的条目不参与", async () => {
      const salt = randomBytes(20);
      const mac = createHmac("sha1", salt).update("[10.0.0.5]:2222").digest();
      const hashedName = `|1|${salt.toString("base64")}|${mac.toString("base64")}`;
      await writeFile(
        knownHostsPath,
        [
          `${hashedName} ${rsaLine}`, // 10.0.0.5:2222 的哈希条目
          `10.0.0.5 ${ed25519Line}`, // 22 端口：不适用于 2222
          `10.0.0.9 ${ecdsaLine}`, // 别的主机
        ].join("\n") + "\n",
      );
      const { result, dump } = await run(
        ["--host", "10.0.0.5", "--port", "2222", "--user", "ops", "--", "ls"],
        connectEnv(bothKeys),
      );
      expect(result.ok).toBe(true);
      expect(algos(dump)).toEqual(["rsa-sha2-512", "rsa-sha2-256", "ssh-rsa"]);
    });

    it("host 不在 known_hosts（首次连接）→ 不收窄、仍 fail-closed 拒绝", async () => {
      await writeFile(knownHostsPath, `10.0.0.99 ${rsaLine}\n`);
      const { result, dump } = await run(
        ["--env", "test", "--", "ls"],
        connectEnv(bothKeys),
      );
      expect(algos(dump)).toBeUndefined();
      expect(dump?.algorithms).toBeUndefined();
      expect(result.ok).toBe(false);
      expect(result.error).toContain("known_hosts");
    });

    it("只有 @revoked / @cert-authority / 不支持的类型 → 不收窄、仍拒绝", async () => {
      for (const line of [
        `@revoked 10.0.0.1 ${rsaLine}`,
        `@cert-authority 10.0.0.1 ${rsaLine}`,
        "10.0.0.1 sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29t",
      ]) {
        await writeFile(knownHostsPath, `${line}\n`);
        const { result, dump } = await run(
          ["--env", "test", "--", "ls"],
          connectEnv(bothKeys),
        );
        expect(dump?.algorithms, line).toBeUndefined();
        expect(result.ok, line).toBe(false);
      }
    });

    it("known_hosts 记的 key 类型服务端根本没有 → 仍拒绝，并给出「类型不匹配」的明确提示", async () => {
      await writeFile(knownHostsPath, `10.0.0.1 ${rsaLine}\n`);
      const { result } = await run(
        ["--env", "test", "--", "ls"],
        connectEnv(JSON.stringify({ "ssh-ed25519": ed25519Line })),
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain("no matching host key format");
      expect(result.error).toContain("known_hosts");
      expect(result.error).toContain("ssh-rsa");
    });

    it("收窄后 hostVerifier 仍逐字节比对：host 匹配但 key 内容不同 → 拒绝", async () => {
      await writeFile(
        knownHostsPath,
        "10.0.0.1 ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDIFFERENTKEY\n",
      );
      const { result, dump } = await run(
        ["--env", "test", "--", "ls"],
        connectEnv(bothKeys),
      );
      expect(algos(dump)).toEqual(["rsa-sha2-512", "rsa-sha2-256", "ssh-rsa"]);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("known_hosts");
    });
  });

  describe("known_hosts 匹配（非 22 端口 / 逗号列表 / 裸 IPv6 / 哈希条目；仍 fail-closed）", () => {
    const hostKey =
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICi+npzd79xkDoP4gPqozCU6HcKyRKmHfwZKy3i2isKj";
    const otherKey =
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOtherKeyOtherKeyOtherKeyOtherKeyOtherKeyOtherK";
    const knownHostsPath = path.join(TMP, "known_hosts");

    /** host 模式连一次，返回是否被 hostVerifier 放行 */
    const verify = async (
      line: string,
      host: string,
      port?: number,
    ): Promise<boolean> => {
      await writeFile(knownHostsPath, `${line}\n`);
      const args = ["--host", host, "--user", "ops"];
      if (port !== undefined) args.push("--port", String(port));
      const { result } = await run([...args, "--", "ls"], {
        SSH2_FAKE_MODE: "host-verify",
        SSH2_FAKE_HOST_KEY: hostKey,
        SSH2_KNOWN_HOSTS: knownHostsPath,
      });
      if (!result.ok) expect(result.error).toContain("known_hosts");
      return result.ok;
    };

    /** OpenSSH `HashKnownHosts`：`|1|base64(salt)|base64(HMAC-SHA1(salt, 主机串))` */
    const hashed = (name: string) => {
      const salt = randomBytes(20);
      const mac = createHmac("sha1", salt).update(name).digest();
      return `|1|${salt.toString("base64")}|${mac.toString("base64")}`;
    };

    it("[host]:port 条目：只放行对应端口", async () => {
      expect(await verify(`[10.0.0.5]:2222 ${hostKey}`, "10.0.0.5", 2222)).toBe(true);
      // 端口不同 / 裸 host 条目对应 22 端口：都不能互相放行
      expect(await verify(`[10.0.0.5]:2222 ${hostKey}`, "10.0.0.5", 2223)).toBe(false);
      expect(await verify(`[10.0.0.5]:2222 ${hostKey}`, "10.0.0.5")).toBe(false);
      expect(await verify(`10.0.0.5 ${hostKey}`, "10.0.0.5", 2222)).toBe(false);
    });

    it("逗号分隔的多 host 列表（含每项各带 [host]:port）", async () => {
      const line = `[10.0.0.5]:2222,[backup.example.com]:2222 ${hostKey}`;
      expect(await verify(line, "10.0.0.5", 2222)).toBe(true);
      expect(await verify(line, "backup.example.com", 2222)).toBe(true);
      expect(await verify(line, "other.example.com", 2222)).toBe(false);
      // 22 端口的列表（ssh 对 HostKeyAlias / CheckHostIP 的写法）
      const plain = `app.example.com,10.0.0.5 ${hostKey}`;
      expect(await verify(plain, "10.0.0.5")).toBe(true);
      expect(await verify(plain, "app.example.com")).toBe(true);
      expect(await verify(plain, "10.0.0.6")).toBe(false);
    });

    it("裸 IPv6（22 端口）与 [IPv6]:port", async () => {
      expect(await verify(`2001:db8::1 ${hostKey}`, "2001:db8::1")).toBe(true);
      expect(await verify(`2001:db8::1 ${hostKey}`, "2001:db8::2")).toBe(false);
      expect(await verify(`[2001:db8::1]:2222 ${hostKey}`, "2001:db8::1", 2222)).toBe(true);
      // 裸 IPv6 条目不能被当成「host:端口」误解析、更不能放行非 22 端口
      expect(await verify(`2001:db8::1 ${hostKey}`, "2001:db8::1", 2222)).toBe(false);
    });

    it("哈希条目 |1|salt|hash：22 端口与 [host]:port 都能校验", async () => {
      expect(await verify(`${hashed("10.0.0.5")} ${hostKey}`, "10.0.0.5")).toBe(true);
      expect(await verify(`${hashed("[10.0.0.5]:2222")} ${hostKey}`, "10.0.0.5", 2222)).toBe(true);
      // 哈希对不上（别的主机 / 别的端口）一律拒绝
      expect(await verify(`${hashed("10.0.0.9")} ${hostKey}`, "10.0.0.5")).toBe(false);
      expect(await verify(`${hashed("[10.0.0.5]:2222")} ${hostKey}`, "10.0.0.5")).toBe(false);
      expect(await verify(`${hashed("10.0.0.5")} ${hostKey}`, "10.0.0.5", 2222)).toBe(false);
      // 哈希字段损坏 / 截断：拒绝而不是抛异常
      expect(await verify(`|1|%%%|%%% ${hostKey}`, "10.0.0.5")).toBe(false);
      expect(await verify(`|1|onlysalt ${hostKey}`, "10.0.0.5")).toBe(false);
    });

    it("fail-closed：host 匹配但 key 不同、负匹配命中仍拒绝", async () => {
      expect(await verify(`[10.0.0.5]:2222 ${otherKey}`, "10.0.0.5", 2222)).toBe(false);
      expect(await verify(`${hashed("10.0.0.5")} ${otherKey}`, "10.0.0.5")).toBe(false);
      expect(
        await verify(`![10.0.0.5]:2222,[10.0.0.*]:2222 ${hostKey}`, "10.0.0.5", 2222),
      ).toBe(false);
    });
  });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});
