/**
 * 事件脱敏值集合纳入 MCP 凭据（server 安全审计）
 *
 * 缺口：值集合只有 gitToken / apiKey / customProviders[].apiKey / companyEnv。
 * `settings.mcpServers` 里的 headers（`Authorization: Bearer …`、`X-API-Key`）/ env（`*_TOKEN`、`*_SECRET`）
 * 与落盘的 MCP OAuth token（`<dataRoot>/mcp-oauth/*.json` 的 access / refresh token）都不在集合里：
 * agent `cat config.json` / `printenv` / 打印 MCP 报错时明文进 events.jsonl 与 SSE / 飞书回流。
 *
 * 口径：只收「键名像凭据」的值（不是整个 headers / env 一锅端），长度 < 8 / 环境变量引用 / `*_URL` 类不收，
 * 避免 `production` / `true` / `application/json` 满屏误码。
 *
 * 全程假凭据（运行时拼接）+ 临时数据目录，绝不碰真实配置。
 */
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  REDACTED_MCP_SECRET,
  getEventRedactionSecrets,
  redactSecretsInText,
} from "@/lib/server/event-secret-redact";

/** 运行时拼接的假值：源码里不出现完整的密钥形态 */
const fake = (tag: string): string => ["fake", tag, "value", "0123456789"].join("-");

const HDR_BEARER = fake("hdr-bearer");
const HDR_APIKEY = fake("hdr-apikey");
const ENV_TOKEN = fake("env-token");
const ENV_SECRET = fake("env-secret");
const OAUTH_ACCESS = fake("oauth-access");
const OAUTH_REFRESH = fake("oauth-refresh");
const OAUTH_NEW_ACCESS = fake("oauth-access-rotated");

let root: string;
let dataDir: string;
let savedDataDir: string | undefined;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "flowship-redact-mcp-"));
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

const writeConfig = (cfg: unknown): void => {
  writeFileSync(
    path.join(dataDir, "config.json"),
    `${JSON.stringify(cfg, null, 2)}\n`,
    "utf-8",
  );
};

const oauthDir = (): string => path.join(dataDir, "mcp-oauth");
const writeOAuthRecord = (name: string, rec: unknown): void => {
  mkdirSync(oauthDir(), { recursive: true });
  writeFileSync(path.join(oauthDir(), name), JSON.stringify(rec, null, 2), "utf-8");
};

describe("settings.mcpServers 的 headers / env", () => {
  it("凭据类键名的值被抹掉；Bearer 前缀的整串与令牌本身都抹", () => {
    writeConfig({
      mcpServers: {
        remote: {
          url: "https://mcp.example.com/sse",
          headers: {
            Authorization: `Bearer ${HDR_BEARER}`,
            "X-API-Key": HDR_APIKEY,
          },
        },
        local: {
          command: "node",
          args: ["server.js"],
          env: { SERVICE_TOKEN: ENV_TOKEN, CLIENT_SECRET: ENV_SECRET },
        },
      },
    });
    const text = [
      `Authorization: Bearer ${HDR_BEARER}`,
      `token only ${HDR_BEARER}`,
      `key ${HDR_APIKEY}`,
      `SERVICE_TOKEN=${ENV_TOKEN}`,
      `CLIENT_SECRET=${ENV_SECRET}`,
    ].join("\n");
    const out = redactSecretsInText(text);
    for (const v of [HDR_BEARER, HDR_APIKEY, ENV_TOKEN, ENV_SECRET]) {
      expect(out).not.toContain(v);
    }
    expect(out).toContain(REDACTED_MCP_SECRET);
  });

  it("不误伤：普通 env / 头、短值、环境变量引用、*_URL 类键名、非字符串值都不进集合", () => {
    writeConfig({
      mcpServers: {
        s: {
          command: "node",
          env: {
            NODE_ENV: "production", // 键名不像凭据
            DEBUG: "true",
            PORT: "8080",
            API_TOKEN: "short", // < 8 位
            REF_TOKEN: "${MY_REAL_TOKEN}", // 环境变量引用
            REF2_TOKEN: "$MY_REAL_TOKEN2",
            REF3_TOKEN: "${env:MY_REAL_TOKEN3}",
            TOKEN_URL: "https://auth.example.com/oauth/token", // 地址不是秘密
            API_KEY_FILE: "/home/user/.keys/api-key.txt",
            TOKEN_EXPIRES: "3600000000",
            RETRIES: 3,
          },
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "User-Agent": "flowship-mcp-client/1.0",
          },
        },
      },
    });
    expect(getEventRedactionSecrets()).toEqual([]);
    const text =
      "NODE_ENV=production DEBUG=true Content-Type: application/json https://auth.example.com/oauth/token /home/user/.keys/api-key.txt";
    expect(redactSecretsInText(text)).toBe(text);
  });

  it("形状不对（mcpServers 是数组 / server 不是对象 / headers 是数组）不抛、不收", () => {
    writeConfig({ mcpServers: [{ headers: { Authorization: "Bearer xxxxxxxx-yyyyyyyy" } }] });
    expect(getEventRedactionSecrets()).toEqual([]);
    writeConfig({ mcpServers: { a: null, b: "str", c: { headers: ["Bearer abcdefghijkl"], env: 5 } } });
    expect(getEventRedactionSecrets()).toEqual([]);
  });
});

