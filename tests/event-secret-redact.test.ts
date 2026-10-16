/**
 * 事件凭据脱敏（S03-04 / S16-11 / R1-01 / R1-02）
 *
 * 背景：「GitLab 访问」提示让 agent 用 jq 从 config.json 取 gitToken，命令输出（tool_result）
 * 与带 token 的 curl（tool_call）会原样写进 events.jsonl。统一入口 appendEventLine 在落盘前
 * 把凭据（gitToken / apiKey / 公司环境密码）的精确值替换成占位符，且 publish 出去的事件同样是脱敏版。
 * 流式增量帧（assistant_delta / thinking_delta / tool_output_delta）不落盘，由 task-stream.publish 推送前脱敏。
 *
 * 全程用假 token + 临时数据目录，绝不读真实配置。
 */
import { mkdtempSync, promises as fs, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";
import type { TaskEvent } from "@/lib/types";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-event-redact-"));
const DATA_DIR = path.join(TMP_ROOT, "data");
process.env.FLOWSHIP_DATA_DIR = DATA_DIR;

vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: vi.fn(),
    resume: vi.fn(),
  },
}));
vi.mock("@/lib/server/mcp-oauth", () => ({
  enrichMcpServersWithOAuth: async <T>(servers: T) => servers,
}));
vi.mock("@/lib/server/mcp-probe", () => ({
  filterHealthyMcp: async (servers: Record<string, unknown>) => ({
    servers,
    dropped: [],
  }),
  invalidateMcpProbeCache: () => {},
}));
vi.mock("@/lib/server/skills-loader", () => ({
  loadSkills: async () => [],
  loadSkillsForTask: async () => [],
  renderSkillsForPrompt: () => "",
}));
vi.mock("@/lib/server/kill-orphans", () => ({
  reapTaskOrphans: vi.fn(),
}));
vi.mock("@/lib/server/action-checks", () => ({
  runActionCheck: vi.fn(async () => ({ passed: true, details: "ok" })),
  captureActionStartBaseline: vi.fn(async () => null),
  captureReadonlyRepoBaselines: vi.fn(async () => null),
}));

const { EVENTS_FILE, clearEventSeqCounter, taskDir, writeMeta } = await import(
  "@/lib/server/task-fs-core"
);
const { appendEvent } = await import("@/lib/server/task-fs");
const { GITLAB_TOKEN_ENV_NAME } = await import("@/lib/server/git-token-env");
const {
  REDACTED_API_KEY,
  REDACTED_COMPANY_ENV,
  REDACTED_GIT_TOKEN,
  getEventRedactionReplacements,
  getEventRedactionSecrets,
  lineContainsSecret,
  redactCopyIfHit,
  redactSecretsInPlace,
  redactSecretsInText,
  serializeEventLineRedacted,
} = await import("@/lib/server/event-secret-redact");
const { publish, subscribeAllTaskStreams, subscribeTaskStream } = await import(
  "@/lib/server/task-stream"
);
const {
  discardPendingThinkingDeltas,
  flushPendingAssistantDeltas,
  getLiveThinkingSnapshot,
  handleSdkMessage,
  THINKING_DELTA_INTERVAL_MS,
} = await import("@/lib/server/sdk-message-handler");
const { __resetGroupReplyStateForTest, appendGroupReplyAnswer, peekGroupReply, rememberGroupReply } =
  await import("@/lib/server/feishu-bridge/group-shared");
import type { TaskStreamEvent } from "@/lib/server/task-stream";

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`event-secret-redact DATA_DIR 未隔离到 TMP：${taskDir("probe")}`);
}

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

const FAKE_TOKEN = "glpat-FAKEFAKEFAKE1234567890";
const FAKE_API_KEY = "crsr_FAKEAPIKEY_0123456789abcdef";
const FAKE_PG_PASSWORD = "pg-Pa55w0rd-FAKE-XYZ";
const FAKE_SERVER_PASSWORD = "ssh-Pa55w0rd-FAKE-ABC";
const FAKE_SLS_SECRET = "sls-AK-SECRET-FAKE-0001";

const gitSecret = (value: string) => [
  { value, placeholder: REDACTED_GIT_TOKEN },
];

/** 写（或覆盖）临时数据目录下的 company-env.json（tmp+rename，同生产原子写） */
const writeCompanyEnvFile = async (raw: string): Promise<void> => {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, "company-env.json");
  const tmp = `${file}.tmp-${Math.random().toString(36).slice(2)}`;
  await fs.writeFile(tmp, raw, "utf-8");
  await fs.rename(tmp, file);
};

const clearCredentialFiles = async (): Promise<void> => {
  await fs.rm(path.join(DATA_DIR, "config.json"), { force: true });
  await fs.rm(path.join(DATA_DIR, "config.json.bak"), { force: true });
  await fs.rm(path.join(DATA_DIR, "config.json.bak.shrink"), { force: true });
  await fs.rm(path.join(DATA_DIR, "company-env.json"), { force: true });
};

/** 写（或覆盖）临时数据目录下的 config.json；tmp+rename 模拟生产的原子写 */
const writeConfig = async (cfg: Record<string, unknown>): Promise<void> => {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, "config.json");
  const tmp = `${file}.tmp-${Math.random().toString(36).slice(2)}`;
  await fs.writeFile(tmp, JSON.stringify(cfg), "utf-8");
  await fs.rename(tmp, file);
};

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: "redact",
    mode: "chat",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    repoStatus: "idle",
    runStatus: "idle",
    actions: [],
    mrs: [],
    repoPaths: [],
    currentActionId: null,
  }) as unknown as TaskMetaV06;

describe("redactSecretsInPlace / lineContainsSecret（纯逻辑）", () => {
  it("递归替换对象 / 数组里所有字符串值，其它字段不动", () => {
    const ev = {
      kind: "tool_result",
      text: `out: ${FAKE_TOKEN}`,
      meta: { nested: [`a ${FAKE_TOKEN} b ${FAKE_TOKEN}`, 42, { deep: FAKE_TOKEN }] },
      n: 7,
    };
    redactSecretsInPlace(ev, gitSecret(FAKE_TOKEN));
    expect(JSON.stringify(ev)).not.toContain(FAKE_TOKEN);
    expect(ev.text).toBe(`out: ${REDACTED_GIT_TOKEN}`);
    expect(ev.meta.nested[0]).toBe(
      `a ${REDACTED_GIT_TOKEN} b ${REDACTED_GIT_TOKEN}`,
    );
    expect(ev.meta.nested[1]).toBe(42);
    expect(ev.n).toBe(7);
  });

  it("凭据含需要 JSON 转义的字符时，也能在序列化行里检出并替换", () => {
    const weird = 'tok"en\\with\nspecial-chars';
    const ev = { text: `v=${weird}` };
    const line = JSON.stringify(ev);
    expect(line.includes(weird)).toBe(false); // 行里是转义形态
    expect(lineContainsSecret(line, gitSecret(weird))).toBe(true);
    redactSecretsInPlace(ev, gitSecret(weird));
    expect(ev.text).toBe(`v=${REDACTED_GIT_TOKEN}`);
  });

  it("不含凭据的行不误报", () => {
    expect(lineContainsSecret('{"text":"hello"}', gitSecret(FAKE_TOKEN))).toBe(false);
  });
});

