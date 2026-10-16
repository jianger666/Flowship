/**
 * 更新 manifest 验签（R9-01：mac dmg 与 Windows exe 共用）——electron-app/update-manifest-verify.mjs
 *
 * 与 tests/update-manifest.test.ts 的区别：那边的 `verifyManifest` 是测试里手抄的一份验签逻辑，
 * 证明不了壳真的会拒；这里直接调壳用的纯函数，并用**真实 Ed25519 密钥对**现场签名（不 mock 验签），
 * 再配合真实的 generate / verify 脚本跑端到端，保证「CI 签出来的东西」和「壳验的东西」是同一回事。
 *
 * 回退自检：把验签 / version / 条目 / size / sha256 任一道检查删掉，下面对应用例必须变红。
 */
import { execFile } from "node:child_process";
import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import { existsSync, promises as fs, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  UpdateVerifyMismatchError,
  UpdateVerifyUnavailableError,
  findSignedManifestEntry,
  pickWinInstallerAssetName,
  verifyManifestEntry,
} from "../electron-app/update-manifest-verify.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");

interface ManifestFile {
  name: string;
  size: number;
  sha256: string;
}
interface Manifest {
  version: string;
  files: ManifestFile[];
  signature: string;
}

const VERSION = "9.9.9";
const EXE = `fe-ai-flow-${VERSION}-win-x64.exe`;
const DMG_ARM = `fe-ai-flow-${VERSION}-mac-arm64.dmg`;
const DMG_X64 = `fe-ai-flow-${VERSION}-mac-x64.dmg`;
const CONTENT: Record<string, string> = {
  [EXE]: "MZ-fake-exe-bytes-0123456789-abcdefghij",
  [DMG_ARM]: "fake-dmg-arm64-bytes",
  [DMG_X64]: "fake-dmg-x64-bytes-xx",
};

const sha256Of = (s: string): string => createHash("sha256").update(s).digest("hex");
const fileEntry = (name: string): ManifestFile => ({
  name,
  size: Buffer.byteLength(CONTENT[name]),
  sha256: sha256Of(CONTENT[name]),
});

// 与 scripts/generate-update-manifest.mjs 同款：签名覆盖 JSON.stringify({ version, files })
const signManifest = (
  privateKey: KeyObject,
  version: string,
  files: ManifestFile[],
): Manifest => ({
  version,
  files,
  signature: sign(null, Buffer.from(JSON.stringify({ version, files }), "utf8"), privateKey).toString(
    "base64",
  ),
});

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const privPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const other = generateKeyPairSync("ed25519");

const FILES = [fileEntry(DMG_ARM), fileEntry(DMG_X64), fileEntry(EXE)];
const good = (): Manifest => signManifest(privateKey, VERSION, FILES.map((f) => ({ ...f })));

// 校验一枚「本地实测」文件：默认就是 manifest 里记录的那份（即合法）
const verify = (
  manifest: unknown,
  over: Partial<{
    publicKeyPem: string;
    version: string;
    assetName: string;
    size: number;
    sha256: string;
  }> = {},
): void =>
  verifyManifestEntry({
    manifest: manifest as object,
    publicKeyPem: over.publicKeyPem ?? pubPem,
    version: over.version ?? VERSION,
    assetName: over.assetName ?? EXE,
    size: over.size ?? Buffer.byteLength(CONTENT[EXE]),
    sha256: over.sha256 ?? sha256Of(CONTENT[EXE]),
  });

describe("verifyManifestEntry：合法路径", () => {
  it("合法 exe 条目通过（Windows）", () => {
    expect(() => verify(good())).not.toThrow();
  });

  it("两枚 mac dmg 同样通过（mac 行为不变）", () => {
    for (const name of [DMG_ARM, DMG_X64]) {
      expect(() =>
        verify(good(), {
          assetName: name,
          size: Buffer.byteLength(CONTENT[name]),
          sha256: sha256Of(CONTENT[name]),
        }),
      ).not.toThrow();
    }
  });

  it("findSignedManifestEntry 返回被签名保护的那条记录", () => {
    const entry = findSignedManifestEntry({
      manifest: good(),
      publicKeyPem: pubPem,
      version: VERSION,
      assetName: EXE,
    });
    expect(entry).toEqual(fileEntry(EXE));
  });
});

