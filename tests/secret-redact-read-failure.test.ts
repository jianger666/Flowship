/**
 * R14 B2-1 · Q9-10 的后半句：config.json「读不出来」≠「没配凭据」→ 事件脱敏沿用上一次读成功的凭据。
 *
 * 旧行为：readSecretsCached 一失败就清缓存并返回空集合——config.json 半写 / 被杀毒软件占用 / 用户手改漏了逗号的那段时间里，
 * 写盘的事件整体不脱敏（工具输出里的 apiKey / gitToken 明文落进 events.jsonl）；手改坏了一直没修，这个窗口就一直开着。
 * 现在：文件不存在（ENOENT）= 没配 → 清缓存、空集合（与以前一致）；其它读不出（半写 / EBUSY / 权限 / 手改坏）
 * → 沿用上一次读成功的凭据（只沿用**同一个文件**的缓存），一次都没读成功过则与「没配」相同。
 * 文件一变（stat 指纹不同）下个事件就重读，恢复后立刻改用新凭据；事件落盘永远不受影响。
 *
 * 全程假凭据 + 临时数据目录，绝不碰真实配置。
 */
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { redactSecretsInText } from "@/lib/server/event-secret-redact";

const OLD_KEY = "fake-old-api-key-for-redact-0001";
const NEW_KEY = "fake-new-api-key-for-redact-0002";
const GIT_TOKEN = "fake-git-token-for-redact-0003";

let root: string;
let dataDir: string;
let savedDataDir: string | undefined;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "flowship-redact-fail-"));
  dataDir = path.join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  savedDataDir = process.env.FLOWSHIP_DATA_DIR;
  process.env.FLOWSHIP_DATA_DIR = dataDir;
});

afterEach(() => {
  if (savedDataDir === undefined) delete process.env.FLOWSHIP_DATA_DIR;
  else process.env.FLOWSHIP_DATA_DIR = savedDataDir;
  rmSync(root, { recursive: true, force: true });
});

const configPath = (): string => path.join(dataDir, "config.json");
const writeConfig = (cfg: unknown): void => {
  writeFileSync(configPath(), `${JSON.stringify(cfg, null, 2)}\n`, "utf-8");
};
/** 手改写坏 / 半写：长度与有效版本不同，stat 指纹必变（不依赖 mtime 精度） */
const breakConfig = (): void => {
  writeFileSync(configPath(), '{"apiKey": "', "utf-8");
};
const line = (...secrets: string[]): string =>
  secrets.map((s) => `x=${s}`).join(" ");

describe("config.json 读出错时的事件脱敏（Q9-10 后半句）", () => {
  it("自检：有效配置下凭据被抹掉（否则下面的断言在空转）", () => {
    writeConfig({ apiKey: OLD_KEY, gitToken: GIT_TOKEN });
    const out = redactSecretsInText(line(OLD_KEY, GIT_TOKEN));
    expect(out).not.toContain(OLD_KEY);
    expect(out).not.toContain(GIT_TOKEN);
  });

  it("读成功之后文件被写坏（半写 / 手改漏了逗号）：同一凭据仍然被抹掉", () => {
    writeConfig({ apiKey: OLD_KEY });
    expect(redactSecretsInText(line(OLD_KEY))).not.toContain(OLD_KEY); // 先读成功一次
    breakConfig();
    expect(redactSecretsInText(line(OLD_KEY))).not.toContain(OLD_KEY);
  });

  it("写坏期间连续多个事件都被抹掉（沿用的是缓存，不是只管一次）", () => {
    writeConfig({ apiKey: OLD_KEY });
    redactSecretsInText(line(OLD_KEY));
    breakConfig();
    for (let i = 0; i < 3; i += 1) {
      expect(redactSecretsInText(line(OLD_KEY))).not.toContain(OLD_KEY);
    }
  });

  it("config.json 被换成目录（EISDIR：读不出、但不是「不存在」）：沿用旧凭据", () => {
    writeConfig({ apiKey: OLD_KEY });
    redactSecretsInText(line(OLD_KEY));
    unlinkSync(configPath());
    mkdirSync(configPath());
    expect(redactSecretsInText(line(OLD_KEY))).not.toContain(OLD_KEY);
  });

  it("写坏之后恢复成有效内容（换了新凭据）：新凭据立刻被抹掉，旧凭据不再抹（沿用只管「读不出」的那段）", () => {
    writeConfig({ apiKey: OLD_KEY });
    redactSecretsInText(line(OLD_KEY));
    breakConfig();
    redactSecretsInText(line(OLD_KEY));
    writeConfig({ apiKey: NEW_KEY });
    const out = redactSecretsInText(line(NEW_KEY, OLD_KEY));
    expect(out).not.toContain(NEW_KEY);
    expect(out).toContain(OLD_KEY);
  });

  it("文件被删（ENOENT）= 没配：不再沿用旧凭据（语义不变）", () => {
    writeConfig({ apiKey: OLD_KEY });
    redactSecretsInText(line(OLD_KEY));
    unlinkSync(configPath());
    expect(redactSecretsInText(line(OLD_KEY))).toContain(OLD_KEY);
  });

  it("文件被删之后又出现一份坏文件：缓存已在读到 ENOENT 时清掉，不会把删除前的凭据翻出来用", () => {
    writeConfig({ apiKey: OLD_KEY });
    redactSecretsInText(line(OLD_KEY));
    unlinkSync(configPath());
    redactSecretsInText(line(OLD_KEY)); // 读到 ENOENT → 清缓存
    breakConfig();
    expect(redactSecretsInText(line(OLD_KEY))).toContain(OLD_KEY);
  });

  it("一次都没读成功过就是坏文件：不抹、也不抛（与「没配」相同，事件照常落盘）", () => {
    breakConfig();
    expect(() => redactSecretsInText(line(OLD_KEY))).not.toThrow();
    expect(redactSecretsInText(line(OLD_KEY))).toContain(OLD_KEY);
  });

  it("沿用只限同一个文件：数据目录换了，新目录里的坏文件不会拿旧目录的凭据来抹", () => {
    writeConfig({ apiKey: OLD_KEY });
    redactSecretsInText(line(OLD_KEY));
    const other = path.join(root, "data2");
    mkdirSync(other, { recursive: true });
    process.env.FLOWSHIP_DATA_DIR = other;
    writeFileSync(path.join(other, "config.json"), '{"apiKey": "', "utf-8");
    expect(redactSecretsInText(line(OLD_KEY))).toContain(OLD_KEY);
  });
});
