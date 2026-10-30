/**
 * classifyLarkFailure：飞书 / lark-cli 失败的分类（R14 B4-3 · Q12a-07）
 *
 * 分类是 card-stream 失败策略与 outbound 提示文案共用的**单一来源**。表驱动：
 *  - 错误码（最硬）→ permissionViolations → 文案兜底 → 既有的传输瞬时判据 → unknown；
 *  - 码优先于文案；
 *  - 「不该误判」同样要钉住：误判成致命类（gone / auth / too_long）会让一张本来还能更新的卡被放弃。
 *
 * ⚠️ 错误码取自飞书开放平台 CardKit / 通用错误码文档，仓库内有真机样例的只有 99991672 / 230002 / 300317；
 * 其余码没有真机样例——这里钉的是「表里写了什么」，不是「飞书真的回这个码」。
 */
import { describe, expect, it } from "vitest";

import {
  classifyLarkFailure,
  LARK_ARGV_TOO_LONG_CODE,
  LarkApiError,
  type LarkFailureKind,
} from "@/lib/server/feishu-bridge/types";

const withCode = (code: number | string, message = "x"): LarkApiError =>
  new LarkApiError(message, { code });

describe("错误码优先（数字和字符串两种写法都认）", () => {
  const rows: Array<[string, number | string, LarkFailureKind]> = [
    ["本地命令行预检（常量）", LARK_ARGV_TOO_LONG_CODE, "too_long"],
    ["本地命令行预检（字面值）", "ARGV_TOO_LONG", "too_long"],
    ["spawn ENAMETOOLONG", "ENAMETOOLONG", "too_long"],
    ["spawn E2BIG", "E2BIG", "too_long"],
    ["卡片体积超限（数字）", 200860, "too_long"],
    ["卡片体积超限（字符串）", "200860", "too_long"],
    ["序号没严格递增", 300317, "seq_conflict"],
    ["序号没严格递增（字符串）", "300317", "seq_conflict"],
    ["流式超时自动关", 200850, "stream_closed"],
    ["流式已关闭", 300309, "stream_closed"],
    ["卡片实体不存在", 200740, "gone"],
    ["卡片实体已过期", 200750, "gone"],
    ["缺 scope（真机样例）", 99991672, "auth"],
    ["access_token 缺失", 99991661, "auth"],
    ["tenant_access_token 失效", 99991663, "auth"],
    ["user_access_token 失效", 99991668, "auth"],
    ["应用无权操作这张卡", 300311, "auth"],
    ["机器人不在会话（真机样例）", 230002, "auth"],
    ["无发送权限", 230035, "auth"],
    ["OpenAPI 限流", 99991400, "rate_limit"],
    ["发消息触发频率限制", 230020, "rate_limit"],
    ["飞书服务内部错误", 300120, "transient"],
    ["卡片正处于用户交互回调中", 200810, "transient"],
  ];
  it.each(rows)("%s（%s）→ %s", (_label, code, kind) => {
    expect(classifyLarkFailure(withCode(code))).toBe(kind);
  });

  it("码优先于文案：限流码 + 'Access denied' 文案 → 仍是 rate_limit", () => {
    expect(classifyLarkFailure(withCode(99991400, "Access denied"))).toBe("rate_limit");
  });

  it("码优先于文案：流式已关（300309）+ 'timeout' 文案 → stream_closed，不被「超时 = 瞬时」吃掉", () => {
    expect(classifyLarkFailure(withCode(300309, "request timeout"))).toBe("stream_closed");
    expect(classifyLarkFailure(withCode(200850, "card streaming timeout"))).toBe("stream_closed");
  });

  it("原生系统错误（没有 LarkApiError 包装）带 code 也认：Node 的 spawn ENAMETOOLONG", () => {
    const err = Object.assign(new Error("spawn lark-cli ENAMETOOLONG"), { code: "ENAMETOOLONG" });
    expect(classifyLarkFailure(err)).toBe("too_long");
  });
});

