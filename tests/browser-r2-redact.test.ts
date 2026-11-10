/**
 * R2-04：脱敏补强的回归测试。
 *  · redact-text.ts（server 侧文本脱敏）：JWT / cookie 正则的回溯上限、键名表补 pass / passcode / pin / otp / jwt、console 文本里的 userinfo；
 *  · net-detail.mjs（主进程网络详情脱敏）：头名与 query 键名共用词表、h2 伪头、质询头里的 token68、userinfo 吃到最后一个 `@`、
 *    query 值里嵌套的 JSON / URL 凭据。
 * 耗时用例按「旧实现 ≥ 1s、新实现 < 100ms」选的规模，阈值留足 4 倍以上余量，不依赖机器快慢的精确值。
 */
import { describe, expect, it } from "vitest";

import {
  isSensitiveHeader,
  isSensitiveQueryKey,
  REDACTED,
  redactHeaders,
  redactUrlSecrets,
} from "../electron-app/browser/net-detail.mjs";
import { REDACTED_TEXT, redactSensitiveText, redactSensitiveTextCounted } from "@/lib/server/browser/redact-text";

const timed = (fn: () => void): number => {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
};

const b64u = (n: number, ch = "A"): string => ch.repeat(n);
const JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

describe("R2-04 ①：redact-text 的 ReDoS 上限", () => {
  it("`eyJabcde-` 重复 10 万字符：每个起点都是合法 JWT 头开头，不能每个都扫到串尾（旧版 O(n²)，约 2s）", () => {
    const s = "eyJabcde-".repeat(11_000);
    const ms = timed(() => redactSensitiveText(s));
    expect(ms, `耗时 ${ms.toFixed(0)}ms`).toBeLessThan(400);
  });

  it("`cookie:` 重复 10 万字符：COOKIE_HEADER_RE 的前瞻有上限（旧版每个起点扫到串尾，约 2s）", () => {
    const s = "cookie:".repeat(14_000);
    const ms = timed(() => redactSensitiveText(s));
    expect(ms, `耗时 ${ms.toFixed(0)}ms`).toBeLessThan(400);
  });

  it("加了上限也不能漏报：真 JWT（含 1500 字符的长 header、2 万字符的大 payload）、带 x5c 的长头、真 cookie 行照样整体隐藏", () => {
    const longHeader = `eyJ${b64u(1500)}.eyJzdWIiOiJhIn0.sig`;
    expect(redactSensitiveText(`t=${longHeader};`)).toBe(`t=${REDACTED_TEXT};`);
    const bigPayload = `eyJhbGciOiJIUzI1NiJ9.eyJ${b64u(20_000, "B")}.c2ln`;
    expect(redactSensitiveText(`x ${bigPayload} y`)).toBe(`x ${REDACTED_TEXT} y`);
    expect(redactSensitiveText(`值是 ${JWT} 结束`)).toBe(`值是 ${REDACTED_TEXT} 结束`);
    // cookie 名正常长度（几十字符）：整行隐藏
    expect(redactSensitiveText(`Cookie: ${"n".repeat(60)}=abc; theme=dark`)).toBe(`Cookie: ${REDACTED_TEXT}`);
  });
});

describe("R2-04 ②：键名表补 pass / passcode / pin / otp / jwt", () => {
  it("命中：整词 / 以 _ - . 分隔的后缀；= 与 : 两种写法；JSON 键；hotp / totp", () => {
    const cases: Array<[string, string]> = [
      ["pass=hunter2", `pass=${REDACTED_TEXT}`],
      ["user_pass: hunter2", `user_pass: ${REDACTED_TEXT}`],
      ["passcode=1234", `passcode=${REDACTED_TEXT}`],
      ["login_passcode=1234", `login_passcode=${REDACTED_TEXT}`],
      ['{"pin":"4321"}', `{"pin":"${REDACTED_TEXT}"}`],
      ["x-pin=4321", `x-pin=${REDACTED_TEXT}`],
      ["otp=123456", `otp=${REDACTED_TEXT}`],
      ["sms.otp: 123456", `sms.otp: ${REDACTED_TEXT}`],
      ["totp=123456", `totp=${REDACTED_TEXT}`],
      ["hotp=123456", `hotp=${REDACTED_TEXT}`],
      ["jwt=abc.def", `jwt=${REDACTED_TEXT}`],
      ['{"jwt":"abc"}', `{"jwt":"${REDACTED_TEXT}"}`],
      ["id_jwt=abc", `id_jwt=${REDACTED_TEXT}`],
    ];
    for (const [input, expected] of cases) expect(redactSensitiveText(input), input).toBe(expected);
  });

  it("边界不误伤：bypass / compass / passenger / passport / spin / ping / hotpot / potpourri / pinned 原样", () => {
    for (const s of [
      "bypass=1", "compass=north", "passenger=3", "passport=ok", "spin=fast", "ping=1", "hotpot=yes", "potpourri=1", "pinned=true",
      "bypass_cache: yes", "opinion=none",
    ]) {
      expect(redactSensitiveText(s), s).toBe(s);
    }
  });
});