describe("verifyManifestEntry：签名", () => {
  it("签名被篡改（翻转一位）→ 拒绝", () => {
    const m = good();
    const raw = Buffer.from(m.signature, "base64");
    raw[0] ^= 0x01;
    expect(() => verify({ ...m, signature: raw.toString("base64") })).toThrow("签名校验失败");
  });

  it("签名被截断 / 为空 / 缺失 → 拒绝", () => {
    const m = good();
    expect(() => verify({ ...m, signature: m.signature.slice(0, 20) })).toThrow("签名校验失败");
    expect(() => verify({ ...m, signature: "" })).toThrow("签名校验失败");
    // 字段压根不存在 = 形态不完整、不像我们产出的清单（F1-04）：归 Unavailable(manifest-invalid)，同样拒绝但不删缓存
    const { signature: _drop, ...noSig } = m;
    void _drop;
    expect(() => verify(noSig)).toThrow("manifest 结构非法");
    expect(() => verify(noSig)).toThrow(UpdateVerifyUnavailableError);
  });

  it("别人的私钥签出来的 manifest（内容完全自洽）→ 拒绝", () => {
    const forged = signManifest(other.privateKey, VERSION, FILES.map((f) => ({ ...f })));
    expect(() => verify(forged)).toThrow("签名校验失败");
  });

  it("公钥不匹配（CI 私钥与壳内置公钥错配）→ 拒绝", () => {
    const otherPub = other.publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(() => verify(good(), { publicKeyPem: otherPub })).toThrow("签名校验失败");
  });

  it("公钥不是合法 PEM → 拒绝（抛错、不静默放行）", () => {
    expect(() => verify(good(), { publicKeyPem: "not a pem" })).toThrow();
  });
});

describe("verifyManifestEntry：files 被篡改（攻击者同时替换 exe 与摘要）", () => {
  it("改 exe 的 sha256 为恶意包的摘要 → 签名失败（即使本地文件刚好匹配被改的摘要）", () => {
    const evil = "MZ-evil-payload";
    const m = good();
    const tampered = {
      ...m,
      files: m.files.map((f) =>
        f.name === EXE ? { ...f, size: Buffer.byteLength(evil), sha256: sha256Of(evil) } : f,
      ),
    };
    // 本地文件 = 恶意包、manifest 里的摘要也被改成恶意包：唯一挡住它的就是签名
    expect(() =>
      verify(tampered, { size: Buffer.byteLength(evil), sha256: sha256Of(evil) }),
    ).toThrow("签名校验失败");
  });

  it("改 size → 签名失败", () => {
    const m = good();
    const tampered = {
      ...m,
      files: m.files.map((f) => (f.name === EXE ? { ...f, size: f.size + 1 } : f)),
    };
    expect(() => verify(tampered, { size: Buffer.byteLength(CONTENT[EXE]) + 1 })).toThrow(
      "签名校验失败",
    );
  });

  it("改条目名（把 exe 条目改成别的名字再让壳按新名查）→ 签名失败", () => {
    const m = good();
    const tampered = {
      ...m,
      files: m.files.map((f) => (f.name === EXE ? { ...f, name: "evil.exe" } : f)),
    };
    expect(() => verify(tampered, { assetName: "evil.exe" })).toThrow("签名校验失败");
  });

  it("追加 / 删除条目 → 签名失败", () => {
    const m = good();
    expect(() =>
      verify({ ...m, files: [...m.files, { name: "x.exe", size: 1, sha256: "0".repeat(64) }] }),
    ).toThrow("签名校验失败");
    expect(() => verify({ ...m, files: m.files.filter((f) => f.name !== DMG_X64) })).toThrow(
      "签名校验失败",
    );
  });

  it("files 整体被抹掉 → 拒绝（形态不完整，F1-04 起归 Unavailable(manifest-invalid)；files 被改 / 置空数组仍是签名失败）", () => {
    const { files: _files, ...rest } = good();
    void _files;
    expect(() => verify(rest)).toThrow("manifest 结构非法");
    expect(() => verify(rest)).toThrow(UpdateVerifyUnavailableError);
    // 形态完整、只是内容对不上签名 → 仍是确定不符
    expect(() => verify({ ...good(), files: [] })).toThrow("签名校验失败");
    expect(() => verify({ ...good(), files: [] })).toThrow(UpdateVerifyMismatchError);
  });
});