describe("权限违规清单 → auth", () => {
  it("permissionViolations 非空数组 → auth（没有错误码也认）", () => {
    const err = new LarkApiError("x", {
      permissionViolations: [{ subject: "cardkit:card:write" }],
    });
    expect(classifyLarkFailure(err)).toBe("auth");
  });

  it("permissionViolations 是非数组的真值对象 → auth", () => {
    const err = new LarkApiError("x", { permissionViolations: { subject: "x" } });
    expect(classifyLarkFailure(err)).toBe("auth");
  });

  it("空数组不算 → 落到后面的判据（这里什么都没有 = unknown）", () => {
    expect(classifyLarkFailure(new LarkApiError("x", { permissionViolations: [] }))).toBe("unknown");
  });
});

describe("文案兜底（没有错误码时）", () => {
  const rows: Array<[LarkFailureKind, string]> = [
    ["rate_limit", "request trigger frequency limit"],
    ["rate_limit", "Too Many Requests"],
    ["rate_limit", "HTTP 429 returned"],
    ["rate_limit", "rate limited"],
    ["rate_limit", "请求过于频繁，请稍后再试"],
    ["rate_limit", "触发限流"],
    ["seq_conflict", "The sequence number for operating on the card did not increment consecutively"],
    ["seq_conflict", "sequence number compare failed"],
    ["stream_closed", "streaming mode is closed"],
    ["stream_closed", "Card streaming timeout"],
    ["stream_closed", "Card streaming closed"],
    ["gone", "The card entity does not exist"],
    ["gone", "The card entity has expired"],
    ["gone", "the message has been recalled"],
    ["gone", "消息已撤回"],
    ["gone", "卡片已过期"],
    ["auth", "Access denied"],
    ["auth", "no permission"],
    ["auth", "missing required scope: cardkit:card:write"],
    ["auth", "bot not in chat"],
    ["auth", "The bot can not be outside the group"],
    ["auth", "权限不足"],
    ["too_long", "Card content exceeds limit."],
    ["too_long", "The length of the message content reaches its limit"],
    ["too_long", "spawn ENAMETOOLONG"],
    ["too_long", "argument list too long"],
    ["too_long", "卡片内容过长"],
    ["too_long", "参数超出限制"],
    ["transient", "Internal Server Error"],
    ["transient", "service unavailable"],
    ["transient", "502 Bad Gateway"],
    ["transient", "服务内部错误"],
    // 既有的传输瞬时判据
    ["transient", "read ECONNRESET"],
    ["transient", "socket hang up"],
    ["transient", "unexpected EOF"],
    // —— 每个文案分支至少有一条「只有它自己能命中」的文案（删掉任何一个分支都会有用例变红）——
    ["seq_conflict", "Sequence Number Compare Failed"], // 大小写不敏感
    ["seq_conflict", "card sequence conflict"], // sequence…conflict（不含 "sequence number"）
    ["seq_conflict", "sequence must increment"], // sequence…increment
    ["seq_conflict", "卡片序号冲突"],
    ["seq_conflict", "序号需严格递增"],
    ["stream_closed", "streaming timeout"], // 没有 "card " 前缀：删掉这个分支会掉到兜底变成 transient
    ["auth", "Permission denied"],
    ["auth", "lack of required scope"],
    ["auth", "lack of scope"],
    ["auth", "scope im:message not granted"],
    ["auth", "scope is missing"],
    ["auth", "scope required"],
    ["rate_limit", "frequency limit exceeded"], // 没有 "trigger"
    ["rate_limit", "triggered the frequency control"], // 没有 "limit"
    ["rate_limit", "调用频率限制"],
    ["rate_limit", "接口调用频率过高"],
    ["transient", "504 Gateway Time-out"], // 连字符写法：兜底的 timeout 判据接不住，只有这个分支认得
    ["transient", "系统繁忙，请稍后再试"],
    ["transient", "Server busy"],
    ["auth", "无权限访问该会话"], // 中文：「无权限 / 没有权限 / 权限不足」是三个独立候选，各要一条只有它自己能命中的文案
    ["auth", "没有权限发送消息"],
    ["too_long", "体积超限"], // 不能写成「卡片体积超限」：前面的「(内容|卡片|…)…超限」分支会顶替它
  ];
  it.each(rows)("→ %s：%s", (kind, message) => {
    expect(classifyLarkFailure(new LarkApiError(message))).toBe(kind);
    // 普通 Error 同样认（调用方抛的不一定是 LarkApiError）
    expect(classifyLarkFailure(new Error(message))).toBe(kind);
  });

  it("文案顺序：'rate limit exceeded' 是限流，不是内容超限", () => {
    expect(classifyLarkFailure(new Error("rate limit exceeded"))).toBe("rate_limit");
  });
});