describe("R2-04 ②：console 文本里的 userinfo", () => {
  it("`https://user:pw@host` 整段隐藏；密码里含 @ 时吃到最后一个 @；一行多个都处理", () => {
    expect(redactSensitiveText("Failed to load https://alice:hunter2@host.test/x?y=1")).toBe(`Failed to load https://${REDACTED_TEXT}@host.test/x?y=1`);
    // 密码里有 @：旧写法（userinfo 不含 @）只会吃到第一个 @，`ss` 残留
    const out = redactSensitiveText("GET https://user:p@ss@h.test/a");
    expect(out).toBe(`GET https://${REDACTED_TEXT}@h.test/a`);
    expect(out).not.toContain("ss");
    expect(redactSensitiveText("postgres://u:pw@db:5432/x and redis://:tok@cache:6379")).toBe(
      `postgres://${REDACTED_TEXT}@db:5432/x and redis://${REDACTED_TEXT}@cache:6379`,
    );
  });

  it("幂等 + 计数；路径 / 查询里的 @、没有 scheme 的 `git@host:` 不是 userinfo", () => {
    const once = redactSensitiveTextCounted("https://alice:hunter2@host.test/");
    expect(once.count).toBe(1);
    const twice = redactSensitiveTextCounted(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.count).toBe(0);
    for (const s of [
      "https://example.com/@user/profile?k=1", "git@github.com:a/b.git", "mailto:a@b.com", "https://a.test/cb?email=a@b.com",
      "visit https://a.test/ or mail a@b.com",
    ]) {
      expect(redactSensitiveText(s), s).toBe(s);
    }
  });

  it("长串字母（没有 ://）不触发二次方扫描：4 万字符 < 400ms（旧版每个位置都向后扫，约 2.5s）", () => {
    const ms = timed(() => redactSensitiveText("a".repeat(40_000)));
    expect(ms, `耗时 ${ms.toFixed(0)}ms`).toBeLessThan(400);
  });
});

describe("R2-04 ③：net-detail 头名与 query 键名共用词表", () => {
  it("头名补 pass / pwd / otp / pin / bypass 等（词表 + 头独有的 bypass），大小写不敏感，值被隐藏", () => {
    const sensitive = [
      "X-Otp", "x-totp", "X-Pin", "X-Pincode", "X-Pass", "x-pwd", "X-Passcode", "X-User-Pass", "X-Vercel-Protection-Bypass", "x-bypass-token",
      "X-Sid", "X-Sig", "X-Ticket", "x-hotp",
    ];
    for (const n of sensitive) expect(isSensitiveHeader(n), n).toBe(true);
    const out = redactHeaders(Object.fromEntries(sensitive.map((n) => [n, "RAW-SECRET"])));
    expect(JSON.stringify(out)).not.toContain("RAW-SECRET");
  });

  it("边界：passenger / compass / spin / ping / hotpot 之类的头原样；`code` 只对 query 成立（x-error-code 是状态码，不藏）", () => {
    for (const n of ["X-Passenger-Id", "X-Compass", "X-Spin", "X-Ping", "X-Hotpot", "X-Error-Code", "X-Status-Code", "Accept-Language", "X-Request-Id"]) {
      expect(isSensitiveHeader(n), n).toBe(false);
    }
    expect(isSensitiveQueryKey("code")).toBe(true);
    // `bypass` 只对头成立：query 里的 bypass=1 是开关
    expect(isSensitiveQueryKey("bypass")).toBe(false);
  });

  it("query 键名也用同一份词表：pin / pincode / hotp / totp 命中，别的原样", () => {
    for (const k of ["pin", "pincode", "hotp", "totp", "PIN"]) {
      expect(isSensitiveQueryKey(k), k).toBe(true);
      expect(redactUrlSecrets(`/x?${k}=RAW&ok=1`), k).toBe(`/x?${k}=${REDACTED}&ok=1`);
    }
    for (const k of ["spin", "ping", "compass", "hotpot", "passenger"]) expect(isSensitiveQueryKey(k), k).toBe(false);
  });
});

