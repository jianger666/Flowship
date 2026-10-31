/**
 * 团队库密钥扫描：「宽松写法」补充规则（R14 Q13-08）
 *
 * 为什么要这组用例：基线只认「ASCII 键名 + `=` / `:` + 非注释行」这一种形态，下面这些写法里口令照样躺在文件里，却整类漏报
 * （修前用同一批用例实测：「应拦」70 行只拦住 1 行——`MYSQL_PWD`，基线本来就认 `pwd`；「应放行」116 行修前修后都放行，是对照）。
 * 每一类都是「形态确凿才报」的窄规则，取值过滤复用 `secretPartOf` 那一套
 * （占位符 / 环境变量引用 / 开关 / token 计数 / 结构值），所以每条「应拦」旁边都配了成组的「应放行」反例：
 *
 *   ① 注释里被注释掉的配置：`# password: x`（整行以 `#` / `//` 开头 = 以前只扫私钥 / 连接串 / 令牌）
 *   ② npmrc 的 `//registry.npmjs.org/:_authToken=…`（`//` 开头，同样被当成注释行）
 *   ③ 全角分隔符 / 中文键名：`password：x`、`password＝x`、`密码：x`
 *   ④ 命令行：`--password=x`、`--password x`、`sshpass -p x`、`docker login -p x`、`redis-cli -a x`、`curl -u 用户:口令`
 *   ⑤ `Authorization: Basic <base64(用户:口令)>`
 *   ⑥ 不带分隔符的复合键名 `PGPASSWORD=x`（classifyCredentialKey 里补）
 *
 * 几个取舍（都写在源码注释里，这里用例把它们固定下来）：
 * - 「不是明确赋值」的场合——注释里、空格分隔、全角分隔、中文键名之后——取值另要求「像口令」（≥6 位、纯 ASCII、含字母、
 *   含数字或符号），挡住 `# password: required`、`--password-policy strict`、`token：未过期直接返` 这类说明文字。
 *   代价是纯字母的真口令在这几个场合会漏——见末尾【已知局限】；明确赋值 `--password=correcthorse` 不受这关限制。
 * - 全角分隔符不能「整行把 `：` 换成 `:` 再走原流程」：试过，中文文档里「`token：` + 中文说明」随处都是，
 *   仓库自己的语料差分一下多出 40 条误报；所以它是独立规则，取值要「像口令」（见「全角分隔符不整行归一化」一组）。
 *
 * 语料差分（改前改后命中集合对比，找新增误报；2026-10-30 实测）：
 * - 仓库自己受控的全部文本（1804 个文件）：旧 8271 条 / 新 8271 条，新增 0、消失 0；
 * - node_modules 里的 README / 文档（2088 个文件，满是真实的命令行与 .npmrc 示例）：旧 1314 条 / 新 1315 条，新增 1 条——
 *   pg-pool 文档里的 `PGPASSWORD="my awesome password"`，与基线对同形的 `DB_PASSWORD="my awesome password"` 的处理一致
 *   （键名现在认得出来了，示例口令是句子这件事基线本来就不管）。
 */
import { describe, expect, it } from "vitest";

import {
  classifyCredentialKey,
  scanSensitiveFiles,
} from "@/lib/server/team-library-secret-scan";

const MB = 1024 * 1024;

/**
 * 假的 npm 令牌，两种形态：新式是 `npm_` + 36 位字母数字，旧式是一个 UUID。
 * 源码里不能把它们直接写成字面量：GitHub 的推送保护认这两种形态，旧式的 UUID 写在 .npmrc 认证行后面时，
 * 它把整次 push 拦下了（2026-10-31 发 v1.9.39 时踩到）；新式的格式同样是它认的，所以一并处理。
 * 做法是拆成几段、运行时再拼；拼出来的值和原来的字面量逐字相同。
 * 往后在测试里新写「像真令牌」的假值（`ghp_…` / `AKIA…` 之类）也照这个办法。
 */
const FAKE_NPM_TOKEN = ["npm", "_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789"].join("");
const FAKE_LEGACY_NPM_TOKEN = ["0f3a9c1d", "4b2e", "4f6a", "8c7d", "1234567890ab"].join("-");

const scan = (content: string, path = "skills/fe/demo/config.txt") =>
  scanSensitiveFiles([{ path, content }]);

