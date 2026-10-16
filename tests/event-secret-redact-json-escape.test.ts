/**
 * 事件凭据脱敏：凭据的「JSON 转义形态」出现在**文本**里也必须脱敏（代码复查补洞）
 *
 * 漏洞：agent `cat company-env.json` / `cat config.json` / `jq .` 时，输出文本里的口令是 **JSON 转义后的样子**
 * （口令含 `"` / `\` / 制表符时，磁盘上写的是 `pa\"ss\\word`）。落盘与推流脱敏只认两种形态：
 *   ① 原值（`replaceSecrets` 的 `value`）；
 *   ② 原值的 JSON 转义形态——但 `escaped` 只被 `lineContainsSecret` 用来「判断整行序列化后是否含凭据」，
 *      **从来没有拿它在字符串值里做替换**；而且 tool_result 文本进事件行时又被再转义一层，
 *      行里长的是「转义的转义」，`lineContainsSecret` 预检压根查不到 → 整条事件原样落盘。
 * 结果：口令含 `"` / `\` 的公司环境密码（人设的口令，不像 PAT 那样只含字母数字 / `-_`）在 `cat` 输出里明文进 events.jsonl。
 *
 * 全程假口令 + 临时数据目录，绝不读真实配置。
 */
import { mkdtempSync, promises as fs, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-event-redact-esc-"));
const DATA_DIR = path.join(TMP_ROOT, "data");
process.env.FLOWSHIP_DATA_DIR = DATA_DIR;

const { dataRoot } = await import("@/lib/server/data-root");
const {
  REDACTED_API_KEY,
  REDACTED_COMPANY_ENV,
  getEventRedactionReplacements,
  redactCopyIfHit,
  redactSecretsInText,
  serializeEventLineRedacted,
} = await import("@/lib/server/event-secret-redact");

if (!dataRoot().startsWith(TMP_ROOT)) {
  throw new Error(`DATA_DIR 未隔离到 TMP：${dataRoot()}`);
}

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

/** 写（或覆盖）数据目录下的 JSON 文件，tmp+rename 模拟生产的原子写 */
const writeJson = async (fileName: string, obj: unknown): Promise<string> => {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, fileName);
  const tmp = `${file}.tmp-${Math.random().toString(36).slice(2)}`;
  const body = `${JSON.stringify(obj, null, 2)}\n`;
  await fs.writeFile(tmp, body, "utf-8");
  await fs.rename(tmp, file);
  return body; // 就是 agent `cat` 这个文件会看到的文本
};

afterEach(async () => {
  await fs.rm(path.join(DATA_DIR, "config.json"), { force: true });
  await fs.rm(path.join(DATA_DIR, "company-env.json"), { force: true });
});

/** 口令里各类需要 JSON 转义的字符（引号 / 反斜杠 / 制表符 / 换行），尾段是用来断言「明文没留下」的指纹 */
const WEIRD_PASSWORDS: Array<[string, string, string]> = [
  ["双引号 + 反斜杠", 'Pa"ss\\word-FAKE-0001', "word-FAKE-0001"],
  ["仅反斜杠", "C:\\corp\\pg-Pa55-FAKE-0002", "pg-Pa55-FAKE-0002"],
  ["制表符", "Pa55\tword-FAKE-0003", "word-FAKE-0003"],
  ["换行", "Pa55\nword-FAKE-0004", "word-FAKE-0004"],
];

describe("口令的 JSON 转义形态出现在文本里（cat company-env.json 的输出）", () => {
  it.each(WEIRD_PASSWORDS)(
    "%s：redactSecretsInText（推流增量 / 累积文本入口）不留明文",
    async (_label, pw, fingerprint) => {
      const body = await writeJson("company-env.json", { pg: [{ env: "test", password: pw }] });
      const escaped = JSON.stringify(pw).slice(1, -1);
      expect(body.includes(escaped)).toBe(true); // 前提：cat 出来的就是转义形态
      expect(body.includes(pw)).toBe(false);

      const out = redactSecretsInText(`$ cat company-env.json\n${body}`);
      expect(out).not.toContain(escaped);
      expect(out).not.toContain(fingerprint);
      expect(out).toContain(REDACTED_COMPANY_ENV);
    },
  );

  it.each(WEIRD_PASSWORDS)(
    "%s：serializeEventLineRedacted（事件落盘入口）——tool_result 整段落盘后不含明文",
    async (_label, pw, fingerprint) => {
      const body = await writeJson("company-env.json", { pg: [{ env: "test", password: pw }] });
      const ev = { kind: "tool_result", text: body, meta: { callId: "c1" } };

      const line = serializeEventLineRedacted(ev);

      // 落盘的那一行文本里不能再有指纹（无论是转义几层的形态）
      expect(line).not.toContain(fingerprint);
      const parsed = JSON.parse(line) as { text: string; meta: { callId: string } };
      expect(parsed.text).toContain(REDACTED_COMPANY_ENV);
      expect(parsed.meta.callId).toBe("c1");
    },
  );

  it("config.json 里的 apiKey 含引号 / 反斜杠：cat config.json 的输出同样脱敏（占位符区分来源）", async () => {
    const apiKey = 'crsr_FAKE"KEY\\0123456789';
    const body = await writeJson("config.json", { apiKey, gitToken: "" });
    const ev = { kind: "tool_result", text: body };
    const line = serializeEventLineRedacted(ev);
    expect(line).not.toContain("0123456789");
    expect((JSON.parse(line) as { text: string }).text).toContain(REDACTED_API_KEY);
  });

  it("redactCopyIfHit（推流不可原地改的帧）：命中才拷贝、原对象不动；转义形态也算命中", async () => {
    const pw = 'Pa"ss\\word-FAKE-0005';
    const body = await writeJson("company-env.json", { pg: [{ password: pw }] });
    const frame = { kind: "tool_output_delta", chunk: body };

    const safe = redactCopyIfHit(frame);

    expect(safe).not.toBe(frame);
    expect(JSON.stringify(safe)).not.toContain("word-FAKE-0005");
    expect(frame.chunk).toBe(body); // 原对象保持原样（调用方还握着它）
  });

  it("原有形态不退化：口令原样（未转义）出现 / 不含需转义字符的凭据，行为与之前一致", async () => {
    const pw = 'Pa"ss\\word-FAKE-0006';
    await writeJson("company-env.json", { pg: [{ password: pw }] });
    expect(redactSecretsInText(`raw=${pw}`)).toBe(`raw=${REDACTED_COMPANY_ENV}`);

    const plain = "pg-Pa55w0rd-FAKE-0007";
    await writeJson("company-env.json", { pg: [{ password: plain }] });
    const body = `${JSON.stringify({ pg: [{ password: plain }] }, null, 2)}\n`;
    expect(redactSecretsInText(body)).not.toContain(plain);
    // 没有需要转义的字符 → 不应多出「转义形态」条目（值集合规模不因这次修复膨胀）
    expect(getEventRedactionReplacements().map((s) => s.value)).toEqual([plain]);
  });

  it("不误伤：不含凭据的 JSON 文本原样返回同一个字符串 / 同一个对象（零拷贝）", async () => {
    await writeJson("company-env.json", { pg: [{ password: 'Pa"ss\\word-FAKE-0008' }] });
    const harmless = JSON.stringify({ pg: [{ host: "10.0.3.1", note: 'say "hi" \\ ok' }] }, null, 2);
    expect(redactSecretsInText(harmless)).toBe(harmless);
    const obj = { text: harmless };
    expect(redactCopyIfHit(obj)).toBe(obj);
  });
});
