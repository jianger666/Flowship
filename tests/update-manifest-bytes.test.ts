/**
 * 更新 manifest 签名「字节一致性」（N2）：CI 签的 payload ≡ 壳重建的 payload
 *
 * 壳不拿原始字节验签，而是 `JSON.parse` 之后重建 `JSON.stringify({version, files})` 再验——
 * 所以必须证明：scripts/generate-update-manifest.mjs 签的那串字节，经「GitHub 下载 → Response.json() → 重建」
 * 之后**逐字节相同**；以及任何会让字节变化的篡改 / 重排都 fail-closed（而不是误放行或误拒真包）。
 *
 * 与 update-manifest-verify.test.ts 的分工：那边已有「脚本产物（pretty、ASCII 名）→ JSON.parse → 验」；
 * 这里补它没覆盖的：① 走 fetchUpdateManifest 的 Response.json() 真实路径（含多字节字符被 chunk 切开）；
 * ② 非 ASCII / 空格 / 引号 / 反斜杠 / emoji 的 asset 名；③ 文件文本形态变化（压缩 / CRLF / tab / \uXXXX 转义 / BOM）；
 * ④ 字段 / 条目重排、条目多字段的 fail-closed 与前向兼容；⑤ 数字边界（2^53-1 与之上）；⑥ 顶层额外字段。
 *
 * 结论（写在断言里）：两端 payload 构造一致（key 顺序 version→files、条目 name→size→sha256、
 * 条目顺序 = 签名顺序、数字是 JS 最短十进制）；重建依赖的是「文件里的 key 顺序 = 签名时的顺序」，
 * 而 generate 脚本正是把签名用的同一个 files 数组原样写进文件，所以天然一致。
 *
 * 回退自检：把 update-manifest-verify.mjs 里重建 payload 的 key 顺序改成 { files, version }，
 * 「脚本真实产物」一组必须全红。
 */
import { execFile } from "node:child_process";
import {
  createHash,
  generateKeyPairSync,
  sign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  UpdateVerifyMismatchError,
  fetchUpdateManifest,
  verifyManifestEntry,
} from "../electron-app/update-manifest-verify.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");
const VERSION = "9.9.9";

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

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const privPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const sha256Of = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const signFiles = (key: KeyObject, version: string, files: unknown[]): string =>
  sign(null, Buffer.from(JSON.stringify({ version, files }), "utf8"), key).toString("base64");

// 名字里刻意带上会让 JSON 序列化 / 解码出事的字符；引号与反斜杠在 Windows 上不是合法文件名、只在 POSIX 造
const NAMES = [
  `fe-ai-flow-${VERSION}-win-x64.exe`,
  `流程 ✨ ${VERSION} émoji😀 x64.exe`,
  ...(process.platform === "win32" ? [] : [`we"ird\\name<>&'${VERSION}.exe`]),
];
const bytesOf = (name: string): Buffer => Buffer.from(`MZ-bytes-of-${name}-${"x".repeat(37)}`, "utf8");

const TMP = path.join(os.tmpdir(), `fe-update-manifest-bytes-${Date.now()}`);
let scriptText = "";
let manifest: Manifest;

beforeAll(async () => {
  await fs.mkdir(TMP, { recursive: true });
  const paths: string[] = [];
  for (const name of NAMES) {
    const p = path.join(TMP, name);
    await fs.writeFile(p, bytesOf(name));
    paths.push(p);
  }
  // 真实 generate 脚本（CI finalize 同款调用）：产物就是「被签的那串字节」的来源
  await execFileAsync(
    process.execPath,
    [path.join(ROOT, "scripts/generate-update-manifest.mjs"), VERSION, ...paths],
    { cwd: TMP, env: { ...process.env, UPDATE_MANIFEST_PRIVATE_KEY: privPem } },
  );
  scriptText = await fs.readFile(path.join(TMP, "update-manifest.json"), "utf8");
  manifest = JSON.parse(scriptText) as Manifest;
});