describe("不该误判（误判成致命类 = 放弃一张本来还能更新的卡）", () => {
  it.each([
    ["request took too long（超时的口语，不是内容超限）", new Error("request took too long")],
    ["随便一句话", new Error("something exploded")],
    ["boom", new Error("boom")],
    ["空消息", new Error("")],
    ["纯字符串", "oops"],
    ["null", null],
    ["undefined", undefined],
    ["数字", 42],
    ["空对象", {}],
  ])("%s → unknown", (_label, err) => {
    expect(classifyLarkFailure(err)).toBe("unknown");
  });

  it("CLI 的退出码（code: 1）不是飞书错误码 → unknown", () => {
    const err = Object.assign(new Error("Command failed"), { code: 1 });
    expect(classifyLarkFailure(err)).toBe("unknown");
    expect(classifyLarkFailure(new LarkApiError("Command failed", { code: 2 }))).toBe("unknown");
  });

  it("表外的飞书错误码（没见过的）→ unknown，不猜", () => {
    expect(classifyLarkFailure(withCode(99999999, "weird"))).toBe("unknown");
  });
});

describe("带整条命令行的 message（`Command failed: <argv>\\n<stderr>`）：命令行里的正文不参与判定", () => {
  const ARGV = (userText: string): string =>
    `Command failed: lark-cli api PUT /open-apis/cardkit/v1/cards/x --data {"content":"${userText}"}`;

  it("正文里恰好写着 access denied / rate limit / 429，真正的原因在 stderr 里是断网 → transient", () => {
    const err = new LarkApiError(ARGV("Access denied, rate limit 429, 权限不足, 限流"), {
      raw: { stdout: "", stderr: "Error: connect ECONNRESET\n" },
    });
    expect(classifyLarkFailure(err)).toBe("transient");
  });

  it("stderr 里才是真原因：Access denied → auth", () => {
    const err = new LarkApiError(ARGV("你好"), {
      raw: { stdout: "", stderr: "Error: Access denied\n" },
    });
    expect(classifyLarkFailure(err)).toBe("auth");
  });

  it("原生 execFile 错误（stderr 直接挂在错误对象上）同样只看 stderr", () => {
    const err = Object.assign(new Error(ARGV("Card content exceeds limit")), {
      stdout: "",
      stderr: "Error: socket hang up",
    });
    expect(classifyLarkFailure(err)).toBe("transient");
  });

  it("stderr / stdout 都没有 → 命令行里的字样一律不算，unknown", () => {
    const err = new LarkApiError(ARGV("Access denied 429 exceeds limit"), {
      raw: { stdout: "", stderr: "" },
    });
    expect(classifyLarkFailure(err)).toBe("unknown");
  });

  it("stdout 里的飞书错误（ok:false 的 JSON）也看：流式已关", () => {
    const err = new LarkApiError(ARGV("x"), {
      raw: { stdout: JSON.stringify({ ok: false, error: { message: "streaming mode is closed" } }), stderr: "" },
    });
    expect(classifyLarkFailure(err)).toBe("stream_closed");
  });

  it("不带 Command failed 前缀的 message 照常看（不能把整类 message 都屏蔽掉）", () => {
    expect(classifyLarkFailure(new LarkApiError("Access denied"))).toBe("auth");
  });
});