/** 应拦行：[整行内容, 其中的密文（脱敏后不得出现在命中里）] */
type BlockRow = readonly [line: string, secret: string];

/** 一组「应拦」：每行恰好 1 条命中、类型符合预期、完整密文不出现在命中里（只留前 3 位） */
const expectBlocked = (rows: readonly BlockRow[], kind: string, path?: string) => {
  it.each(rows)("%s", (line, secret) => {
    const hits = scan(line, path);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.kind).toBe(kind);
    expect(JSON.stringify(hits)).not.toContain(secret);
  });
};

/** 一组「应放行」：整行零命中 */
const expectPassed = (lines: readonly string[], path?: string) => {
  it.each(lines)("%s", (line) => {
    expect(scan(line, path)).toEqual([]);
  });
};

describe("① 注释里被注释掉的配置", () => {
  describe("应拦", () => {
    expectBlocked(
      [
        ["# password: hunter2xyz99", "hunter2xyz99"],
        ['// password = "S3cretValue99"', "S3cretValue99"],
        ["# DB_PASSWORD=Pr0dS3cret!", "Pr0dS3cret!"],
        ["// api_key: abcd1234efgh5678", "abcd1234efgh5678"],
        ["# secret: Zx9fQ2pL7vB3", "Zx9fQ2pL7vB3"],
        ["    # password: hunter2xyz99", "hunter2xyz99"],
        ["## password: hunter2xyz99", "hunter2xyz99"],
        ["# - password: hunter2xyz99", "hunter2xyz99"],
        ['// "password": "hunter2xyz99"', "hunter2xyz99"],
        ["# password：hunter2xyz99", "hunter2xyz99"],
        ["// password＝hunter2xyz99", "hunter2xyz99"],
        ["# - password：hunter2xyz99", "hunter2xyz99"],
        ["# password: hunter2", "hunter2"],
        // 「像口令」的下限：6 位刚好够；含符号不含数字也算（只认数字会漏掉 `Zx!qWvbnM` 这类）
        ["# password: Ab12xy", "Ab12xy"],
        ["# password: Zx!qWvbnM", "Zx!qWvbnM"],
      ],
      "credential-key",
    );
  });

  describe("应放行（说明文字 / 占位符 / 非强敏感键）", () => {
    expectPassed([
      "# password: <填写>",
      "# password: <your-password>",
      "// password: string",
      "// password: the user's password",
      "# password must be at least 8 characters",
      "# password: required",
      "# password: Required",
      "// token: string",
      "# 密码：请填写",
      "// secret: see 1Password",
      "# password: ${DB_PASSWORD}",
      "# password: $DB_PASSWORD",
      "# set the password to something long",
      "# secret: [redacted]",
      "# password: (hidden)",
      "# secret: MY_SECRET_NAME",
      "# password: correct-horse-battery-staple",
      "# api_key: your_api_key_here",
      "# password: ******",
      // 5 位：不像口令（下限是 6 位）
      "# password: Ab12x",
      "# password: Ab1!x",
      // token / weak 类键名在注释里说明性用法太多，只认强敏感键名
      "# token: abcd1234efgh5678",
      "# max_tokens: 4096",
      "# auth: abcd1234efgh5678",
    ]);
  });

  it("基线本来就能拦的相邻写法仍然拦（防回退）：JSDoc 星号行 / SQL 注释 / ini 分号注释", () => {
    for (const line of [" * password: hunter2xyz99", "-- password: hunter2xyz99", "; password=hunter2xyz99"]) {
      expect(scan(line).map((h) => h.kind)).toEqual(["credential-key"]);
    }
  });
});