describe("R2-04 ③：h2 伪头不因含 auth 被误藏", () => {
  it(":authority / :path / :method / :scheme 原样可见，值里的 URL 凭据仍脱敏", () => {
    expect(isSensitiveHeader(":authority")).toBe(false);
    const out = redactHeaders({ ":authority": "a.test", ":method": "GET", ":scheme": "https", ":path": "/cb?code=AUTHCODE&page=2", Authorization: "Bearer x" });
    expect(out[":authority"]).toBe("a.test");
    expect(out[":method"]).toBe("GET");
    expect(out[":scheme"]).toBe("https");
    expect(out[":path"]).toBe(`/cb?code=${REDACTED}&page=2`);
    expect(out.Authorization).toBe(REDACTED);
  });
});

describe("R2-04 ③：www-authenticate / proxy-authenticate 质询里的 token68", () => {
  it("`Negotiate <token>` / `NTLM <token>`：scheme 保留，token 隐藏（SPNEGO / NTLM 握手 token 是凭据材料）", () => {
    const out = redactHeaders({
      "WWW-Authenticate": "Negotiate oYIBhTCCAYGgAwoBAaGCAXAEggFsYIIBaAYJKoZIhvcSAQICAQBuggFXMIIBU6ADAgEFoQMCAQ6iBwMFACAAAACjggFeYYIBWjCCAVagAwIBBaENGwtFWEFNUExFLkNPTaIcMBqgAwIBA6ETMBEbBEhUVFAbCWxvY2FsaG9zdA==",
      "Proxy-Authenticate": "NTLM TlRMTVNTUAACAAAADAAMADgAAAA1goriU1fO",
    });
    expect(out["WWW-Authenticate"]).toBe(`Negotiate ${REDACTED}`);
    expect(out["Proxy-Authenticate"]).toBe(`NTLM ${REDACTED}`);
  });

  it("多个质询并列：只藏 token68，其它 scheme / realm / error 保持可见；已隐藏的再处理一遍不变（幂等）", () => {
    const out = redactHeaders({ "WWW-Authenticate": 'Negotiate oYIBhTCC, Bearer realm="api", error="invalid_token", Basic realm=x' });
    expect(out["WWW-Authenticate"]).toBe(`Negotiate ${REDACTED}, Bearer realm="api", error="invalid_token", Basic realm=x`);
    const again = redactHeaders(out);
    expect(again["WWW-Authenticate"]).toBe(out["WWW-Authenticate"]);
  });

  it("没有 token68 的质询原样（纯 scheme、只有 auth-param），行为与 R1 的豁免测试一致", () => {
    const same = ["Negotiate", 'Bearer realm="api", error="invalid_token"', "Basic realm=proxy", 'Negotiate, Basic realm="x"', "Digest realm=a, nonce=b"];
    for (const v of same) expect(redactHeaders({ "WWW-Authenticate": v })["WWW-Authenticate"], v).toBe(v);
  });
});

describe("R2-04 ③：URL userinfo 吃到最后一个 @，且线性", () => {
  it("`user:p@ss@host`：整段隐藏，不残留 ss；路径里的 @ 不是 userinfo", () => {
    expect(redactUrlSecrets("https://user:p@ss@h.test/p?x=1")).toBe(`https://${REDACTED}@h.test/p?x=1`);
    expect(redactUrlSecrets("https://user:a@b@c@h.test/")).toBe(`https://${REDACTED}@h.test/`);
    expect(redactUrlSecrets("https://example.com/@user/profile?k=1")).toBe("https://example.com/@user/profile?k=1");
    expect(redactUrlSecrets("https://a.test/cb?email=a@b.com")).toBe("https://a.test/cb?email=a@b.com");
  });

  it("长串字母（没有 ://）：3 万字符 < 400ms（旧版每个位置向后扫，约 1.4s）", () => {
    const ms = timed(() => redactUrlSecrets("a".repeat(30_000)));
    expect(ms, `耗时 ${ms.toFixed(0)}ms`).toBeLessThan(400);
  });
});

