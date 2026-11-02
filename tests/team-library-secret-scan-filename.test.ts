/**
 * 团队库上传：文件名策略 + 值形态规则补充（上传前敏感扫描审计）
 *
 * 症状：上传 / 推送前只扫「文本内容」——`.env`、`id_rsa`、`.p12`、`.pem`、`.zip` 这类文件名本身就是敏感载体的东西：
 * 二进制（p12 / zip）整个被 decodeForScan 判成不扫；文本的 `.env` 若内容恰好不命中规则也照传。
 * 另外值形态规则缺 JWT / `AIza` / `sk_live_` / `npm_` / `LTAI` / `AKID`。
 *
 * 修法：
 * - `classifySensitiveFilename` / `scanSensitiveFilenames`：命中即出 `sensitive-file` 命中，走同一套 force 闸门与 UI 列表；
 * - `commitAndPush` 里把「全部 staged 路径」（含二进制）交给文件名策略；
 * - KNOWN_TOKEN_RULES 加六条前缀特异 + 定长规则，正例报、反例（长度不对 / test 模式 / 环境变量名 / 官方示例）不报。
 *
 * 假密钥一律运行时拼接，避免仓库自己的密钥扫描报警。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  syncTeamLibrary,
  uploadSkillsToTeamLibrary,
} from "@/lib/server/team-library";
import {
  classifySensitiveFilename,
  gateSensitiveUpload,
  scanSensitiveFilenames,
  scanSensitiveFiles,
} from "@/lib/server/team-library-secret-scan";
import { setupTeamLibraryE2E } from "./helpers/team-library-e2e";

const T = 60_000;

/** 运行时拼接，源码里不出现完整的密钥形态 */
const cat = (...parts: string[]): string => parts.join("");
const rep = (unit: string, n: number): string => unit.repeat(n);

describe("classifySensitiveFilename：命中", () => {
  const SHOULD_HIT: Array<[string, RegExp]> = [
    [".env", /\.env/],
    ["skills/qa/demo/.env", /\.env/],
    [".env.production", /\.env/],
    [".env.local", /\.env/],
    ["config/prod.env", /\.env/],
    [".ENV", /\.env/], // 大小写不敏感
    ["skills/x/id_rsa", /SSH/],
    ["id_ed25519", /SSH/],
    ["id_ecdsa", /SSH/],
    ["id_dsa", /SSH/],
    ["keys/id_rsa_deploy", /SSH/],
    ["ID_RSA", /SSH/],
    ["a/server.pem", /\.pem/],
    ["a/private.key", /\.key/],
    ["cert.p12", /\.p12/],
    ["cert.PFX", /\.pfx/],
    ["release.jks", /\.jks/],
    ["release.keystore", /\.keystore/],
    ["putty.ppk", /\.ppk/],
    ["AuthKey_ABC123.p8", /\.p8/],
    ["a/credentials", /credentials/],
    [".aws/credentials", /credentials/],
    ["credentials.json", /credentials/],
    ["Credentials.YAML", /credentials/],
    [".netrc", /凭据/],
    [".pgpass", /凭据/],
    [".git-credentials", /凭据/],
    ["secrets.yaml", /凭据/],
    ["bundle.zip", /\.zip/],
    ["backup.tar.gz", /\.gz/],
    ["a/b.7z", /\.7z/],
    // Windows 反斜杠路径
    ["skills\\qa\\demo\\.env", /\.env/],
  ];
  it.each(SHOULD_HIT)("%s → 命中", (p, reason) => {
    const r = classifySensitiveFilename(p);
    expect(r).not.toBeNull();
    expect(r).toMatch(reason);
  });
});

describe("classifySensitiveFilename：不误报", () => {
  const SHOULD_PASS = [
    "skills/qa/demo/SKILL.md",
    "skills/qa/demo/scripts/run.py",
    ".env.example",
    ".env.sample",
    ".env.template",
    ".env.local.example",
    "config/prod.env.example",
    "id_rsa.pub", // 公钥
    "id_ed25519.pub",
    "identity.md",
    "docs/idea_rsa.md",
    "public.crt", // 公开证书
    "ca.cer",
    "keyboard.md",
    "monkey.txt",
    "pem.md",
    "key.md",
    "credentials-guide.md",
    "how-to-credentials.md",
    "skills/x/.env/readme.md", // 目录名叫 .env 不算
    "skills/x/environment.ts",
    "notes.envelope",
    "zip-guide.md",
    ".gitignore",
    "logo.png",
    "report.docx",
  ];
  it.each(SHOULD_PASS)("%s → 不命中", (p) => {
    expect(classifySensitiveFilename(p)).toBeNull();
  });
});