afterAll(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

/** 对某个 asset 用「本地实测值」走壳的完整验签 */
const verifyAsset = (m: unknown, name: string): void =>
  verifyManifestEntry({
    manifest: m as object,
    publicKeyPem: pubPem,
    version: VERSION,
    assetName: name,
    size: bytesOf(name).length,
    sha256: sha256Of(bytesOf(name)),
  });

const verifyAll = (m: unknown): void => {
  for (const n of NAMES) verifyAsset(m, n);
};

/** 把字节当作 HTTP 响应体、按 chunkSize 切成多块（可切在多字节字符中间），走真实 fetchUpdateManifest */
const fetchViaResponse = async (bytes: Uint8Array, chunkSize = 7): Promise<unknown> => {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += chunkSize) c.enqueue(bytes.slice(i, i + chunkSize));
      c.close();
    },
  });
  return fetchUpdateManifest({
    url: "https://example.invalid/update-manifest.json",
    fetchImpl: async () => new Response(stream, { status: 200 }),
  });
};

const catchErr = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("预期抛错但没有抛");
};

describe("脚本真实产物 ↔ 壳重建 payload（逐字节一致）", () => {
  it("脚本产物的 key 顺序 / 条目顺序 / 条目 key 顺序正是壳重建所依赖的那一套", () => {
    expect(Object.keys(manifest)).toEqual(["version", "files", "signature"]);
    expect(manifest.files.map((f) => f.name)).toEqual(NAMES);
    for (const f of manifest.files) expect(Object.keys(f)).toEqual(["name", "size", "sha256"]);
    expect(manifest.files.every((f) => Number.isSafeInteger(f.size))).toBe(true);
  });

  it("壳重建的 payload 与签名字节完全一致：用同一串字节直接验签通过", () => {
    // 重建方式 = update-manifest-verify.mjs 内部：JSON.stringify({ version: m.version, files: m.files })
    const rebuilt = JSON.stringify({ version: manifest.version, files: manifest.files });
    const ok = cryptoVerify(
      null,
      Buffer.from(rebuilt, "utf8"),
      publicKey,
      Buffer.from(manifest.signature, "base64"),
    );
    expect(ok).toBe(true);
  });

  it("含空格 / 中文 / emoji（代理对）/ 引号 / 反斜杠 / <>& 的 asset 名：全部通过完整验签", () => {
    expect(() => verifyAll(manifest)).not.toThrow();
  });

  it("走真实下载路径：Response.json() 解码（多字节字符被 chunk 边界切开也不影响）→ 通过", async () => {
    const bytes = Buffer.from(scriptText, "utf8");
    // 切块大小取不同质数，总有边界落在某个 UTF-8 多字节序列中间
    for (const chunk of [1, 2, 3, 5, 7, 13]) {
      const m = await fetchViaResponse(bytes, chunk);
      expect(() => verifyAll(m), `chunk=${chunk}`).not.toThrow();
    }
  });
});

describe("文件文本形态变化不影响验签（签名覆盖的是语义值、不是文件排版）", () => {
  const pretty = (): string => scriptText;
  const variants: Array<[string, () => string]> = [
    ["压缩成单行", () => JSON.stringify(JSON.parse(pretty()))],
    ["CRLF 换行（Windows 编辑器 / git autocrlf 改写）", () => pretty().replace(/\n/g, "\r\n")],
    ["tab 缩进", () => JSON.stringify(JSON.parse(pretty()), null, "\t")],
    ["4 空格缩进 + 结尾多个换行", () => `${JSON.stringify(JSON.parse(pretty()), null, 4)}\n\n`],
    [
      "非 ASCII 全部转成 \\uXXXX 转义（含代理对）",
      () =>
        pretty().replace(
          /[\u0080-\uffff]/g,
          (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
        ),
    ],
    ["size 写成 123.0 形态（语义值相同）", () => pretty().replace(/("size": )(\d+)/g, "$1$2.0")],
  ];
  it.each(variants)("%s → 通过", async (_name, make) => {
    const text = make();
    // 既走 JSON.parse、也走真实的 Response.json() 路径
    expect(() => verifyAll(JSON.parse(text))).not.toThrow();
    const m = await fetchViaResponse(Buffer.from(text, "utf8"), 11);
    expect(() => verifyAll(m)).not.toThrow();
  });

  it("文件开头带 UTF-8 BOM：Response.json() 会剥掉、照常通过（不会因 BOM 误拒真包）", async () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(scriptText, "utf8")]);
    const m = await fetchViaResponse(withBom, 9);
    expect(() => verifyAll(m)).not.toThrow();
  });
});