describe("落盘的 MCP OAuth token", () => {
  const record = (access: string, refresh: string) => ({
    serverName: "feishu-project",
    serverUrl: "https://mcp.example.com/mcp",
    tokens: { access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: 3600 },
    obtainedAt: 1,
    codeVerifier: "verifier-not-collected-01",
  });

  it("access / refresh token 被抹掉", () => {
    writeOAuthRecord("a.json", record(OAUTH_ACCESS, OAUTH_REFRESH));
    const out = redactSecretsInText(`a=${OAUTH_ACCESS} r=${OAUTH_REFRESH}`);
    expect(out).not.toContain(OAUTH_ACCESS);
    expect(out).not.toContain(OAUTH_REFRESH);
    expect(out).toContain(REDACTED_MCP_SECRET);
  });

  it("续期 / 新授权后（目录内文件被原子替换）新 token 立刻被抹；旧 token 清除后不再抹", () => {
    writeOAuthRecord("a.json", record(OAUTH_ACCESS, OAUTH_REFRESH));
    expect(redactSecretsInText(OAUTH_ACCESS)).not.toContain(OAUTH_ACCESS); // 先读成功一次、进缓存

    // 新增另一个 server 的记录（目录变了）→ 立刻生效
    writeOAuthRecord("b.json", record(OAUTH_NEW_ACCESS, OAUTH_REFRESH));
    expect(redactSecretsInText(OAUTH_NEW_ACCESS)).not.toContain(OAUTH_NEW_ACCESS);

    // 删掉 a.json：旧值不再脱敏（不残留陈旧缓存）
    unlinkSync(path.join(oauthDir(), "a.json"));
    expect(redactSecretsInText(OAUTH_ACCESS)).toBe(OAUTH_ACCESS);
    expect(redactSecretsInText(OAUTH_NEW_ACCESS)).not.toContain(OAUTH_NEW_ACCESS);
  });

  it("同名记录被 tmp + rename 原子覆盖（token 续期的真实写法）：新 token 立刻被抹", () => {
    writeOAuthRecord("a.json", record(OAUTH_ACCESS, OAUTH_REFRESH));
    expect(redactSecretsInText(OAUTH_ACCESS)).not.toContain(OAUTH_ACCESS); // 先进缓存
    const tmp = path.join(oauthDir(), ".a.json.tmp-1");
    writeFileSync(tmp, JSON.stringify(record(OAUTH_NEW_ACCESS, OAUTH_REFRESH)), "utf-8");
    renameSync(tmp, path.join(oauthDir(), "a.json"));
    expect(redactSecretsInText(OAUTH_NEW_ACCESS)).not.toContain(OAUTH_NEW_ACCESS);
  });

  it("DCR 的 client_secret 也收；codeVerifier 不收；损坏的 JSON / 非 json 文件被跳过、不影响好文件", () => {
    const secret = fake("dcr-client-secret");
    writeOAuthRecord("a.json", {
      ...record(OAUTH_ACCESS, OAUTH_REFRESH),
      client: { client_id: "cid", client_secret: secret },
    });
    mkdirSync(oauthDir(), { recursive: true });
    writeFileSync(path.join(oauthDir(), "bad.json"), "{not json", "utf-8");
    writeFileSync(path.join(oauthDir(), "note.txt"), OAUTH_NEW_ACCESS, "utf-8");
    const out = redactSecretsInText(`${secret} ${OAUTH_ACCESS} verifier-not-collected-01 ${OAUTH_NEW_ACCESS}`);
    expect(out).not.toContain(secret);
    expect(out).not.toContain(OAUTH_ACCESS);
    expect(out).toContain("verifier-not-collected-01");
    expect(out).toContain(OAUTH_NEW_ACCESS); // note.txt 不是记录文件
  });

  it("没有 mcp-oauth 目录 = 没配：空集合、不抛", () => {
    expect(getEventRedactionSecrets()).toEqual([]);
  });

  it("热路径：凭据没变时重复调用返回同一个数组引用（缓存生效，不重复读目录）", () => {
    writeOAuthRecord("a.json", record(OAUTH_ACCESS, OAUTH_REFRESH));
    const first = getEventRedactionSecrets();
    expect(first.length).toBeGreaterThan(0);
    for (let i = 0; i < 5; i++) expect(getEventRedactionSecrets()).toBe(first);
  });
});