describe("scanSensitiveFilenames：命中结构与 force 闸门", () => {
  it("命中项：kind=sensitive-file、line=1、snippet 只含原因", () => {
    const hits = scanSensitiveFilenames([
      "skills/qa/demo/SKILL.md",
      "skills/qa/demo/.env",
      "skills/qa/demo\\certs\\a.p12",
    ]);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({
      file: "skills/qa/demo/.env",
      line: 1,
      kind: "sensitive-file",
    });
    expect(hits[0]!.snippet).toContain("敏感文件名");
    // 反斜杠规整成正斜杠
    expect(hits[1]!.file).toBe("skills/qa/demo/certs/a.p12");
  });

  it("沿用同一套闸门：未 force 阻断、force 放行", () => {
    const hits = scanSensitiveFilenames(["a/.env"]);
    expect(gateSensitiveUpload(hits, false).blocked).toBe(true);
    expect(gateSensitiveUpload(hits, true).blocked).toBe(false);
  });
});

describe("值形态规则补充：正例报", () => {
  const prose = (v: string): string => `调用示例 ${v} 结束\n`;
  const expectToken = (value: string, label: RegExp): void => {
    const hits = scanSensitiveFiles([
      { path: "skills/qa/demo/SKILL.md", content: prose(value) },
    ]);
    expect(hits.map((h) => h.kind)).toContain("known-token");
    expect(hits.some((h) => label.test(h.snippet))).toBe(true);
    // 脱敏：snippet 不含完整原值
    expect(hits.every((h) => !h.snippet.includes(value))).toBe(true);
  };

  it("JWT（三段 eyJ…）", () => {
    const jwt = [
      cat("ey", "JhbGciOiJIUzI1NiJ9"),
      cat("ey", "JzdWIiOiJ1c2VyMSJ9"),
      "aB3dE5fG7hJ9kL1mN3pQ",
    ].join(".");
    expectToken(jwt, /JWT/);
  });

  it("Google API key（AIza + 35 位）", () => {
    expectToken(cat("AI", "za", rep("a1B2", 9).slice(0, 35)), /AIza/);
  });

  it("Stripe live 密钥（sk_live_ / rk_live_）", () => {
    expectToken(cat("sk_", "live_", "a1B2c3D4e5F6g7H8i9J0k1L2"), /Stripe/);
    expectToken(cat("rk_", "live_", "a1B2c3D4e5F6g7H8i9J0k1L2"), /Stripe/);
  });

  it("npm 令牌（npm_ + 36 位）", () => {
    expectToken(cat("npm", "_", rep("a1B2", 9)), /npm/);
  });

  it("阿里云 AccessKeyId（LTAI + 12~20 位）", () => {
    expectToken(cat("LT", "AI", "5tAbC1dEf2GhJk3L"), /LTAI/);
    expectToken(cat("LT", "AI", rep("a1B2", 5)), /LTAI/);
  });

  it("腾讯云 SecretId（AKID + 32 位）", () => {
    expectToken(cat("AK", "ID", rep("a1B2", 8)), /AKID/);
  });

  it("注释行里贴的也要拦", () => {
    const hits = scanSensitiveFiles([
      {
        path: "skills/qa/demo/run.py",
        content: `# ${cat("npm", "_", rep("a1B2", 9))}\n`,
      },
    ]);
    expect(hits.map((h) => h.kind)).toContain("known-token");
  });
});

