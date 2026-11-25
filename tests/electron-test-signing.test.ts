/**
 * 本机固定的 test 包签名证书（scripts/lib/electron-test-signing.mjs）与签名后的「指定要求」核对
 * （scripts/lib/codesign-requirement.mjs + scripts/electron-after-pack.mjs 的接线）。
 *
 * 背景：test 包不设签名身份时是 ad-hoc，身份绑代码哈希、每次打包都变，系统授权（辅助功能 / 屏幕录制）
 * 和钥匙串里保存的开机密码都跟着失效。固定一张本机自签证书后，重新打包身份不变、授权保留。
 *
 * 这里覆盖：指定要求的两种写法（root / leaf）都认、别的一律不认；证书目录缺任何一样都当「没有」；
 * 创建流程的命令顺序、权限、临时私钥清理、失败回滚、幂等；错误信息不泄露钥匙串密码；打包环境变量的合成；
 * afterPack 用假 codesign 验「leaf 写法通过 / 别的证书抛错 / ad-hoc 不核对」。
 *
 * 不在这里验证：真的 openssl / security / codesign（`node scripts/electron-test-signing.mjs` 在本机跑过一次，
 * 之后用该证书连打两次包、比对指定要求不变）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { designatedRequirementNamesCertificate } from "../scripts/lib/codesign-requirement.mjs";
import {
  buildSigningBuildEnv,
  buildTestBuildEnv,
  buildUnlockKeychainSpec,
  createTestSigning,
  defaultRun,
  ensureTestSigning,
  OPENSSL,
  parseFingerprint,
  readTestSigning,
  resolveTestSigningDir,
  TEST_SIGNING_DIR_ENV,
  testSigningPaths,
  unlockTestKeychain,
} from "../scripts/lib/electron-test-signing.mjs";

const FP = "566f6cac5a06f6cca21f6cb23039e370a007137d";
const OTHER_FP = "a318d8988d982bc704f1b375ee204bc39772fd31";
const LOGIN_KEYCHAIN = "/Users/someone/Library/Keychains/login.keychain-db";

const tmpDirs: string[] = [];
const mkTmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "test-signing-"));
  tmpDirs.push(d);
  return d;
};

afterEach(() => {
  vi.restoreAllMocks();
  // 环境变量的还原放在这里、不写在用例末尾：用例里断言先失败就走不到末尾，FLOWSHIP_SIGN_* 会泄漏给后面的用例（第三轮评审）
  vi.unstubAllEnvs();
  vi.doUnmock("node:child_process");
  vi.resetModules();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("designatedRequirementNamesCertificate：指定要求里是不是这张证书", () => {
  it("证书被信任时的写法（certificate root）和没被信任时的写法（certificate leaf）都认", () => {
    expect(designatedRequirementNamesCertificate(`designated => identifier "x" and certificate root = H"${FP}"`, FP)).toBe(true);
    expect(designatedRequirementNamesCertificate(`designated => identifier "x" and certificate leaf = H"${FP}"`, FP)).toBe(true);
  });

  it("指纹大小写、冒号分隔、首尾空白都不影响判断", () => {
    const out = `certificate leaf = H"${FP}"`;
    expect(designatedRequirementNamesCertificate(out, FP.toUpperCase())).toBe(true);
    expect(designatedRequirementNamesCertificate(out, FP.replace(/(..)(?!$)/g, "$1:"))).toBe(true);
    expect(designatedRequirementNamesCertificate(out, `  ${FP}\n`)).toBe(true);
    // 输出里是大写也认
    expect(designatedRequirementNamesCertificate(`certificate leaf = H"${FP.toUpperCase()}"`, FP)).toBe(true);
  });

  it("别的证书 / ad-hoc（只有 cdhash）/ 别的锚点写法 → 不认", () => {
    expect(designatedRequirementNamesCertificate(`certificate leaf = H"${OTHER_FP}"`, FP)).toBe(false);
    expect(designatedRequirementNamesCertificate(`designated => cdhash H"${FP}"`, FP)).toBe(false);
    expect(designatedRequirementNamesCertificate(`designated => anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[subject.OU] = "${FP}"`, FP)).toBe(false);
    expect(designatedRequirementNamesCertificate("", FP)).toBe(false);
    expect(designatedRequirementNamesCertificate(undefined as unknown as string, FP)).toBe(false);
  });

  it("指纹本身不合格（空 / 太短 / 不是十六进制 / 带正则符号）一律 false——不能因为正则退化成「匹配任意证书」", () => {
    const anyCert = `certificate leaf = H"${FP}"`;
    for (const bad of ["", "abc", FP.slice(1), `${FP}0`, "z".repeat(40), ".*", ".{40}", "[0-9a-f]{40}", "(?:)", undefined, null]) {
      expect(designatedRequirementNamesCertificate(anyCert, bad as unknown as string)).toBe(false);
    }
  });

  it("只认带引号的完整 40 位：指纹是另一串更长十六进制的一部分时不算", () => {
    expect(designatedRequirementNamesCertificate(`certificate leaf = H"0${FP}"`, FP)).toBe(false);
    expect(designatedRequirementNamesCertificate(`certificate leaf = H"${FP}0"`, FP)).toBe(false);
  });
});

describe("证书目录与指纹解析", () => {
  it("parseFingerprint：冒号 / 大写 / 空白都规整成 40 位小写；不合格返回 null", () => {
    expect(parseFingerprint(FP)).toBe(FP);
    expect(parseFingerprint(`${FP.toUpperCase()}\n`)).toBe(FP);
    expect(parseFingerprint(FP.replace(/(..)(?!$)/g, "$1:").toUpperCase())).toBe(FP);
    expect(parseFingerprint("SHA1 Fingerprint=AA")).toBeNull();
    expect(parseFingerprint("")).toBeNull();
    expect(parseFingerprint(undefined)).toBeNull();
    expect(parseFingerprint(FP.slice(1))).toBeNull();
    // 必须恰好 40 位：多出来的也不行（拼错 / 多复制了一截的指纹不能被当成合法身份）
    expect(parseFingerprint(`${FP}0`)).toBeNull();
    expect(parseFingerprint(`${FP}${FP}`)).toBeNull();
  });

  it("resolveTestSigningDir：环境变量优先（去空白），缺省在用户主目录下", () => {
    expect(resolveTestSigningDir({ env: { [TEST_SIGNING_DIR_ENV]: "  /somewhere/else  " }, home: "/home/me" })).toBe("/somewhere/else");
    expect(resolveTestSigningDir({ env: {}, home: "/home/me" })).toBe(path.join("/home/me", ".flowship-test-signing"));
    expect(resolveTestSigningDir({ env: { [TEST_SIGNING_DIR_ENV]: "   " }, home: "/home/me" })).toBe(path.join("/home/me", ".flowship-test-signing"));
  });

  it("testSigningPaths：三个文件都在证书目录下", () => {
    expect(testSigningPaths("/d")).toEqual({
      dir: "/d",
      identityFile: path.join("/d", "identity.txt"),
      keychain: path.join("/d", "test-sign.keychain-db"),
      passwordFile: path.join("/d", "keychain-password"),
    });
  });
});

describe("readTestSigning：缺任何一样都当「没有」", () => {
  const writeComplete = (dir: string) => {
    const p = testSigningPaths(dir);
    fs.writeFileSync(p.identityFile, `${FP}\n`);
    fs.writeFileSync(p.passwordFile, "kc-password\n");
    fs.writeFileSync(p.keychain, "keychain");
    return p;
  };

  it("齐全 → 返回指纹 / 钥匙串路径 / 密码（密码去掉换行）", async () => {
    const dir = mkTmp();
    const p = writeComplete(dir);
    expect(await readTestSigning({ dir })).toEqual({ dir, identity: FP, keychain: p.keychain, password: "kc-password" });
  });

  it.each([
    ["指纹文件不在", "identityFile"],
    ["密码文件不在", "passwordFile"],
    ["钥匙串不在", "keychain"],
  ] as const)("%s → null", async (_name, key) => {
    const dir = mkTmp();
    const p = writeComplete(dir);
    fs.rmSync(p[key]);
    expect(await readTestSigning({ dir })).toBeNull();
  });

  it("指纹文件内容不合格 / 密码是空的 → null", async () => {
    const dir = mkTmp();
    const p = writeComplete(dir);
    fs.writeFileSync(p.identityFile, "not-a-fingerprint");
    expect(await readTestSigning({ dir })).toBeNull();
    fs.writeFileSync(p.identityFile, FP);
    fs.writeFileSync(p.passwordFile, "  \n");
    expect(await readTestSigning({ dir })).toBeNull();
  });

  it("目录根本不存在 → null（不抛错）", async () => {
    expect(await readTestSigning({ dir: path.join(mkTmp(), "nope") })).toBeNull();
  });
});

describe("打包环境变量 / 解锁命令", () => {
  const signing = { dir: "/d", identity: FP, keychain: "/d/test-sign.keychain-db", password: "kc-password" };

  it("buildSigningBuildEnv：和发版 CI 同名的两个变量", () => {
    expect(buildSigningBuildEnv(signing)).toEqual({ FLOWSHIP_SIGN_IDENTITY: FP, FLOWSHIP_SIGN_KEYCHAIN: "/d/test-sign.keychain-db" });
  });

  it("buildTestBuildEnv：叠加签名变量、不改原对象、保留其它变量", () => {
    const base = { PATH: "/usr/bin", KEEP: "1" };
    const env = buildTestBuildEnv(base, signing);
    expect(env).toEqual({ PATH: "/usr/bin", KEEP: "1", FLOWSHIP_SIGN_IDENTITY: FP, FLOWSHIP_SIGN_KEYCHAIN: "/d/test-sign.keychain-db" });
    expect(base).toEqual({ PATH: "/usr/bin", KEEP: "1" });
  });

  it("buildTestBuildEnv：没有本机证书 → 原样复制（不凭空塞签名变量；调用方自己设的照旧）", () => {
    expect(buildTestBuildEnv({ PATH: "/usr/bin" }, null)).toEqual({ PATH: "/usr/bin" });
    expect(buildTestBuildEnv({ FLOWSHIP_SIGN_IDENTITY: OTHER_FP }, null)).toEqual({ FLOWSHIP_SIGN_IDENTITY: OTHER_FP });
  });

  it("buildUnlockKeychainSpec / unlockTestKeychain：security unlock-keychain 带密码和钥匙串路径", async () => {
    expect(buildUnlockKeychainSpec(signing)).toEqual({
      command: "security",
      args: ["unlock-keychain", "-p", "kc-password", "/d/test-sign.keychain-db"],
    });
    const run = vi.fn(async () => ({ stdout: "", stderr: "" }));
    await unlockTestKeychain(signing, run);
    expect(run).toHaveBeenCalledWith("security", ["unlock-keychain", "-p", "kc-password", "/d/test-sign.keychain-db"]);
  });
});

describe("defaultRun：出错信息不能带出完整参数（里面有钥匙串密码）", () => {
  it("失败时只带命令名 + 子命令 + stderr", async () => {
    const script = "process.stderr.write('boom'); process.exit(3)";
    const err = await defaultRun(process.execPath, ["-e", script, "SECRET-PASSWORD-123"]).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("boom");
    expect(err!.message).not.toContain("SECRET-PASSWORD-123");
    expect(err!.message).not.toContain("process.exit");
  });

  it("成功时返回 stdout / stderr 文本", async () => {
    const r = await defaultRun(process.execPath, ["-e", "process.stdout.write('out'); process.stderr.write('err')"]);
    expect(r).toEqual({ stdout: "out", stderr: "err" });
  });
});

describe("createTestSigning：创建流程", () => {
  type Call = { cmd: string; args: string[] };

  /** 假 run：记录调用、读下 openssl 配置、按命令返回像样的输出；可指定某条命令失败 / 返回别的指定要求 */
  const makeRun = (
    dir: string,
    opts: {
      failOn?: string;
      requirement?: string;
      fingerprintOutput?: string;
      /** 用户域搜索列表：创建前 / 创建钥匙串之后各返回什么（默认都是只有登录钥匙串，即本机实测的行为） */
      keychainList?: { before: string[]; afterCreate: string[] };
    } = {},
  ) => {
    const calls: Call[] = [];
    const seen: {
      opensslConfig?: string;
      keychainExistedAtCreate?: boolean;
      workDir?: string;
      keyPem?: boolean;
      /** 探针签名 / 核对指定要求的那一刻，指纹文件已经在了吗（应当还没有：它最后才写） */
      identityFileAtProbe: boolean[];
    } = { identityFileAtProbe: [] };
    const list = opts.keychainList ?? { before: [LOGIN_KEYCHAIN], afterCreate: [LOGIN_KEYCHAIN] };
    let created = false;
    const run = async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      const tag = `${path.basename(cmd)} ${args[0]}`;
      if (opts.failOn === tag) throw new Error(`${tag} 失败：假的`);
      if (tag === "security list-keychains" && args.includes("-d") && !args.includes("-s")) {
        return { stdout: (created ? list.afterCreate : list.before).map((k) => `    "${k}"\n`).join(""), stderr: "" };
      }
      if (tag === "openssl req") {
        const cfg = args[args.indexOf("-config") + 1]!;
        seen.opensslConfig = fs.readFileSync(cfg, "utf8");
        seen.workDir = path.dirname(cfg);
        // 真 openssl 会写出私钥 / 证书：造出来，才能验「临时目录最后被清掉」
        fs.writeFileSync(args[args.indexOf("-keyout") + 1]!, "PRIVATE KEY");
        fs.writeFileSync(args[args.indexOf("-out") + 1]!, "CERT");
        seen.keyPem = true;
      }
      if (tag === "openssl x509") {
        return { stdout: opts.fingerprintOutput ?? `SHA1 Fingerprint=${FP.toUpperCase().replace(/(..)(?!$)/g, "$1:")}\n`, stderr: "" };
      }
      if (tag === "security create-keychain") {
        seen.keychainExistedAtCreate = fs.existsSync(testSigningPaths(dir).keychain);
        created = true;
        // 真 security 会在这个路径建出钥匙串文件：造一个，才能验失败时它被清掉、成功后 readTestSigning 能找到
        fs.writeFileSync(args[args.length - 1]!, "stub-keychain");
      }
      if (tag === "codesign --force" || tag === "codesign -d") seen.identityFileAtProbe.push(fs.existsSync(testSigningPaths(dir).identityFile));
      if (tag === "codesign -d") {
        return { stdout: "", stderr: opts.requirement ?? `designated => identifier "probe-bin" and certificate leaf = H"${FP}"` };
      }
      return { stdout: "", stderr: "" };
    };
    return { run, calls, seen };
  };

  const probeFile = () => {
    const f = path.join(mkTmp(), "probe-src");
    fs.writeFileSync(f, "binary");
    return f;
  };

  it("按顺序：生成证书 → 读指纹 → 导出 p12 → 建专用钥匙串 → 解锁 → 导入 → 放行 codesign → 真签探针 → 核对指定要求", async () => {
    const dir = path.join(mkTmp(), "signing");
    const tmpRoot = mkTmp();
    const { run, calls, seen } = makeRun(dir);
    const signing = await createTestSigning({ dir, run, tmpDir: tmpRoot, uuid: (() => { let n = 0; return () => `uuid-${++n}`; })(), probeBinary: probeFile() });
    // 创建完，readTestSigning 能原样读回来（两边对「齐全」的理解一致）
    expect(await readTestSigning({ dir })).toEqual(signing);
    // identity.txt 是最后一个写入的：探针签名 / 核对的那一刻它还不存在（中途被打断也不会被当成「已就绪」）
    expect(seen.identityFileAtProbe).toEqual([false, false]);
    expect(calls.map((c) => `${path.basename(c.cmd)} ${c.args[0]}`)).toEqual([
      "openssl req",
      "openssl x509",
      "openssl pkcs12",
      "security list-keychains", // 建钥匙串前先记下用户的搜索列表
      "security create-keychain",
      "security unlock-keychain",
      "security import",
      "security set-key-partition-list",
      "codesign --force",
      "codesign -d",
      "security list-keychains", // 收尾再看一眼：没被加进去 → 不动
    ]);
    const p = testSigningPaths(dir);
    expect(signing).toEqual({ dir, identity: FP, keychain: p.keychain, password: "uuid-1" });

    // 用的是 macOS 自带的 openssl（Homebrew 的 OpenSSL 3 导出的 p12 `security import` 读不了）
    expect(calls[0]!.cmd).toBe("/usr/bin/openssl");
    expect(OPENSSL).toBe("/usr/bin/openssl");
    // 钥匙串密码（uuid-1）和 p12 密码（uuid-2）是两个不同的东西
    expect(calls.find((c) => c.args[0] === "create-keychain")!.args).toEqual(["create-keychain", "-p", "uuid-1", p.keychain]);
    const imp = calls.find((c) => c.args[0] === "import")!.args;
    expect(imp).toEqual(expect.arrayContaining(["-k", p.keychain, "-P", "uuid-2", "-T", "/usr/bin/codesign"]));
    expect(calls.find((c) => c.args[0] === "set-key-partition-list")!.args).toEqual([
      "set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", "uuid-1", p.keychain,
    ]);
    // 探针用刚生成的指纹 + 专用钥匙串签（不依赖登录钥匙串的搜索列表）
    const sign = calls.find((c) => c.args[0] === "--force")!.args;
    expect(sign).toEqual(expect.arrayContaining(["--sign", FP, "--keychain", p.keychain]));
  });

  it("证书带 codeSigning 用途（没有它 codesign 不认这张证书）", async () => {
    const dir = path.join(mkTmp(), "signing");
    const { run, seen } = makeRun(dir);
    await createTestSigning({ dir, run, tmpDir: mkTmp(), probeBinary: probeFile() });
    expect(seen.opensslConfig).toContain("extendedKeyUsage = critical,codeSigning");
    expect(seen.opensslConfig).toContain("CA:false");
  });

  it("落盘：目录 0700、密码文件 0600 且内容就是钥匙串密码、指纹文件是规整后的指纹；私钥 PEM / 临时目录被清掉", async () => {
    const dir = path.join(mkTmp(), "signing");
    const tmpRoot = mkTmp();
    const { run, seen } = makeRun(dir);
    await createTestSigning({ dir, run, tmpDir: tmpRoot, uuid: () => "the-uuid", probeBinary: probeFile() });
    const p = testSigningPaths(dir);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(p.passwordFile).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(p.passwordFile, "utf8")).toBe("the-uuid");
    expect(fs.readFileSync(p.identityFile, "utf8")).toBe(`${FP}\n`);
    expect(seen.keyPem).toBe(true);
    // 私钥 PEM 只在临时目录里停留，创建结束就删：之后私钥只存在于专用钥匙串
    expect(fs.existsSync(seen.workDir!)).toBe(false);
    expect(fs.readdirSync(tmpRoot)).toEqual([]);
  });

  it("目录已存在但权限宽松 → 收紧成 0700", async () => {
    const dir = path.join(mkTmp(), "signing");
    fs.mkdirSync(dir, { mode: 0o755 });
    const { run } = makeRun(dir);
    await createTestSigning({ dir, run, tmpDir: mkTmp(), probeBinary: probeFile() });
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("上次中断留下的残骸（旧钥匙串 / 旧指纹 / 旧密码）在建新钥匙串之前清掉", async () => {
    const dir = path.join(mkTmp(), "signing");
    const p = testSigningPaths(dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p.keychain, "stale-keychain");
    fs.writeFileSync(p.identityFile, `${OTHER_FP}\n`);
    fs.writeFileSync(p.passwordFile, "stale-password");
    const { run, seen } = makeRun(dir);
    await createTestSigning({ dir, run, tmpDir: mkTmp(), uuid: () => "fresh", probeBinary: probeFile() });
    expect(seen.keychainExistedAtCreate).toBe(false);
    expect(fs.readFileSync(p.identityFile, "utf8")).toBe(`${FP}\n`);
    expect(fs.readFileSync(p.passwordFile, "utf8")).toBe("fresh");
  });

  it.each(["openssl req", "openssl pkcs12", "security create-keychain", "security import", "security set-key-partition-list", "codesign --force"])(
    "「%s」失败 → 抛出原因、不留指纹 / 密码 / 钥匙串、临时目录也清掉（下次 setup 从头来）",
    async (failOn) => {
      const dir = path.join(mkTmp(), "signing");
      const tmpRoot = mkTmp();
      const { run } = makeRun(dir, { failOn });
      await expect(createTestSigning({ dir, run, tmpDir: tmpRoot, probeBinary: probeFile() })).rejects.toThrow(`${failOn} 失败：假的`);
      const p = testSigningPaths(dir);
      expect(fs.existsSync(p.identityFile)).toBe(false);
      expect(fs.existsSync(p.passwordFile)).toBe(false);
      expect(fs.existsSync(p.keychain)).toBe(false);
      expect(fs.readdirSync(tmpRoot)).toEqual([]);
      expect(await readTestSigning({ dir })).toBeNull();
    },
  );

  it("读不出指纹 → 抛错且不留残骸", async () => {
    const dir = path.join(mkTmp(), "signing");
    const { run, calls } = makeRun(dir, { fingerprintOutput: "garbage\n" });
    await expect(createTestSigning({ dir, run, tmpDir: mkTmp(), probeBinary: probeFile() })).rejects.toThrow(/指纹/);
    expect(calls.some((c) => c.args[0] === "create-keychain")).toBe(false);
    expect(fs.existsSync(testSigningPaths(dir).identityFile)).toBe(false);
  });

  it("探针签完指定要求里不是这张证书 → 抛错、不写指纹文件（宁可失败也不留一张用不了的证书）", async () => {
    const dir = path.join(mkTmp(), "signing");
    const { run } = makeRun(dir, { requirement: `designated => cdhash H"${OTHER_FP}"` });
    await expect(createTestSigning({ dir, run, tmpDir: mkTmp(), probeBinary: probeFile() })).rejects.toThrow(/指定要求/);
    expect(fs.existsSync(testSigningPaths(dir).identityFile)).toBe(false);
    expect(fs.existsSync(testSigningPaths(dir).passwordFile)).toBe(false);
  });

  it("create-keychain 把专用钥匙串加进了用户搜索列表 → 收尾恢复成创建前的列表（锁上的钥匙串留在列表里会让别的程序弹密码框）", async () => {
    const dir = path.join(mkTmp(), "signing");
    const p = testSigningPaths(dir);
    const { run, calls } = makeRun(dir, { keychainList: { before: [LOGIN_KEYCHAIN], afterCreate: [LOGIN_KEYCHAIN, p.keychain] } });
    await createTestSigning({ dir, run, tmpDir: mkTmp(), probeBinary: probeFile() });
    const restore = calls.filter((c) => c.args[0] === "list-keychains" && c.args.includes("-s"));
    expect(restore.map((c) => c.args)).toEqual([["list-keychains", "-d", "user", "-s", LOGIN_KEYCHAIN]]);
  });

  it("列表里的路径写法和我们传的不同（只是同一个文件名）也认得出来并恢复", async () => {
    const dir = path.join(mkTmp(), "signing");
    const { run, calls } = makeRun(dir, {
      keychainList: { before: [LOGIN_KEYCHAIN], afterCreate: [LOGIN_KEYCHAIN, "/private/elsewhere/test-sign.keychain-db"] },
    });
    await createTestSigning({ dir, run, tmpDir: mkTmp(), probeBinary: probeFile() });
    expect(calls.filter((c) => c.args.includes("-s") && c.args[0] === "list-keychains")).toHaveLength(1);
  });

  it("创建中途失败也恢复搜索列表（不在列表里留一条指向已删文件的钥匙串）", async () => {
    const dir = path.join(mkTmp(), "signing");
    const p = testSigningPaths(dir);
    const { run, calls } = makeRun(dir, {
      failOn: "security import",
      keychainList: { before: [LOGIN_KEYCHAIN], afterCreate: [LOGIN_KEYCHAIN, p.keychain] },
    });
    await expect(createTestSigning({ dir, run, tmpDir: mkTmp(), probeBinary: probeFile() })).rejects.toThrow(/security import 失败/);
    expect(calls.filter((c) => c.args[0] === "list-keychains" && c.args.includes("-s")).map((c) => c.args)).toEqual([
      ["list-keychains", "-d", "user", "-s", LOGIN_KEYCHAIN],
    ]);
  });

  it("读不到搜索列表（命令失败）→ 不恢复、不影响创建成功；恢复命令本身失败也不影响", async () => {
    const dir = path.join(mkTmp(), "signing");
    const base = makeRun(dir);
    const noList = async (cmd: string, args: string[]) => {
      if (args[0] === "list-keychains") throw new Error("读不出来");
      return base.run(cmd, args);
    };
    await expect(createTestSigning({ dir, run: noList, tmpDir: mkTmp(), probeBinary: probeFile() })).resolves.toMatchObject({ identity: FP });

    const dir2 = path.join(mkTmp(), "signing2");
    const withList = makeRun(dir2, { keychainList: { before: [LOGIN_KEYCHAIN], afterCreate: [LOGIN_KEYCHAIN, testSigningPaths(dir2).keychain] } });
    const restoreFails = async (cmd: string, args: string[]) => {
      if (args[0] === "list-keychains" && args.includes("-s")) throw new Error("恢复不了");
      return withList.run(cmd, args);
    };
    await expect(createTestSigning({ dir: dir2, run: restoreFails, tmpDir: mkTmp(), probeBinary: probeFile() })).resolves.toMatchObject({ identity: FP });
  });

  it("创建前的搜索列表是空的（读到的东西不可信）→ 不去改列表，免得把用户的列表清空", async () => {
    const dir = path.join(mkTmp(), "signing");
    const { run, calls } = makeRun(dir, { keychainList: { before: [], afterCreate: [testSigningPaths(dir).keychain] } });
    await createTestSigning({ dir, run, tmpDir: mkTmp(), probeBinary: probeFile() });
    expect(calls.some((c) => c.args[0] === "list-keychains" && c.args.includes("-s"))).toBe(false);
  });

  it("指定要求被 codesign 打在 stdout 上也认（输出可能在 stdout 或 stderr）", async () => {
    const dir = path.join(mkTmp(), "signing");
    const base = makeRun(dir);
    const run = async (cmd: string, args: string[]) => {
      if (cmd === "codesign" && args[0] === "-d") return { stdout: `certificate root = H"${FP}"`, stderr: "" };
      return base.run(cmd, args);
    };
    await expect(createTestSigning({ dir, run, tmpDir: mkTmp(), probeBinary: probeFile() })).resolves.toMatchObject({ identity: FP });
  });
});