// ---------- 第 2 轮复审：URL 形态的值 / 键名补全 / Bearer 引用误报 ----------

const setServers = (servers: unknown): void => writeConfig({ mcpServers: servers });

describe("URL 形态的值：只抽 userinfo 密码与凭据名 query 参数，不收整条 URL", () => {
  it("DATABASE_URL / REDIS_URL（被 *_URL 后缀豁免的键）里的 userinfo 密码被抹，主机 / 库名 / 用户名不动", () => {
    const pw = fake("db-pw");
    const rpw = fake("redis-pw");
    setServers({
      s: {
        command: "node",
        env: {
          DATABASE_URL: `postgres://app_user:${pw}@db.internal:5432/appdb`,
          REDIS_URL: `rediss://:${rpw}@cache.internal:6379/0`,
        },
      },
    });
    const text = `DATABASE_URL=postgres://app_user:${pw}@db.internal:5432/appdb REDIS_URL=rediss://:${rpw}@cache.internal:6379/0`;
    const out = redactSecretsInText(text);
    expect(out).not.toContain(pw);
    expect(out).not.toContain(rpw);
    expect(out).toContain("postgres://app_user:");
    expect(out).toContain("@db.internal:5432/appdb");
    expect(out).toContain("@cache.internal:6379/0");
    expect(out).toContain(REDACTED_MCP_SECRET);
  });

  it("密码里有百分号编码：编码前后两种写法都被抹", () => {
    const decoded = `${fake("enc-pw")}@#/x`;
    const encoded = encodeURIComponent(decoded);
    expect(encoded).not.toBe(decoded);
    setServers({ s: { env: { DB_URL: `mysql://u:${encoded}@h.internal/db` } } });
    const out = redactSecretsInText(`a=${encoded} b=${decoded}`);
    expect(out).not.toContain(encoded);
    expect(out).not.toContain(decoded);
  });

  it("server 顶层 url 与 headers / env 里的 URL：`?token=` / `?key=` / `?api_key=` / `?sig=` 的值被抹，其它参数与地址不动", () => {
    const t1 = fake("q-token");
    const t2 = fake("q-key");
    const t3 = fake("q-apikey");
    const t4 = fake("q-sig");
    setServers({
      remote: {
        url: `https://mcp.example.com/sse?token=${t1}&mode=full-duplex-mode`,
        headers: { "X-Callback-Url": `https://hook.example.com/cb?key=${t2}&page=2` },
        env: {
          UPSTREAM_ENDPOINT: `https://up.example.com/v1?api_key=${t3}`,
          SIGNED_URL: `https://cdn.example.com/f?Expires=1&sig=${t4}#frag`,
        },
      },
    });
    const out = redactSecretsInText([t1, t2, t3, t4].join(" ") + " mode=full-duplex-mode page=2 https://mcp.example.com/sse");
    for (const v of [t1, t2, t3, t4]) expect(out).not.toContain(v);
    expect(out).toContain("mode=full-duplex-mode");
    expect(out).toContain("page=2");
    expect(out).toContain("https://mcp.example.com/sse");
  });

  it("不收整条 URL：无 userinfo 密码、无凭据名参数的 URL（含 *_URL 键与普通键）→ 集合为空", () => {
    setServers({
      s: {
        url: "https://mcp.example.com/sse?mode=full&page=2&q=search-things-here",
        env: {
          DATABASE_URL: "postgres://app_user@db.internal:5432/appdb", // 只有用户名
          TOKEN_URL: "https://auth.example.com/oauth/token",
          HOMEPAGE: "https://example.com/some/long/path?utm_source=newsletter-campaign",
        },
      },
    });
    expect(getEventRedactionSecrets()).toEqual([]);
  });

  it("密码 / 参数值是环境变量引用（含被百分号编码的 ${VAR}）→ 不收", () => {
    setServers({
      s: {
        url: "https://mcp.example.com/sse?token=${MCP_TOKEN}&key=$MCP_KEY",
        env: {
          A_URL: "postgres://u:${DB_PASSWORD}@h.internal/db",
          B_URL: "postgres://u:%24%7BDB_PASSWORD%7D@h.internal/db",
          C_URL: "https://x.example.com/p?secret=%TOKEN_FROM_ENV%",
        },
      },
    });
    expect(getEventRedactionSecrets()).toEqual([]);
  });
});