describe("verifyManifestEntry：version", () => {
  it("manifest.version 与要装的版本不符 → 拒绝（版本号被改 → 签名失败；签名合法但版本不同 → 版本不符）", () => {
    // 合法签名、但版本不是这次要装的：典型的「旧版本 manifest + 旧版本安装包」重放
    const oldVersion = signManifest(privateKey, "9.9.8", FILES.map((f) => ({ ...f })));
    expect(() => verify(oldVersion)).toThrow("版本不符");
    // 单改 manifest.version 字段（不重签）→ 签名先挡住
    expect(() => verify({ ...good(), version: "10.0.0" }, { version: "10.0.0" })).toThrow(
      "签名校验失败",
    );
  });

  it("更新通道给的版本（latest.yml、不可信）与签名内版本不同 → 拒绝", () => {
    expect(() => verify(good(), { version: "9.9.10" })).toThrow("版本不符");
  });
});

describe("verifyManifestEntry：条目缺失", () => {
  it("manifest 里没有被请求的 asset → 拒绝", () => {
    expect(() => verify(good(), { assetName: "fe-ai-flow-9.9.9-win-arm64.exe" })).toThrow(
      "manifest 里没有",
    );
  });

  it("旧发版链产的 manifest 只含 mac dmg、没有 exe 条目 → 新壳对 exe 一律拒绝（不允许缺条目放行）", () => {
    const macOnly = signManifest(privateKey, VERSION, [fileEntry(DMG_ARM), fileEntry(DMG_X64)]);
    expect(() => verify(macOnly)).toThrow(`manifest 里没有 ${EXE} 的摘要`);
    // 同一份 manifest 对 mac 仍然可用（旧 release 的 mac 链路不受影响）
    expect(() =>
      verify(macOnly, {
        assetName: DMG_ARM,
        size: Buffer.byteLength(CONTENT[DMG_ARM]),
        sha256: sha256Of(CONTENT[DMG_ARM]),
      }),
    ).not.toThrow();
  });

  it("files 为空数组（签了空清单）→ 拒绝", () => {
    expect(() => verify(signManifest(privateKey, VERSION, []))).toThrow("manifest 里没有");
  });

  it("assetName 必须精确相等（大小写 / 前后缀 / 路径都不算）", () => {
    for (const name of [
      EXE.toUpperCase(),
      `${EXE}.blockmap`,
      `dist/${EXE}`,
      EXE.replace(".exe", ""),
    ]) {
      expect(() => verify(good(), { assetName: name })).toThrow("manifest 里没有");
    }
  });
});

describe("verifyManifestEntry：size / sha256（本地实测值）", () => {
  it("size 不符（截断 / 追加）→ 拒绝", () => {
    const real = Buffer.byteLength(CONTENT[EXE]);
    expect(() => verify(good(), { size: real - 1 })).toThrow("安装包大小不符");
    expect(() => verify(good(), { size: real + 1 })).toThrow("安装包大小不符");
    expect(() => verify(good(), { size: 0 })).toThrow("安装包大小不符");
  });

  it("size 对、sha256 不符（同长度调包）→ 拒绝", () => {
    const sameLen = "X".repeat(Buffer.byteLength(CONTENT[EXE]));
    expect(() => verify(good(), { sha256: sha256Of(sameLen) })).toThrow("SHA-256 校验失败");
  });

  it("sha256 大小写不同也不放行（hex 必须逐字相等）", () => {
    expect(() => verify(good(), { sha256: sha256Of(CONTENT[EXE]).toUpperCase() })).toThrow(
      "SHA-256 校验失败",
    );
  });

  it("文案是中性的「安装包」、不再写死 dmg", () => {
    const real = Buffer.byteLength(CONTENT[EXE]);
    let sizeMsg = "";
    try {
      verify(good(), { size: real + 1 });
    } catch (e) {
      sizeMsg = (e as Error).message;
    }
    expect(sizeMsg).not.toMatch(/dmg/i);
    let shaMsg = "";
    try {
      verify(good(), { sha256: "0".repeat(64) });
    } catch (e) {
      shaMsg = (e as Error).message;
    }
    expect(shaMsg).not.toMatch(/dmg/i);
  });
});

