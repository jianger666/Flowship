/**
 * verifyNpmTarball（CR-05）——meegle npm 包下载后的完整性校验。
 *
 * 回归点（旧实现完全没有校验、任何断言在旧代码上都不存在等价保护）：
 * - integrity（SRI sha512）匹配放行、篡改内容拒绝
 * - 只有旧式 shasum（sha1 hex）时也能验
 * - registry 元数据两个字段都缺 → 拒装（不静默放行）
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TMP_ROOT = path.join(os.tmpdir(), `fe-cli-integrity-${Date.now()}`);
process.env.FE_AI_FLOW_DATA_DIR = path.join(TMP_ROOT, "data");

import {
  isTrustedFeishuAuthUrl,
  verifyNpmTarball,
} from "@/lib/server/feishu-cli";

const FILE = path.join(TMP_ROOT, "pkg.tgz");
const CONTENT = "fake-tgz-bytes-abcdef";

const sri = `sha512-${createHash("sha512").update(CONTENT).digest("base64")}`;
const shasum = createHash("sha1").update(CONTENT).digest("hex");

beforeAll(async () => {
  await fs.mkdir(TMP_ROOT, { recursive: true });
  await fs.writeFile(FILE, CONTENT);
});

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("verifyNpmTarball（CR-05）", () => {
  it("integrity 匹配 → 放行", async () => {
    await expect(verifyNpmTarball(FILE, { integrity: sri }, "t")).resolves.toBeUndefined();
  });

  it("内容被篡改 → 拒绝", async () => {
    const tampered = path.join(TMP_ROOT, "tampered.tgz");
    await fs.writeFile(tampered, `${CONTENT}X`);
    await expect(verifyNpmTarball(tampered, { integrity: sri }, "t")).rejects.toThrow(
      /校验失败/,
    );
  });

  it("只有旧式 shasum → 用 sha1 验、匹配放行、不匹配拒绝", async () => {
    await expect(verifyNpmTarball(FILE, { shasum }, "t")).resolves.toBeUndefined();
    await expect(
      verifyNpmTarball(FILE, { shasum: "0".repeat(40) }, "t"),
    ).rejects.toThrow(/校验失败/);
  });

  it("integrity / shasum 都缺 → 拒装", async () => {
    await expect(verifyNpmTarball(FILE, {}, "t")).rejects.toThrow(/拒绝安装/);
  });

  it("integrity 非 sha512 前缀 → 拒装（格式不认识就不猜）", async () => {
    await expect(
      verifyNpmTarball(FILE, { integrity: "sha256-abc" }, "t"),
    ).rejects.toThrow(/格式不认识/);
  });
});

describe("isTrustedFeishuAuthUrl（登录 stdout 自动 open 白名单）", () => {
  it("飞书 / larksuite / feishu-boe.cn 域放行", () => {
    expect(
      isTrustedFeishuAuthUrl("https://accounts.feishu.cn/oauth/authorize?x=1"),
    ).toBe(true);
    expect(
      isTrustedFeishuAuthUrl("https://project.feishu.cn/auth/login"),
    ).toBe(true);
    expect(
      isTrustedFeishuAuthUrl("https://open.larksuite.com/open-apis/authen/v1"),
    ).toBe(true);
    expect(isTrustedFeishuAuthUrl("https://feishu-boe.cn/oauth")).toBe(true);
    expect(
      isTrustedFeishuAuthUrl("https://foo.feishu-boe.cn/oauth"),
    ).toBe(true);
  });

  it("非飞书 https / 非 https → 拒绝", () => {
    expect(isTrustedFeishuAuthUrl("https://evil.example/phish")).toBe(false);
    expect(isTrustedFeishuAuthUrl("http://accounts.feishu.cn/x")).toBe(false);
    expect(isTrustedFeishuAuthUrl("not-a-url")).toBe(false);
  });

  it("feishu-boe substring / 混淆域 → 拒绝", () => {
    expect(
      isTrustedFeishuAuthUrl("https://feishu-boe.evil.example/phish"),
    ).toBe(false);
    expect(isTrustedFeishuAuthUrl("https://evilfeishu-boe.cn/oauth")).toBe(
      false,
    );
    expect(
      isTrustedFeishuAuthUrl("https://feishu-boe.cn.evil.com/oauth"),
    ).toBe(false);
  });
});