describe("R2-04 ③：query 值里嵌套的 JSON / URL 凭据", () => {
  it("JSON：原始引号 / percent 编码 / 两层编码 / `+` 当空格，整个值隐藏、别的参数原样", () => {
    const encoded = encodeURIComponent('{"token":"abc"}');
    const double = encodeURIComponent(encoded);
    for (const url of [
      '/p?data={"token":"abc"}&q=1',
      `/p?data=${encoded}&q=1`,
      `/p?data=${double}&q=1`,
      "/p?data={%22password%22:%22hunter2%22}&q=1",
      `/p?data=${encodeURIComponent('{"user":"bob","apiKey":"K"}')}&q=1`,
    ]) {
      const out = redactUrlSecrets(url);
      expect(out, url).toBe(`/p?data=${REDACTED}&q=1`);
    }
  });

  it("值本身是带凭据的 URL / 表单串：redirect_uri=…?code=… / next=…?password=…", () => {
    expect(redactUrlSecrets(`/p?redirect_uri=${encodeURIComponent("https://a.test/cb?code=xyz&state=s")}&q=1`)).toBe(`/p?redirect_uri=${REDACTED}&q=1`);
    expect(redactUrlSecrets(`/p?next=${encodeURIComponent("/login?password=hunter2")}&q=1`)).toBe(`/p?next=${REDACTED}&q=1`);
    expect(redactUrlSecrets("/p?cb=https%3A%2F%2Fa.test%2Fx%3Ftoken%3DSECRET1")).not.toContain("SECRET1");
  });

  it("不误伤：普通 URL 值、`{\"code\":200}`（JSON 里的 code 是状态码）、时间 12:30、带冒号的普通值、无害 JSON", () => {
    for (const url of [
      "/p?redirect_uri=https%3A%2F%2Fa.test%2Fx&q=1",
      "/p?filter={%22code%22:200,%22msg%22:%22ok%22}&q=1",
      '/p?filter={"code":200,"msg":"ok"}&q=1',
      "/p?time=12:30&q=a:b",
      `/p?cb=${encodeURIComponent('{"user":"bob","page":2}')}&q=1`,
      "/p?q=a=b==",
    ]) {
      expect(redactUrlSecrets(url), url).toBe(url);
    }
  });

  it("值遇到引号不再截断：`?token=\"abc\"` 整个值隐藏（旧版只把空值换成占位符，\"abc\" 原样残留）；头参数 rel=\"next\" 不是键值对", () => {
    const out = redactUrlSecrets('/p?token="abc"&q=1');
    expect(out).toBe(`/p?token=${REDACTED}&q=1`);
    expect(out).not.toContain("abc");
    expect(redactUrlSecrets('<https://a.test/b>; rel="next"')).toBe('<https://a.test/b>; rel="next"');
    expect(redactUrlSecrets('attachment;filename="a.pdf"')).toBe('attachment;filename="a.pdf"');
  });

  it("超长值（>4096）：只扫前 4096 字符，截断点落在 %XX 中间也能解码（不因半个转义整体放弃）；超出部分是已知边界", () => {
    // 前缀 27 字符 + 若干 %20：4096 的截断点恰在一个 `%` 之后 → 不修剪的话 decodeURIComponent 抛错、嵌套键永远看不到
    const value = `${encodeURIComponent('{"token":"a"}')}${"%20".repeat(2000)}`;
    expect(value.length).toBeGreaterThan(4096);
    expect(value.slice(0, 4096).endsWith("%")).toBe(true);
    expect(redactUrlSecrets(`/p?d=${value}&q=1`)).toBe(`/p?d=${REDACTED}&q=1`);
  });

  it("线性：大量 `a:` / `k=` 交替的长值不触发回溯（4000 字符内）", () => {
    const value = "a:".repeat(2000);
    const ms = timed(() => redactUrlSecrets(`/p?d=${value}&q=1`));
    expect(ms, `耗时 ${ms.toFixed(0)}ms`).toBeLessThan(200);
  });
});

// ───────────────────────── R3-03：脱敏漏报 ─────────────────────────

