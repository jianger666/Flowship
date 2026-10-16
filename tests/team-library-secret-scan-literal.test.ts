/**
 * 团队库密钥扫描：开关 / 空值型取值不是密钥（M2-10）
 *
 * 根因（读现有值过滤 + 修前实测）：`requirePassword: false` 的键名含 password（强敏感），
 * 而值过滤里只有「token 类键名 + 纯数字 / 布尔」一条豁免（`isNonSecretTokenConfig`，刻意不给
 * password / secret 类：`password=12345678` 仍是口令）；`isPlaceholderSecretValue` 只认
 * null / undefined / none / n/a，没有 true / false。于是三种写法
 * （YAML 无引号 `requirePassword: false`、JSON `"requirePassword": false`、带引号 `"false"`）
 * 全部被当成口令 `fal***` 误报。
 *
 * 修法：值整体（去引号后）恰好是 true / false / yes / no / on / off / null / nil / undefined / 空串
 * （外加 YAML 的 `~`、压缩 JS 的 `!0` / `!1`），或 1~2 位纯数字（0 / 1 开关、个位数计数）才豁免；
 * 以布尔词开头但不是布尔的真实口令（`false123` / `truePassw0rd`）仍命中。
 * 刻意不拆 `&`：URL 查询串 `?requirePassword=false&x=1` 的无引号值是 `false&x=1`，仍会报——
 * 拆开会把 `password=12&abc` 这类真实口令一起放行，宁可留这个已知误报。
 */
import { describe, expect, it } from "vitest";

import { scanSensitiveFiles } from "@/lib/server/team-library-secret-scan";

const scan = (content: string) =>
  scanSensitiveFiles([{ path: "skills/fe/demo/cfg.yaml", content }]);

describe("开关 / 空值型取值不当作密钥（M2-10）", () => {
  it.each([
    // 三种写法：YAML 无引号 / JSON / 带引号
    ["yaml 无引号 false", "requirePassword: false"],
    ["json false", '"requirePassword": false'],
    ["json 对象里的 false", '{"requirePassword": false, "name": "x"}'],
    ["带引号 \"false\"", '"requirePassword": "false"'],
    ["带单引号 'false'", "requirePassword: 'false'"],
    ["true", "requirePassword: true"],
    ["大小写不敏感（py / yaml）", "requirePassword = False"],
    ["TRUE 全大写", "REQUIRE_PASSWORD=TRUE"],
    ["结尾分号", "requirePassword = false;"],
    ["结尾逗号", "  requirePassword: false,"],
    ["py 调用里的实参（带右括号）", "login(requirePassword=False)"],
    ["secret 类键名同理", "useSecret: false"],
    ["api_key 类键名同理", "api_key: true"],
    ["yaml 的 yes / no / on / off", "usePassword: yes\nneedSecret: no\npasswordRequired: on\nsecretEnabled: off"],
    ["null / nil / undefined", "password: null\nsecret = nil\nclientSecret: undefined"],
    ["空串（带引号）", 'password: ""\nsecret: \'\''],
    ["纯数字开关 0 / 1", '"requirePassword": 1\nusePassword: 0\n"hasSecret": "1"'],
    ["个位 / 两位计数", "passwordAttempts: 3\nsecretRotation = 12"],
    ["引号里的布尔词带空白", 'requirePassword: " false "'],
    // 同语义的另一种写法：YAML 的 `~`（null）、压缩 JS 的 `!0` / `!1`（true / false）
    ["yaml 的 ~（null）", "password: ~\nsecret: ~"],
    ["压缩 JS 的 !0 / !1", "{requirePassword:!1,usePassword:!0}\nneedSecret=!!1"],
  ])("%s 不报", (_name, content) => {
    expect(scan(content), content).toEqual([]);
  });

  it.each([
    // 以布尔词 / 开关词开头（或包含）但整体不是布尔的真实口令仍命中
    ["false123", "password: false123", "password=fal***"],
    ["truePassw0rd", '"password": "truePassw0rd"', "password=tru***"],
    ["falsey 开头", "secret=falsey-S3cret", "secret=fal***"],
    ["null 开头", "password: nullable9Pass", "password=nul***"],
    ["yes 开头", "password: yesterday99", "password=yes***"],
    ["on 开头", '"password":"on1ineBank"', "password=on1***"],
    ["布尔词前缀 + 键名含布尔词", "requirePassword: falsePositive88", "requirePassword=fal***"],
    ["带引号的 false123", 'requirePassword: "false123"', "requirePassword=fal***"],
    ["真实口令恰好是纯数字（≥3 位）", "password=12345678", "password=123***"],
    ["三位数字口令", "password: 123", "password=***"],
    ["大写 FALSE 开头", "password=FALSEalarm77", "password=FAL***"],
    // `~` / `!0` / `!1` 只认整体相等：以它们开头的真实取值照报
    ["~ 开头的口令", "password: ~hunter22Pw", "password=~hu***"],
    ["!1 开头的口令", "password: !1nvalidPass9", "password=!1n***"],
  ])("真实口令 %s 仍命中", (_name, content, snippet) => {
    const hits = scan(content);
    expect(hits.map((h) => h.snippet), content).toEqual([snippet]);
    expect(hits.every((h) => h.kind === "credential-key")).toBe(true);
  });

  it("同一行：开关键不挡后面真正的口令", () => {
    expect(
      scan('{"requirePassword": false, "password": "RealPassw0rd99"}').map((h) => h.snippet),
    ).toEqual(["password=Rea***"]);
  });

  it("token 类键名的旧豁免（计数 / 布尔）不受影响", () => {
    expect(scan("max_tokens: 4096\nuseToken: true\ntokenCount = 12")).toEqual([]);
  });

  // 真实文件对比里发现的误报：TS / Python / Rust 的数字字面量允许用 `_` 分组（`8_192`、`128_000`），
  // 旧豁免只认 `\d+`，于是 LLM 配置里常见的 `maxTokens: 8_192` 被当成口令 `8_1***` 拦发布。
  it("token 类键名的数字豁免认下划线分组（8_192 / 128_000）", () => {
    expect(
      scan(
        ["maxTokens: 8_192,", "contextWindow: 128_000, maxTokens: 8_192,", "max_tokens = 1_000_000"].join("\n"),
      ),
    ).toEqual([]);
  });

  it("下划线分组的豁免只给 token 类键名，口令类键名不豁免；非纯数字不豁免", () => {
    // password / secret 类：纯数字（含 `_`）仍可能是 PIN / 弱口令，照报
    expect(scan("password: 1_234_567").map((h) => h.kind)).toEqual(["credential-key"]);
    // token 类但值不是纯数字：`_` 开头 / 结尾、夹字母都不算数字字面量，仍按口令报
    expect(scan("accessToken: _8192abcd").map((h) => h.kind)).toEqual(["credential-key"]);
    expect(scan("accessToken: 8_192abcd").map((h) => h.kind)).toEqual(["credential-key"]);
  });
});