describe("appendEvent 落盘前脱敏（真实写盘）", () => {
  const ids: string[] = [];
  const alloc = async (): Promise<string> => {
    const id = `t_redact_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    await writeMeta(makeMeta(id));
    return id;
  };
  const rawEventsFile = async (id: string): Promise<string> =>
    fs.readFile(path.join(taskDir(id), EVENTS_FILE), "utf-8");

  afterEach(async () => {
    for (const id of ids.splice(0)) {
      clearEventSeqCounter(id);
      await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
    }
    await clearCredentialFiles();
  });

  it("jq 取 token 的 tool_result / 带 token 的 tool_call 落盘后都不含明文", async () => {
    await writeConfig({ gitToken: FAKE_TOKEN, apiKey: "k" });
    const id = await alloc();

    await appendEvent(id, {
      kind: "tool_call",
      text: `curl -H "PRIVATE-TOKEN: ${FAKE_TOKEN}" https://gitlab.example.com/api/v4/projects`,
    });
    await appendEvent(id, {
      kind: "tool_result",
      text: `${FAKE_TOKEN}\n`,
    });
    await appendEvent(id, { kind: "info", text: "无关事件" });

    const raw = await rawEventsFile(id);
    expect(raw).not.toContain(FAKE_TOKEN);
    const lines = raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as TaskEvent);
    expect(lines[0]!.text).toContain(`PRIVATE-TOKEN: ${REDACTED_GIT_TOKEN}`);
    expect(lines[1]!.text).toBe(`${REDACTED_GIT_TOKEN}\n`);
    // 其它字段 / 无关事件不受影响
    expect(lines[2]!.text).toBe("无关事件");
    expect(lines.map((l) => l.seq)).toEqual([1, 2, 3]);
  });

  it("publish（onCommitted）收到的也是脱敏后的事件", async () => {
    await writeConfig({ gitToken: FAKE_TOKEN });
    const id = await alloc();
    const committed: TaskEvent[] = [];
    const ev = await appendEvent(
      id,
      { kind: "tool_result", text: `token=${FAKE_TOKEN}` },
      undefined,
      (e) => committed.push(structuredClone(e)),
    );
    expect(ev!.text).toBe(`token=${REDACTED_GIT_TOKEN}`);
    expect(committed).toHaveLength(1);
    expect(committed[0]!.text).toBe(`token=${REDACTED_GIT_TOKEN}`);
  });

  it("没配 gitToken / 没有 config.json：事件原样落盘", async () => {
    const id = await alloc();
    await appendEvent(id, { kind: "info", text: `看起来像 token：${FAKE_TOKEN}` });
    expect(await rawEventsFile(id)).toContain(FAKE_TOKEN);

    await writeConfig({ apiKey: "k" }); // 有 config 但没 gitToken
    await appendEvent(id, { kind: "info", text: `again ${FAKE_TOKEN}` });
    const lines = (await rawEventsFile(id)).split("\n").filter(Boolean);
    expect(lines[1]).toContain(FAKE_TOKEN);
  });

  it("过短的 gitToken 不脱敏（防误伤普通文本）", async () => {
    await writeConfig({ gitToken: "abc" });
    expect(getEventRedactionSecrets()).toEqual([]);
    const id = await alloc();
    await appendEvent(id, { kind: "info", text: "abc def" });
    expect(await rawEventsFile(id)).toContain("abc def");
  });

  it("用户在设置页换了新 token：缓存失效，新值立刻生效、旧值不再脱敏", async () => {
    const NEW_TOKEN = "glpat-NEWNEWNEWNEW0987654321";
    await writeConfig({ gitToken: FAKE_TOKEN });
    const id = await alloc();
    await appendEvent(id, { kind: "info", text: FAKE_TOKEN });

    await writeConfig({ gitToken: NEW_TOKEN });
    await appendEvent(id, { kind: "info", text: `${NEW_TOKEN}|${FAKE_TOKEN}` });

    const lines = (await rawEventsFile(id)).split("\n").filter(Boolean);
    expect(lines[0]).not.toContain(FAKE_TOKEN);
    expect(lines[1]).not.toContain(NEW_TOKEN);
    // 旧 token 已不是当前凭据：不再脱敏（精确匹配当前值）
    expect(lines[1]).toContain(FAKE_TOKEN);
  });
});

