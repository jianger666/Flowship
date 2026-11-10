/**
 * V2：server 侧凭据样式文本脱敏（src/lib/server/browser/redact-text.ts）。
 * 主进程只脱敏头；请求体 / 响应体 / URL 里的 Bearer / token= / password= / JWT 由这里再扫一遍。
 */
import { describe, expect, it } from "vitest";
import { REDACTED_TEXT, redactSensitiveText, redactSensitiveTextCounted } from "@/lib/server/browser/redact-text";

const JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

describe("redactSensitiveText", () => {
  it("Bearer / Basic 凭据：保留 scheme，值换成 [已隐藏]", () => {
    expect(redactSensitiveText("Authorization: Bearer abcDEF123456.xyz")).toBe(`Authorization: Bearer ${REDACTED_TEXT}`);
    expect(redactSensitiveText("curl -H 'authorization: bearer sk-live_1234567890'")).toContain(`bearer ${REDACTED_TEXT}`);
    expect(redactSensitiveText("Proxy: Basic dXNlcjpwYXNzd29yZA==")).toBe(`Proxy: Basic ${REDACTED_TEXT}`);
    // 「Bearer」后面不是凭据（太短 / 只是普通英文）不动
    expect(redactSensitiveText("the Bearer of bad news")).toBe("the Bearer of bad news");
  });

  it("JWT（三段 base64url）整体替换，哪怕没有任何键名", () => {
    expect(redactSensitiveText(`值是 ${JWT} 结束`)).toBe(`值是 ${REDACTED_TEXT} 结束`);
    // alg:none 的第三段为空
    expect(redactSensitiveText("eyJhbGciOiJub25lIn0.eyJzdWIiOiJhIn0.")).toBe(REDACTED_TEXT);
    // 两段不是 JWT：不动
    expect(redactSensitiveText("eyJhbGciOiJub25lIn0.eyJzdWIiOiJhIn0")).toBe("eyJhbGciOiJub25lIn0.eyJzdWIiOiJhIn0");
  });

  it("URL / form 里的 key=value：token / password / secret / api_key 等", () => {
    // （R1-26：`code=` 现在也会被藏，所以这里改用无害的 page=1 作对照；code= 的用例见下面的 R1-19 / R1-26 describe）
    expect(redactSensitiveText("https://a.test/cb?page=1&token=abc123&x=2")).toBe(`https://a.test/cb?page=1&token=${REDACTED_TEXT}&x=2`);
    expect(redactSensitiveText("user=bob&password=p@ss w0rd&remember=1")).toBe(`user=bob&password=${REDACTED_TEXT} w0rd&remember=1`);
    expect(redactSensitiveText("access_token=AAA&refresh_token=BBB")).toBe(`access_token=${REDACTED_TEXT}&refresh_token=${REDACTED_TEXT}`);
    expect(redactSensitiveText("client_secret=zzz;api_key=k1;apikey=k2")).toBe(`client_secret=${REDACTED_TEXT};api_key=${REDACTED_TEXT};apikey=${REDACTED_TEXT}`);
    expect(redactSensitiveText("X-CSRF-Token: abc")).toBe(`X-CSRF-Token: ${REDACTED_TEXT}`);
  });

  it("JSON：保持引号风格，数字 / null 值也隐藏", () => {
    const out = redactSensitiveText('{"user":"bob","password":"hunter2","token": "t-1","pwd":123456,"api_key":null}');
    expect(out).toBe(`{"user":"bob","password":"${REDACTED_TEXT}","token": "${REDACTED_TEXT}","pwd":${REDACTED_TEXT},"api_key":${REDACTED_TEXT}}`);
    expect(JSON.parse(redactSensitiveText('{"password":"x y z"}')).password).toBe(REDACTED_TEXT);
    expect(redactSensitiveText("{'secret': 'abc def'}")).toBe(`{'secret': '${REDACTED_TEXT}'}`);
  });

  it("不误伤：token_type / tokenizer / passwords 之类、普通文字", () => {
    expect(redactSensitiveText('{"token_type":"Bearer","expires_in":3600}')).toBe('{"token_type":"Bearer","expires_in":3600}');
    expect(redactSensitiveText("tokenizer=wordpiece")).toBe("tokenizer=wordpiece");
    expect(redactSensitiveText("password_hint=宠物名")).toBe("password_hint=宠物名");
    expect(redactSensitiveText("没有任何敏感内容的一段话，status: ok")).toBe("没有任何敏感内容的一段话，status: ok");
    expect(redactSensitiveText("")).toBe("");
  });

  it("同一段里多种形式并存：数量统计正确，且幂等（再扫一遍不变）", () => {
    const text = `POST /login\nAuthorization: Bearer abcdefgh12345\n\n{"password":"p1","jwt":"${JWT}"}\n?token=zzz`;
    const r = redactSensitiveTextCounted(text);
    expect(r.count).toBe(4);
    expect(r.text).not.toContain("abcdefgh12345");
    expect(r.text).not.toContain("p1");
    expect(r.text).not.toContain("SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c");
    expect(r.text).not.toContain("zzz");
    expect(redactSensitiveText(r.text)).toBe(r.text);
    expect(redactSensitiveTextCounted("无敏感").count).toBe(0);
  });

  it("入参不是字符串也不抛", () => {
    expect(redactSensitiveText(undefined as unknown as string)).toBe("");
    expect(redactSensitiveText(null as unknown as string)).toBe("");
  });
});

