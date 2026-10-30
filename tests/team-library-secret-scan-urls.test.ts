/**
 * 团队库密钥扫描：URL / UUID / 摘要 / 文件路径不再被当成高熵口令，路径里嵌着凭据的 webhook 地址仍被拦（R14 Q13-03）
 *
 * 现象：团队库里贴一条文档 / clone 链接就被「疑似敏感信息」阻断上传——仓库自带的 `context-docs-handler` skill
 * 里两行飞书链接（`https://project.feishu.cn/...`）就中招。R14 时对 1585 个仓库文本文件的差分：改前 9726 条命中、
 * 7826 条是 high-entropy，其中 2156 条只是 URL / 路径 / 摘要。
 * 根因：高熵赋值规则（第 5 步）取「`:` / `=` 之后连续 ≥ 20 个字符集内字符」，`https:` 之后的 `//host/path…` 天然满足；
 * UUID、`sha512-…` integrity、`@sha256:` digest、`src/…/Foo.tsx` 路径同理。
 *
 * 修法的分工（每一段下面都有用例钉住）：
 *  1. URL 先抹掉再跑高熵规则；带 userinfo 的 URL 不抹；credential-key / 连接串 / 平台令牌仍扫原行。
 *  2. **webhook 地址由专门规则兜住**：飞书 / Slack / Discord / 企业微信 / Teams 的 webhook 没有敏感键名、也不是 sk- / ghp_ 前缀，
 *     以前只是被「URL 一律误报」顺带拦住，抹掉 URL 之后会整类漏报（拿到地址就能往群里发消息，它本身就是密钥）。
 *     规则：host 标签或路径段里有**整词** hook(s) / webhook(s)，且路径段 / 查询值里有像凭据的段。
 *     刻意没有写成逐平台的固定正则：那种写法需要 `{20,}` 这类带下界的计数量词，18MB 的输入会让 V8 抛
 *     `RangeError: Maximum call stack size exceeded`（实测五条全抛，且 force 也救不了；见 perf 测试头注释）。
 *  3. UUID / npm integrity（`sha512-…`）/ 文件路径（只认末段带扩展名的）不当口令；`@sha256:` digest 与 JSON 写法的
 *     `"sha256": "…"` 认作 hash 语境。
 *  4. 第 5 步逐个候选看：**良性值**让位给后面的候选（否则 `{id: <uuid>, note: <口令>}` 里的真口令没人看了——
 *     以前 UUID 自己会误命中、顺带拦住整行）；第一个真正被评估的候选不够高熵则整行放过（与以前一致，
 *     放出后面的候选会让 `jobs: BackgroundSubagentJobView[]` 这类 CamelCase 标识符连带误报）。
 *  5. Telegram bot token（路径里的 `bot<id>:<token>`，没有 hook 字样）以前同样只靠「URL 一律误报」被拦，
 *     由 KNOWN_TOKEN_RULES 里的值形态规则兜住（总长 35 位；官方文档示例只有 34 位，算示例、不拦）。
 *     IFTTT `…/with/key/<key>`、没有 hook 字样的 `…/v1/<随机串>/…` 和文档 id 形态上分不开，作为已知残余写在
 *     findWebhookUrlSecrets 的注释里——这里不为它们写「放过」的用例，免得把漏报固化成期望。
 *
 * 示例值全部是虚构的；webhook 地址 / Telegram token 在运行时用 `join` 拼接，源码里不出现连续的完整值
 *（否则会被 GitHub push protection 之类的 secret 扫描当成真令牌拦住推送）。
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  scanSensitiveFiles,
  type SecretScanFile,
} from "@/lib/server/team-library-secret-scan";

import { doublingRatio, LINEAR_RATIO_MAX } from "./helpers/scaling-ratio";

const scan = (content: string) =>
  scanSensitiveFiles([{ path: "skills/fe/demo/SKILL.md", content }]);
const kinds = (content: string) => scan(content).map((h) => h.kind);
const snippets = (content: string) => scan(content).map((h) => h.snippet);
const join = (...parts: string[]) => parts.join("");

/** 24 位混合口令（虚构）：键名不敏感时只能靠高熵规则发现 */
const SECRET = "Xk9fT2mQ7vLr8Zp3Xk9fT2mQ";
const SECRET16 = "Xk9fT2mQ7vLr8Zp3";
const UUID = "550e8400-e29b-41d4-a716-446655440000";
const SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const INTEGRITY = `sha512-Zq1v7rCzmq3pZb1QYb1QZ0aV0A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R8S9T0U1V2W3X4Y5Z==`;