describe("多凭据脱敏（R1-02：gitToken / apiKey / 公司环境密码）", () => {
  const ids: string[] = [];
  const alloc = async (): Promise<string> => {
    const id = `t_redact_multi_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    await writeMeta(makeMeta(id));
    return id;
  };
  const readLines = async (id: string): Promise<TaskEvent[]> =>
    (await fs.readFile(path.join(taskDir(id), EVENTS_FILE), "utf-8"))
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as TaskEvent);

  afterEach(async () => {
    for (const id of ids.splice(0)) {
      clearEventSeqCounter(id);
      await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
    }
    await clearCredentialFiles();
  });

  it("各凭据落盘后都换成各自的占位符；非凭据字段（host / accessKeyId / note）不动", async () => {
    await writeConfig({
      gitToken: FAKE_TOKEN,
      apiKey: FAKE_API_KEY,
      customProviders: [{ id: "cp_1", apiKey: "sk-custom-provider-FAKE-77" }],
      companyEnv: {
        servers: [{ env: "test", host: "10.9.8.7", user: "deploy", password: FAKE_SERVER_PASSWORD }],
        pg: [{ env: "test", host: "pg.internal", user: "ro", password: FAKE_PG_PASSWORD }],
        sls: [
          {
            env: "test",
            accessKeyId: "LTAI-ID-FAKE-1234",
            accessKeySecret: FAKE_SLS_SECRET,
          },
        ],
        httpApis: [{ env: "test", url: "https://api.internal", note: "login first" }],
      },
    });
    const id = await alloc();
    await appendEvent(id, {
      kind: "tool_result",
      text: [
        FAKE_TOKEN,
        FAKE_API_KEY,
        "sk-custom-provider-FAKE-77",
        FAKE_SERVER_PASSWORD,
        FAKE_PG_PASSWORD,
        FAKE_SLS_SECRET,
        "host=10.9.8.7 id=LTAI-ID-FAKE-1234 note=login first",
      ].join("|"),
    });
    const raw = await fs.readFile(path.join(taskDir(id), EVENTS_FILE), "utf-8");
    for (const secret of [
      FAKE_TOKEN,
      FAKE_API_KEY,
      "sk-custom-provider-FAKE-77",
      FAKE_SERVER_PASSWORD,
      FAKE_PG_PASSWORD,
      FAKE_SLS_SECRET,
    ]) {
      expect(raw).not.toContain(secret);
    }
    const [ev] = await readLines(id);
    expect(ev!.text).toBe(
      [
        REDACTED_GIT_TOKEN,
        REDACTED_API_KEY,
        REDACTED_API_KEY,
        REDACTED_COMPANY_ENV,
        REDACTED_COMPANY_ENV,
        REDACTED_COMPANY_ENV,
        "host=10.9.8.7 id=LTAI-ID-FAKE-1234 note=login first",
      ].join("|"),
    );
  });

  it("company-env.json 里的密码（config.json 里没有）也脱敏", async () => {
    await writeCompanyEnvFile(
      JSON.stringify({
        servers: [],
        redis: [{ env: "test", host: "r.internal", port: 6379, db: 0, password: "redis-FAKE-pass-99" }],
      }),
    );
    const id = await alloc();
    await appendEvent(id, { kind: "tool_result", text: "AUTH redis-FAKE-pass-99" });
    const [ev] = await readLines(id);
    expect(ev!.text).toBe(`AUTH ${REDACTED_COMPANY_ENV}`);
  });

  it("同一个值同时是 gitToken 和 apiKey：只出一种占位符（gitToken 优先）", async () => {
    await writeConfig({ gitToken: FAKE_TOKEN, apiKey: FAKE_TOKEN });
    const id = await alloc();
    await appendEvent(id, { kind: "info", text: FAKE_TOKEN });
    expect((await readLines(id))[0]!.text).toBe(REDACTED_GIT_TOKEN);
  });

  it("一个凭据是另一个的前缀：长的先换，不留半截明文", async () => {
    const SHORT = "prefix-secret-12";
    const LONG = `${SHORT}-and-more-tail`;
    await writeConfig({ gitToken: SHORT, apiKey: LONG });
    const id = await alloc();
    await appendEvent(id, { kind: "info", text: `${LONG} / ${SHORT}` });
    const text = (await readLines(id))[0]!.text;
    expect(text).toBe(`${REDACTED_API_KEY} / ${REDACTED_GIT_TOKEN}`);
    expect(text).not.toContain("and-more-tail");
  });

  it("更换凭据后新值立刻生效、旧值不再脱敏（config.json 与 company-env.json 各自失效）", async () => {
    await writeConfig({ apiKey: FAKE_API_KEY });
    await writeCompanyEnvFile(JSON.stringify({ pg: [{ password: FAKE_PG_PASSWORD }] }));
    const id = await alloc();
    await appendEvent(id, { kind: "info", text: `${FAKE_API_KEY} ${FAKE_PG_PASSWORD}` });

    const NEW_KEY = "crsr_NEWNEWNEW_9876543210zyxwvu";
    const NEW_PG = "pg-N3w-Pa55w0rd-FAKE";
    await writeConfig({ apiKey: NEW_KEY });
    await writeCompanyEnvFile(JSON.stringify({ pg: [{ password: NEW_PG }] }));
    await appendEvent(id, {
      kind: "info",
      text: `${NEW_KEY} ${NEW_PG} old:${FAKE_API_KEY} ${FAKE_PG_PASSWORD}`,
    });

    const lines = await readLines(id);
    expect(lines[0]!.text).toBe(`${REDACTED_API_KEY} ${REDACTED_COMPANY_ENV}`);
    expect(lines[1]!.text).toBe(
      `${REDACTED_API_KEY} ${REDACTED_COMPANY_ENV} old:${FAKE_API_KEY} ${FAKE_PG_PASSWORD}`,
    );
  });

  it("config.json.bak（PUT 覆盖前的备份）里的旧凭据也脱敏：轮换掉的旧 key 还躺在磁盘上、agent 读到就会外流", async () => {
    const OLD_KEY = "crsr_OLDOLDOLD_0123456789abcdef";
    const OLD_TOKEN = "glpat-OLDOLDOLDOLD1234567890";
    await writeConfig({ apiKey: FAKE_API_KEY });
    await fs.writeFile(
      path.join(DATA_DIR, "config.json.bak"),
      JSON.stringify({ apiKey: OLD_KEY, gitToken: OLD_TOKEN }),
      "utf-8",
    );
    const id = await alloc();
    await appendEvent(id, {
      kind: "info",
      text: `${FAKE_API_KEY} ${OLD_KEY} ${OLD_TOKEN}`,
    });
    expect((await readLines(id))[0]!.text).toBe(
      `${REDACTED_API_KEY} ${REDACTED_API_KEY} ${REDACTED_GIT_TOKEN}`,
    );
  });

  it("config.json.bak 缺失 / 损坏：不抛错，config.json 的凭据照常脱敏", async () => {
    await writeConfig({ apiKey: FAKE_API_KEY });
    await fs.writeFile(path.join(DATA_DIR, "config.json.bak"), "{ not json", "utf-8");
    const id = await alloc();
    await appendEvent(id, { kind: "info", text: FAKE_API_KEY });
    expect((await readLines(id))[0]!.text).toBe(REDACTED_API_KEY);
  });

  describe("config.json.bak.shrink（收缩前的完整配置、含已清掉 / 轮换掉的旧凭据）也是脱敏源", () => {
    const SHRINK_KEY = "crsr_SHRINKSHRINK_0123456789abcdef";
    const SHRINK_TOKEN = "glpat-SHRINKSHRINK1234567890";
    const SHRINK_PROVIDER_KEY = "sk-provider-SHRINK-FAKE-0001";
    const SHRINK_PG = "pg-Shrink-Pa55w0rd-FAKE";
    const shrinkFile = (): string => path.join(DATA_DIR, "config.json.bak.shrink");

    it("用户清空 key 后（config.json 里已无它，.bak 也被后续保存滚掉）旧 key / PAT / 自定义 provider key / 公司环境密码仍被脱敏", async () => {
      // 现场：用户清空了 apiKey / gitToken，config.json 是「空配置」；好备份只剩 .bak.shrink
      await writeConfig({ apiKey: "", gitToken: "", repos: [] });
      await fs.writeFile(
        shrinkFile(),
        JSON.stringify({
          apiKey: SHRINK_KEY,
          gitToken: SHRINK_TOKEN,
          customProviders: [{ id: "p1", apiKey: SHRINK_PROVIDER_KEY }],
          companyEnv: { pg: [{ password: SHRINK_PG }] },
        }),
        "utf-8",
      );
      const id = await alloc();
      await appendEvent(id, {
        kind: "info",
        text: `${SHRINK_KEY} ${SHRINK_TOKEN} ${SHRINK_PROVIDER_KEY} ${SHRINK_PG}`,
      });
      expect((await readLines(id))[0]!.text).toBe(
        `${REDACTED_API_KEY} ${REDACTED_GIT_TOKEN} ${REDACTED_API_KEY} ${REDACTED_COMPANY_ENV}`,
      );
    });

    it("同值先到先得：config.json > config.json.bak > config.json.bak.shrink（占位符以更靠前的来源为准）", async () => {
      const SAME_A = "crsr_SAMEVALUE_AAAAAAAAAAAAAAAAAAAA"; // config 里是 apiKey、shrink 里是 gitToken
      const SAME_B = "crsr_SAMEVALUE_BBBBBBBBBBBBBBBBBBBB"; // bak 里是 apiKey、shrink 里是 gitToken
      await writeConfig({ apiKey: SAME_A });
      await fs.writeFile(
        path.join(DATA_DIR, "config.json.bak"),
        JSON.stringify({ apiKey: SAME_B }),
        "utf-8",
      );
      await fs.writeFile(
        shrinkFile(),
        JSON.stringify({ gitToken: SAME_A, customProviders: [{ apiKey: SAME_B }] }),
        "utf-8",
      );
      const id = await alloc();
      await appendEvent(id, { kind: "info", text: `${SAME_A} ${SAME_B}` });
      expect((await readLines(id))[0]!.text).toBe(
        `${REDACTED_API_KEY} ${REDACTED_API_KEY}`,
      );
      // 同值只占集合里一条
      expect(
        getEventRedactionSecrets().filter((s) => s.value === SAME_A || s.value === SAME_B),
      ).toHaveLength(2);
    });

    it("文件内容变了（再次收缩写覆盖）→ 按 stat 失效重读：旧值不再脱敏、新值开始脱敏", async () => {
      const OLD = "crsr_FIRSTSHRINK_0123456789abcdef";
      const NEW = "crsr_SECONDSHRINK_0123456789abcdef";
      await writeConfig({ apiKey: FAKE_API_KEY });
      await fs.writeFile(shrinkFile(), JSON.stringify({ apiKey: OLD }), "utf-8");
      expect(getEventRedactionSecrets().map((s) => s.value)).toContain(OLD);
      // 生产是 tmp + rename 原子写：inode 变化即失效
      const tmp = `${shrinkFile()}.tmp.test`;
      await fs.writeFile(tmp, JSON.stringify({ apiKey: NEW }), "utf-8");
      await fs.rename(tmp, shrinkFile());
      const values = getEventRedactionSecrets().map((s) => s.value);
      expect(values).toContain(NEW);
      expect(values).not.toContain(OLD);
    });

    it("缺失 / 损坏：不抛错，config.json 的凭据照常脱敏", async () => {
      await writeConfig({ apiKey: FAKE_API_KEY });
      const id = await alloc();
      await appendEvent(id, { kind: "info", text: FAKE_API_KEY });
      await fs.writeFile(shrinkFile(), "{ not json", "utf-8");
      await appendEvent(id, { kind: "info", text: FAKE_API_KEY });
      const lines = await readLines(id);
      expect(lines[0]!.text).toBe(REDACTED_API_KEY);
      expect(lines[1]!.text).toBe(REDACTED_API_KEY);
    });
  });

  it("太短（< 8 位）的凭据不脱敏，恰好 8 位脱敏", async () => {
    await writeConfig({
      apiKey: "short",
      companyEnv: { pg: [{ password: "1234567" }], servers: [{ password: "12345678" }] },
    });
    expect(getEventRedactionSecrets().map((s) => s.value)).toEqual(["12345678"]);
    const id = await alloc();
    await appendEvent(id, { kind: "info", text: "short 1234567 12345678" });
    expect((await readLines(id))[0]!.text).toBe(
      `short 1234567 ${REDACTED_COMPANY_ENV}`,
    );
  });

  it("company-env.json 缺失 / 损坏：不抛错、事件照常落盘，config.json 的凭据仍脱敏", async () => {
    await writeConfig({ gitToken: FAKE_TOKEN });
    const id = await alloc();

    // 缺失（没写过）
    await appendEvent(id, { kind: "info", text: `a ${FAKE_TOKEN}` });
    // 损坏（半写 / 乱码）
    await writeCompanyEnvFile("{not json at all");
    await appendEvent(id, { kind: "info", text: `b ${FAKE_TOKEN}` });
    // 合法 JSON 但形状不对
    await writeCompanyEnvFile(JSON.stringify([1, "x", null, { password: 123 }]));
    await appendEvent(id, { kind: "info", text: `c ${FAKE_TOKEN}` });
    // 损坏的 company-env 恢复后立刻生效
    await writeCompanyEnvFile(JSON.stringify({ pg: [{ password: FAKE_PG_PASSWORD }] }));
    await appendEvent(id, { kind: "info", text: `d ${FAKE_PG_PASSWORD}` });

    const lines = await readLines(id);
    expect(lines.map((l) => l.text)).toEqual([
      `a ${REDACTED_GIT_TOKEN}`,
      `b ${REDACTED_GIT_TOKEN}`,
      `c ${REDACTED_GIT_TOKEN}`,
      `d ${REDACTED_COMPANY_ENV}`,
    ]);
  });

  it("config.json 损坏时 company-env.json 的凭据仍脱敏", async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(path.join(DATA_DIR, "config.json"), "{broken", "utf-8");
    await writeCompanyEnvFile(JSON.stringify({ servers: [{ password: FAKE_SERVER_PASSWORD }] }));
    const id = await alloc();
    await appendEvent(id, { kind: "info", text: FAKE_SERVER_PASSWORD });
    expect((await readLines(id))[0]!.text).toBe(REDACTED_COMPANY_ENV);
  });
});

describe("进程 env 里的 GitLab PAT（agent `printenv` 看到的值）也脱敏", () => {
  // 背景：env 值 ≠ config.json 的 gitToken 是真实存在的——会话启动时 resolveSessionGitToken 优先用
  // 入口（前端输入条）带来的 Token，config.json 里可能是旧值 / 没有。只按 config.json 脱敏的话，
  // agent 跑 `printenv FLOWSHIP_GITLAB_TOKEN` 的输出会把 PAT 明文落进 events.jsonl。
  const ENV_TOKEN = "glpat-ENVENVENVENV5555666677";
  const ids: string[] = [];
  const ORIGINAL_ENV_TOKEN = process.env[GITLAB_TOKEN_ENV_NAME];
  const alloc = async (): Promise<string> => {
    const id = `t_redact_env_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    await writeMeta(makeMeta(id));
    return id;
  };
  const rawEventsFile = async (id: string): Promise<string> =>
    fs.readFile(path.join(taskDir(id), EVENTS_FILE), "utf-8");

  afterEach(async () => {
    if (ORIGINAL_ENV_TOKEN === undefined) delete process.env[GITLAB_TOKEN_ENV_NAME];
    else process.env[GITLAB_TOKEN_ENV_NAME] = ORIGINAL_ENV_TOKEN;
    for (const id of ids.splice(0)) {
      clearEventSeqCounter(id);
      await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
    }
    await clearCredentialFiles();
  });

  it("env 里的 token 与 config.json 不同：printenv 输出里两个值都被脱敏", async () => {
    await writeConfig({ gitToken: FAKE_TOKEN });
    process.env[GITLAB_TOKEN_ENV_NAME] = ENV_TOKEN;
    const id = await alloc();

    await appendEvent(id, { kind: "tool_result", text: `${ENV_TOKEN}\n` });
    await appendEvent(id, { kind: "tool_result", text: `${FAKE_TOKEN}\n` });

    const raw = await rawEventsFile(id);
    expect(raw).not.toContain(ENV_TOKEN);
    expect(raw).not.toContain(FAKE_TOKEN);
    const lines = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as TaskEvent);
    expect(lines[0]!.text).toBe(`${REDACTED_GIT_TOKEN}\n`);
    expect(lines[1]!.text).toBe(`${REDACTED_GIT_TOKEN}\n`);
  });

  it("config.json 里根本没有 token（首次安装 / 只在入口带了 token）：env 值照样脱敏", async () => {
    process.env[GITLAB_TOKEN_ENV_NAME] = ENV_TOKEN;
    const id = await alloc();
    await appendEvent(id, {
      kind: "tool_call",
      text: `echo "val=[${ENV_TOKEN}]"`,
    });
    const raw = await rawEventsFile(id);
    expect(raw).not.toContain(ENV_TOKEN);
    expect(raw).toContain(`val=[${REDACTED_GIT_TOKEN}]`);
  });

  it("实时推流也脱敏（publish 唯一扇出点）", async () => {
    process.env[GITLAB_TOKEN_ENV_NAME] = ENV_TOKEN;
    const got: TaskStreamEvent[] = [];
    const unsub = subscribeTaskStream("t_env_stream", (ev) => got.push(ev));
    try {
      publish("t_env_stream", { kind: "assistant_delta", text: `p ${ENV_TOKEN}`, origin: "o1" });
    } finally {
      unsub();
    }
    expect(got).toEqual([
      { kind: "assistant_delta", text: `p ${REDACTED_GIT_TOKEN}`, origin: "o1" },
    ]);
  });

  it("env 值变了立刻生效（缓存键含 env 值）：旧值不再脱敏、新值脱敏；清掉 env 后不再脱敏", async () => {
    const NEW_ENV_TOKEN = "glpat-NEWENVNEWENV8888999900";
    process.env[GITLAB_TOKEN_ENV_NAME] = ENV_TOKEN;
    expect(getEventRedactionSecrets().map((s) => s.value)).toEqual([ENV_TOKEN]);

    process.env[GITLAB_TOKEN_ENV_NAME] = NEW_ENV_TOKEN;
    expect(getEventRedactionSecrets().map((s) => s.value)).toEqual([NEW_ENV_TOKEN]);

    delete process.env[GITLAB_TOKEN_ENV_NAME];
    expect(getEventRedactionSecrets()).toEqual([]);
    expect(redactSecretsInText(`x ${NEW_ENV_TOKEN}`)).toBe(`x ${NEW_ENV_TOKEN}`);
  });

  it("env 与 config.json 是同一个值：只出一条（不重复）；前后空白被 trim", async () => {
    await writeConfig({ gitToken: FAKE_TOKEN });
    process.env[GITLAB_TOKEN_ENV_NAME] = `  ${FAKE_TOKEN}\n`;
    expect(getEventRedactionSecrets()).toEqual(gitSecret(FAKE_TOKEN));
  });

  it("太短（< 8 位）的 env 值不脱敏（同 config.json 口径，防误伤普通文本）", async () => {
    process.env[GITLAB_TOKEN_ENV_NAME] = "abc";
    expect(getEventRedactionSecrets()).toEqual([]);
  });
});