describe("verifyManifestEntry：manifest 结构非法一律 throw（fail-closed）", () => {
  // F1-04：以前只断言 toThrow()——`[]` 实际落进「验签失败」（Mismatch → 删缓存 + 开发布页）也算过，类型分流没人守。
  // 现在钉死：不像清单的东西证明不了安装包有问题 → Unavailable(manifest-invalid)，绝不是 Mismatch
  const unavailableInvalid = (bad: unknown): void => {
    let caught: unknown;
    try {
      verify(bad);
    } catch (e) {
      caught = e;
    }
    expect(caught, JSON.stringify(bad)).toBeInstanceOf(UpdateVerifyUnavailableError);
    expect(caught).not.toBeInstanceOf(UpdateVerifyMismatchError);
    expect((caught as UpdateVerifyUnavailableError).code).toBe("manifest-invalid");
  };

  // 每项再包一层：it.each 会把「数组项」展开成参数列表，裸 `[]` 会变成「零个参数」、实际测成 undefined
  it.each<[unknown]>([[null], [undefined], ["string"], [42], [[]], [{}], [{ message: "Not Found" }]])(
    "manifest = %j → 拒绝，且归为「暂时无法校验」而不是「确定不符」",
    (bad) => {
      unavailableInvalid(bad);
    },
  );
});

describe("pickWinInstallerAssetName：manifest 查找键取自 latest.yml、不信本地缓存文件名", () => {
  // electron-updater 的 update-downloaded 事件 = latest.yml 解析结果 + downloadedFile（本地缓存路径）
  const info = {
    version: VERSION,
    files: [{ url: EXE, sha512: "x", size: 123 }],
    path: EXE,
    sha512: "x",
    releaseDate: "2026-10-14T00:00:00.000Z",
    downloadedFile: "C:\\Users\\a\\AppData\\Local\\fe-ai-flow-updater\\pending\\attacker-renamed.exe",
  };

  it("取 files[].url 的 basename，忽略 downloadedFile 的本地文件名", () => {
    expect(pickWinInstallerAssetName(info, "x64")).toBe(EXE);
  });

  it("files 缺失时退到 latest.yml 的 path", () => {
    expect(pickWinInstallerAssetName({ path: EXE }, "x64")).toBe(EXE);
    expect(pickWinInstallerAssetName({ files: [], path: EXE }, "x64")).toBe(EXE);
  });

  it("只认 .exe：blockmap / yml / dmg 不会被选中", () => {
    expect(
      pickWinInstallerAssetName(
        { files: [{ url: `${EXE}.blockmap` }, { url: "latest.yml" }, { url: DMG_ARM }, { url: EXE }] },
        "x64",
      ),
    ).toBe(EXE);
    expect(pickWinInstallerAssetName({ files: [{ url: `${EXE}.blockmap` }] }, "x64")).toBeNull();
  });

  it("多个 exe 时与 electron-updater 的 findFile 同口径：优先文件名含当前架构的", () => {
    const files = [
      { url: `fe-ai-flow-${VERSION}-win-arm64.exe` },
      { url: `fe-ai-flow-${VERSION}-win-x64.exe` },
    ];
    expect(pickWinInstallerAssetName({ files }, "x64")).toBe(`fe-ai-flow-${VERSION}-win-x64.exe`);
    expect(pickWinInstallerAssetName({ files }, "arm64")).toBe(`fe-ai-flow-${VERSION}-win-arm64.exe`);
    // 没有匹配架构时退到第一个 exe
    expect(pickWinInstallerAssetName({ files }, "ia32")).toBe(`fe-ai-flow-${VERSION}-win-arm64.exe`);
  });

  it("按 URL 解码、绝对 URL 取 basename、空格按 electron-updater 换成 -", () => {
    expect(pickWinInstallerAssetName({ files: [{ url: "fe-ai-flow-1.0.0-win-x64%2Bx.exe" }] }, "x64")).toBe(
      "fe-ai-flow-1.0.0-win-x64+x.exe",
    );
    expect(
      pickWinInstallerAssetName(
        { files: [{ url: "https://github.com/jianger666/Flowship/releases/download/v1.0.0/a.exe" }] },
        "x64",
      ),
    ).toBe("a.exe");
    expect(pickWinInstallerAssetName({ files: [{ url: "My App 1.0.0.exe" }] }, "x64")).toBe(
      "My-App-1.0.0.exe",
    );
  });

  it("路径穿越形态只留 basename；取不到 / 乱数据返回 null（调用方按拒绝处理）", () => {
    expect(pickWinInstallerAssetName({ files: [{ url: "../../etc/evil.exe" }] }, "x64")).toBe(
      "evil.exe",
    );
    for (const bad of [null, undefined, {}, { files: "nope" }, { files: [{}] }, { files: [{ url: 7 }] }, { path: 7 }]) {
      expect(pickWinInstallerAssetName(bad as never, "x64")).toBeNull();
    }
  });
});