const SLACK = join(
  "https://hooks",
  ".slack.com/services/",
  "T01ABCDEF/B02GHIJKL/",
  "AbCdEfGhIjKlMnOpQrStUvWx",
);
const FEISHU_HOOK = join(
  "https://open.feishu.cn/open-apis/bot/v2/",
  "hook/3f2a9c1e-5b7d-4e8a-9c0d-1a2b3c4d5e6f",
);

/** Telegram bot token（虚构）：`<8–16 位 bot id>:A<34 位>`，第二段总长 35；运行时拼接 */
const TG_ID = "123456789";
const TG_TOKEN = join("AAFhGOJlxQnK", "z1E9yJwXn7pnHGBQhD9PXfA");
/** Telegram 官方文档里的示例 token：只有 34 位，不是真 token 的形态 */
const TG_DOC_EXAMPLE = join("AAHdqTcvCH1vGWJx", "fSeofSAs0K5PALDsaw");
const tgUrl = (token: string, id = TG_ID) =>
  `https://api.telegram.org/bot${id}:${token}/sendMessage`;

describe("普通链接 / UUID / 摘要 / 文件路径不再被当成高熵口令", () => {
  it.each<[string, string]>([
    ["git clone 链接", "git clone https://gitlab.example.com/group/repo.git"],
    [
      "飞书 wiki 链接",
      "https://wukong.feishu.cn/wiki/wikcnAbCdEfGhIjKlMnOpQrStUv",
    ],
    [
      "飞书 docx 链接（带语境）",
      "参考 https://wukongedu.feishu.cn/docx/doxcnAbCdEfGhIjKlMnOpQrStUv",
    ],
    [
      "飞书文档链接（带 from 参数）",
      "https://xxx.feishu.cn/wiki/wikcnAbCdEfGhIjKlMnOpQrStUv?from=from_copylink",
    ],
    ["自带 skill 原文：带省略号的链接", "   https://project.feishu.cn/..."],
    ["自带 skill 原文：docx 省略号", "   https://wukongedu.feishu.cn/docx/..."],
    [
      "markdown 链接",
      "[文档](https://wukong.feishu.cn/wiki/wikcnAbCdEfGhIjKlMnOpQrStUv)",
    ],
    ["URL 带 id 参数", "https://example.com/a/b?id=Ab12Cd34Ef56Gh78Ij90Kl12"],
    [
      "带 UTM 的长链接",
      "https://example.com/blog/2024/how-to-build-a-secure-pipeline?utm_source=newsletter&utm_medium=email&utm_campaign=spring_launch_2024",
    ],
    [
      "MDN 长链接",
      "访问 https://developer.mozilla.org/zh-CN/docs/Web/API/Fetch_API/Using_Fetch 了解",
    ],
    [
      "GitHub blob 链接",
      "see https://github.com/org/repo/blob/main/docs/README.md#section",
    ],
    ["UUID", `id: ${UUID}`],
    ["UUID（引号 + 大写）", `"requestId": "${UUID.toUpperCase()}"`],
    ["npm integrity", `"integrity": "${INTEGRITY}"`],
    ["Docker digest（@sha256:）", `FROM node@sha256:${SHA256}`],
    ["JSON 写法的 sha256", `{"sha256":"${SHA256}"}`],
    ["引号包裹键名的 checksum", `'checksum': '${SHA256}'`],
    [
      "相对路径（: 后）",
      "file: src/components/features/UserProfileCard/UserProfileCardHeader.tsx",
    ],
    ["相对路径（= 后）", "entry=src/lib/server/team-library-secret-scan.ts"],
    [
      "绝对路径",
      "path: /Users/someone/Documents/project/src/components/Foo.tsx",
    ],
    [
      "Windows 盘符路径",
      "path: C:/Users/someone/Documents/project/src/Foo.tsx",
    ],
  ])("%s", (_name, line) => {
    expect(scan(line), line).toEqual([]);
  });

  it("hash 语境不受前面很长的内容影响（窗口只看候选左侧紧邻的 64 个字符）", () => {
    const prefix = "x".repeat(200);
    expect(kinds(`${prefix} sha256: ${SHA256}`)).toEqual([]);
    // 对照：同样长的前缀、键名不是 hash 语境 → 照旧命中（窗口化没有把所有候选都豁免）
    expect(kinds(`${prefix} foo: ${SHA256}`)).toEqual(["high-entropy"]);
  });
});