describe("实时推流脱敏（R1-01：publish 唯一扇出点）", () => {
  const TASK = "t_stream_redact";
  let unsubscribe: (() => void) | null = null;
  let unsubscribeAll: (() => void) | null = null;
  let frames: TaskStreamEvent[] = [];
  let tapFrames: TaskStreamEvent[] = [];

  beforeEach(() => {
    frames = [];
    tapFrames = [];
    unsubscribe = subscribeTaskStream(TASK, (ev) => frames.push(ev));
    unsubscribeAll = subscribeAllTaskStreams((id, ev) => {
      if (id === TASK) tapFrames.push(ev);
    });
  });

  afterEach(async () => {
    unsubscribe?.();
    unsubscribeAll?.();
    unsubscribe = null;
    unsubscribeAll = null;
    await clearCredentialFiles();
  });

  it("assistant_delta / thinking_delta / error：SSE 订阅端与全局 tap（飞书回流）收到的都是占位符", async () => {
    await writeConfig({ gitToken: FAKE_TOKEN, apiKey: FAKE_API_KEY });
    publish(TASK, { kind: "assistant_delta", text: `token=${FAKE_TOKEN}`, origin: "o1" });
    publish(TASK, { kind: "thinking_delta", text: `key ${FAKE_API_KEY}!`, eventId: "e1" });
    publish(TASK, { kind: "error", message: `boom ${FAKE_TOKEN}` });

    for (const got of [frames, tapFrames]) {
      expect(got).toEqual([
        { kind: "assistant_delta", text: `token=${REDACTED_GIT_TOKEN}`, origin: "o1" },
        { kind: "thinking_delta", text: `key ${REDACTED_API_KEY}!`, eventId: "e1" },
        { kind: "error", message: `boom ${REDACTED_GIT_TOKEN}` },
      ]);
      expect(JSON.stringify(got)).not.toContain(FAKE_TOKEN);
    }
  });

  it("ephemeral tool_output_delta（shell 实时输出）：chunk 脱敏，调用方手里的原对象不被改", async () => {
    await writeConfig({ gitToken: FAKE_TOKEN });
    await writeCompanyEnvFile(JSON.stringify({ pg: [{ password: FAKE_PG_PASSWORD }] }));
    const event: TaskEvent = {
      id: "ephemeral_tod_c1_1",
      ts: 1,
      kind: "tool_output_delta",
      text: "",
      meta: { callId: "c1", chunk: `${FAKE_TOKEN}\nPGPASSWORD=${FAKE_PG_PASSWORD}\n` },
    } as TaskEvent;
    publish(TASK, { kind: "event", event });

    const got = frames[0] as Extract<TaskStreamEvent, { kind: "event" }>;
    expect(got.event.meta).toEqual({
      callId: "c1",
      chunk: `${REDACTED_GIT_TOKEN}\nPGPASSWORD=${REDACTED_COMPANY_ENV}\n`,
    });
    expect(got.event.id).toBe("ephemeral_tod_c1_1");
    // 不原地改：调用方（shell-output-bridge）手里的对象保持原样
    expect((event.meta as { chunk: string }).chunk).toContain(FAKE_TOKEN);
    expect(JSON.stringify(tapFrames)).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(tapFrames)).not.toContain(FAKE_PG_PASSWORD);
  });

  it("没命中 / 没配凭据：同一个帧对象原样推送（零拷贝），其它帧种类不受影响", async () => {
    // 先没配
    const a: TaskStreamEvent = { kind: "assistant_delta", text: `plain ${FAKE_TOKEN}` };
    publish(TASK, a);
    expect(frames[0]).toBe(a);
    expect((frames[0] as { text: string }).text).toContain(FAKE_TOKEN);

    await writeConfig({ gitToken: FAKE_TOKEN });
    const clean: TaskStreamEvent = { kind: "assistant_delta", text: "没有凭据的正文" };
    const doneLike: TaskStreamEvent = { kind: "restricted_run", active: true };
    const tod: TaskStreamEvent = {
      kind: "event",
      event: {
        id: "ephemeral_tod_c2_1",
        ts: 1,
        kind: "tool_output_delta",
        text: "",
        meta: { callId: "c2", chunk: "clean output" },
      } as TaskEvent,
    };
    publish(TASK, clean);
    publish(TASK, doneLike);
    publish(TASK, tod);
    expect(frames.slice(1)).toEqual([clean, doneLike, tod]);
    expect(frames[1]).toBe(clean);
    expect(frames[3]).toBe(tod);
  });

  it("更换凭据后推流脱敏立刻跟上", async () => {
    await writeConfig({ gitToken: FAKE_TOKEN });
    publish(TASK, { kind: "assistant_delta", text: FAKE_TOKEN });
    const NEW_TOKEN = "glpat-NEWNEWNEWNEW0987654321";
    await writeConfig({ gitToken: NEW_TOKEN });
    publish(TASK, { kind: "assistant_delta", text: NEW_TOKEN });
    expect(frames.map((f) => (f as { text: string }).text)).toEqual([
      REDACTED_GIT_TOKEN,
      REDACTED_GIT_TOKEN,
    ]);
  });

  it("端到端：sdk-message-handler 的 assistant 增量（合帧后 flush）推到订阅端是占位符", async () => {
    await writeConfig({ gitToken: FAKE_TOKEN });
    await handleSdkMessage(
      TASK,
      {
        type: "assistant",
        message: { content: [{ type: "text", text: `jq 取到：${FAKE_TOKEN}` }] },
      } as never,
      { buffer: "", flush: async () => {} },
      () => true,
    );
    flushPendingAssistantDeltas(TASK);
    expect(frames).toEqual([
      { kind: "assistant_delta", text: `jq 取到：${REDACTED_GIT_TOKEN}` },
    ]);
  });

  describe("thinking 实时帧 / 快照", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      discardPendingThinkingDeltas(TASK);
    });
    afterEach(() => {
      discardPendingThinkingDeltas(TASK);
      vi.useRealTimers();
    });

    const think = (text: string) =>
      handleSdkMessage(
        TASK,
        { type: "thinking", text } as never,
        { buffer: "", flush: async () => {} },
        () => true,
      );

    it("thinking 帧与 watch-task bootstrap 用的快照都不含明文；token 跨两帧时快照（累积文本）仍能脱敏", async () => {
      await writeConfig({ gitToken: FAKE_TOKEN });
      const cut = 10;
      await think(`先取 token：${FAKE_TOKEN.slice(0, cut)}`);
      await think(`${FAKE_TOKEN.slice(cut)} 然后调接口`);
      await vi.advanceTimersByTimeAsync(THINKING_DELTA_INTERVAL_MS + 10);

      const snap = getLiveThinkingSnapshot(TASK);
      expect(snap).not.toBeNull();
      expect(snap!.text).not.toContain(FAKE_TOKEN);
      expect(snap!.text).toBe(`先取 token：${REDACTED_GIT_TOKEN} 然后调接口`);
    });

    it("token 完整落在单个 thinking 帧里：该帧直接是占位符", async () => {
      await writeConfig({ gitToken: FAKE_TOKEN });
      await think(`用 ${FAKE_TOKEN} 调 API`);
      const thinkingFrames = frames.filter((f) => f.kind === "thinking_delta") as Array<{
        text: string;
      }>;
      expect(thinkingFrames).toHaveLength(1);
      expect(thinkingFrames[0]!.text).toBe(`用 ${REDACTED_GIT_TOKEN} 调 API`);
    });
  });
});