describe("ensureTestSigning：已有就沿用（换证书 = 所有授权重来一次），没有才创建", () => {
  it("已有完整证书 → created=false，一条命令都不跑", async () => {
    const dir = mkTmp();
    const p = testSigningPaths(dir);
    fs.writeFileSync(p.identityFile, FP);
    fs.writeFileSync(p.passwordFile, "kc-password");
    fs.writeFileSync(p.keychain, "keychain");
    const run = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const r = await ensureTestSigning({ dir, run });
    expect(r).toEqual({ created: false, signing: { dir, identity: FP, keychain: p.keychain, password: "kc-password" } });
    expect(run).not.toHaveBeenCalled();
  });

  it("没有 → created=true 并走创建流程", async () => {
    const dir = path.join(mkTmp(), "signing");
    const probe = path.join(mkTmp(), "probe-src");
    fs.writeFileSync(probe, "binary");
    const run = vi.fn(async (cmd: string, args: string[]) => {
      if (args[0] === "req") {
        fs.writeFileSync(args[args.indexOf("-keyout") + 1]!, "K");
        fs.writeFileSync(args[args.indexOf("-out") + 1]!, "C");
      }
      if (args[0] === "x509") return { stdout: `SHA1 Fingerprint=${FP}`, stderr: "" };
      if (cmd === "codesign" && args[0] === "-d") return { stdout: "", stderr: `certificate leaf = H"${FP}"` };
      return { stdout: "", stderr: "" };
    });
    const r = await ensureTestSigning({ dir, run, tmpDir: mkTmp(), probeBinary: probe });
    expect(r.created).toBe(true);
    expect(r.signing.identity).toBe(FP);
    expect(run).toHaveBeenCalled();
  });
});