describe("路径 / 查询里嵌着凭据的 webhook 地址：地址本身就是密钥，必须继续被拦", () => {
  it.each<[string, string]>([
    ["飞书自定义机器人", `curl -X POST ${FEISHU_HOOK} -d '{}'`],
    [
      "Lark 自定义机器人",
      join(
        "POST https://open.larksuite.com/open-apis/bot/v2/",
        "hook/3f2a9c1e-5b7d-4e8a-9c0d-1a2b3c4d5e6f",
      ),
    ],
    ["Slack（令牌段混合大小写）", SLACK],
    [
      "Slack（令牌段纯小写的示例）",
      join(
        "https://hooks",
        ".slack.com/services/T01234567/B01234567/",
        "abcdefghijklmnopqrstuvwx",
      ),
    ],
    [
      "Discord",
      join(
        "https://discord.com/api/",
        "webhooks/123456789012345678/",
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      ),
    ],
    [
      "企业微信（令牌在查询里）",
      join(
        "https://qyapi.weixin.qq.com/cgi-bin/",
        "webhook/send?key=693a91f6-7a00-4bc4-97a0-0ec2a1fa5aaa",
      ),
    ],
    [
      "Teams",
      join(
        "https://contoso.webhook.office.com/",
        "webhookb2/0123456789abcdef-0123-4567-89ab-cdef01234567",
        "@01234567-89ab-cdef-0123-456789abcdef/IncomingWebhook/",
        "0123456789abcdef0123456789abcdef/01234567-89ab-cdef-0123-456789abcdef",
      ),
    ],
    [
      "Mattermost / Rocket.Chat 一类的 /hooks/<令牌>",
      "https://chat.corp.local/hooks/xyz9abc1234567890abcdefgh",
    ],
    ["markdown 链接里的 webhook", `[通知机器人](${SLACK})`],
    ["带语境的行", `发送通知到 ${SLACK} 即可`],
  ])("%s", (_name, line) => {
    expect(kinds(line), line).toEqual(["known-token"]);
    expect(snippets(line)[0]).toMatch(/^令牌\(webhook URL\) .{3}\*\*\*$/);
  });

  it.each<[string, string]>([
    [
      "Slack 官方文档的占位示例",
      join(
        "https://hooks",
        ".slack.com/services/T00000000/B00000000/",
        "XXXXXXXXXXXXXXXXXXXXXXXX",
      ),
    ],
    [
      "尖括号占位",
      "https://hooks.slack.com/services/T123/B456/<your-token>",
    ],
    ["Slack webhook 文档页", "https://api.slack.com/messaging/webhooks"],
    [
      "GitHub webhook 文档页（小写 slug 路径）",
      "https://docs.github.com/en/webhooks/webhook-events-and-payloads#push",
    ],
    ["react 的 hooks 文档", "https://react.dev/reference/react/hooks"],
    [
      "react-hooks 不是整词 hook(s)",
      "https://github.com/facebook/react/blob/main/packages/react-hooks/README.md",
    ],
    [
      "git hooks 示例文件（末段含点）",
      "https://github.com/org/repo/blob/main/.git/hooks/pre-commit.sample",
    ],
    [
      "GitHub 仓库 hooks 设置页（短数字 id）",
      "https://github.com/org/repo/settings/hooks/123456789",
    ],
    [
      "文档名里含 hooks 子串、还带数字（不是整词，也不是 webhook）",
      "https://example.com/docs/react-hooks-best-practices-2024",
    ],
  ])("webhook 文档 / 示例不拦：%s", (_name, line) => {
    expect(scan(line), line).toEqual([]);
  });

  it("同一个 URL 最多报一条（Teams 地址里有好几段像凭据的）", () => {
    const teams = join(
      "https://contoso.webhook.office.com/webhookb2/",
      "0123456789abcdef-0123-4567-89ab-cdef01234567@01234567-89ab-cdef-0123-456789abcdef/",
      "IncomingWebhook/0123456789abcdef0123456789abcdef/01234567-89ab-cdef-0123-456789abcdef",
    );
    expect(scan(teams)).toHaveLength(1);
    // 同一行两个 webhook 地址 = 两条
    expect(scan(`${SLACK} ${FEISHU_HOOK}`)).toHaveLength(2);
  });

  it("同一行已被别的规则报过就不重复报：键名敏感 → 只有 credential-key；令牌本身是平台令牌形态 → 只有一条", () => {
    expect(kinds(`webhook_secret: ${SLACK}`)).toEqual(["credential-key"]);
    // webhook 地址里的令牌段同时满足 ghp_ 形态：webhook 规则先报，平台令牌规则不再重复
    const ghp = join("ghp_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8");
    expect(kinds(`https://hooks.corp.local/services/${ghp}`)).toEqual([
      "known-token",
    ]);
  });
});