describe("飞书群回复累积文本（R1-01：跨帧凭据）", () => {
  afterEach(async () => {
    __resetGroupReplyStateForTest();
    await clearCredentialFiles();
  });

  it("token 被切在两个 delta 里：累积的 answer 里是占位符，不是拼回来的明文", async () => {
    await writeConfig({ gitToken: FAKE_TOKEN });
    const handle = rememberGroupReply("t_group_redact", {
      chatId: "oc_x",
      requesterOpenId: "ou_z",
      requesterName: "张三",
      kind: "question",
      channel: "owner",
    });
    expect(handle).not.toBeNull();
    const cut = 9;
    appendGroupReplyAnswer("t_group_redact", null, `token 是 ${FAKE_TOKEN.slice(0, cut)}`);
    appendGroupReplyAnswer("t_group_redact", null, `${FAKE_TOKEN.slice(cut)}，请保密`);
    const entry = peekGroupReply("t_group_redact", null);
    expect(entry!.answer).toBe(`token 是 ${REDACTED_GIT_TOKEN}，请保密`);
  });
});

describe("redactSecretsInText / redactCopyIfHit（纯 helper）", () => {
  afterEach(clearCredentialFiles);

  it("没配凭据 / 没命中：返回原值（同一引用）", async () => {
    const obj = { a: "x" };
    expect(redactSecretsInText("hello")).toBe("hello");
    expect(redactCopyIfHit(obj)).toBe(obj);
    await writeConfig({ gitToken: FAKE_TOKEN });
    expect(redactSecretsInText("hello")).toBe("hello");
    expect(redactCopyIfHit(obj)).toBe(obj);
  });

  it("命中：文本替换；对象深拷贝后脱敏、原对象不变", async () => {
    await writeConfig({ gitToken: FAKE_TOKEN });
    expect(redactSecretsInText(`a${FAKE_TOKEN}b`)).toBe(`a${REDACTED_GIT_TOKEN}b`);
    const obj = { nested: { list: [FAKE_TOKEN] } };
    const copy = redactCopyIfHit(obj);
    expect(copy).not.toBe(obj);
    expect(copy.nested.list[0]).toBe(REDACTED_GIT_TOKEN);
    expect(obj.nested.list[0]).toBe(FAKE_TOKEN);
  });
});