describe("端到端：真实 generate / verify 脚本产出的 manifest ↔ 壳验签函数", () => {
  const TMP = path.join(os.tmpdir(), `fe-update-manifest-verify-${Date.now()}`);
  const ASSETS = path.join(TMP, "assets");
  let manifest: Manifest;

  // 把 verify 脚本复制进一棵临时目录树：它按「自身位置的上一级/electron-app」找公钥，
  // 这样能用测试密钥对而不是仓库里的真公钥来跑
  const VERIFY_TREE = path.join(TMP, "tree");
  const runVerifyScript = async (manifestPath: string) =>
    execFileAsync(process.execPath, [path.join(VERIFY_TREE, "scripts/verify-update-manifest.mjs"), manifestPath], {
      cwd: VERIFY_TREE,
    }).then(
      (r) => ({ code: 0, out: `${r.stdout}${r.stderr}` }),
      (e: NodeJS.ErrnoException & { code?: number; stdout?: string; stderr?: string }) => ({
        code: e.code ?? -1,
        out: `${e.stdout ?? ""}${e.stderr ?? ""}`,
      }),
    );

  const writeManifest = async (name: string, m: unknown): Promise<string> => {
    const p = path.join(TMP, name);
    await fs.writeFile(p, JSON.stringify(m));
    return p;
  };

  beforeAll(async () => {
    await fs.mkdir(ASSETS, { recursive: true });
    await fs.mkdir(path.join(VERIFY_TREE, "scripts"), { recursive: true });
    await fs.mkdir(path.join(VERIFY_TREE, "electron-app"), { recursive: true });
    await fs.copyFile(
      path.join(ROOT, "scripts/verify-update-manifest.mjs"),
      path.join(VERIFY_TREE, "scripts/verify-update-manifest.mjs"),
    );
    await fs.writeFile(path.join(VERIFY_TREE, "electron-app/update-manifest-public-key.pem"), pubPem);
    for (const name of [DMG_ARM, DMG_X64, EXE]) {
      await fs.writeFile(path.join(ASSETS, name), CONTENT[name]);
    }
    // CI finalize 的调用方式：2 dmg + 1 exe 一起交给 generate 脚本
    await execFileAsync(
      process.execPath,
      [
        path.join(ROOT, "scripts/generate-update-manifest.mjs"),
        VERSION,
        path.join(ASSETS, DMG_ARM),
        path.join(ASSETS, DMG_X64),
        path.join(ASSETS, EXE),
      ],
      { cwd: TMP, env: { ...process.env, UPDATE_MANIFEST_PRIVATE_KEY: privPem } },
    );
    manifest = JSON.parse(await fs.readFile(path.join(TMP, "update-manifest.json"), "utf8")) as Manifest;
  });

  afterAll(async () => {
    await fs.rm(TMP, { recursive: true, force: true });
  });

  it("generate 脚本把 exe 与 dmg 一起签进同一份 manifest", () => {
    expect(manifest.version).toBe(VERSION);
    expect(manifest.files.map((f) => f.name).sort()).toEqual([DMG_ARM, DMG_X64, EXE].sort());
  });

  it("壳验签函数对脚本真实产物：三个 asset 的实测 size / sha256 全部通过", async () => {
    for (const name of [DMG_ARM, DMG_X64, EXE]) {
      const buf = await fs.readFile(path.join(ASSETS, name));
      expect(() =>
        verifyManifestEntry({
          manifest,
          publicKeyPem: pubPem,
          version: VERSION,
          assetName: name,
          size: buf.length,
          sha256: createHash("sha256").update(buf).digest("hex"),
        }),
      ).not.toThrow();
    }
  });

  it("对脚本真实产物：exe 被调包（同名、内容不同）→ 拒绝", async () => {
    const evil = Buffer.from("MZ-evil-payload-of-another-size");
    expect(() =>
      verifyManifestEntry({
        manifest,
        publicKeyPem: pubPem,
        version: VERSION,
        assetName: EXE,
        size: evil.length,
        sha256: createHash("sha256").update(evil).digest("hex"),
      }),
    ).toThrow("安装包大小不符");
  });

  it("verify 脚本：2 dmg + 1 exe 的合法 manifest → 通过", async () => {
    const r = await runVerifyScript(path.join(TMP, "update-manifest.json"));
    expect(r.out).toContain("验签通过");
    expect(r.code).toBe(0);
  });

  it("verify 脚本：签名被篡改 → exit 1", async () => {
    const p = await writeManifest("tampered.json", { ...manifest, files: manifest.files.map((f) => ({ ...f, size: f.size + 1 })) });
    const r = await runVerifyScript(p);
    expect(r.code).toBe(1);
    expect(r.out).toContain("验签失败");
  });

  it("verify 脚本：已签名但缺 exe 条目（旧发版链形态）→ exit 1，不放行残缺 manifest", async () => {
    const files = manifest.files.filter((f) => f.name !== EXE);
    const p = await writeManifest("no-exe.json", signManifest(privateKey, VERSION, files));
    const r = await runVerifyScript(p);
    expect(r.code).toBe(1);
    expect(r.out).toContain("Windows exe 条目");
  });

  it("verify 脚本：缺一枚 dmg → exit 1", async () => {
    const files = manifest.files.filter((f) => f.name !== DMG_X64);
    const p = await writeManifest("one-dmg.json", signManifest(privateKey, VERSION, files));
    const r = await runVerifyScript(p);
    expect(r.code).toBe(1);
    expect(r.out).toContain("mac dmg 条目");
  });

  it("verify 脚本：混进 blockmap 之类多余条目 → exit 1", async () => {
    const files = [...manifest.files, { name: `${EXE}.blockmap`, size: 10, sha256: "a".repeat(64) }];
    const p = await writeManifest("extra.json", signManifest(privateKey, VERSION, files));
    const r = await runVerifyScript(p);
    expect(r.code).toBe(1);
    expect(r.out).toContain("预期之外的条目");
  });

  it("verify 脚本：文件名不带本次版本号（旧版本残留）→ exit 1", async () => {
    const files = manifest.files.map((f) =>
      f.name === EXE ? { ...f, name: "fe-ai-flow-9.9.8-win-x64.exe" } : f,
    );
    const p = await writeManifest("stale.json", signManifest(privateKey, VERSION, files));
    const r = await runVerifyScript(p);
    expect(r.code).toBe(1);
    expect(r.out).toContain("Windows exe 条目");
  });

  it("verify 脚本：条目 sha256 / size 形态非法 → exit 1", async () => {
    const files = manifest.files.map((f) => (f.name === EXE ? { ...f, sha256: "xyz" } : f));
    const p = await writeManifest("bad-hash.json", signManifest(privateKey, VERSION, files));
    const r = await runVerifyScript(p);
    expect(r.code).toBe(1);
    expect(r.out).toContain("sha256");
  });
});