describe("Telegram bot token：路径里的 bot<id>:<token> 没有 hook 字样，靠值形态规则兜住", () => {
  it("样本长度自检：token 第二段 35 位，官方文档示例 34 位", () => {
    expect(TG_TOKEN).toHaveLength(35);
    expect(TG_DOC_EXAMPLE).toHaveLength(34);
  });

  // URL 会先被抹掉再跑高熵规则，所以 URL 里的 token 只能靠这条值形态规则发现——这是新规则真正补上的缺口
  it.each<[string, string]>([
    ["URL 里的 bot<id>:<token>（bot 与 id 相连，\\b 在这里不成立）", tgUrl(TG_TOKEN)],
    ["id 8 位（下限）", tgUrl(TG_TOKEN, "12345678")],
    ["id 10 位（现在 bot id 的位数）", tgUrl(TG_TOKEN, "1234567890")],
    ["id 16 位（上限：id 涨到 11 位以后真 token 也不能漏）", tgUrl(TG_TOKEN, "1234567890123456")],
    ["markdown 链接里", `[机器人](${tgUrl(TG_TOKEN)})`],
    ["注释行里贴的 URL（注释行也扫平台令牌）", `# curl ${tgUrl(TG_TOKEN)}`],
    ["注释行里的裸 token", `# ${TG_ID}:${TG_TOKEN}`],
  ])("拦：%s", (_name, line) => {
    expect(kinds(line), line).toEqual(["known-token"]);
    expect(snippets(line)[0]).toMatch(/^令牌\(Telegram bot\) .{3}\*\*\*$/);
  });

  it("正文里的裸 token 以前就被高熵规则拦住（`:` 之后 35 位混合字符），kind 仍是 high-entropy，不重复报", () => {
    expect(kinds(`note: ${TG_ID}:${TG_TOKEN}`)).toEqual(["high-entropy"]);
  });

  it.each<[string, string]>([
    ["官方文档的示例 token 只有 34 位（示例，不是真 token）", tgUrl(TG_DOC_EXAMPLE, "110201543")],
    ["token 比 35 位长（右侧还有 token 字符）", tgUrl(`${TG_TOKEN}x`)],
    ["id 只有 7 位", tgUrl(TG_TOKEN, "1234567")],
    ["id 有 17 位（超过上限；左侧紧挨数字也不能从中间截一段）", tgUrl(TG_TOKEN, "12345678901234567")],
    ["token 不以 A 开头", tgUrl(`B${TG_TOKEN.slice(1)}`)],
  ])("不拦：%s", (_name, line) => {
    expect(scan(line), line).toEqual([]);
  });

  it("键名敏感的行只报 credential-key，不重复报", () => {
    expect(kinds(`TELEGRAM_BOT_TOKEN=${TG_ID}:${TG_TOKEN}`)).toEqual([
      "credential-key",
    ]);
  });
});

