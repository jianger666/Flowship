/**
 * 团队库密钥扫描：真实形态漏报 / 合法内容误报（真实执行语料实测出来的几类）
 *
 * 语料来源：用 74 个「应当被拦」的真实密钥写法 + 97 个「应当放行」的常见合法写法实际跑了一遍扫描器，
 * 下面是其中**根因明确、修法不削弱任何已有拦截**的几类（其余是设计上的行扫描局限，写在汇报里、不改）：
 *
 * 漏报
 * 1. `&` 拼接的参数（URL 查询串 / 表单体 / JDBC URL）：`?user=root&password=x`、`curl -d 'a=b&token=x'`。
 *    无引号取值不拦 `&`，`user` 的值被吃成 `root&password=x`，后面的 password 整个漏报。
 * 2. 连接串 scheme 白名单太窄：`rediss://`（TLS Redis，Upstash / ElastiCache 的标配）、`amqps://`、`sftp://`、
 *    `ssh://`、`smtps://`、`mssql://`、`ldap://` 漏；`redis://:pass@host`（空用户名）也漏。
 * 3. `-----BEGIN PGP PRIVATE KEY BLOCK-----`（GPG 私钥导出）、`-----BEGIN SSH2 ENCRYPTED PRIVATE KEY-----` 漏。
 *
 * 误报
 * 4. 高熵赋值规则把 `name: <≥20 字符的 kebab 名>` 当密钥：frontmatter 的 name 是每个 skill 都有的字段，
 *    仓库自带 7 个 skill 里就有 2 个（`chat-history-recovery` / `context-docs-handler`）被拦、只能靠 force 放行。
 */
import { describe, expect, it } from "vitest";

import {
  looksHighEntropySecret,
  scanSensitiveFiles,
} from "@/lib/server/team-library-secret-scan";

const scan = (content: string, path = "skills/fe/demo/cfg.txt") =>
  scanSensitiveFiles([{ path, content }]);
const snippets = (content: string): string[] => scan(content).map((h) => h.snippet);

describe("`&` 拼接的参数：后面的敏感参数不能被前一个参数的取值吞掉", () => {
  it.each([
    ["URL 查询串", "https://api.x.com/v1?page=1&password=Zx9Qw7Er5Ty", ["password=Zx9***"]],
    ["curl -d 表单体（带单引号收尾）", "curl -d 'username=admin&password=Zx9Qw7Er5Ty' https://x", ["password=Zx9***"]],
    ["JDBC URL", "jdbc:mysql://h/db?user=root&password=Zx9Qw7Er5Ty", ["password=Zx9***"]],
    ["多个参数之后", "a=1&b=2&secret=Zx9Qw7Er5Ty", ["secret=Zx9***"]],
    ["token 类键名", "x=1&access_token=Zx9Qw7Er5Ty1234", ["access_token=Zx9***"]],
    ["前一个敏感参数是空值，不能遮住后面真正的", "password=&token=Zx9Qw7Er5Ty", ["token=Zx9***"]],
    ["两个敏感参数各报一次", "?password=Zx9Qw7Er5Ty&token=Ab12Cd34Ef", ["password=Zx9***", "token=Ab1***"]],
  ])("%s", (_name, content, expected) => {
    expect(snippets(content), content).toEqual(expected);
  });

  it("`&` 后面不是「键名 + =」时仍是取值的一部分：真实口令里的 & 不会把口令截成两位数字放行", () => {
    // 这正是 -literal.test.ts 头注释里「刻意不拆 &」担心的情形：若按 & 无脑截断，`12&abc` 会变成 `12`（两位纯数字开关）被豁免
    expect(snippets("password=12&abc")).toEqual(["password=12&***"]);
    expect(snippets("password=ab&cd")).toEqual(["password=ab&***"]);
    expect(snippets("password=12&abc&user=x")).toEqual(["password=12&***"]);
    expect(snippets("secret=Zx9&Qw7&Er5")).toEqual(["secret=Zx9***"]);
  });

  it("顺带消掉一个已知误报：`?requirePassword=false&x=1` 的值是 false，不是 `false&x=1`", () => {
    expect(snippets("https://x/y?requirePassword=false&x=1")).toEqual([]);
    expect(snippets("a=1&usePassword=0&b=2")).toEqual([]);
  });

  it("以 false 开头的真实口令照旧命中（`&` 切分不影响整体相等判断）", () => {
    expect(snippets("a=1&password=false123&b=2")).toEqual(["password=fal***"]);
  });
});