// ───────────── R1-19 / R1-26：脱敏缺口补强 ─────────────

describe("R1-19 / R1-26：转义 JSON、Authorization 方案、裸密钥、cookie、query 键名", () => {
  it("转义引号的 JSON（\\\"password\\\":\\\"abc\\\"）：键与值都被识别，转义引号风格保留", () => {
    const out = redactSensitiveText('{\\"user\\":\\"bob\\",\\"password\\":\\"hunter2\\",\\"token\\": \\"t-1\\"}');
    expect(out).toBe(`{\\"user\\":\\"bob\\",\\"password\\":\\"${REDACTED_TEXT}\\",\\"token\\": \\"${REDACTED_TEXT}\\"}`);
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("t-1");
    // 值里带转义引号的普通 JSON 串：整串吃掉（旧版会在第一个 \" 处停下，后半段残留）
    expect(redactSensitiveText('{"password":"ab\\"cd","x":1}')).toBe(`{"password":"${REDACTED_TEXT}","x":1}`);
  });

  it("Authorization 的 Token / Bearer / Basic / Digest 方案：方案词保留，凭据整体替换（旧版 Token 只换了方案词、凭据残留）", () => {
    expect(redactSensitiveText("Authorization: Token abc123def")).toBe(`Authorization: Token ${REDACTED_TEXT}`);
    expect(redactSensitiveText("authorization: token abc123def")).toBe(`authorization: token ${REDACTED_TEXT}`);
    expect(redactSensitiveText("Authorization: Bearer abcDEF123456")).toBe(`Authorization: Bearer ${REDACTED_TEXT}`);
    expect(redactSensitiveText("Authorization: Basic dXNlcjpwYXNz")).toBe(`Authorization: Basic ${REDACTED_TEXT}`);
    expect(redactSensitiveText('Proxy-Authorization: Digest username="bob", response="zz"')).toBe(`Proxy-Authorization: Digest ${REDACTED_TEXT}"`); // 行尾紧贴的闭合符原样保留（这里是 response="zz" 的收尾引号）
    expect(redactSensitiveText("curl -H 'authorization: bearer sk-live_1234567890' https://a.test")).toBe(
      `curl -H 'authorization: bearer ${REDACTED_TEXT}' https://a.test`, // 凭据之后的 URL 不被连带吃掉
    );
    // JSON / 转义 JSON 形态
    expect(redactSensitiveText('{"authorization":"Token abc123def","x":1}')).toBe(`{"authorization":"Token ${REDACTED_TEXT}","x":1}`);
    expect(redactSensitiveText('{\\"authorization\\":\\"Token abc123def\\"}')).toBe(`{\\"authorization\\":\\"Token ${REDACTED_TEXT}\\"}`);
    // 一个凭据只算一处，且幂等
    const r = redactSensitiveTextCounted("Authorization: Token abc123def");
    expect(r.count).toBe(1);
    expect(redactSensitiveTextCounted(r.text)).toEqual({ text: r.text, count: 0 });
    // 没有 authorization 键时，裸的「Token xxx」是普通英文，不动
    expect(redactSensitiveText("Token expired, please login again")).toBe("Token expired, please login again");
  });

  it("裸密钥：sk- / ghp_ / xox / glpat- / AKIA / AIza（没有任何键名也要藏）", () => {
    const sk = "sk-proj-AbCdEf1234567890GhIjKlMn";
    const ghp = "ghp_" + "A1b2C3d4E5".repeat(4);
    const xox = "xoxb-123456789012-abcdefABCDEF";
    const glpat = "glpat-abcdefghij0123456789";
    const aws = "AKIAIOSFODNN7EXAMPLE";
    const gk = "AIzaSyA-1234567890abcdefghijklmnopqrstu";
    for (const secret of [sk, ghp, xox, glpat, aws, gk]) {
      const out = redactSensitiveText(`log: got ${secret} from env`);
      expect(out, secret).toBe(`log: got ${REDACTED_TEXT} from env`);
    }
    expect(redactSensitiveTextCounted(`${sk} ${ghp}`).count).toBe(2);
  });

  it("cookie 键：cookie 头整行（含第二个及以后的键值对）、JSON 的 cookie、cookie= 参数", () => {
    expect(redactSensitiveText("Cookie: sid=abc; theme=dark; _ga=GA1.2.3")).toBe(`Cookie: ${REDACTED_TEXT}`);
    expect(redactSensitiveText("set-cookie: session=xyz; Path=/; HttpOnly")).toBe(`set-cookie: ${REDACTED_TEXT}`);
    expect(redactSensitiveText('{"cookie":"a=1; b=2","x":1}')).toBe(`{"cookie":"${REDACTED_TEXT}","x":1}`);
    expect(redactSensitiveText("https://a.test/?cookie=abc&x=1")).toBe(`https://a.test/?cookie=${REDACTED_TEXT}&x=1`);
  });

  it("code / key / sig / sid / session 等 query 参数名与键名（R1-26）", () => {
    expect(redactSensitiveText("https://a.test/cb?code=4/0AbCdEf&state=xyz")).toBe(`https://a.test/cb?code=${REDACTED_TEXT}&state=xyz`);
    expect(redactSensitiveText("grant_type=authorization_code&code=abc123&redirect_uri=x")).toBe(
      `grant_type=authorization_code&code=${REDACTED_TEXT}&redirect_uri=x`,
    );
    expect(redactSensitiveText("https://maps.test/api?key=AIzaFAKE&q=cafe")).toBe(`https://maps.test/api?key=${REDACTED_TEXT}&q=cafe`);
    expect(redactSensitiveText("https://cdn.test/a.png?sig=deadbeef&sid=42&session=s1&w=100")).toBe(
      `https://cdn.test/a.png?sig=${REDACTED_TEXT}&sid=${REDACTED_TEXT}&session=${REDACTED_TEXT}&w=100`,
    );
    // 带分隔的复合键名
    expect(redactSensitiveText("access_key=AK1&private-key=PK1&x-auth-key: k9")).toBe(
      `access_key=${REDACTED_TEXT}&private-key=${REDACTED_TEXT}&x-auth-key: ${REDACTED_TEXT}`,
    );
    expect(redactSensitiveText("x-amz-signature=0123abcd&csrf=zz&PHPSESSID=abc")).toBe(
      `x-amz-signature=${REDACTED_TEXT}&csrf=${REDACTED_TEXT}&PHPSESSID=${REDACTED_TEXT}`,
    );
  });

  it("不误伤：普通调试信息 / 相近词（反例）", () => {
    const innocent = [
      "status_code=200",
      "error code: 404",
      "zipcode=1000&barcode=123",
      "keyboard=us&monkey=banana&hotkey=ctrl",
      "turkey: yes",
      "assignment=done",
      "tokenizer=wordpiece&token_type=bearer",
      "password_hint=宠物名",
      "the Bearer of bad news",
      "Token expired, please login again",
      "see sk-learn-is-a-python-library for details",
      "task-force-delta-assessment-report-final",
      "ghp is not a token prefix here",
      "keys of the map; sessions=3",
      "https://a.test/cb?page=1&sort=asc&q=hello",
    ];
    for (const s of innocent) {
      expect(redactSensitiveText(s), s).toBe(s);
    }
  });

  it("2 万字符的 [\\w.-] 连续串：线性耗时（旧版前缀 (?:[\\w.-]*?) 无锚点，O(L²)）", () => {
    const L = 20_000;
    const shapes: Record<string, string> = {
      hex: "0123456789abcdef".repeat(L / 16),
      a: "a".repeat(L),
      dashes: "a-".repeat(L / 2),
      dots: "a.".repeat(L / 2),
      underscores: "k_".repeat(L / 2),
      tokens: "token".repeat(L / 5),
      keys: "key=".repeat(L / 4),
      sks: "sk-".repeat(Math.floor(L / 3)),
      quotes: '"'.repeat(L),
      escapedQuotes: 'password=\\"'.repeat(L / 11),
    };
    for (const [name, s] of Object.entries(shapes)) {
      const t0 = performance.now();
      redactSensitiveText(s);
      const ms = performance.now() - t0;
      expect(ms, `${name} 耗时 ${ms.toFixed(1)}ms`).toBeLessThan(200);
    }
    // 长串末尾的真键仍然被识别（线性化不能以漏报为代价）
    const long = `${"x".repeat(5000)}_token=SECRET1 tail`;
    expect(redactSensitiveText(long)).toBe(`${"x".repeat(5000)}_token=${REDACTED_TEXT} tail`);
  });

  it("JWT 跨越旧的截断点：脱敏发生在截断之前才不会残留前两段（顺序约束的单元级演示）", () => {
    const text = `url=https://a.test/cb?next=${JWT}`;
    // 先脱敏：干净
    expect(redactSensitiveText(text)).not.toContain("eyJ");
    // 先截（在第二段中间切断）再脱敏：残留 header——这就是调用方必须「先脱敏后截断」的原因
    const cutAt = text.indexOf(".", text.indexOf("eyJ") + 10) + 8;
    expect(redactSensitiveText(text.slice(0, cutAt))).toContain("eyJ");
  });
});