describe("打包与接线", () => {
  const main = readFileSync(path.join(ROOT, "electron-app/main.js"), "utf8");
  const builder = readFileSync(path.join(ROOT, "electron-builder.yml"), "utf8");

  it("electron-builder 没有 files 白名单：electron-app/ 下的 .mjs 整体入包（与 win-update-guard.mjs 同一机制）", () => {
    // directories.app = electron-app、且没有顶层 `files:` 白名单 → 目录内除 node_modules 开发依赖外全部打进 asar。
    // 一旦有人加了白名单，新模块不在名单里 = 打包后 main.js 启动即 ERR_MODULE_NOT_FOUND，这里先红
    expect(builder).toMatch(/^directories:\n(?:[ \t]+.*\n|\n)*?[ \t]+app: electron-app/m);
    expect(builder).not.toMatch(/^files:/m);
    expect(builder).not.toMatch(/^[ \t]+asarUnpack:/m);
  });

  it("main.js 静态 import 的每个 ./*.mjs 都真实存在于 electron-app/（含新增的两个纯函数模块）", () => {
    const imports = [...main.matchAll(/from "\.\/([\w-]+\.mjs)"/g)].map((m) => m[1]);
    expect(imports).toContain("update-manifest-verify.mjs");
    expect(imports).toContain("external-url.mjs");
    expect(imports).toContain("win-pending-verify.mjs");
    expect(imports).toContain("win-update-guard.mjs");
    const present = new Set(readdirSync(path.join(ROOT, "electron-app")));
    for (const f of imports) expect(present.has(f), `${f} 应存在`).toBe(true);
    expect(existsSync(path.join(ROOT, "electron-app/update-manifest-public-key.pem"))).toBe(true);
  });

  it("纯函数模块不依赖 electron（可在 vitest 里直接 import、也不会在壳外炸）", () => {
    for (const f of ["update-manifest-verify.mjs", "external-url.mjs", "win-pending-verify.mjs"]) {
      const src = readFileSync(path.join(ROOT, "electron-app", f), "utf8");
      expect(src).not.toMatch(/from "electron"|require\("electron"\)/);
    }
  });

  it("verifyDownloadedUpdate / loadSignedManifest 委托纯函数、参数改名 filePath、manifest URL 仍是 releases/download/v${version}", () => {
    // F1-01：「读公钥 + 取清单 + 三道廉价检查」从 verifyDownloadedUpdate 拆成 loadSignedManifest（mac 要在下 dmg 之前先做），
    // verifyDownloadedUpdate 只剩「实测 size / SHA-256 + 最终裁决」，清单上下文可由调用方预取传入（preloaded）
    const loadStart = main.indexOf("const loadSignedManifest = async (version, assetName) => {");
    expect(loadStart).toBeGreaterThanOrEqual(0);
    const load = main.slice(loadStart, main.indexOf("\n};", loadStart));
    const start = main.indexOf(
      "const verifyDownloadedUpdate = async (version, filePath, assetName, preloaded) => {",
    );
    expect(start).toBeGreaterThanOrEqual(0);
    const fn = main.slice(start, main.indexOf("\n};", start));
    expect(load).toContain("findSignedManifestEntry({ manifest, publicKeyPem, version, assetName })");
    expect(fn).toContain("verifyManifestEntry({");
    // 没传 preloaded（Windows 路径）就在这里现取：行为与拆分前一致、没有「跳过取清单」的分支
    expect(fn).toContain("preloaded ?? (await loadSignedManifest(version, assetName))");
    // 公钥缺失 / 为空 / manifest 拿不到仍然 throw（fail-closed 的 IO 部分没被削弱）
    expect(load).toContain("更新验签公钥缺失");
    expect(load).toContain("更新验签公钥为空");
    // manifest 取不到：取清单（超时 / HTTP / 解析）已挪进纯模块的 fetchUpdateManifest（N2-02 要按类型分流），
    // 壳里仍必须调它、且 HTTP 非 2xx 文案仍在纯模块里（行为见 update-manifest-failure-kinds.test.ts）
    expect(load).toContain("fetchUpdateManifest({ url: manifestUrl })");
    expect(readFileSync(path.join(ROOT, "electron-app/update-manifest-verify.mjs"), "utf8")).toContain(
      "更新 manifest 下载失败 HTTP",
    );
    // 验签判定不再内联：壳里不应再有自己的 Ed25519 verify 实现
    expect(main).not.toMatch(/\bverify\(\s*null/);
    expect(main).not.toContain("createPublicKey");
    // mac 暂存链路：先取清单（下 dmg 之前）→ 下 dmg → attach 之前再验签（复用先取到的清单）
    const prefetch = main.indexOf("const manifestCtx = await loadSignedManifest(version, assetName);");
    const download = main.indexOf("await fetch(dmgUrl)", prefetch);
    const mac = main.indexOf("await verifyDownloadedUpdate(version, dmgPath, assetName, manifestCtx);");
    const attach = main.indexOf('await execFileStrict("hdiutil", [', mac);
    expect(prefetch).toBeGreaterThanOrEqual(0);
    expect(download).toBeGreaterThan(prefetch);
    expect(mac).toBeGreaterThan(download);
    expect(attach).toBeGreaterThan(mac);
  });
});
