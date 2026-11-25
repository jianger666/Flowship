/**
 * 本机固定的「test 包签名证书」：让 FlowshipTest 每次重新打包后身份不变。
 *
 * 为什么需要：不设签名身份时 test 包是 ad-hoc 签名，身份绑「代码哈希」，每打一次包都变——
 * 系统「辅助功能 / 屏幕录制」的授权全部失效，钥匙串里保存的开机密码也因为访问控制只认旧身份而读不出来。
 * 这里生成一张只给本机 test 包用的自签证书，放进专用钥匙串（默认 ~/.flowship-test-signing/，不是登录钥匙串），
 * 打包时经 FLOWSHIP_SIGN_IDENTITY / FLOWSHIP_SIGN_KEYCHAIN 交给 scripts/electron-after-pack.mjs——和发版 CI 走同一条签名路径。
 *
 * 目录内容（缺一样就当没有，需要重新 setup）：
 *   identity.txt        证书 SHA-1 指纹（40 位小写十六进制，不是机密）；最后一个写入，它在 = 整套已就绪且自检通过
 *   test-sign.keychain-db  专用钥匙串，里面只有这一张测试证书的私钥
 *   keychain-password   只用来解锁上面那个专用钥匙串（权限 0600）
 *
 * 取舍（别悄悄改掉）：私钥在本机、同一用户下的程序读得到钥匙串密码，所以这张证书只配用来签「本机 test 包」，
 * 绝不用于发版（发版证书的私钥只在 GitHub 的 release environment 里，见 .github/workflows/release.yml）。
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { designatedRequirementNamesCertificate } from "./codesign-requirement.mjs";

const execFileP = promisify(execFile);

export const TEST_SIGNING_DIR_ENV = "FLOWSHIP_TEST_SIGN_DIR";
export const TEST_SIGNING_COMMON_NAME = "Flowship Test Local Signing";
/** macOS 自带的 openssl（LibreSSL）：导出的 p12 能被 `security import` 直接读；Homebrew 的 OpenSSL 3 默认算法读不了 */
export const OPENSSL = "/usr/bin/openssl";

const OPENSSL_CONFIG = `[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = ${TEST_SIGNING_COMMON_NAME}
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
`;

/**
 * 证书目录：环境变量 FLOWSHIP_TEST_SIGN_DIR 优先，缺省 ~/.flowship-test-signing
 * @param {{ env?: Record<string, string | undefined>, home?: string }} [opts]
 * @returns {string}
 */
export const resolveTestSigningDir = ({ env = process.env, home = os.homedir() } = {}) =>
  String(env[TEST_SIGNING_DIR_ENV] ?? "").trim() || path.join(home, ".flowship-test-signing");

export const testSigningPaths = (dir) => ({
  dir,
  identityFile: path.join(dir, "identity.txt"),
  keychain: path.join(dir, "test-sign.keychain-db"),
  passwordFile: path.join(dir, "keychain-password"),
});

/** 指纹文本 → 40 位小写十六进制；不合格返回 null（冒号分隔、大写、首尾空白都认） */
export const parseFingerprint = (text) => {
  const hex = String(text ?? "")
    .trim()
    .replace(/:/g, "")
    .toLowerCase();
  return /^[0-9a-f]{40}$/.test(hex) ? hex : null;
};

/**
 * 读本机已有的 test 签名证书；缺任何一样（指纹 / 钥匙串 / 密码）都返回 null。
 * 返回值里的 password 只用来解锁专用钥匙串，不得打印、不得写进日志。
 * @returns {Promise<{ dir: string, identity: string, keychain: string, password: string } | null>}
 */
export const readTestSigning = async ({ dir, fsImpl = fs }) => {
  const p = testSigningPaths(dir);
  try {
    const identity = parseFingerprint(await fsImpl.readFile(p.identityFile, "utf8"));
    if (!identity) return null;
    const password = String(await fsImpl.readFile(p.passwordFile, "utf8")).trim();
    if (!password) return null;
    await fsImpl.access(p.keychain);
    return { dir, identity, keychain: p.keychain, password };
  } catch {
    return null;
  }
};