describe("凭据写在 URL 里的其他写法不受影响（credential-key / 连接串仍扫原行）", () => {
  it.each<[string, string, string]>([
    [
      "钉钉 access_token",
      "https://oapi.dingtalk.com/robot/send?access_token=0123456789abcdef0123456789abcdef",
      "credential-key",
    ],
    [
      "?token= 参数",
      `https://api.corp.local/v1/export?token=${SECRET}`,
      "credential-key",
    ],
    [
      "&access_token= 参数",
      `https://api.corp.local/v1/list?page=1&access_token=${SECRET}`,
      "credential-key",
    ],
    [
      "S3 预签名 URL",
      "https://bucket.s3.amazonaws.com/a.png?X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20240101%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Signature=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "credential-key",
    ],
    [
      "OSS 预签名 URL",
      "https://b.oss-cn-hangzhou.aliyuncs.com/f.png?OSSAccessKeyId=LTAI4G1234567890abcdef&Expires=1700000000&Signature=AbCdEfGh%2Bxyz1234567890%3D",
      "credential-key",
    ],
    [
      "飞书 tenant_access_token",
      "https://open.feishu.cn/open-apis/drive/v1/medias/xxx/download?tenant_access_token=t-g1044abc0123456789abcdef0123456789abc",
      "credential-key",
    ],
    [
      "带 user:pass@ 的 URL",
      `git clone https://deploy:${SECRET16}@git.corp.local/a/b.git`,
      "connection-string",
    ],
    [
      "redis 空用户名",
      `redis://:${SECRET16}@cache.corp.local:6379`,
      "connection-string",
    ],
    [
      "令牌放在 userinfo 的用户名位置（无冒号）：带 userinfo 的 URL 不抹",
      `https://${SECRET}@git.corp.local/a/b.git`,
      "high-entropy",
    ],
  ])("%s", (_name, line, kind) => {
    expect(kinds(line), line).toEqual([kind]);
  });
});