describe("R3-03 ① redact-text：表单体键名里的方括号 / 确认 / 序号 / 取值后缀", () => {
  const hidden = (input: string, mustNotContain: string[]) => {
    const out = redactSensitiveText(input);
    for (const x of mustNotContain) expect(out, input).not.toContain(x);
    expect(out, input).toContain(REDACTED_TEXT);
    return out;
  };

  it("Rails / Devise 的 `user[password]=` / `password_confirmation=`、`token_value=`、`password2=` 等整条隐藏", () => {
    hidden("user[password]=hunter2&a=1", ["hunter2"]);
    expect(redactSensitiveText("user[password]=hunter2&a=1")).toContain("a=1");
    hidden("password_confirmation=hunter2", ["hunter2"]);
    hidden("user[password_confirmation]=hunter2", ["hunter2"]);
    hidden("token_value=abcd1234efgh", ["abcd1234efgh"]);
    hidden("password2=hunter2", ["hunter2"]);
    hidden("new_password_again=hunter2", ["hunter2"]);
    hidden("passwordConfirmation=hunter2", ["hunter2"]);
    hidden("data[credit][token]=tok_123456", ["tok_123456"]);
    hidden("user[session]=abcdef123456", ["abcdef123456"]);
  });

  it("括号被 percent 编码 / JSON 键里带括号 / 冒号写法：同样隐藏", () => {
    hidden("user%5Bpassword%5D=hunter2&x=1", ["hunter2"]);
    hidden('{"user[password]":"hunter2","a":1}', ["hunter2"]);
    hidden("user[password]: hunter2", ["hunter2"]);
  });

  it("反例不误伤：token_type / tokenizer / password_strength / passport / bypass / user[name] / status_code[]", () => {
    for (const s of [
      "token_type=Bearer",
      "tokenizer=bert",
      "password_strength=strong",
      "passport=E12345",
      "bypass=1",
      "user[name]=alice",
      "status_code[]=200",
      "page[2]=x",
      "monkey[1]=banana",
      "keyboard=us",
    ]) {
      expect(redactSensitiveText(s), s).toBe(s);
    }
  });

  it("幂等：已脱敏的再处理一遍不变，计数不增", () => {
    const once = redactSensitiveTextCounted("user[password]=hunter2&password_confirmation=hunter2");
    expect(once.count).toBe(2);
    const twice = redactSensitiveTextCounted(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.count).toBe(0);
  });

  it("线性：带大量方括号 / 百分号 / 长键名的对抗输入不会触发二次方回溯（< 400ms）", () => {
    for (const s of [
      "a[".repeat(40_000),
      "%5B".repeat(30_000),
      "password[".repeat(10_000),
      "x[password".repeat(8_000),
      `${"k".repeat(50_000)}[password]=1`,
      "token_".repeat(15_000),
      "password_confirmation_".repeat(5_000),
    ]) {
      const ms = timed(() => redactSensitiveText(s));
      expect(ms, `${s.slice(0, 20)}… 耗时 ${ms.toFixed(0)}ms`).toBeLessThan(400);
    }
  });
});