/** 打包时交给 afterPack 的两个环境变量（和发版 CI 同名） */
export const buildSigningBuildEnv = (signing) => ({
  FLOWSHIP_SIGN_IDENTITY: signing.identity,
  FLOWSHIP_SIGN_KEYCHAIN: signing.keychain,
});

/** 打包用的子进程环境：在基础环境上叠加签名变量；没有本机证书就原样（沿用 ad-hoc / 调用方自己设的变量） */
export const buildTestBuildEnv = (baseEnv, signing) => (signing ? { ...baseEnv, ...buildSigningBuildEnv(signing) } : { ...baseEnv });

/** 解锁专用钥匙串（自动锁定 / 重启之后签名前要先解锁） */
export const buildUnlockKeychainSpec = (signing) => ({
  command: "security",
  args: ["unlock-keychain", "-p", signing.password, signing.keychain],
});

/**
 * 执行外部命令。出错时只带「命令 + 子命令 + stderr」，不带完整参数——参数里有钥匙串密码，不能进错误信息 / 日志。
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
export const defaultRun = async (command, args) => {
  try {
    const { stdout, stderr } = await execFileP(command, args, { maxBuffer: 16 * 1024 * 1024 });
    return { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") };
  } catch (err) {
    const why = String(err?.stderr ?? "").trim().slice(0, 300) || String(err?.code ?? "未知原因");
    throw new Error(`${path.basename(command)} ${args[0] ?? ""} 失败：${why}`);
  }
};

export const unlockTestKeychain = async (signing, run = defaultRun) => {
  const spec = buildUnlockKeychainSpec(signing);
  await run(spec.command, spec.args);
};

/** 用户域的钥匙串搜索列表（路径数组）；读不出来返回 null */
const listUserKeychains = async (run) => {
  try {
    const { stdout } = await run("security", ["list-keychains", "-d", "user"]);
    return String(stdout)
      .split("\n")
      .map((line) => line.trim().replace(/^"(.*)"$/, "$1"))
      .filter(Boolean);
  } catch {
    return null;
  }
};

/**
 * `security create-keychain` 按手册会把新钥匙串加进用户的搜索列表（本机实测没加，但各系统版本的行为没保证）。
 * 留在列表里的话，它一旦自动锁上，别的程序查证书 / 密码时可能弹「请输入钥匙串密码」。
 * 所以创建完把搜索列表恢复成创建前的样子；尽力而为，恢复失败不影响创建结果。
 */
const restoreUserKeychains = async (run, before, keychain) => {
  if (!before || before.length === 0) return;
  const now = await listUserKeychains(run);
  if (!now?.some((k) => k === keychain || path.basename(k) === path.basename(keychain))) return;
  try {
    await run("security", ["list-keychains", "-d", "user", "-s", ...before]);
  } catch {
    /* 尽力而为 */
  }
};

/**
 * 生成证书 + 建专用钥匙串 + 导入私钥 + 真签一个探针自检；全部通过才写 identity.txt。
 * 任何一步失败：清掉半成品（下次 setup 从头来），把原因抛出去。
 * @param {object} p
 * @param {string} p.dir  证书目录
 * @param {(command: string, args: string[]) => Promise<{ stdout: string, stderr: string }>} [p.run]  执行外部命令（单测注入假的）
 * @param {typeof fs} [p.fsImpl]
 * @param {string} [p.tmpDir]  放临时私钥的父目录（单测指到临时目录）
 * @param {() => string} [p.uuid]  生成钥匙串密码 / p12 密码用的随机串
 * @param {string} [p.probeBinary]  拿来真签一遍做自检的可执行文件（会先拷贝一份，不动原件）
 * @returns {Promise<{ dir: string, identity: string, keychain: string, password: string }>}
 */