describe("既有传输瞬时判据仍是最后一道", () => {
  it("message 只是 Command failed，真正的 EOF 只在 raw.stderr → transient", () => {
    const err = new LarkApiError("Command failed", { raw: { stderr: "EOF" } });
    expect(classifyLarkFailure(err)).toBe("transient");
  });

  it("具体类别优先于「瞬时」：'card streaming timeout' 里有 timeout，但它是 stream_closed", () => {
    expect(classifyLarkFailure(new Error("card streaming timeout"))).toBe("stream_closed");
  });

  it("单段文本上限：几十 KB 的 stderr 只看尾部，原因在尾部就认得出", () => {
    const err = new LarkApiError("Command failed", {
      raw: { stdout: "", stderr: `${"垃圾行\n".repeat(20_000)}Error: card entity does not exist` },
    });
    expect(classifyLarkFailure(err)).toBe("gone");
  });
});

describe("判定用全文（证据文本）：非 Error 抛出物 / message 头部 / 直挂 stdout / 单段上限 2000", () => {
  const ARGV = (userText: string): string =>
    `Command failed: lark-cli api PUT /open-apis/cardkit/v1/cards/x --data {"content":"${userText}"}`;

  it("非 Error 抛出物（字符串）：按字符串化后的文案分类，不是一律 unknown", () => {
    expect(classifyLarkFailure("rate limit exceeded")).toBe("rate_limit");
    expect(classifyLarkFailure("Access denied")).toBe("auth");
    expect(classifyLarkFailure("The card entity does not exist")).toBe("gone");
  });

  it("单段上限是 2000 字符：message 头部第 150 / 1900 个字符之后的原因照样认得出（上限不能缩得太小）", () => {
    expect(classifyLarkFailure(new Error(`${"x".repeat(150)} rate limit`))).toBe("rate_limit");
    expect(classifyLarkFailure(new Error(`${"x".repeat(1900)} rate limit`))).toBe("rate_limit");
  });

  it("不带命令行的超长 message 取头不取尾：原因在头部 → 认得出；只出现在 2000 字符之后 → 不认", () => {
    expect(classifyLarkFailure(new Error(`rate limit ${"x".repeat(3000)}`))).toBe("rate_limit");
    expect(classifyLarkFailure(new Error(`${"x".repeat(3000)} rate limit`))).toBe("unknown");
  });

  it("非 Error 的超长字符串同样只看头部 2000 字符", () => {
    expect(classifyLarkFailure(`rate limit ${"x".repeat(3000)}`)).toBe("rate_limit");
    expect(classifyLarkFailure(`${"x".repeat(3000)} rate limit`)).toBe("unknown");
  });

  it("原生 execFile 错误：stdout 直接挂在错误对象上（不在 raw 里）也看，和 stderr 对称", () => {
    const viaStdout = Object.assign(new Error(ARGV("x")), { stdout: "streaming mode is closed", stderr: "" });
    expect(classifyLarkFailure(viaStdout)).toBe("stream_closed");
    const viaStderr = Object.assign(new Error(ARGV("x")), { stdout: "", stderr: "streaming mode is closed" });
    expect(classifyLarkFailure(viaStderr)).toBe("stream_closed");
  });
});

describe("文案表的优先级：同一段文案同时命中多个类别时，表里靠前的赢（更具体的在前，transient 在最后）", () => {
  it.each<[LarkFailureKind, string]>([
    ["seq_conflict", "Sequence Number Compare Failed (rate limit)"], // seq_conflict 在 rate_limit 前
    ["gone", "card entity does not exist (permission denied)"], // gone 在 auth 前
    ["auth", "access denied: too many requests"], // auth 在 rate_limit 前
    ["rate_limit", "rate limit exceeded: internal error"], // rate_limit 在 transient 前
    ["too_long", "content exceeds the size limit (internal error)"], // too_long 在 transient 前
  ])("→ %s：%s", (kind, message) => {
    expect(classifyLarkFailure(new LarkApiError(message))).toBe(kind);
  });
});