describe("R3-03 ② net-detail：JSON 起头的 query 值里嵌着凭据（encodeURI 不编码 ; ? &）、pw 类键", () => {
  it("`?data={…;…,\"token\":\"SECRET\"}`：值在第一个 `;` 处旧版被截断、后半段看不到——现在整体隐藏", () => {
    const url = 'https://a.test/cb?note=1&data={%22note%22:%22a;b%22,%22token%22:%22SECRET123%22}&z=2';
    const out = redactUrlSecrets(url);
    expect(out).not.toContain("SECRET123");
    expect(out).toContain("note=1");
    expect(out).toContain(`data=${REDACTED}`);
    const q = redactUrlSecrets('https://a.test/cb?data={"a":"x?y","password":"SECRET123"}');
    expect(q).not.toContain("SECRET123");
    const amp = redactUrlSecrets("https://a.test/cb?p=%7B%22k%22:%22v&w%22,%22secret%22:%22SECRET123%22%7D");
    expect(amp).not.toContain("SECRET123");
    const arr = redactUrlSecrets("https://a.test/cb?p=[%7B%22token%22:%22SECRET123%22%7D];x=1");
    expect(arr).not.toContain("SECRET123");
  });

  it("凭据就在第一个分隔符之前：照旧只替换这个值、后面的参数保留（精确路径不受影响）；在分隔符之后：整体隐藏", () => {
    expect(redactUrlSecrets('https://a.test/cb?data={"token":"abc"}&q=1')).toBe(`https://a.test/cb?data=${REDACTED}&q=1`);
    expect(redactUrlSecrets("https://a.test/cb?data={%22note%22:%22a;b%22,%22token%22:%22abc%22}&q=1")).not.toContain("abc");
  });

  it("没有凭据的 JSON 值原样；`{\"code\":200}` 不误伤；幂等", () => {
    for (const u of [
      "https://a.test/cb?data={%22note%22:%22a;b%22,%22n%22:1}&z=2",
      "https://a.test/cb?data={%22code%22:200}",
      "https://a.test/cb?list=[1,2,3];x=1",
    ]) {
      expect(redactUrlSecrets(u), u).toBe(u);
    }
    const once = redactUrlSecrets("https://a.test/cb?data={%22token%22:%22SECRET123%22;}");
    expect(redactUrlSecrets(once)).toBe(once);
  });

  it("线性：大量 `?k={` 开头的值 / 超长 JSON 起头值（> 4096）不会拖慢（< 400ms），也不爆栈", () => {
    for (const s of ["?a={&b={&c=".repeat(8_000), `?a={${"x".repeat(200_000)}`, "?a=[%7B".repeat(20_000)]) {
      const ms = timed(() => redactUrlSecrets(s));
      expect(ms, `${s.slice(0, 16)}… 耗时 ${ms.toFixed(0)}ms`).toBeLessThan(400);
    }
  });

  it("`pw` / `psw` / `pswd` 作为整词：头名与 query 键名都敏感；pwa / pws / pwd 之外的相似词不误伤", () => {
    for (const k of ["pw", "user_pw", "X-Pswd", "psw"]) {
      expect(isSensitiveQueryKey(k), k).toBe(true);
      expect(isSensitiveHeader(k), k).toBe(true);
    }
    expect(isSensitiveQueryKey("userPsw")).toBe(true); // 驼峰只在 query 键名里切词（头名先转小写）
    for (const k of ["pwa", "pws", "psw1x", "spw", "power"]) {
      expect(isSensitiveQueryKey(k), k).toBe(false);
    }
    expect(redactUrlSecrets("https://a.test/login?pw=hunter2&name=a")).toBe(`https://a.test/login?pw=${REDACTED}&name=a`);
  });
});

// ───────────────────────── R4 复审 R3-03：打回的两点 + 新漏报 ─────────────────────────