describe("scripts/electron-test-restart.mjs 的接线（脚本本身没法在单测里跑，钉住关键几行）", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "scripts", "electron-test-restart.mjs"), "utf8");

  it("只在 mac 上找本机证书；找到就先解锁专用钥匙串、再把签名变量交给 electron-builder 子进程", () => {
    expect(src).toContain('from "./lib/electron-test-signing.mjs"');
    const readAt = src.indexOf("readTestSigning({ dir: resolveTestSigningDir() })");
    const unlockAt = src.indexOf("unlockTestKeychain(signing)");
    const builderAt = src.indexOf("buildElectronBuilderDistTestSpawnSpec(platform, { electronDistPath })");
    expect(readAt).toBeGreaterThan(-1);
    expect(unlockAt).toBeGreaterThan(readAt);
    expect(builderAt).toBeGreaterThan(unlockAt);
    // 读证书被 platform === "darwin" 包着（win 的 test 包不涉及）
    expect(src.slice(src.lastIndexOf("\n", readAt - 80), readAt)).toContain('platform === "darwin"');
    // 交给 builder 的环境：在 process.env 之上叠加签名变量
    expect(src.slice(builderAt, builderAt + 300)).toContain("env: buildTestBuildEnv(process.env, signing)");
  });

  it("没有本机证书时明说「退回 ad-hoc、授权会失效」并给出创建命令，而不是悄悄降级", () => {
    expect(src).toContain("没有本机固定测试证书 → ad-hoc 签名");
    expect(src).toContain("node scripts/electron-test-signing.mjs");
  });
});