describe("值形态规则补充：反例不报", () => {
  const prose = (v: string): string => `调用示例 ${v} 结束\n`;
  const scan = (value: string) =>
    scanSensitiveFiles([
      { path: "skills/qa/demo/SKILL.md", content: prose(value) },
    ]);

  it("JWT：只有两段 / 第一段太短 / jwt.io 官方示例 → 不报", () => {
    const h = cat("ey", "JhbGciOiJIUzI1NiJ9");
    const p = cat("ey", "JzdWIiOiJ1c2VyMSJ9");
    expect(scan(`${h}.${p}`)).toEqual([]);
    expect(scan(`${cat("ey", "Jabc")}.${cat("ey", "Jdef")}.sig12345`)).toEqual([]);
    const sample = [
      cat("ey", "JhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"),
      cat("ey", "JzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ"),
      cat("SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV", "_adQssw5c"),
    ].join(".");
    expect(scan(sample)).toEqual([]);
  });

  it("AIza：34 位（太短）/ 36 位（更长的串）/ 全 x 占位 / 嵌在单词里 → 不报", () => {
    expect(scan(cat("AI", "za", rep("a1B2", 9).slice(0, 34)))).toEqual([]);
    expect(scan(cat("AI", "za", rep("a1B2", 9).slice(0, 36)))).toEqual([]);
    expect(scan(cat("AI", "za", rep("x", 35)))).toEqual([]);
    expect(scan(cat("prefix", "AI", "za", rep("a1B2", 9).slice(0, 35)))).toEqual([]);
  });

  it("Stripe：test 模式 / publishable / 太短 / 全 x → 不报", () => {
    expect(scan(cat("sk_", "test_", "a1B2c3D4e5F6g7H8i9J0k1L2"))).toEqual([]);
    expect(scan(cat("pk_", "live_", "a1B2c3D4e5F6g7H8i9J0k1L2"))).toEqual([]);
    expect(scan(cat("sk_", "live_", "a1B2c3D4"))).toEqual([]);
    expect(scan(cat("sk_", "live_", rep("x", 24)))).toEqual([]);
  });

  it("npm：环境变量名 / 35 位 / 37 位 / 纯字母 / 全 x → 不报", () => {
    expect(scan("npm_config_registry npm_package_name npm_lifecycle_event")).toEqual([]);
    expect(scan(cat("npm", "_", rep("a1B2", 9).slice(0, 35)))).toEqual([]);
    expect(scan(cat("npm", "_", `${rep("a1B2", 9)}c`))).toEqual([]);
    expect(scan(cat("npm", "_", rep("abcd", 9)))).toEqual([]);
    expect(scan(cat("npm", "_", rep("x", 36)))).toEqual([]);
  });

  it("LTAI：太短 / 太长 / 无数字的单词 → 不报", () => {
    expect(scan(cat("LT", "AI", "a1B2c3D4e5F"))).toEqual([]); // 11 位
    expect(scan(cat("LT", "AI", rep("a1B2", 6)))).toEqual([]); // 24 位（> 20）
    expect(scan(cat("LT", "AI", "abcdefghijklmnop"))).toEqual([]); // 无数字
  });

  it("AKID：31 位 / 33 位 / 无数字 → 不报", () => {
    expect(scan(cat("AK", "ID", rep("a1B2", 8).slice(0, 31)))).toEqual([]);
    expect(scan(cat("AK", "ID", `${rep("a1B2", 8)}c`))).toEqual([]);
    expect(scan(cat("AK", "ID", rep("abcd", 8)))).toEqual([]);
  });
});