describe("R4 复审 R3-03 ② net-detail：秘密值本身含 `;` `?` `&` 时，截断点之后的尾巴不能泄漏", () => {
  it("复审原例：前半段已命中、值在分隔符处被截断——整个起头 token 的尾部全藏", () => {
    expect(redactUrlSecrets('https://a.test/cb?data={"password":"ab;cd"}')).toBe(`https://a.test/cb?data=${REDACTED}`);
    expect(redactUrlSecrets('https://a.test/cb?data={"password":"ab?cd"}')).toBe(`https://a.test/cb?data=${REDACTED}`);
    // `&` 也一样；整个 token 尾部（含后面的参数）一起藏——宁可多藏
    expect(redactUrlSecrets('https://a.test/cb?data={"password":"ab&cd"}&x=1')).toBe(`https://a.test/cb?data=${REDACTED}`);
    expect(redactUrlSecrets('https://a.test/cb?json={"user":{"pw":"s;ecret"}}')).toBe(`https://a.test/cb?json=${REDACTED}`);
    for (const u of [
      'https://a.test/cb?data={"password":"ab;cd"}',
      'https://a.test/cb?data={"password":"ab?cd"}',
      'https://a.test/cb?data={"password":"ab&cd"}&x=1',
      'https://a.test/cb?json={"user":{"pw":"s;ecret"}}',
    ]) {
      const out = redactUrlSecrets(u);
      expect(out, u).not.toMatch(/cd|ecret/);
    }
  });

  it("percent 编码的 JSON、`[` 起头、单引号 JSON、转义引号：同样判成「没闭合」", () => {
    expect(redactUrlSecrets("https://a.test/cb?data=%7B%22password%22%3A%22ab;cd%22%7D&x=1")).toBe(`https://a.test/cb?data=${REDACTED}`);
    expect(redactUrlSecrets('https://a.test/cb?data=[{"token":"ab;cd"}]&x=1')).toBe(`https://a.test/cb?data=${REDACTED}`);
    expect(redactUrlSecrets("https://a.test/cb?data={'password':'ab;cd'}&x=1")).toBe(`https://a.test/cb?data=${REDACTED}`);
    // 字符串里有转义引号：`"a\"b;c"` 里的 `;` 仍在字符串内，没闭合
    expect(redactUrlSecrets('https://a.test/cb?data={"x":"a\\"b;c","token":"zz"}')).toBe(`https://a.test/cb?data=${REDACTED}`);
    // 键名敏感（值本身不含嵌套键）+ 值里有分隔符：同样整段藏
    expect(redactUrlSecrets('https://a.test/cb?token={"a":"b;c"}&q=1')).toBe(`https://a.test/cb?token=${REDACTED}`);
  });

  it("前半段已闭合（分隔符是真的参数分隔）：只替换这一个值，后面的参数保留——不能因此多藏", () => {
    expect(redactUrlSecrets('https://a.test/cb?data={"password":"abc"}&q=1')).toBe(`https://a.test/cb?data=${REDACTED}&q=1`);
    expect(redactUrlSecrets('https://a.test/cb?token={"a":1}&q=1')).toBe(`https://a.test/cb?token=${REDACTED}&q=1`);
    expect(redactUrlSecrets("https://a.test/cb?token=[1,2]&q=1")).toBe(`https://a.test/cb?token=${REDACTED}&q=1`);
    expect(redactUrlSecrets('https://a.test/cb?data={"password":"abc"};x=1')).toBe(`https://a.test/cb?data=${REDACTED};x=1`);
    // 引号里的括号不影响配平
    expect(redactUrlSecrets('https://a.test/cb?data={"password":"a{b[c"}&q=1')).toBe(`https://a.test/cb?data=${REDACTED}&q=1`);
  });

  it("R4-04 变异补强：「没闭合」的三个判据各自必要（括号深度 / 字符串转义 / 配平后落进没收尾的字符串）", () => {
    // ① 括号深度：没有引号参与，只靠深度判（去掉深度判据这几条尾巴会漏）
    expect(redactUrlSecrets('https://a.test/cb?data={"pin":12;34}')).toBe(`https://a.test/cb?data=${REDACTED}`);
    expect(redactUrlSecrets('https://a.test/cb?data={"token":{"v":1;2}}')).toBe(`https://a.test/cb?data=${REDACTED}`);
    expect(redactUrlSecrets('https://a.test/cb?password={"a":1;2}')).toBe(`https://a.test/cb?password=${REDACTED}`);
    // ② 字符串里的转义引号不能提前收尾：`"a\"` 之后的 `]` 仍在字符串里（不跳转义就会把 `]` 当真括号、判成已闭合 → `;c` 漏出）
    expect(redactUrlSecrets('https://a.test/cb?password=["a\\"]b;c')).toBe(`https://a.test/cb?password=${REDACTED}`);
    expect(redactUrlSecrets('https://a.test/cb?password={"a\\"}b;c')).toBe(`https://a.test/cb?password=${REDACTED}`);
    // ③ 括号已配平、后面又落进一个没收尾的字符串：不是合法 JSON，保守当没闭合（只看深度会放过 `;y`）
    expect(redactUrlSecrets('https://a.test/cb?password=[]"x;y')).toBe(`https://a.test/cb?password=${REDACTED}`);
    // 对照：真闭合的 JSON 后面的参数照旧保留
    expect(redactUrlSecrets('https://a.test/cb?password=["x"];c')).toBe(`https://a.test/cb?password=${REDACTED};c`);
  });

  it("非 JSON 的 `?password=ab;cd`：`;` 按 query 分隔符处理（老式写法的合理解读，写进注释的取舍）", () => {
    expect(redactUrlSecrets("https://a.test/cb?password=ab;cd")).toBe(`https://a.test/cb?password=${REDACTED};cd`);
  });

  it("没有凭据的 JSON 值与幂等不变；对抗输入线性", () => {
    for (const u of ["https://a.test/cb?data={%22code%22:200}&q=1", "https://a.test/cb?list=[1,2,3];x=1", 'https://a.test/cb?data={"a":"b;c"}&q=1']) {
      expect(redactUrlSecrets(u), u).toBe(u);
    }
    const once = redactUrlSecrets('https://a.test/cb?data={"password":"ab;cd"}');
    expect(redactUrlSecrets(once)).toBe(once);
    for (const s of ['?d={"password":"'.repeat(8_000), `?d={"password":"${"{[".repeat(60_000)}`, `?d=${"{".repeat(100_000)};password=1`, '?d={"a":"\\'.repeat(20_000)]) {
      const ms = timed(() => redactUrlSecrets(s));
      expect(ms, `${s.slice(0, 16)}… 耗时 ${ms.toFixed(0)}ms`).toBeLessThan(400);
    }
  });
});