describe("编码变体脱敏（第四轮 P3：URL 编码 / HTTP Basic base64）", () => {
  // 现实泄露路径：agent 跑 `GIT_TRACE_CURL=1 git …` / `curl -v` 会把
  // `Authorization: Basic base64(oauth2:<PAT>)` 打进输出；URL 里带口令时会被 URL 编码。
  // 精确值替换只认原样字节，这两种形态原先原样落进 events.jsonl / 推流。
  const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");
  const ENV_TOKEN = "glpat-ENVENVENVENV5555666677";
  const SPECIAL_PW = "p@ss/w0rd#FAKE:99?x"; // 含 @ / # : ? 的公司密码：URL 里必被编码
  const SPECIAL_KEY = "crsr_FAKE+key/0123=="; // 含 + / = 的 apiKey
  const ids: string[] = [];
  const ORIGINAL_ENV_TOKEN = process.env[GITLAB_TOKEN_ENV_NAME];
  const alloc = async (): Promise<string> => {
    const id = `t_redact_variant_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    await writeMeta(makeMeta(id));
    return id;
  };
  const rawEventsFile = async (id: string): Promise<string> =>
    fs.readFile(path.join(taskDir(id), EVENTS_FILE), "utf-8");
  const readLines = async (id: string): Promise<TaskEvent[]> =>
    (await rawEventsFile(id))
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as TaskEvent);

  afterEach(async () => {
    if (ORIGINAL_ENV_TOKEN === undefined) delete process.env[GITLAB_TOKEN_ENV_NAME];
    else process.env[GITLAB_TOKEN_ENV_NAME] = ORIGINAL_ENV_TOKEN;
    for (const id of ids.splice(0)) {
      clearEventSeqCounter(id);
      await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
    }
    await clearCredentialFiles();
  });

  it("curl -v / GIT_TRACE_CURL：Basic 头里 base64(oauth2:<PAT>) 落盘前被遮盖", async () => {
    await writeConfig({ gitToken: FAKE_TOKEN });
    const id = await alloc();
    const basic = b64(`oauth2:${FAKE_TOKEN}`);
    await appendEvent(id, {
      kind: "tool_result",
      text: `> GET /api/v4/projects HTTP/1.1\n> Authorization: Basic ${basic}\n> Accept: */*\n`,
    });
    const raw = await rawEventsFile(id);
    expect(raw).not.toContain(basic);
    expect(raw).not.toContain(FAKE_TOKEN);
    const [ev] = await readLines(id);
    expect(ev!.text).toBe(
      `> GET /api/v4/projects HTTP/1.1\n> Authorization: Basic ${REDACTED_GIT_TOKEN}\n> Accept: */*\n`,
    );
  });

  it("仅 token 自身的 base64（用户名留空 / echo -n $PAT | base64）也遮盖", async () => {
    await writeConfig({ gitToken: FAKE_TOKEN });
    const id = await alloc();
    const bare = b64(FAKE_TOKEN);
    await appendEvent(id, { kind: "tool_result", text: `Authorization: Basic ${bare}` });
    const raw = await rawEventsFile(id);
    expect(raw).not.toContain(bare);
    expect((await readLines(id))[0]!.text).toBe(`Authorization: Basic ${REDACTED_GIT_TOKEN}`);
  });

  it("进程 env 里的 PAT（会话启动优先用入口带来的 Token）的 Basic 头同样遮盖", async () => {
    process.env[GITLAB_TOKEN_ENV_NAME] = ENV_TOKEN;
    const id = await alloc();
    const basic = b64(`oauth2:${ENV_TOKEN}`);
    await appendEvent(id, { kind: "tool_result", text: `Authorization: Basic ${basic}` });
    expect(await rawEventsFile(id)).not.toContain(basic);
    expect((await readLines(id))[0]!.text).toBe(`Authorization: Basic ${REDACTED_GIT_TOKEN}`);
  });

  it("URL 里带口令（userinfo 被 URL 编码）：公司环境密码 / apiKey 的编码形态遮盖，占位符同原值", async () => {
    await writeConfig({
      apiKey: SPECIAL_KEY,
      companyEnv: { pg: [{ env: "test", host: "pg.internal", user: "ro", password: SPECIAL_PW }] },
    });
    const id = await alloc();
    const encPw = encodeURIComponent(SPECIAL_PW);
    const encKey = encodeURIComponent(SPECIAL_KEY);
    expect(encPw).not.toBe(SPECIAL_PW);
    expect(encKey).not.toBe(SPECIAL_KEY);
    await appendEvent(id, {
      kind: "tool_call",
      text: `psql "postgresql://ro:${encPw}@pg.internal:5432/app" && curl "https://x.example.com/?key=${encKey}"`,
    });
    const raw = await rawEventsFile(id);
    expect(raw).not.toContain(encPw);
    expect(raw).not.toContain(encKey);
    expect((await readLines(id))[0]!.text).toBe(
      `psql "postgresql://ro:${REDACTED_COMPANY_ENV}@pg.internal:5432/app" && curl "https://x.example.com/?key=${REDACTED_API_KEY}"`,
    );
  });

  it("原值本身（未编码）仍照常遮盖，原值与变体同一行都遮", async () => {
    await writeConfig({ gitToken: FAKE_TOKEN, companyEnv: { pg: [{ password: SPECIAL_PW }] } });
    const id = await alloc();
    await appendEvent(id, {
      kind: "tool_result",
      text: `${SPECIAL_PW} | ${encodeURIComponent(SPECIAL_PW)} | ${FAKE_TOKEN} | ${b64(`oauth2:${FAKE_TOKEN}`)}`,
    });
    expect((await readLines(id))[0]!.text).toBe(
      `${REDACTED_COMPANY_ENV} | ${REDACTED_COMPANY_ENV} | ${REDACTED_GIT_TOKEN} | ${REDACTED_GIT_TOKEN}`,
    );
  });

  it("实时推流（publish 唯一扇出点）：Basic 头 / URL 编码口令也被遮盖，ephemeral 帧不原地改", async () => {
    await writeConfig({
      gitToken: FAKE_TOKEN,
      companyEnv: { pg: [{ password: SPECIAL_PW }] },
    });
    const basic = b64(`oauth2:${FAKE_TOKEN}`);
    const encPw = encodeURIComponent(SPECIAL_PW);
    const got: TaskStreamEvent[] = [];
    const unsub = subscribeTaskStream("t_variant_stream", (ev) => got.push(ev));
    const event: TaskEvent = {
      id: "ephemeral_tod_v1_1",
      ts: 1,
      kind: "tool_output_delta",
      text: "",
      meta: { callId: "v1", chunk: `Authorization: Basic ${basic}\nurl=${encPw}\n` },
    } as TaskEvent;
    try {
      publish("t_variant_stream", { kind: "assistant_delta", text: `h: Basic ${basic}`, origin: "o1" });
      publish("t_variant_stream", { kind: "event", event });
    } finally {
      unsub();
    }
    expect(got[0]).toEqual({
      kind: "assistant_delta",
      text: `h: Basic ${REDACTED_GIT_TOKEN}`,
      origin: "o1",
    });
    const frame = got[1] as Extract<TaskStreamEvent, { kind: "event" }>;
    expect(frame.event.meta).toEqual({
      callId: "v1",
      chunk: `Authorization: Basic ${REDACTED_GIT_TOKEN}\nurl=${REDACTED_COMPANY_ENV}\n`,
    });
    expect((event.meta as { chunk: string }).chunk).toContain(basic);
    expect(redactSecretsInText(`x ${basic} y`)).toBe(`x ${REDACTED_GIT_TOKEN} y`);
  });

  it("没配凭据 / 无关的 base64 不误伤：同一引用原样返回", async () => {
    const unrelated = b64("oauth2:some-other-token-value-1234");
    expect(redactSecretsInText(`Basic ${unrelated}`)).toBe(`Basic ${unrelated}`);
    await writeConfig({ gitToken: FAKE_TOKEN });
    expect(redactSecretsInText(`Basic ${unrelated}`)).toBe(`Basic ${unrelated}`);
    const obj = { a: `Basic ${unrelated}` };
    expect(redactCopyIfHit(obj)).toBe(obj);
  });

  it("换了新 token：新值的变体立刻生效，旧值的变体不再脱敏（变体跟随凭据缓存）", async () => {
    const NEW_TOKEN = "glpat-NEWNEWNEWNEW0987654321";
    await writeConfig({ gitToken: FAKE_TOKEN });
    const oldBasic = b64(`oauth2:${FAKE_TOKEN}`);
    expect(redactSecretsInText(oldBasic)).toBe(REDACTED_GIT_TOKEN);

    await writeConfig({ gitToken: NEW_TOKEN });
    const newBasic = b64(`oauth2:${NEW_TOKEN}`);
    expect(redactSecretsInText(`${newBasic}|${oldBasic}`)).toBe(
      `${REDACTED_GIT_TOKEN}|${oldBasic}`,
    );
  });

  it("已知缺口（pin 住现状，日后补覆盖时同步改）：hex 编码 / 拆分打印不在覆盖范围", async () => {
    await writeConfig({ gitToken: FAKE_TOKEN });
    const hex = Buffer.from(FAKE_TOKEN, "utf8").toString("hex");
    expect(redactSecretsInText(`hex=${hex}`)).toBe(`hex=${hex}`);
    const cut = 10;
    const split = `${FAKE_TOKEN.slice(0, cut)} ${FAKE_TOKEN.slice(cut)}`;
    expect(redactSecretsInText(split)).toBe(split);
  });
});

describe("编码变体集合的构造与缓存（getEventRedactionReplacements）", () => {
  const b64 = (v: string): string => Buffer.from(v, "utf8").toString("base64");
  const ORIGINAL_ENV_TOKEN = process.env[GITLAB_TOKEN_ENV_NAME];

  afterEach(async () => {
    if (ORIGINAL_ENV_TOKEN === undefined) delete process.env[GITLAB_TOKEN_ENV_NAME];
    else process.env[GITLAB_TOKEN_ENV_NAME] = ORIGINAL_ENV_TOKEN;
    await clearCredentialFiles();
  });

  it("纯字母数字 PAT：只多出 2 个 Basic base64 变体（URL 编码后不变 → 不加）；apiKey 无变体", async () => {
    await writeConfig({ gitToken: FAKE_TOKEN, apiKey: FAKE_API_KEY });
    const got = getEventRedactionReplacements();
    expect(new Set(got.map((s) => s.value))).toEqual(
      new Set([FAKE_TOKEN, FAKE_API_KEY, b64(`oauth2:${FAKE_TOKEN}`), b64(FAKE_TOKEN)]),
    );
    // 变体与原值同占位符
    expect(got.find((s) => s.value === b64(`oauth2:${FAKE_TOKEN}`))!.placeholder).toBe(
      REDACTED_GIT_TOKEN,
    );
    expect(got.find((s) => s.value === b64(FAKE_TOKEN))!.placeholder).toBe(REDACTED_GIT_TOKEN);
    // apiKey 不加 base64（Basic 用户名不可枚举）
    expect(got.some((s) => s.value === b64(FAKE_API_KEY))).toBe(false);
    // 原值集合接口仍是原值（不含变体）
    expect(getEventRedactionSecrets().map((s) => s.value)).toEqual(
      [FAKE_TOKEN, FAKE_API_KEY].sort((a, b) => b.length - a.length),
    );
  });

  it("含特殊字符的凭据才多出 URL 编码变体；公司密码不加 base64", async () => {
    const PW = "p@ss/w0rd#FAKE:99?x";
    await writeConfig({
      companyEnv: { pg: [{ password: PW }], servers: [{ password: FAKE_SERVER_PASSWORD }] },
    });
    const values = getEventRedactionReplacements().map((s) => s.value);
    expect(new Set(values)).toEqual(
      new Set([PW, encodeURIComponent(PW), FAKE_SERVER_PASSWORD]),
    );
    expect(values).not.toContain(b64(PW));
    expect(
      getEventRedactionReplacements().find((s) => s.value === encodeURIComponent(PW))!
        .placeholder,
    ).toBe(REDACTED_COMPANY_ENV);
  });

  it("集合规模有上界：原值数 + gitToken×2 + 含特殊字符的凭据数，且每条都 ≥ 8 位", async () => {
    await writeConfig({
      gitToken: FAKE_TOKEN,
      apiKey: FAKE_API_KEY,
      companyEnv: {
        pg: [{ password: FAKE_PG_PASSWORD }, { password: "p@ss/w0rd#FAKE:99?x" }],
        servers: [{ password: FAKE_SERVER_PASSWORD }],
      },
    });
    const raw = getEventRedactionSecrets();
    expect(raw).toHaveLength(5);
    const got = getEventRedactionReplacements();
    expect(got).toHaveLength(raw.length + 2 + 1);
    expect(got.length).toBeLessThanOrEqual(raw.length * 3);
    expect(got.every((s) => s.value.length >= 8)).toBe(true);
    // 按长度降序（长值先换）
    for (let i = 1; i < got.length; i++) {
      expect(got[i - 1]!.value.length).toBeGreaterThanOrEqual(got[i]!.value.length);
    }
  });

  it("变体与另一个凭据的原值重复时：只留一条，原值的占位符优先", async () => {
    const A = "pass word 99"; // 含空格 → URL 编码 pass%20word%2099
    const B = encodeURIComponent(A); // 恰好是另一个凭据（apiKey）的原值
    await writeConfig({ apiKey: B, companyEnv: { pg: [{ password: A }] } });
    const got = getEventRedactionReplacements();
    // A 的 URL 编码变体 === B 的原值：不重复加；B 自己含 `%`，它的 URL 编码是另一条正常变体
    expect(got.map((s) => s.value).sort()).toEqual([A, B, encodeURIComponent(B)].sort());
    expect(got.filter((s) => s.value === B)).toHaveLength(1);
    expect(got.find((s) => s.value === B)!.placeholder).toBe(REDACTED_API_KEY);
    expect(got.find((s) => s.value === encodeURIComponent(B))!.placeholder).toBe(
      REDACTED_API_KEY,
    );
  });

  it("缓存：凭据没变 → 同一个数组引用（热路径不重复编码 / 排序）；凭据 / env 变了 → 重算", async () => {
    await writeConfig({ gitToken: FAKE_TOKEN });
    const first = getEventRedactionReplacements();
    expect(getEventRedactionReplacements()).toBe(first);
    expect(getEventRedactionReplacements()).toBe(first);

    await writeConfig({ gitToken: "glpat-NEWNEWNEWNEW0987654321" });
    const second = getEventRedactionReplacements();
    expect(second).not.toBe(first);
    expect(getEventRedactionReplacements()).toBe(second);

    process.env[GITLAB_TOKEN_ENV_NAME] = "glpat-ENVENVENVENV5555666677";
    const third = getEventRedactionReplacements();
    expect(third).not.toBe(second);
    expect(third.some((s) => s.value === b64("oauth2:glpat-ENVENVENVENV5555666677"))).toBe(true);
    expect(getEventRedactionReplacements()).toBe(third);
  });

  it("没有任何凭据：空集合（redact 入口零开销）", () => {
    expect(getEventRedactionReplacements()).toEqual([]);
  });

  it("JSON 转义形态在构造时预算：含引号 / 反斜杠的原值照样能在序列化行里检出，变体不带转义", async () => {
    const weird = 'tok"en\\with-special-chars';
    await writeConfig({ gitToken: weird });
    const got = getEventRedactionReplacements();
    const rawEntry = got.find((s) => s.value === weird)!;
    expect(rawEntry.escaped).toBe(JSON.stringify(weird).slice(1, -1));
    // base64 / URL 编码形态里没有需要 JSON 转义的字符
    for (const s of got.filter((x) => x.value !== weird)) expect(s.escaped).toBe("");
    const line = JSON.stringify({ text: `v=${weird}` });
    expect(line.includes(weird)).toBe(false);
    expect(lineContainsSecret(line, got)).toBe(true);
    // 事件落盘入口：转义形态命中 → 脱敏
    const ev = { text: `v=${weird} Basic ${b64(`oauth2:${weird}`)}` };
    expect(serializeEventLineRedacted(ev)).not.toContain("with-special-chars");
    expect(ev.text).toBe(`v=${REDACTED_GIT_TOKEN} Basic ${REDACTED_GIT_TOKEN}`);
  });

  it("畸形 UTF-16（落单代理对）的值：encodeURIComponent 会抛，不能带崩值集合", async () => {
    const lone = "pass-\ud800-lone-surrogate-FAKE";
    await writeConfig({ companyEnv: { pg: [{ password: lone }] } });
    expect(() => getEventRedactionReplacements()).not.toThrow();
    expect(getEventRedactionReplacements().map((s) => s.value)).toEqual([lone]);
  });
});