describe("同一行里被放过的良性值 / URL 不能挡住后面键名不敏感的真口令", () => {
  it.each<[string, string]>([
    ["UUID 在前", `id: ${UUID} note: ${SECRET}`],
    ["flow map：UUID 在前", `{id: ${UUID}, note: ${SECRET}}`],
    [
      "长相对路径在前",
      `file: src/components/features/UserProfileCard/Header.tsx note: ${SECRET}`,
    ],
    ["npm integrity 在前", `"integrity": "${INTEGRITY}", note: ${SECRET}`],
    ["Docker digest 在前", `FROM node@sha256:${SHA256} # note: ${SECRET}`],
    ["sha256 语境在前（修前就漏）", `sha256: ${SHA256} note: ${SECRET}`],
    [
      "URL 在前（参数里有 UUID）",
      `see https://a.corp.local/x?id=${UUID} note: ${SECRET}`,
    ],
    ["URL 在后", `key: ${SECRET} 见 https://docs.corp.local/guide`],
    // URL 抹除只吃到第一个非 URL 字符：紧贴的标点 / 中文标点 / 括号 / 引号之后的内容必须还看得到
    ["URL 后紧贴逗号", `https://a.corp.local/x,note: ${SECRET}`],
    ["URL 后紧贴中文逗号", `https://a.corp.local/x，note: ${SECRET}`],
    ["URL 后紧贴分号", `https://a.corp.local/x;note=${SECRET}`],
    ["URL 在括号里", `(https://a.corp.local/x)note: ${SECRET}`],
    ["URL 在引号里", `"https://a.corp.local/x" note: ${SECRET}`],
    ["markdown 链接之后", `[文档](https://a.corp.local/x) note: ${SECRET}`],
    ["URL 末尾带句号", `见 https://a.corp.local/x. note: ${SECRET}`],
  ])("%s", (_name, line) => {
    expect(kinds(line), line).toEqual(["high-entropy"]);
  });

  it("URL 后面的真口令键名敏感时走 credential-key（高熵不重复报）", () => {
    expect(
      kinds(`see https://docs.corp.local/guide , secret_value: ${SECRET}`),
    ).toEqual(["credential-key"]);
    expect(
      kinds(
        `curl https://api.corp.local/v1/x -H "X-Api-Key: ${SECRET}"`,
      ),
    ).toEqual(["credential-key"]);
  });
});

describe("第一个被评估的候选不够高熵时整行放过（逐个候选不能放出后面的 CamelCase 标识符）", () => {
  // 这几行都来自仓库自身源码：改成「每个候选都评估」时它们是语料差分里仅有的新增误报
  it.each<[string, string]>([
    [
      "TS 类型定义",
      `  | { kind: "background_subagents"; jobs: BackgroundSubagentJobView[] }`,
    ],
    [
      "Tailwind 类名（最小形态）",
      "placeholder:text-muted-foreground dark:aria-invalid:border-destructive/50",
    ],
    [
      "Tailwind 类名（input.tsx 整行）",
      `        "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",`,
    ],
    [
      "内联脚本里的点路径",
      `        "process.stdout.write(JSON.stringify({dir:process.report.directory,excl:process.report.excludeEnv,opts:process.env.NODE_OPTIONS??null}))",`,
    ],
  ])("%s", (_name, line) => {
    expect(scan(line), line).toEqual([]);
  });
});

