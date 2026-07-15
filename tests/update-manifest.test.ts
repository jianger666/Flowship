/**
 * 更新 manifest 签名链（CR-02）——scripts/generate-update-manifest.mjs 的产签 +
 * 壳侧验签逻辑（同序 payload 重建）做 roundtrip 回归。
 *
 * 回归点：
 * - 私钥签出的 manifest 用公钥可验、asset 的 SHA-256 / size 记录正确
 * - 篡改 asset 任意字节 → 哈希对不上；篡改 manifest → 验签失败
 * - secret 未配置时脚本非零退出且不产文件（P0-01 起 fail-closed、缺私钥直接断发版）
 */
import { execFile } from "node:child_process";
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  verify,
} from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const TMP = path.join(os.tmpdir(), `fe-update-manifest-${Date.now()}`);
const SCRIPT = path.resolve("scripts/generate-update-manifest.mjs");
const ASSET = path.join(TMP, "fe-ai-flow-9.9.9-mac-arm64.dmg");
const ASSET_CONTENT = "fake-dmg-bytes-0123456789";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const privPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();

// 跑脚本（cwd=TMP、manifest 落 TMP）
const runScript = (env: Record<string, string | undefined>) =>
  execFileAsync(process.execPath, [SCRIPT, "9.9.9", ASSET], {
    cwd: TMP,
    env: { ...process.env, ...env },
  });

beforeAll(async () => {
  await fs.mkdir(TMP, { recursive: true });
  await fs.writeFile(ASSET, ASSET_CONTENT);
});

afterAll(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

// 壳侧验签的同款逻辑（electron-app/main.js verifyDownloadedUpdate 的核心步骤）
const verifyManifest = (manifest: {
  version: string;
  files: Array<{ name: string; size: number; sha256: string }>;
  signature: string;
}): boolean => {
  const payload = JSON.stringify({ version: manifest.version, files: manifest.files });
  return verify(
    null,
    Buffer.from(payload, "utf8"),
    createPublicKey(pubPem),
    Buffer.from(manifest.signature, "base64"),
  );
};

describe("generate-update-manifest（CR-02）", () => {
  it("secret 未配置 → 非零退出、不产 manifest（fail-closed）", async () => {
    // execFile 非零退出会 reject、错误对象带 code/stdout
    const err = (await runScript({ UPDATE_MANIFEST_PRIVATE_KEY: "" }).catch(
      (e) => e,
    )) as NodeJS.ErrnoException & { code?: number; stdout?: string };
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(1);
    expect(`${err.stdout ?? ""}${err.message}`).toContain("未配置");
    await expect(fs.access(path.join(TMP, "update-manifest.json"))).rejects.toThrow();
  });

  it("产签 roundtrip：签名可验、SHA-256 / size 正确；篡改即拒", async () => {
    await runScript({ UPDATE_MANIFEST_PRIVATE_KEY: privPem });
    const manifest = JSON.parse(
      await fs.readFile(path.join(TMP, "update-manifest.json"), "utf8"),
    ) as {
      version: string;
      files: Array<{ name: string; size: number; sha256: string }>;
      signature: string;
    };

    // 内容记录正确
    expect(manifest.version).toBe("9.9.9");
    expect(manifest.files).toHaveLength(1);
    expect(manifest.files[0].name).toBe("fe-ai-flow-9.9.9-mac-arm64.dmg");
    expect(manifest.files[0].size).toBe(Buffer.byteLength(ASSET_CONTENT));
    expect(manifest.files[0].sha256).toBe(
      createHash("sha256").update(ASSET_CONTENT).digest("hex"),
    );

    // 正品验签通过
    expect(verifyManifest(manifest)).toBe(true);

    // 篡改 manifest（改版本 / 改哈希）→ 验签失败（攻击者不能同时替换 dmg + 摘要）
    expect(verifyManifest({ ...manifest, version: "10.0.0" })).toBe(false);
    expect(
      verifyManifest({
        ...manifest,
        files: [{ ...manifest.files[0], sha256: "0".repeat(64) }],
      }),
    ).toBe(false);

    // 篡改 asset 一个字节 → 与 manifest 记录的哈希对不上（壳侧会拒绝替换）
    const tampered = `${ASSET_CONTENT.slice(0, -1)}X`;
    expect(createHash("sha256").update(tampered).digest("hex")).not.toBe(
      manifest.files[0].sha256,
    );
  });
});