describe("② npmrc 认证行", () => {
  describe("应拦", () => {
    expectBlocked(
      [
        [`//registry.npmjs.org/:_authToken=${FAKE_LEGACY_NPM_TOKEN}`, FAKE_LEGACY_NPM_TOKEN],
        [`//registry.npmjs.org/:_authToken=${FAKE_NPM_TOKEN}`, FAKE_NPM_TOKEN],
        ["//registry.npmjs.org/:_auth=dXNlcjpwYXNzd29yZDEyMw==", "dXNlcjpwYXNzd29yZDEyMw=="],
        ["//npm.example.com/:_authToken=AbCd1234EfGh5678IjKl", "AbCd1234EfGh5678IjKl"],
        ["//npm.example.com:8080/repo/:_authToken=AbCd1234EfGh5678IjKl", "AbCd1234EfGh5678IjKl"],
        ['//registry.npmjs.org/:_authToken="AbCd1234EfGh5678IjKl"', "AbCd1234EfGh5678IjKl"],
        ["  //registry.npmjs.org/:_authToken=AbCd1234EfGh5678IjKl", "AbCd1234EfGh5678IjKl"],
        ["//registry.npmjs.org/:_password=cGFzc3dvcmQxMjM=", "cGFzc3dvcmQxMjM="],
      ],
      "credential-key",
      ".npmrc",
    );
  });

  describe("应放行（环境变量引用 / 占位符 / 与认证无关的行）", () => {
    expectPassed(
      [
        "//registry.npmjs.org/:_authToken=${NPM_TOKEN}",
        "//registry.npmjs.org/:_authToken=${NPM_TOKEN:-}",
        "//registry.npmjs.org/:_authToken=$NPM_TOKEN",
        "//registry.npmjs.org/:_authToken=<token>",
        "//registry.npmjs.org/:_authToken=xxxx",
        "//registry.npmjs.org/:_authToken=",
        "registry=https://registry.npmjs.org/",
        "//registry.npmjs.org/:always-auth=true",
      ],
      ".npmrc",
    );
  });

  it("非注释写法的 `_authToken=` 基线本来就拦（防回退）", () => {
    expect(scan("_authToken=AbCd1234EfGh5678IjKl", ".npmrc").map((h) => h.kind)).toEqual(["credential-key"]);
  });
});

describe("③ 全角分隔符 / 中文键名", () => {
  describe("应拦", () => {
    expectBlocked(
      [
        ["password：hunter2xyz99", "hunter2xyz99"],
        ["password＝hunter2xyz99", "hunter2xyz99"],
        ["api_key：abcd1234efgh5678", "abcd1234efgh5678"],
        ["secret：Zx9fQ2pL7vB3", "Zx9fQ2pL7vB3"],
        ["密码：Hunter2xyz99", "Hunter2xyz99"],
        ["口令：Abc12345!x", "Abc12345!x"],
        ["密码＝Hunter2xyz99", "Hunter2xyz99"],
        ["访问令牌：Abc12345!x", "Abc12345!x"],
        ['密码："Hunter2xyz99"', "Hunter2xyz99"],
        // 含符号不含数字也算「像口令」
        ["password：Zx!qWvbnM", "Zx!qWvbnM"],
        ["密码：Zx!qWvbnM", "Zx!qWvbnM"],
      ],
      "credential-key",
    );
  });

  describe("应放行（占位符 / 中文说明）", () => {
    expectPassed([
      "密码：<填写>",
      "密码：请填写",
      "密码：（见密码管理器）",
      "密码：",
      "密码：无",
      "口令：见密码管理器 1Password",
      "令牌：Bearer",
      "令牌：${GITLAB_TOKEN}",
      // 5 位：不像口令（下限是 6 位）
      "password：Ab12x",
      "密码：Ab12x",
      // 键名与认证无关：值再像口令也不报（全角规则要过 classifyCredentialKey，不是「见到全角分隔符就报」）
      "name：Abc12345!x",
      "title＝Hello2World!",
      "version：1.2.3-beta.1",
    ]);
  });

  describe("全角分隔符不整行归一化（语料差分踩出来的坑）", () => {
    // 中文文档里「ASCII 词 + 全角冒号 + 中文说明」随处都是；整行把 `：` 换成 `:` 会让它们全变成「键: 值」被报
    it.each([
      "token：未过期直接返，过期且有 refresh → 自动续",
      "- `gitToken`：Personal Access Token（明文存服务端，跟 apiKey 同安全级别）",
      "* 会话恢复时要装进 submit_mr 桥的 GitLab Token：入口随 bootArgs 带来的优先",
      "it(\"用户在设置页换了新 token：缓存失效，新值立刻生效\", () => {",
      "describe(\"callerToken：被新 agent 接管 / 已停止的旧实例不许再建或取消定时\", () => {",
      "console.log(\"========== 私钥（存 GitHub secret：UPDATE_MANIFEST_PRIVATE_KEY、勿泄漏）==========\");",
      "await think(`先取 token：${'x'}`);",
      "password：必填",
    ])("%s", (line) => {
      expect(scan(line)).toEqual([]);
    });
  });
});