describe("键名补全：裸 *_KEY / session / jwt / dsn / 驼峰词尾", () => {
  it("MAPS_KEY / X-Session / SESSION_ID / JWT / SENTRY_DSN / appKey / sessionId 的值被抹", () => {
    const vals = {
      MAPS_KEY: fake("maps-key"),
      "X-Session": fake("x-session"),
      SESSION_ID: fake("session-id"),
      JWT: fake("jwt-bare"),
      SENTRY_DSN: fake("sentry-dsn"),
      appKey: fake("camel-appkey"),
      sessionId: fake("camel-sessionid"),
    };
    setServers({ s: { env: vals } });
    const out = redactSecretsInText(Object.values(vals).join(" | "));
    for (const v of Object.values(vals)) expect(out).not.toContain(v);
  });

  it("不误伤：KEY_FILE / KEY_PATH / KEY_NAME / KEYBOARD_LAYOUT / MONKEY 不收（后缀豁免 / 无词边界）", () => {
    setServers({
      s: {
        env: {
          KEY_FILE: "/home/user/.keys/id_rsa_work_laptop",
          KEY_PATH: "/home/user/.keys/id_rsa_work_laptop",
          PRIMARY_KEY_NAME: "primary-key-name-long",
          KEYBOARD_LAYOUT: "dvorak-programmer-layout",
          MONKEY: "monkey-business-long-value",
          Dsnotes: "not-a-dsn-just-notes-text",
        },
      },
    });
    expect(getEventRedactionSecrets()).toEqual([]);
  });
});

describe("Bearer / Basic 后接环境变量引用：不是明文，不收", () => {
  it("`Bearer ${TOKEN}` / `Bearer $TOKEN` / `Basic %TOKEN%` / 整值 `%TOKEN%` → 集合为空，字面量不被涂", () => {
    setServers({
      s: {
        headers: {
          Authorization: "Bearer ${MCP_API_TOKEN}",
          "X-Auth": "Basic %MCP_BASIC_AUTH%",
          "X-Alt-Token": "Bearer $MCP_ALT_TOKEN",
        },
        env: { WIN_STYLE_TOKEN: "%MCP_WIN_TOKEN%" },
      },
    });
    expect(getEventRedactionSecrets()).toEqual([]);
    const text = "Authorization: Bearer ${MCP_API_TOKEN} and Basic %MCP_BASIC_AUTH%";
    expect(redactSecretsInText(text)).toBe(text);
  });

  it("真实令牌的 Bearer 仍然整串 + 令牌本身都收（回归）", () => {
    const tok = fake("real-bearer");
    setServers({ s: { headers: { Authorization: `Bearer ${tok}` } } });
    const out = redactSecretsInText(`Bearer ${tok} / ${tok}`);
    expect(out).not.toContain(tok);
  });
});