describe("会让字节变化的改动一律 fail-closed（不误放行）", () => {
  const clone = (): Manifest => JSON.parse(scriptText) as Manifest;
  const NAME0 = NAMES[0]!;

  it("条目 key 顺序被重排（name,size,sha256 → sha256,name,size）→ 签名失败", () => {
    const m = clone();
    m.files = m.files.map((f) => ({ sha256: f.sha256, name: f.name, size: f.size }));
    const err = catchErr(() => verifyAsset(m, NAME0));
    expect(err).toBeInstanceOf(UpdateVerifyMismatchError);
    expect((err as UpdateVerifyMismatchError).code).toBe("signature");
  });

  it("条目顺序被调换 → 签名失败（顺序是签名内容的一部分）", () => {
    const m = clone();
    m.files = [...m.files].reverse();
    const err = catchErr(() => verifyAsset(m, NAME0));
    expect((err as UpdateVerifyMismatchError).code).toBe("signature");
  });

  it("顶层 key 顺序改变（version / files 对调）不影响：壳按固定顺序重建、不信文件里的顺序", () => {
    const m = clone();
    const swapped = { files: m.files, signature: m.signature, version: m.version };
    expect(() => verifyAll(swapped)).not.toThrow();
  });

  it("有人往条目里塞了没签过的字段 → 签名失败；往顶层塞额外字段 → 不影响（顶层额外字段壳从不读）", () => {
    const m = clone();
    m.files = m.files.map((f, i) => (i === 0 ? { ...f, url: "https://evil.invalid/x.exe" } : f));
    expect((catchErr(() => verifyAsset(m, NAME0)) as UpdateVerifyMismatchError).code).toBe("signature");

    const extraTop = { ...clone(), generatedAt: "2026-10-14", notes: ["x"], files2: [] };
    expect(() => verifyAll(extraTop)).not.toThrow();
  });

  it("前向兼容：将来发版链给条目新增并签进了字段（如 arch）→ 壳照常通过（重建沿用文件里的 key 顺序）", () => {
    const files = NAMES.map((name) => ({
      name,
      size: bytesOf(name).length,
      sha256: sha256Of(bytesOf(name)),
      arch: "x64",
    }));
    const m = { version: VERSION, files, signature: signFiles(privateKey, VERSION, files) };
    // 走一遍文本往返，确认序列化 / 解析不吞字段
    const roundTripped = JSON.parse(JSON.stringify(m, null, 2));
    expect(() => verifyAll(roundTripped)).not.toThrow();
  });

  it("数字：任何 JS 数字 stringify→parse→stringify 逐字不变（脚本侧签的就是 JS 的 stringify）", () => {
    // 2^53 以上的整数、科学计数法都在内——证明「大整数 size 会让重建字节变化」对 JS 签名端不成立
    for (const n of [0, 1, 2 ** 31, 2 ** 32, 2 ** 53 - 1, 2 ** 53, 2 ** 53 + 2, 1.2345e20, 1e21, 123456789012345680000]) {
      const signed = JSON.stringify({ size: n });
      expect(JSON.stringify(JSON.parse(signed)), String(n)).toBe(signed);
    }
  });

  it("异语言签名端写出超出 2^53 的整数字面量（解析即失真）→ 签名失败、不误放行；2^53-1 以内的字面量照常通过", () => {
    const name = NAMES[0]!;
    const sha = sha256Of(bytesOf(name));
    // 模拟「被签的文本」与「JSON.parse 后再 stringify 的文本」可能不同的唯一场景：整数字面量超出双精度
    const build = (sizeLiteral: string) => {
      const filesText = `[{"name":${JSON.stringify(name)},"size":${sizeLiteral},"sha256":"${sha}"}]`;
      const signature = sign(
        null,
        Buffer.from(`{"version":"${VERSION}","files":${filesText}}`, "utf8"),
        privateKey,
      ).toString("base64");
      return JSON.parse(`{"version":"${VERSION}","files":${filesText},"signature":"${signature}"}`);
    };
    const run = (m: unknown, size: number) =>
      verifyManifestEntry({
        manifest: m as object,
        publicKeyPem: pubPem,
        version: VERSION,
        assetName: name,
        size,
        sha256: sha,
      });

    expect(() => run(build("9007199254740991"), 9007199254740991)).not.toThrow();
    const err = catchErr(() => run(build("9007199254740993"), 9007199254740993));
    expect(err).toBeInstanceOf(UpdateVerifyMismatchError);
    expect((err as UpdateVerifyMismatchError).code).toBe("signature");
  });
});