describe("④ 命令行里的口令", () => {
  describe("应拦（长参数 / 带口令的命令）", () => {
    expectBlocked(
      [
        ["mysql --password=hunter2xyz99 -h db", "hunter2xyz99"],
        ["tool --password hunter2xyz99", "hunter2xyz99"],
        ["tool --token=abcd1234efgh5678", "abcd1234efgh5678"],
        ["tool --api-key abcd1234efgh5678", "abcd1234efgh5678"],
        ["tool --client-secret=Zx9fQ2pL7vB3", "Zx9fQ2pL7vB3"],
        ["tool --passwd 'hunter2xyz99'", "hunter2xyz99"],
        ['tool --secret "Zx9fQ2pL7vB3"', "Zx9fQ2pL7vB3"],
        ['tool --password="hunter2xyz99"', "hunter2xyz99"],
        ["wget --user=admin --password=hunter2xyz99 https://example.com", "hunter2xyz99"],
        ["docker login -u user -p hunter2xyz99", "hunter2xyz99"],
        ["docker login -u user --password hunter2xyz99 registry.example.com", "hunter2xyz99"],
        ["sshpass -p 'hunter2xyz99' ssh host", "hunter2xyz99"],
        ["sshpass -p hunter2xyz99 ssh host", "hunter2xyz99"],
        ["sshpass -e -p hunter2xyz99 ssh host", "hunter2xyz99"],
        ["redis-cli -a hunter2xyz99", "hunter2xyz99"],
        ["redis-cli -h cache.internal -p 6379 -a hunter2xyz99", "hunter2xyz99"],
        ["curl -u admin:hunter2xyz99 https://example.com/api", "hunter2xyz99"],
        ["curl --user admin:hunter2xyz99 https://example.com/api", "hunter2xyz99"],
        ["curl -s -u admin:hunter2xyz99 https://example.com/api", "hunter2xyz99"],
        ['curl -u "admin:hunter2xyz99" https://example.com/api', "hunter2xyz99"],
        // 用户名为空、口令照样躺在冒号后面
        ["curl -u :hunter2xyz99 https://example.com/api", "hunter2xyz99"],
        ["curl --user=:hunter2xyz99 https://example.com/api", "hunter2xyz99"],
        // 空格分隔的值含符号不含数字也算「像口令」
        ["tool --password Zx!qWvbnM", "Zx!qWvbnM"],
        ["# 手动执行：tool --password hunter2xyz99", "hunter2xyz99"],
      ],
      "credential-key",
      "scripts/run.sh",
    );
  });

  describe("应放行（占位符 / 环境变量 / 别的工具里长得像的写法）", () => {
    expectPassed(
      [
        "tool --password-file=/etc/secret",
        "tool --password-stdin",
        "tool --no-password",
        "tool --password",
        "tool --password <your-password>",
        "tool --password $PASS",
        'tool --password "$PASS"',
        "tool --password=${PASS}",
        "tool --password=PASSWORD",
        "tool --api-key=API_KEY",
        "tool --token $TOKEN",
        "tool --passphrase-file ~/.key",
        "tool --password-policy strict",
        "tool --max-tokens 4096",
        "tool --max-tokens=4096",
        "tool --token-ttl 3600",
        "tool --secret-name my-secret",
        'tool --password "your password here"',
        'tool --password "$(cat /run/secrets/pw)"',
        "x --no-password host1",
        // `--no-xxx` 是关闭开关：后面跟的值（库名 / 主机名）再像口令也不是口令；空格分隔与 `=` 两种写法都不报
        "pg_dump --no-password mydb2024",
        "tool --no-password=mydb2024",
        "tool --no_token=Abc12345!x",
        // 5 位：不像口令（空格分隔的值下限是 6 位；明确赋值不受这条限制）
        "tool --password Ab12x",
        "--password <app_specific_password>",
        "| `--api-key <key>` | API key, overriding environment variables |",
        ".addOption(new Option('-s, --secret').hideHelp())",
        'docker login -u user -p "$DOCKER_PASS"',
        "docker login --password-stdin < pw.txt",
        "docker login -u user --password-stdin registry.example.com",
        "docker login && ssh -p 22 host",
        "docker run -u 1000:1000 -v /a:/b image",
        'sshpass -p "$SSH_PASS" ssh host',
        "sshpass -f /path/to/file ssh host",
        "sshpass -e ssh -p 2222 host",
        "ssh -p 2222 host",
        "redis-cli -a $REDIS_PASS",
        "redis-cli -h cache.internal -p 6379",
        "mysql -u root -p mydb",
        "git commit -m \"fix password handling\"",
        "i--; j--;",
        ":root { --color-primary: #3366ff; }",
      ],
      "scripts/run.sh",
    );
  });
});