describe("R4 复审 R3-03 ① redact-text：子键 `[confirm]` / `[]`、`otp_code` / `pin_code`、`pw` 类短词", () => {
  const hidden = (input: string, mustNotContain: string[]) => {
    const out = redactSensitiveText(input);
    for (const x of mustNotContain) expect(out, input).not.toContain(x);
    expect(out, input).toContain(REDACTED_TEXT);
    return out;
  };

  it("复审原例：`password[]=` / `password[confirm]=` / `user[password][confirm]=`（含 percent 编码与 JSON 键）", () => {
    hidden("password[]=hunter2", ["hunter2"]);
    hidden("password[confirm]=hunter2", ["hunter2"]);
    hidden("user[password][confirm]=hunter2&a=1", ["hunter2"]);
    expect(redactSensitiveText("user[password][confirm]=hunter2&a=1")).toContain("a=1");
    hidden("user%5Bpassword%5D%5Bconfirm%5D=hunter2", ["hunter2"]);
    hidden("password%5B%5D=hunter2", ["hunter2"]);
    hidden('{"user[password][confirm]":"hunter2"}', ["hunter2"]);
    hidden("token[0]=abcd1234&token[1]=efgh5678", ["abcd1234", "efgh5678"]);
    hidden("user[password][password_confirmation_attributes_x]=hunter2", ["hunter2"]); // 子键 ≤ 40 字符
  });

  it("`otp_code` / `pin_code` / `totp-code` / `otpCode` 命中；`pw` / `psw` / `pswd` 整词命中（与主进程词表同口径）", () => {
    for (const [s, secret] of [
      ["otp_code=123456", "123456"],
      ["pin_code=1234", "1234"],
      ["totp-code=654321", "654321"],
      ["hotp.code=111222", "111222"],
      ["otpCode=999888", "999888"],
      ["pincode=4321", "4321"],
      ["user[otp_code]=135790", "135790"],
      ["pw=abc12345", "abc12345"],
      ["psw=abc12345", "abc12345"],
      ["pswd=abc12345", "abc12345"],
      ["user_pw=abc12345", "abc12345"],
      ['{"pw":"abc12345"}', "abc12345"],
    ] as const) {
      hidden(s, [secret]);
    }
  });

  it("不误伤：zip_code / status_code / keyCode / pinned / pin_codes / spin_code / pwa / pws / pwned / power / hotpot / 过长子键", () => {
    for (const s of [
      "zip_code=1000",
      "status_code=200",
      "keyCode=13",
      "pinned=1",
      "pin_codes=1",
      "spin_code=1",
      "pwa=1",
      "pws=2",
      "pwned=1",
      "power=9",
      "hotpot=1",
      "sub[3]=x",
      "monkey[1]=banana",
    ]) {
      expect(redactSensitiveText(s), s).toBe(s);
    }
    // 子键超过 40 字符：不在口径内（有界是为了线性）；写在这里把边界钉死，免得有人悄悄放宽成无界
    const longSub = `password[${"a".repeat(41)}]=hunter2`;
    expect(redactSensitiveText(longSub)).toBe(longSub);
  });

  it("幂等、计数；对抗输入线性（< 400ms）", () => {
    const once = redactSensitiveTextCounted("password[]=a1&otp_code=22&pw=333&user[password][confirm]=4444");
    expect(once.count).toBe(4);
    const twice = redactSensitiveTextCounted(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.count).toBe(0);
    for (const s of [
      "password[a]".repeat(15_000),
      "user[password]".repeat(10_000),
      "password[".repeat(20_000),
      "pw[".repeat(30_000),
      "otp_".repeat(30_000),
      `password[${"x".repeat(200_000)}`,
      "%5B".repeat(30_000) + "password",
      "password%5B".repeat(15_000),
      "token[]".repeat(20_000),
    ]) {
      const ms = timed(() => redactSensitiveText(s));
      expect(ms, `${s.slice(0, 20)}… 耗时 ${ms.toFixed(0)}ms`).toBeLessThan(400);
    }
  });
});