describe("端到端：上传前的文件名策略（本地 bare 当远端）", () => {
  let env: Awaited<ReturnType<typeof setupTeamLibraryE2E>>;

  const skillMd = (name: string): string =>
    `---\nname: ${name}\ndescription: ${name} desc\n---\n\n# ${name}\n`;

  const writeBin = async (
    skill: string,
    rel: string,
    buf: Buffer,
  ): Promise<void> => {
    const abs = path.join(env.dataDir, "skills", skill, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, buf);
  };

  beforeAll(async () => {
    env = await setupTeamLibraryE2E({
      prefix: "fe-tl-scan-filename",
      token: "tok-alice",
      users: {
        "tok-alice": {
          id: 101,
          username: "alice",
          name: "Alice",
          email: "alice@example.com",
        },
      },
    });
    const synced = await syncTeamLibrary();
    expect(synced.ok).toBe(true);
  }, T);

  afterAll(async () => {
    await env.cleanup();
  });

  it(
    "无害内容的 .env → 被拦（改前内容不命中任何规则就照传）；远端不动、本地不留幻影",
    async () => {
      await env.writeAppSkill("env-leak", {
        "SKILL.md": skillMd("env-leak"),
        ".env": "MODE=dev\n",
      });
      const before = await env.remoteHead();

      const r = await uploadSkillsToTeamLibrary(["env-leak"], "qa");

      expect(r.ok).toBe(false);
      expect(
        (r.sensitiveHits ?? []).some(
          (h) =>
            h.file === "skills/qa/env-leak/.env" && h.kind === "sensitive-file",
        ),
      ).toBe(true);
      expect(await env.remoteHead()).toBe(before);
      expect(await env.localHead()).toBe(before);
      expect(await env.localStatus()).toBe("");
    },
    T,
  );

  it(
    "二进制 .p12 / .zip（内容扫描整个跳过）→ 靠文件名被拦",
    async () => {
      await env.writeAppSkill("bin-leak", { "SKILL.md": skillMd("bin-leak") });
      const bin = Buffer.concat([
        Buffer.from([0x30, 0x82, 0x00, 0x10, 0x00, 0x00, 0x00, 0x01]),
        Buffer.alloc(64, 0),
      ]);
      await writeBin("bin-leak", "certs/client.p12", bin);
      await writeBin("bin-leak", "assets/pack.zip", bin);
      const before = await env.remoteHead();

      const r = await uploadSkillsToTeamLibrary(["bin-leak"], "qa");

      expect(r.ok).toBe(false);
      const files = (r.sensitiveHits ?? [])
        .filter((h) => h.kind === "sensitive-file")
        .map((h) => h.file)
        .sort();
      expect(files).toEqual([
        "skills/qa/bin-leak/assets/pack.zip",
        "skills/qa/bin-leak/certs/client.p12",
      ]);
      expect(await env.remoteHead()).toBe(before);
    },
    T,
  );

  it(
    "force=true 是同一个误报出口：带 force 后 .env 照常上传",
    async () => {
      await env.writeAppSkill("env-force", {
        "SKILL.md": skillMd("env-force"),
        ".env": "MODE=dev\n",
      });
      const blocked = await uploadSkillsToTeamLibrary(["env-force"], "qa");
      expect(blocked.ok).toBe(false);

      const r = await uploadSkillsToTeamLibrary(["env-force"], "qa", {
        force: true,
      });
      expect(r.ok).toBe(true);
      expect(await env.remoteFiles()).toContain("skills/qa/env-force/.env");
    },
    T,
  );

  it(
    "对照：.env.example 模板 + 普通脚本 → 照常上传",
    async () => {
      await env.writeAppSkill("env-template", {
        "SKILL.md": skillMd("env-template"),
        ".env.example": "API_BASE=https://example.com\n",
        "scripts/run.py": "print('hi')\n",
      });

      const r = await uploadSkillsToTeamLibrary(["env-template"], "qa");

      expect(r.ok).toBe(true);
      expect(await env.remoteFiles()).toContain(
        "skills/qa/env-template/.env.example",
      );
    },
    T,
  );
});

// ---------- 第 2 轮复审：点开头的单段文件名 / 同一行多个令牌 ----------

describe("classifySensitiveFilename：点开头的单段名（文件名整个就是扩展名）", () => {
  const DOT_HIT: Array<[string, RegExp]> = [
    [".pem", /\.pem/],
    [".key", /\.key/],
    [".p12", /\.p12/],
    [".pfx", /\.pfx/],
    [".jks", /\.jks/],
    [".keystore", /\.keystore/],
    [".ppk", /\.ppk/],
    [".p8", /\.p8/],
    [".kdbx", /\.kdbx/],
    [".PEM", /\.pem/], // 大小写不敏感
    [".Key", /\.key/],
    ["skills/qa/demo/.pem", /\.pem/],
    ["certs/.p12", /\.p12/],
    ["skills\\qa\\demo\\.key", /\.key/], // Windows 反斜杠
    [".zip", /\.zip/], // 压缩包同一口径
    [".7z", /\.7z/],
  ];
  it.each(DOT_HIT)("%s → 命中", (p, reason) => {
    const r = classifySensitiveFilename(p);
    expect(r).not.toBeNull();
    expect(r).toMatch(reason);
  });

  it("scanSensitiveFilenames 对 `.pem` 出 sensitive-file 命中（未 force 阻断）", () => {
    const hits = scanSensitiveFilenames(["skills/x/SKILL.md", "skills/x/.pem"]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ file: "skills/x/.pem", kind: "sensitive-file", line: 1 });
    expect(gateSensitiveUpload(hits, false).blocked).toBe(true);
  });

  it("不误伤：公开证书 / 无关点文件 / 带别的后缀的点文件 / 目录名叫 .pem 不算", () => {
    for (const p of [
      ".crt", ".cer", ".md", ".keys", ".pemx", ".keyboard", ".gitignore", ".prettierrc",
      ".key.example", ".pem.md", "skills/x/.pem/readme.md",
    ]) {
      expect(classifySensitiveFilename(p), p).toBeNull();
    }
  });

  it(".env 系语义不变：.env / .env.local 仍命中，`.env.example` 等模板后缀仍放过", () => {
    expect(classifySensitiveFilename(".env")).toMatch(/\.env/);
    expect(classifySensitiveFilename(".env.local")).toMatch(/\.env/);
    for (const p of [".env.example", ".env.sample", ".env.template", ".env.local.example", ".env.dist"]) {
      expect(classifySensitiveFilename(p), p).toBeNull();
    }
  });
});