describe("④ curl -u 用户:口令", () => {
  describe("应放行", () => {
    expectPassed(
      [
        "curl -u $USER:$PASS https://example.com",
        'curl -u "$USER:$PASS" https://example.com',
        "curl -u ${USER}:${PASS} https://example.com",
        "curl -u user https://example.com",
        "curl -u user: https://example.com",
        "curl -u : https://example.com",
        // 文档示例里的假口令词
        "curl -u user:pass https://example.com",
        "curl -u username:password https://example.com",
        // `用户:组` 形态（口令里一个字母都没有）
        "curl -u 1000:1000 https://example.com",
      ],
      "scripts/run.sh",
    );
  });
});

describe("⑤ Authorization: Basic", () => {
  describe("应拦", () => {
    expectBlocked(
      [
        ["Authorization: Basic YWRtaW46aHVudGVyMnh5ejk5", "YWRtaW46aHVudGVyMnh5ejk5"],
        ['curl -H "Authorization: Basic YWRtaW46aHVudGVyMnh5ejk5" https://example.com', "YWRtaW46aHVudGVyMnh5ejk5"],
        ['headers = {"Authorization": "Basic YWRtaW46aHVudGVyMnh5ejk5"}', "YWRtaW46aHVudGVyMnh5ejk5"],
        ["proxy-authorization: basic YWRtaW46aHVudGVyMnh5ejk5", "YWRtaW46aHVudGVyMnh5ejk5"],
        // 解开是 `:hunter2xyz99`（用户名为空，口令在冒号后面）
        ["Authorization: Basic Omh1bnRlcjJ4eXo5OQ==", "Omh1bnRlcjJ4eXo5OQ=="],
      ],
      "known-token",
      "scripts/run.sh",
    );
  });

  describe("应放行", () => {
    expectPassed(
      [
        "Authorization: Basic <your-token>",
        "Authorization: Basic ${TOKEN}",
        "Authorization: Basic $TOKEN",
        "Authorization: Basic base64(user:pass)",
        'curl -H "Authorization: Basic $(echo -n user:pass | base64)" https://example.com',
        // 解开是 user:pass / user:password：文档示例
        "Authorization: Basic dXNlcjpwYXNz",
        "Authorization: Basic dXNlcjpwYXNzd29yZA==",
        // 用户名为空、口令是示例词：同样放过
        "Authorization: Basic OnBhc3N3b3Jk",
        // 解开没有「用户:口令」结构
        "Authorization: Basic Zm9vYmFyYmF6cXV4",
        // 解开碰巧带冒号、但含不可打印字节 / NUL（随机 base64、二进制片段）：不是「用户:口令」
        `Authorization: Basic ${Buffer.from([0x01, 0x3a, 0xff, 0xfe, 0x80, 0x81, 0x82, 0x83]).toString("base64")}`,
        `Authorization: Basic ${Buffer.from([0x75, 0x3a, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06]).toString("base64")}`,
        // 行里没有 authorization 语境
        "Basic YWRtaW46aHVudGVyMnh5ejk5",
        "return req.headers['proxy-authorization'] === `Basic ${Buffer.from('user:pass').toString('base64')}`",
      ],
      "scripts/run.sh",
    );
  });
});