export const createTestSigning = async ({
  dir,
  run = defaultRun,
  fsImpl = fs,
  tmpDir = os.tmpdir(),
  uuid = randomUUID,
  probeBinary = "/usr/bin/true",
}) => {
  const p = testSigningPaths(dir);
  await fsImpl.mkdir(dir, { recursive: true, mode: 0o700 });
  await fsImpl.chmod(dir, 0o700);
  const work = await fsImpl.mkdtemp(path.join(tmpDir, "flowship-test-signing-"));
  const keychainPassword = uuid();
  const p12Password = uuid();
  const cleanup = async () => {
    for (const f of [p.identityFile, p.passwordFile, p.keychain]) await fsImpl.rm(f, { force: true });
  };
  let keychainsBefore = null;
  try {
    const config = path.join(work, "openssl.cnf");
    const key = path.join(work, "key.pem");
    const cert = path.join(work, "cert.pem");
    const p12 = path.join(work, "identity.p12");
    await fsImpl.writeFile(config, OPENSSL_CONFIG);
    await run(OPENSSL, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "3650", "-config", config]);
    const fp = await run(OPENSSL, ["x509", "-in", cert, "-noout", "-fingerprint", "-sha1"]);
    const identity = parseFingerprint(String(fp.stdout).split("=").pop());
    if (!identity) throw new Error("没能读出新证书的指纹");
    await run(OPENSSL, ["pkcs12", "-export", "-inkey", key, "-in", cert, "-out", p12, "-passout", `pass:${p12Password}`]);

    // 上次中断留下的残骸先清掉，再建新的专用钥匙串
    await cleanup();
    keychainsBefore = await listUserKeychains(run);
    await run("security", ["create-keychain", "-p", keychainPassword, p.keychain]);
    await run("security", ["unlock-keychain", "-p", keychainPassword, p.keychain]);
    await run("security", ["import", p12, "-k", p.keychain, "-P", p12Password, "-T", "/usr/bin/codesign"]);
    // 让 codesign 不弹窗就能用这把私钥
    await run("security", ["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", keychainPassword, p.keychain]);

    // 自检：真签一个探针，指定要求里必须是这张证书——和 afterPack 打包后的核对是同一条判断
    const probe = path.join(work, "probe-bin");
    await fsImpl.copyFile(probeBinary, probe);
    await run("codesign", ["--force", "--sign", identity, "--keychain", p.keychain, probe]);
    const req = await run("codesign", ["-d", "-r-", probe]);
    if (!designatedRequirementNamesCertificate(`${req.stdout}\n${req.stderr}`, identity)) {
      throw new Error("探针签名的指定要求里没有这张证书");
    }

    await fsImpl.writeFile(p.passwordFile, keychainPassword, { mode: 0o600 });
    await fsImpl.chmod(p.passwordFile, 0o600);
    await fsImpl.writeFile(p.identityFile, `${identity}\n`);
    return { dir, identity, keychain: p.keychain, password: keychainPassword };
  } catch (err) {
    await cleanup();
    throw err;
  } finally {
    await restoreUserKeychains(run, keychainsBefore, p.keychain);
    // 私钥的 PEM / p12 只在临时目录里停留到这里；之后它只在专用钥匙串里
    await fsImpl.rm(work, { recursive: true, force: true });
  }
};

/**
 * 已有且完整就直接用（不重复生成：换了证书 = 所有授权重来一次）；没有才创建。
 * @param {Parameters<typeof createTestSigning>[0]} p
 * @returns {Promise<{ created: boolean, signing: { dir: string, identity: string, keychain: string, password: string } }>}
 */
export const ensureTestSigning = async ({ dir, ...rest }) => {
  const existing = await readTestSigning({ dir, fsImpl: rest.fsImpl });
  if (existing) return { created: false, signing: existing };
  return { created: true, signing: await createTestSigning({ dir, ...rest }) };
};