describe("afterPack：签名后核对指定要求（假 codesign）", () => {
  const prepare = (): { cwd: string; context: unknown } => {
    const cwd = mkTmp();
    fs.mkdirSync(path.join(cwd, "dist", "app-server"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "dist", "app-server", "server.js"), "// server");
    const out = mkTmp();
    const resourcesDir = path.join(out, "Flowship.app", "Contents", "Resources");
    fs.mkdirSync(resourcesDir, { recursive: true });
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    return { cwd, context: { appOutDir: out, electronPlatformName: "darwin", arch: 3, packager: { getResourcesDir: () => resourcesDir } } };
  };

  /** 假 child_process：记录 codesign 调用；`codesign -d -r-` 返回指定的指定要求 */
  const mockCodesign = (requirement: string) => {
    const calls: string[][] = [];
    vi.doMock("node:child_process", async (orig) => {
      const real = await orig<typeof import("node:child_process")>();
      const execFile = ((cmd: string, args: string[], _opts: unknown, cb?: (e: Error | null, out?: { stdout: string; stderr: string }) => void) => {
        const done = typeof _opts === "function" ? (_opts as typeof cb)! : cb!;
        calls.push([cmd, ...args]);
        done(null, args[0] === "-d" ? { stdout: "", stderr: requirement } : { stdout: "", stderr: "" });
      }) as unknown as typeof real.execFile;
      return { ...real, default: { ...real, execFile }, execFile };
    });
    return calls;
  };

  const runAfterPack = async (context: unknown) => {
    vi.resetModules();
    const { default: afterPack } = await import("../scripts/electron-after-pack.mjs");
    return afterPack(context as never);
  };

  it("本机 test 证书（没被系统信任）：指定要求打印成 certificate leaf → 通过；用专用钥匙串签", async () => {
    vi.stubEnv("FLOWSHIP_SIGN_IDENTITY", FP);
    vi.stubEnv("FLOWSHIP_SIGN_KEYCHAIN", "/d/test-sign.keychain-db");
    vi.stubEnv("FLOWSHIP_REQUIRE_STABLE_SIGN", "");
    const { context } = prepare();
    const calls = mockCodesign(`designated => identifier "com.jianger.fe-ai-flow.test" and certificate leaf = H"${FP}"`);
    await expect(runAfterPack(context)).resolves.toBeUndefined();
    const sign = calls.find((c) => c.includes("--sign"))!;
    expect(sign).toEqual(expect.arrayContaining(["--sign", FP, "--keychain", "/d/test-sign.keychain-db"]));
    expect(calls.some((c) => c[0] === "codesign" && c[1] === "-d")).toBe(true);
  });

  it("发版 CI 的证书（被信任）：certificate root → 仍然通过（原行为不变）", async () => {
    vi.stubEnv("FLOWSHIP_SIGN_IDENTITY", FP);
    vi.stubEnv("FLOWSHIP_SIGN_KEYCHAIN", "");
    vi.stubEnv("FLOWSHIP_REQUIRE_STABLE_SIGN", "");
    const { context } = prepare();
    mockCodesign(`designated => identifier "com.jianger.fe-ai-flow" and certificate root = H"${FP}"`);
    await expect(runAfterPack(context)).resolves.toBeUndefined();
  });

  it("签出来的是别的证书（或退回了 ad-hoc 的 cdhash）→ 抛错，不带病交付", async () => {
    vi.stubEnv("FLOWSHIP_SIGN_IDENTITY", FP);
    vi.stubEnv("FLOWSHIP_SIGN_KEYCHAIN", "");
    vi.stubEnv("FLOWSHIP_REQUIRE_STABLE_SIGN", "");
    const { context } = prepare();
    mockCodesign(`designated => cdhash H"${OTHER_FP}"`);
    await expect(runAfterPack(context)).rejects.toThrow(/签名身份不是预期证书/);
  });

  it("没配身份（ad-hoc）→ 不核对指定要求（那时本来就没有证书可核）", async () => {
    vi.stubEnv("FLOWSHIP_SIGN_IDENTITY", "");
    vi.stubEnv("FLOWSHIP_SIGN_KEYCHAIN", "");
    vi.stubEnv("FLOWSHIP_REQUIRE_STABLE_SIGN", "");
    const { context } = prepare();
    const calls = mockCodesign("");
    await expect(runAfterPack(context)).resolves.toBeUndefined();
    expect(calls.some((c) => c[0] === "codesign" && c[1] === "-d")).toBe(false);
    expect(calls.some((c) => c.includes("--sign") && c.includes("-"))).toBe(true);
  });
});

// 第三轮评审：vi.unstubAllEnvs() 以前写在每个用例的末尾——断言先失败就走不到，FLOWSHIP_SIGN_* 会泄漏给后面的用例。
// 现在统一在 afterEach 还原。这一对用例钉住它：前一条 stub 了不还原（模拟断言先失败），后一条必须看到原值。
describe("环境变量的还原靠 afterEach（用例里断言失败 / 忘了还原也不泄漏给后面的用例）", () => {
  const BEFORE = process.env.FLOWSHIP_SIGN_IDENTITY;
  it("先 stub 一个值、故意不还原", () => {
    vi.stubEnv("FLOWSHIP_SIGN_IDENTITY", "leaked-if-not-restored-by-afterEach");
    expect(process.env.FLOWSHIP_SIGN_IDENTITY).toBe("leaked-if-not-restored-by-afterEach");
  });
  it("紧接着的用例看到的是原值（没被上一条的 stub 污染）", () => {
    expect(process.env.FLOWSHIP_SIGN_IDENTITY).toBe(BEFORE);
  });
});