describe("值形态令牌：同一行多个命中都报（带上限）", () => {
  const knownTokenHits = (content: string) =>
    scanSensitiveFiles([{ path: "skills/qa/demo/SKILL.md", content }]).filter(
      (h) => h.kind === "known-token",
    );
  const aws = (a: string, b: string): string => cat("AKIA", a, b);
  const gh = (i: number): string =>
    cat("ghp_", "Q7zP3xK9m2Wd5rT8nB6vC1lY4jH0gF", String(1000 + i));

  it("同一行两个不同的 AKIA → 两条命中（改前只报第一个）", () => {
    const hits = knownTokenHits(
      `示例 ${aws("Q7ZP3XK9", "M2WD5RT8")} 与 ${aws("H4NB6VC1", "L0YJ8GFS")} 结束\n`,
    );
    expect(hits).toHaveLength(2);
    expect(hits.every((h) => h.line === 1)).toBe(true);
    // 脱敏：snippet 里不含完整原值
    for (const h of hits) {
      expect(h.snippet).not.toContain(aws("Q7ZP3XK9", "M2WD5RT8"));
      expect(h.snippet).not.toContain(aws("H4NB6VC1", "L0YJ8GFS"));
    }
  });

  it("同一个值在一行里重复出现只报一次", () => {
    const v = aws("Q7ZP3XK9", "M2WD5RT8");
    expect(knownTokenHits(`示例 ${v} 与 ${v} 与 ${v} 结束\n`)).toHaveLength(1);
  });

  it("不同规则同一行各报各的（AKIA + ghp_）", () => {
    const hits = knownTokenHits(`${aws("Q7ZP3XK9", "M2WD5RT8")} ${gh(1)}\n`);
    expect(hits.map((h) => h.snippet).join("|")).toMatch(/AKIA/);
    expect(hits.map((h) => h.snippet).join("|")).toMatch(/ghp_/);
    expect(hits).toHaveLength(2);
  });

  it("多行各报各的、行号正确", () => {
    const hits = knownTokenHits(`x\n${gh(1)}\n${gh(2)}\n\n${gh(3)}\n`);
    expect(hits.map((h) => h.line)).toEqual([2, 3, 5]);
  });

  it("上限：一行 30 个不同令牌只报 20 个，之后另一行的令牌照样报", () => {
    const line = Array.from({ length: 30 }, (_, i) => gh(i)).join(" ");
    const hits = knownTokenHits(`${line}\n${gh(99)}\n`);
    expect(hits.filter((h) => h.line === 1)).toHaveLength(20);
    expect(hits.filter((h) => h.line === 2)).toHaveLength(1);
  });

  it("占位符不计入命中、且不挡后面的真令牌：`ghp_xxxx… <真令牌>` 同行 → 只报真令牌", () => {
    const placeholder = cat("ghp_", rep("x", 36));
    const hits = knownTokenHits(`${placeholder} ${placeholder} ${gh(7)}\n`);
    expect(hits).toHaveLength(1);
  });

  it("一行几万个占位串：不挂、不误报", () => {
    const placeholder = cat("ghp_", rep("x", 36));
    const hits = knownTokenHits(`${Array.from({ length: 30_000 }, () => placeholder).join(" ")}\n`);
    expect(hits).toHaveLength(0);
  });

  it("连续调用互不污染（共享的全局正则没有残留 lastIndex）", () => {
    const content = `示例 ${aws("Q7ZP3XK9", "M2WD5RT8")} 结束\n`;
    for (let i = 0; i < 3; i++) expect(knownTokenHits(content)).toHaveLength(1);
  });
});