describe("路径豁免只认「末段带扩展名的文件路径」：不放走含 / 的 base64 口令", () => {
  it.each<[string, string]>([
    [
      "AWS secret 形态（40 位 base64，含 /）",
      "value: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    ],
    [
      "以 / 结尾的 base64",
      "value: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKE/",
    ],
    [
      "以 / 开头的 base64",
      "value: /alrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    ],
    ["含 + 的 base64", "value: wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"],
    ["含 = 的 base64", "value: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKE="],
    [
      // 末段「扩展名」有 20 位：真文件扩展名很短（ts / tsx / json / markdown），这么长的不是扩展名；
      // 钉着 looksLikeFilePath 的 ext.length <= 8 上限（审查 AI 变异 `<= 80` 时没有任何用例红）
      "末段「扩展名」长于 8 位的含 / 串（不是文件路径）",
      "value: wJalrXUtnFEMI/K7MDENG.bPxRfiCYEXAMPLEKEY12",
    ],
  ])("%s 仍命中", (_name, line) => {
    expect(kinds(line), line).toEqual(["high-entropy"]);
  });

  it("扩展名上限的边界：8 位扩展名的文件路径放过、9 位的当高熵（与 looksLikeFilePath 的 ext.length <= 8 对齐）", () => {
    expect(kinds("value: src/lib/server/Component.abcdefgh")).toEqual([]);
    expect(kinds("value: src/lib/server/Component.abcdefghi")).toEqual(["high-entropy"]);
  });
});

describe("新增逻辑（URL 抹除 / webhook 判定 / 逐个候选）在超大输入下线性、不抛栈溢出", () => {
  const MB = 1024 * 1024;
  const scanOne = (content: string) =>
    scanSensitiveFiles([{ path: "skills/fe/demo/big.md", content }]);

  // 倍增比值：n→2n 的耗时比 ≈ 2 为线性、≈ 4 为二次方（CPU 时间，原理与阈值见 tests/helpers/scaling-ratio.ts）
  it.each<[string, (n: number) => string, number]>([
    ["大量 URL", (n) => "https://a.b/c ".repeat(n), 20_000],
    ["大量 webhook 地址", (n) => `${SLACK} `.repeat(n), 5_000],
    [
      "大量 UUID 候选 + 末尾真口令",
      (n) => `id: ${UUID} `.repeat(n) + `note: ${SECRET}`,
      10_000,
    ],
    ["/hook/ 后的很多路径段", (n) => `https://example.com/hook/${"a/".repeat(n)}`, 60_000],
    ["host 里很多标签", (n) => `https://${"a.".repeat(n)}/hook/x`, 60_000],
    ["a:// 重复", (n) => "a://".repeat(n), 60_000],
    // 含 `://` 才会进入 URL 正则；scheme 字符类吃完一长串字母却收不了尾，没有后顾的话每个起点都重来一遍（二次方）
    ["含 :// 但 scheme 收不了尾的长字母串", (n) => `://${"a".repeat(n)}!`, 60_000],
    // Telegram 规则：每个起点最多试 16 位数字就失败；起点只在「前一个字符不是数字」处
    ["大量 `<id>:` 之后不是 A", (n) => "1234567890123456:".repeat(n), 100_000],
    ["大量 `<id>:A` 之后凑不够 token 字符", (n) => "12345678:A".repeat(n), 100_000],
  ])("倍增比值：%s", (_name, build, n) => {
    const ratio = doublingRatio((size) => {
      const content = build(size);
      return () => scanOne(content);
    }, n);
    expect(ratio).toBeLessThan(LINEAR_RATIO_MAX);
  });

  it("18MB 的 webhook 令牌段：不抛、照样命中（专用规则里没有带下界的计数量词）", () => {
    const hits = scanOne(
      join("https://hooks", ".slack.com/services/T01/B02/") + "a1".repeat(9 * MB),
    );
    expect(hits.map((h) => h.kind)).toEqual(["known-token"]);
  });

  it("18MB 的 `<id>:A…`：右侧 token 字符没有尽头 → 不抛、不命中（Telegram 规则只用有上界的计数量词）", () => {
    expect(scanOne(`${TG_ID}:` + "A".repeat(18 * MB))).toEqual([]);
  });

  it("18MB 纯数字 + 末尾一个真 token 的 URL：不抛、照样命中（起点只能在数字串开头）", () => {
    const hits = scanOne(`${"1".repeat(18 * MB)} ${tgUrl(TG_TOKEN)}`);
    expect(hits.map((h) => h.kind)).toEqual(["known-token"]);
  });

  it("18MB 的 /hook/ 路径（900 万个路径段）：不抛、没有凭据段 → 不命中", () => {
    expect(scanOne(`https://example.com/hook/${"a/".repeat(9 * MB)}`)).toEqual(
      [],
    );
  });

  it("45 万个良性候选之后的真口令仍被找到（逐个候选是线性的，不是只看前几个）", () => {
    const hits = scanOne(`id: ${UUID} `.repeat(450_000) + `note: ${SECRET}`);
    expect(hits.map((h) => h.kind)).toEqual(["high-entropy"]);
  });
});

describe("仓库自带 skill 不能被自家扫描器拦住", () => {
  it("skills/ 下的全部文件扫描零命中", () => {
    const root = path.resolve(import.meta.dirname, "..", "skills");
    const files: SecretScanFile[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else
          files.push({
            path: path.relative(root, p),
            content: fs.readFileSync(p, "utf-8"),
          });
      }
    };
    walk(root);
    // 目录被移走 / 改名时别空跑成假绿
    expect(files.length).toBeGreaterThan(0);
    expect(scanSensitiveFiles(files)).toEqual([]);
  });
});