describe("连接串不限 scheme、用户名可空", () => {
  it.each([
    ["rediss（TLS Redis）", "rediss://default:Zx9Qw7Er5Ty1234@host.upstash.io:6379"],
    ["redis 空用户名", "redis://:Zx9Qw7Er5Ty1234@host:6379"],
    ["rediss 空用户名", "rediss://:Zx9Qw7Er5Ty1234@host:6379"],
    ["amqps", "amqps://u:Zx9Qw7Er5Ty@h/vhost"],
    ["sftp", "sftp://u:Zx9Qw7Er5Ty@h/x"],
    ["ssh", "ssh://u:Zx9Qw7Er5Ty@h/x"],
    ["smtps", "smtps://u:Zx9Qw7Er5Ty@smtp.x.com:465"],
    ["mssql", "mssql://sa:Zx9Qw7Er5Ty@h/db"],
    ["ldap（用户名含 =）", "ldap://cn=admin:Zx9Qw7Er5Ty@h"],
    ["jdbc 前缀", "jdbc:postgresql://u:Zx9Qw7Er5Ty@h/db"],
    ["git+https", "git+https://u:Zx9Qw7Er5Ty@h/x.git"],
    ["大写 scheme", "POSTGRES://u:Zx9Qw7Er5Ty@h/db"],
  ])("%s 命中 connection-string", (_name, content) => {
    const hits = scan(content);
    expect(hits.map((h) => h.kind), content).toEqual(["connection-string"]);
    expect(hits[0]!.snippet).toBe("连接串口令 Zx9***");
  });

  it("原本就认的 scheme 不退化", () => {
    for (const content of [
      "postgresql://admin:DbPassw0rd!@db.example.com:5432/app",
      "mysql://root:Zx9Qw7Er5Ty@127.0.0.1:3306/db",
      "mongodb+srv://u:Zx9Qw7Er5Ty@c.mongodb.net/db",
      "https://user:HttpPass99@example.com/path",
    ]) {
      expect(scan(content).map((h) => h.kind), content).toContain("connection-string");
    }
  });

  it("占位符口令 / 没有 user:pass@ 的 URL 不误报", () => {
    for (const content of [
      "rediss://:${REDIS_PASSWORD}@host:6379",
      "redis://user:<password>@host",
      "postgres://user:password@localhost:5432/db",
      "mongodb://<user>:<password>@host/db",
      "https://example.com:8080/path",
      "https://github.com/org/repo/blob/main/a:b@c",
      "ssh://git@github.com:22/org/repo.git",
      "file:///C:/Users/me/x@y",
      "mailto:someone@example.com",
    ]) {
      expect(
        scan(content).filter((h) => h.kind === "connection-string"),
        content,
      ).toEqual([]);
    }
  });
});

describe("私钥块：多词类型名 / BLOCK 收尾", () => {
  it.each([
    "-----BEGIN PGP PRIVATE KEY BLOCK-----",
    "-----BEGIN SSH2 ENCRYPTED PRIVATE KEY-----",
    // 存量形态
    "-----BEGIN PRIVATE KEY-----",
    "-----BEGIN RSA PRIVATE KEY-----",
    "-----BEGIN EC PRIVATE KEY-----",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "-----BEGIN ENCRYPTED PRIVATE KEY-----",
  ])("%s 命中 private-key", (content) => {
    expect(scan(content).map((h) => h.kind), content).toEqual(["private-key"]);
  });

  it("公钥 / 证书不报", () => {
    for (const content of [
      "-----BEGIN PGP PUBLIC KEY BLOCK-----",
      "-----BEGIN PUBLIC KEY-----",
      "-----BEGIN CERTIFICATE-----",
      "-----BEGIN RSA PUBLIC KEY-----",
    ]) {
      expect(scan(content), content).toEqual([]);
    }
  });
});

describe("高熵规则：kebab / snake 命名不当密钥", () => {
  it.each([
    ["frontmatter name（kebab，21 字符）", "name: chat-history-recovery"],
    ["frontmatter name（kebab，20 字符）", "name: context-docs-handler"],
    ["snake 标识符", "module_id: my_awesome_module_name_x"],
    ["点分包名", "package: com.example.service.name.api"],
    ["env 风格", "SKILL_NAME=wk-action-maker-for-everyone"],
  ])("%s 放行", (_name, content) => {
    expect(scan(content, "skills/fe/demo/SKILL.md"), content).toEqual([]);
  });

  it("looksHighEntropySecret：纯小写词串豁免，带数字 / 大写 / 畸形分隔符的照旧判高熵", () => {
    // 豁免
    expect(looksHighEntropySecret("chat-history-recovery")).toBe(false);
    expect(looksHighEntropySecret("com.example.service.name")).toBe(false);
    expect(looksHighEntropySecret("'my_awesome_module_name'")).toBe(false);
    // 反例：这些不是「小写单词 + 分隔符」，保持原判定（不引入绕过）
    expect(looksHighEntropySecret("skill-creator-v2-final-release")).toBe(true); // 含数字
    expect(looksHighEntropySecret("Chat-History-Recovery-Tool")).toBe(true); // 含大写
    expect(looksHighEntropySecret("0123456789abcdef0123456789abcdef")).toBe(true); // 十六进制
    expect(looksHighEntropySecret("aB3dE5fG7hI9jK1lM2nOpQr")).toBe(true);
    expect(looksHighEntropySecret("chat--history--recovery-tool")).toBe(true); // 连续分隔符
    expect(looksHighEntropySecret("chat-history-recovery-tool-")).toBe(true); // 末尾分隔符
    expect(looksHighEntropySecret("-chat-history-recovery-tool")).toBe(true); // 开头分隔符
  });

  it("豁免只作用于高熵规则：敏感键名下的同形取值仍走 credential-key 命中", () => {
    expect(snippets("password: correct-horse-battery-staple")).toEqual(["password=cor***"]);
    expect(snippets("api_key: chat-history-recovery-tool")).toEqual(["api_key=cha***"]);
  });

  it("非敏感键名下真实形态的随机令牌照旧命中高熵", () => {
    for (const content of [
      "SESSION_ID=aB3dE5fG7hI9jK1lM2nOpQr",
      "build_id: 0123456789abcdef0123456789abcdef",
      "x: Zx9Qw7Er5Ty1234AbCdEfGh",
    ]) {
      expect(scan(content).map((h) => h.kind), content).toEqual(["high-entropy"]);
    }
  });
});