// ---------- 第 4 轮：mcpServers.<x>.args / 查询参数 sign ----------

describe("mcpServers.args：URL 参数 / 凭据旗标 / KEY=VALUE / --header", () => {
  const redact = (secrets: string[], extra = ""): string => redactSecretsInText(`${secrets.join(" | ")} ${extra}`);

  it("URL 形态参数：`server-postgres` 的连接串 userinfo 密码被抹，主机 / 库名 / 用户名不动", () => {
    const pw = fake("args-pg-pw");
    setServers({
      pg: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-postgres", `postgresql://app_user:${pw}@db.internal:5432/appdb`],
      },
    });
    const out = redact([pw], "postgresql://app_user:x@db.internal:5432/appdb");
    expect(out).not.toContain(pw);
    expect(out).toContain("db.internal:5432/appdb");
    expect(out).toContain("app_user");
  });

  it("单项里带空白（`sh -c` 字符串）：`npx server-postgres postgresql://u:p@h/db --token abc…` 里的 URL 密码与旗标值都抹", () => {
    const pw = fake("args-shell-pw");
    const tok = fake("args-shell-token");
    setServers({
      s: { command: "sh", args: ["-c", `npx server-postgres postgresql://u:${pw}@h.internal/db --token ${tok} --verbose`] },
    });
    const out = redact([pw, tok]);
    expect(out).not.toContain(pw);
    expect(out).not.toContain(tok);
  });

  it("URL 参数里的凭据名 query 参数被抹（token / key / sign / Signature / SIGN），其它参数与地址不动", () => {
    const vals = [fake("a-token"), fake("a-key"), fake("a-sign"), fake("a-Signature"), fake("a-SIGN")];
    setServers({
      s: {
        args: [
          `https://mcp.example.com/sse?token=${vals[0]}&mode=full-duplex-mode`,
          `https://x.example.com/p?key=${vals[1]}&sign=${vals[2]}`,
          `https://y.example.com/p?Signature=${vals[3]}&SIGN=${vals[4]}&page=2`,
        ],
      },
    });
    const out = redact(vals, "mode=full-duplex-mode page=2 https://mcp.example.com/sse");
    for (const v of vals) expect(out).not.toContain(v);
    expect(out).toContain("mode=full-duplex-mode");
    expect(out).toContain("page=2");
  });

  it("凭据名旗标：`--api-key X`（下一项）/ `--token=X` / `--password X` / `--client-secret=X` / `--auth X` / `--access-token X` 的值被抹", () => {
    const v = {
      apiKey: fake("flag-apikey"),
      token: fake("flag-token"),
      password: fake("flag-password"),
      secret: fake("flag-secret"),
      auth: fake("flag-auth"),
      access: fake("flag-access"),
    };
    setServers({
      s: {
        args: [
          "--api-key", v.apiKey,
          `--token=${v.token}`,
          "--password", v.password,
          `--client-secret=${v.secret}`,
          "--auth", v.auth,
          "--access-token", v.access,
        ],
      },
    });
    const out = redact(Object.values(v));
    for (const x of Object.values(v)) expect(out).not.toContain(x);
  });

  it("值带引号 / 带空白：`--password=\"a b c…\"`、`[\"--password\", \"a b c…\"]` 整个值被抹", () => {
    const spaced = "correct horse battery staple 0123";
    const spaced2 = "another long pass phrase 4567";
    setServers({ s: { args: ["--password", spaced, `--secret="${spaced2}"`] } });
    const out = redact([spaced, spaced2]);
    expect(out).not.toContain(spaced);
    expect(out).not.toContain(spaced2);
  });

  it("KEY=VALUE（`-e API_TOKEN=X` / `DATABASE_URL=postgres://u:PW@h/db`）与 `--url=…?token=`", () => {
    const tk = fake("kv-token");
    const pw = fake("kv-dbpw");
    const q = fake("kv-urlq");
    setServers({
      s: {
        args: ["run", "-e", `API_TOKEN=${tk}`, "-e", `DATABASE_URL=postgres://u:${pw}@h.internal/db`, `--url=https://h.example.com/sse?token=${q}`],
      },
    });
    const out = redact([tk, pw, q], "h.internal/db https://h.example.com/sse");
    for (const x of [tk, pw, q]) expect(out).not.toContain(x);
    expect(out).toContain("h.internal/db");
  });

  it("--header / -H 的下一项 `Name: value`（mcp-remote 风格）：Bearer 令牌与 API key 被抹；`--header=Authorization: Bearer X` 整项形态也抹", () => {
    const b1 = fake("hdr-bearer-a");
    const k1 = fake("hdr-key-a");
    const b2 = fake("hdr-bearer-b");
    setServers({
      s: {
        args: [
          "mcp-remote", "https://mcp.example.com/sse",
          "--header", `Authorization: Bearer ${b1}`,
          "-H", `X-API-Key: ${k1}`,
          `--header=Authorization: Bearer ${b2}`,
        ],
      },
    });
    const out = redact([b1, k1, b2]);
    for (const x of [b1, k1, b2]) expect(out).not.toContain(x);
  });

  it("不误伤：--key-file / --keyboard-layout / --token-url / --password-file / --api-key-name / 布尔旗标 / 普通参数 → 集合为空", () => {
    setServers({
      s: {
        args: [
          "--key-file", "/home/user/.keys/id_rsa_work_laptop",
          "--keyboard-layout", "dvorak-programmer-layout",
          "--token-url", "https://auth.example.com/oauth/token",
          "--password-file=/home/user/.secrets/db-password.txt",
          "--api-key-name", "production-key-name",
          "--session-timeout", "86400000",
          "--auth-method", "client_secret_basic",
          "--verbose", "--port", "8080",
          "server.js", "--config", "/etc/app/config.json",
          "https://mcp.example.com/sse?mode=full&page=2",
          "postgresql://app_user@db.internal:5432/appdb",
          "NODE_ENV=production", "DEBUG=true",
        ],
      },
    });
    expect(getEventRedactionSecrets()).toEqual([]);
  });

  it("不收：值是 $VAR / ${VAR} / %VAR% 引用；凭据旗标后面直接跟另一个旗标（没带值）；Bearer ${TOKEN}", () => {
    setServers({
      s: {
        args: [
          "--token", "${MCP_TOKEN}",
          "--password=$DB_PASSWORD",
          "--secret", "%MCP_SECRET%",
          "--api-key", "--verbose", // --api-key 没带值
          "--header", "Authorization: Bearer ${MCP_TOKEN}",
          "-e", "API_TOKEN=${API_TOKEN}",
          "postgresql://u:${DB_PASSWORD}@h.internal/db",
          "https://h.example.com/sse?token=${MCP_TOKEN}",
        ],
      },
    });
    expect(getEventRedactionSecrets()).toEqual([]);
  });

  it("令牌放在 URL 用户名位置（`https://<令牌>@host`，没有密码段）：令牌被抹；像账号名的用户名（短 / 纯字母）不动", () => {
    const pat = fake("userinfo-pat");
    setServers({
      s: {
        args: [`https://${pat}@git.internal.example.com/org/repo.git`, "ssh://deploy_user@bastion.internal", "postgres://app_user:x@h/db"],
      },
    });
    const out = redact([pat], "deploy_user app_user");
    expect(out).not.toContain(pat);
    expect(out).toContain("deploy_user");
    expect(out).toContain("app_user");
  });

  it("`--env=API_TOKEN=X`（值本身是 KEY=VALUE）按 KEY 判定；`--env=LOG_LEVEL=verbose-debug-0123` 不是凭据不收", () => {
    const tk = fake("envflag-token");
    setServers({ s: { args: [`--env=API_TOKEN=${tk}`, "--env=LOG_LEVEL=verbose-debug-0123"] } });
    const out = redact([tk], "verbose-debug-0123");
    expect(out).not.toContain(tk);
    expect(out).toContain("verbose-debug-0123");
  });

  it("curl 风格 basic auth：`-u user:PW`（下一项）/ `--user=user:PW` / `--proxy-user user:PW` 只抹冒号后的密码；没有冒号的 `--user alice-long-name` 不收", () => {
    const a = fake("basic-a");
    const b = fake("basic-b");
    const c = fake("basic-c");
    setServers({
      s: { command: "curl", args: ["-u", `admin:${a}`, `--user=svc:${b}`, "--proxy-user", `px:${c}`, "--user", "alice-long-name-0123"] },
    });
    const out = redact([a, b, c], "admin svc px alice-long-name-0123");
    for (const v of [a, b, c]) expect(out).not.toContain(v);
    expect(out).toContain("alice-long-name-0123");
    expect(out).toContain("admin");
  });

  it("`-u` / `--user` 只在 curl 类上下文里按 basic auth 收：命令是 curl、或 `sh -c \"curl -u …\"`；docker 的 `-u appuser:appgroup-long` 是 user:group，不当密码", () => {
    const a = fake("basic-sh");
    setServers({
      d: { command: "docker", args: ["run", "-u", "appuser:appgroup-long-name", "--user", "www-data:www-data-group", "img"] },
      c: { command: "sh", args: ["-c", `curl -u admin:${a} https://example.internal/x`] },
    });
    const out = redact([a], "appgroup-long-name www-data-group");
    expect(out).not.toContain(a);
    expect(out).toContain("appgroup-long-name");
    expect(out).toContain("www-data-group");
  });

  it("令牌在 URL 用户名位置、密码是占位字面量（`https://<PAT>:x-oauth-basic@host`、`oauth2` / `x-access-token`）：令牌被抹，占位字面量本身不是秘密", () => {
    const p1 = fake("gh-pat-one");
    const p2 = fake("gh-pat-two");
    setServers({
      s: { args: [`https://${p1}:x-oauth-basic@github.com/o/r.git`, `https://${p2}:x-access-token@github.com/o/r.git`] },
    });
    const out = redact([p1, p2], "github.com");
    expect(out).not.toContain(p1);
    expect(out).not.toContain(p2);
    expect(out).toContain("github.com");
  });

  it("形状不对（args 不是数组 / 元素非字符串 / 超长元素 / 超过数量上限之后的元素）不抛、不收", () => {
    const tok = fake("cap-token");
    setServers({
      a: { args: "--token abcdefghijkl" },
      b: { args: [1, null, { x: 1 }, ["--token", "nested-array-value-1234"]] },
      c: { args: ["--token", `${"x".repeat(70_000)}`] }, // 超长值整项跳过
      d: { args: [...Array.from({ length: 300 }, () => "--verbose"), "--token", tok] }, // 数量上限之后的不看
    });
    expect(getEventRedactionSecrets()).toEqual([]);
  });

  it("线性复杂度：5 万字符的畸形单项（海量引号 / 空白 / 等号 / 冒号）秒级处理完，不挂", () => {
    const evil = `${'"\' ='.repeat(8_000)}http://${":@/".repeat(5_000)}`;
    setServers({ s: { args: ["-c", evil, `--token=${"=".repeat(40_000)}`] } });
    const t0 = Date.now();
    getEventRedactionSecrets();
    expect(Date.now() - t0).toBeLessThan(3_000);
  });
});

describe("query 参数 `sign` / `signature`（含大小写变体）", () => {
  it("env / headers / 顶层 url 里的 URL：`?sign=` / `?Sign=` / `?SIGN=` / `?signature=` / `?Signature=` 的值都被抹；`design=` / `signal=` 不抹", () => {
    const v = [fake("s-sign"), fake("s-Sign"), fake("s-SIGN"), fake("s-signature"), fake("s-Signature")];
    const keep = fake("s-design");
    setServers({
      s: {
        url: `https://a.example.com/p?sign=${v[0]}&Sign=${v[1]}&design=${keep}`,
        env: { CB_URL: `https://b.example.com/p?SIGN=${v[2]}&signal=${keep}`, SIGNED_URL: `https://c.example.com/p?signature=${v[3]}&Signature=${v[4]}` },
      },
    });
    const out = redactSecretsInText([...v, keep].join(" | "));
    for (const x of v) expect(out).not.toContain(x);
    expect(out).toContain(keep);
  });
});