describe("⑥ 复合键名（PGPASSWORD 这类拆不开的）", () => {
  describe("应拦", () => {
    expectBlocked(
      [
        ["PGPASSWORD=hunter2xyz99 psql -h host", "hunter2xyz99"],
        ["export PGPASSWORD=hunter2xyz99", "hunter2xyz99"],
        ["PGPASSWORD='hunter2xyz99' pg_dump db", "hunter2xyz99"],
        ["MYSQL_PWD=hunter2xyz99 mysql -h host", "hunter2xyz99"],
        ["SSHPASS=hunter2xyz99 sshpass -e ssh host", "hunter2xyz99"],
        ["newpassword=abc123xyz", "abc123xyz"],
        ["confirmpassword=abc123xyz", "abc123xyz"],
      ],
      "credential-key",
      "scripts/run.sh",
    );
  });

  describe("应放行", () => {
    expectPassed(
      [
        "PGPASSWORD=$DB_PASS psql -h host",
        'PGPASSWORD="${DB_PASS}" psql',
        "MYSQL_PWD=<password> mysql",
        "SSHPASS=$SSH_PASS sshpass -e ssh host",
        "bypass=abc123xyz",
        "compass: abc123xyz",
        "passwordless: abc123xyz",
      ],
      "scripts/run.sh",
    );
  });

  it("classifyCredentialKey：复合词按「以 password / passwd / passphrase 收尾且比它长」认，整词与别的词不变", () => {
    for (const k of ["PGPASSWORD", "pgpassword", "DBPASSWD", "newpassword", "confirmpassphrase", "SSHPASS", "sshpass"]) {
      expect(classifyCredentialKey(k), k).toBe("strong");
    }
    // 整词 / 复数 / 既有写法不变
    expect(classifyCredentialKey("password")).toBe("strong");
    expect(classifyCredentialKey("passwords")).toBe("strong");
    expect(classifyCredentialKey("DB_PASSWORD")).toBe("strong");
    expect(classifyCredentialKey("MYSQL_PWD")).toBe("strong");
    expect(classifyCredentialKey("accessToken")).toBe("token");
    // `pass` 太短太泛；以 password 开头的词不算；无关的词仍是 null
    for (const k of ["pass", "bypass", "compass", "trespass", "passwordless", "passport", "tokenizer", "author"]) {
      expect(classifyCredentialKey(k), k).toBeNull();
    }
  });
});

describe("命中的组织：每行一条、脱敏、行号", () => {
  it("同一个值被几条规则同时命中只留一条（docker login 的 --password 同时满足长参数和 docker 两条）", () => {
    const hits = scan("docker login --password hunter2xyz99 registry.example.com", "scripts/run.sh");
    expect(hits.map((h) => h.snippet)).toEqual(["--password=hun***"]);
  });

  it("同行已被前面的步骤命中就不重复报：普通键值对命中后不再叠加补充规则", () => {
    const hits = scan("password: hunter2xyz99 --password=hunter2xyz99");
    expect(hits.map((h) => h.snippet)).toEqual(["password=hun***"]);
  });

  it("同行已被前面的步骤认领（高熵 / 平台令牌）就不再叠加补充规则：命中与补充规则出现之前完全一致", () => {
    const token = "ghp_aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5";
    const kindsOf = (line: string) => scan(line, "scripts/run.sh").map((h) => h.kind);
    // `=` 紧跟的长值先被高熵步骤认领；空格分隔 / 命令里的先被平台令牌步骤认领；注释行里令牌命中后不再看补充规则
    expect(kindsOf(`tool --password=${token}`)).toEqual(["high-entropy"]);
    expect(kindsOf(`tool --password ${token}`)).toEqual(["known-token"]);
    expect(kindsOf(`# tool --password=${token}`)).toEqual(["known-token"]);
    expect(kindsOf(`docker login -p ${token}`)).toEqual(["known-token"]);
  });

  it("同行已被 webhook 地址认领也不再叠加补充规则：只报地址那一条", () => {
    // 地址运行时拼接：源码里不出现连续的完整值（与 team-library-secret-scan-urls.test.ts 同一做法）
    const hook = ["https://open.feishu.cn/open-apis/bot/v2/", "hook/3f2a9c1e-5b7d-4e8a-9c0d-1a2b3c4d5e6f"].join("");
    const kindsOf = (line: string) => scan(line, "scripts/run.sh").map((h) => h.kind);
    expect(kindsOf(`curl -u admin:hunter2xyz99 ${hook}`)).toEqual(["known-token"]);
    expect(kindsOf(`sshpass -p hunter2xyz99 ssh host # ${hook}`)).toEqual(["known-token"]);
  });

  it("多行文件：每条命中的行号正确，说明文字行不报", () => {
    const content = [
      "# 部署说明",
      "# password: required",
      "# password: hunter2xyz99",
      "run: |",
      "  curl -u admin:Pa55w0rdXyz https://example.com",
      "",
      "密码：Hunter2xyz99",
      "说明：token：未过期直接返",
    ].join("\n");
    expect(scan(content, "scripts/run.sh").map((h) => [h.line, h.snippet])).toEqual([
      [3, "password=hun***"],
      [5, "curl -u 口令 Pa5***"],
      [7, "密码=Hun***"],
    ]);
  });

  it("基线行为不变：普通键值对照旧一条命中、片段格式不变", () => {
    expect(scan("password: hunter2xyz99").map((h) => [h.kind, h.snippet])).toEqual([
      ["credential-key", "password=hun***"],
    ]);
  });
});

describe("【已知局限】取舍而不是遗漏：这些不报（要改请连同源码注释一起改）", () => {
  it.each([
    // 「不是明确赋值」的场合要求取值像口令：纯字母的真口令会漏
    ["注释里的纯字母口令", "# password: correcthorsebattery"],
    ["空格分隔的纯字母口令", "tool --password correcthorse"],
    ["全角分隔的纯字母口令", "password：correcthorse"],
    ["中文键名后的纯数字口令", "密码：123456"],
    // 只覆盖确凿的几条命令；单字母参数不通用
    ["mysql 的 -p 紧跟口令", "mysql -u root -phunter2xyz99"],
    ["JSON 数组形式的参数", 'subprocess.run(["tool", "--password", "hunter2xyz99"])'],
    // token 类键名在注释里不看
    ["注释里的 token 键", "# access_token: abcd1234efgh5678"],
  ])("%s", (_name, line) => {
    expect(scan(line, "scripts/run.sh")).toEqual([]);
  });

  it("明确赋值不受「像口令」限制：`--password=correcthorse` 照报", () => {
    expect(scan("tool --password=correcthorse", "scripts/run.sh").map((h) => h.kind)).toEqual(["credential-key"]);
  });
});

describe("对抗输入下的线性复杂度（补充规则，单行）", () => {
  const timed = (content: string) => {
    const t0 = performance.now();
    const hits = scan(content, "big.txt");
    return { hits, ms: performance.now() - t0 };
  };

  // 输入规模取「若有上界的窗口被改成无界，修后立即二次方」的量级；上限 1000ms（实测是几十毫秒，留 20 倍以上余量）
  it.each([
    ["curl 反复出现、-u 在最后（≤200 字符窗口反复失败）", "curl ".repeat(60_000) + " -u a:b"],
    ["docker login 反复出现、-p 在最后", "docker login ".repeat(30_000) + " -p x"],
    ["redis-cli 反复出现、-a 在最后", "redis-cli ".repeat(40_000) + " -a x"],
    ["sshpass -e 反复出现", "sshpass -e ".repeat(40_000)],
    ["--password 后面跟的全是下一个参数", "--password ".repeat(60_000)],
    ["4 万个 --password=Ab1234", "--password=Ab1234 ".repeat(40_000)],
    ["Authorization: Basic 反复出现", "Authorization: Basic ".repeat(20_000)],
    ["单字母键 + 全角冒号反复出现", "a ：".repeat(60_000)],
    ["中文键名 + 很长的空白", "密码" + " ".repeat(2 * MB)],
    ["中文键名 + 值 反复出现", "密码：Ab1234 ".repeat(40_000)],
    ["注释行：超长键名", "# " + "a".repeat(2 * MB) + ": x"],
    ["注释行：超长空白", "#" + " ".repeat(2 * MB) + "x"],
    ["npmrc 窗口：`//` 后面是超长非空白", "//" + "a".repeat(2 * MB)],
  ])("%s", (_name, content) => {
    expect(timed(content).ms).toBeLessThan(1000);
  });

  it.each([
    ["注释行里的超长取值", "# password: " + "aB3".repeat(2 * MB)],
    ["curl -u 的超长口令", "curl -u a:" + "Ab1".repeat(2 * MB)],
    ["Authorization: Basic 后面是超长 base64 字符", "Authorization: Basic " + "A".repeat(6 * MB)],
    ["括号包住的超长取值（BRACKETED_VALUE_RE）", "# password: [" + "a".repeat(6 * MB)],
    ["全大写下划线形的取值（ENV_NAME_LIKE_RE）", "--token=" + "A_".repeat(2 * MB) + "a"],
  ])("MB 级单个取值不抛栈溢出、不超时：%s", (_name, content) => {
    const { ms } = timed(content);
    expect(ms).toBeLessThan(5000);
  });
});
