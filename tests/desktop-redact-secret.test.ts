/**
 * electron-app/desktop/redact-secret.mjs —— 开机密码「在手上」的那一层，错误出门之前把整串密码抹掉。
 *
 * 下游（事件 / 审计 / 日志 / 给 AI 的错误文案）都认不出密码，所以必须在这一层抹；这里钉死抹法本身：
 * 整串替换、不被正则 / 替换模板的特殊字符带偏、没有密码时不动文字、Error 保留身份。
 */
import { describe, expect, it } from "vitest";

import { redactError, redactSecret, SECRET_MASK, secretForms } from "../electron-app/desktop/redact-secret.mjs";

describe("redactSecret", () => {
  it("把所有出现的整串密码换成占位；占位和设置页 toast 的 scrubSecret 一致（•••）", () => {
    expect(SECRET_MASK).toBe("•••");
    expect(redactSecret("无法输入 hunter2，请检查 hunter2", "hunter2")).toBe("无法输入 •••，请检查 •••");
  });

  it("按字面整串匹配：密码里有正则 / 替换模板的特殊字符也不会被带偏", () => {
    for (const pw of ["a.b*c", "(x|y)+", "[a-z]", "$&", "$1$`$'", "a\\b", "^$", "?+*"]) {
      const text = `前缀 ${pw} 后缀 ${pw}`;
      expect(redactSecret(text, pw), pw).toBe("前缀 ••• 后缀 •••");
    }
    // 特殊字符的密码不会误伤别的文字：正则里的 . 不是「任意字符」
    expect(redactSecret("axb", "a.b")).toBe("axb");
  });

  it("拿不到密码（空串 / undefined / null / 非字符串）：文字原样返回，不因此被改动", () => {
    for (const secret of ["", undefined, null, 123, {}]) {
      expect(redactSecret("无法输入 abc", secret)).toBe("无法输入 abc");
    }
  });

  it("文字里没有密码：原样返回", () => {
    expect(redactSecret("钥匙串需要你本人授权才能读取", "S3cret-Pass!")).toBe("钥匙串需要你本人授权才能读取");
    expect(redactSecret("", "S3cret-Pass!")).toBe("");
  });

  it("入参不是字符串（Error / 数字）：先转成文字再抹，不抛错", () => {
    expect(redactSecret(new Error("bad S3cret-Pass!"), "S3cret-Pass!")).toBe("Error: bad •••");
    expect(redactSecret(42, "4")).toBe("•••2");
  });

  it("只抹整串：只回显了其中几个字符的认不出来，不动它（不是误抹）", () => {
    expect(redactSecret("无法输入 S3cre", "S3cret-Pass!")).toBe("无法输入 S3cre");
  });
});

// 第三轮评审：只做精确子串匹配，密码含 `"` 或 `\` 时，原生层 / 管道把入参 JSON 序列化后回显的那份就漏了
describe("redactSecret：同一个密码在常见序列化里的写法也抹（JSON / URL 编码 / 反斜杠转义引号）", () => {
  it("JSON 字符串里的样子：密码含 \" 和 \\ 时，管道协议回显整段请求也抹得掉（评审原话的场景）", () => {
    const pw = 'p"a\\ss';
    const echoed = `helper 报错：无法解析请求 ${JSON.stringify({ op: "set", password: pw })}`;
    expect(echoed).not.toContain(pw); // 对照：原样的密码确实不在里面——旧实现抹不到
    expect(echoed).toContain(String.raw`p\"a\\ss`);
    const out = redactSecret(echoed, pw);
    expect(out).toBe('helper 报错：无法解析请求 {"op":"set","password":"•••"}');
    // 密码的任何片段都不剩（含 JSON 转义留下的反斜杠序列）
    expect(out).not.toContain('a\\ss');
    expect(out).not.toContain('p\\"a');
  });

  it("JSON 字符串里的样子：控制字符 / 非 ASCII 不会被误处理（只是原样或 \\uXXXX）", () => {
    const pw = "密码\t换行\n结束";
    const out = redactSecret(`请求 ${JSON.stringify({ password: pw })} 与原样 ${pw}`, pw);
    expect(out).toBe('请求 {"password":"•••"} 与原样 •••');
  });

  it("URL 编码的样子（encodeURIComponent）", () => {
    const pw = "p@ss word&x=1/#";
    const url = `https://h.example/set?pw=${encodeURIComponent(pw)}`;
    expect(url).not.toContain(pw);
    expect(redactSecret(`请求失败：${url}`, pw)).toBe("请求失败：https://h.example/set?pw=•••");
  });

  it("反斜杠转义引号的写法（shell / JS 字面量 / inspect 一类回显）：' → \\'、\" → \\\"、\\ → \\\\", () => {
    const pw = `it's"a\\b`;
    expect(redactSecret(String.raw`bad arg 'it\'s\"a\\b'`, pw)).toBe("bad arg '•••'");
  });

  it("几种写法同时出现、互相包含也抹得干净：长的先抹，不留半截（没有残留的反斜杠 / 引号）", () => {
    const pw = 'a"b\\c';
    const text = `raw ${pw} | json ${JSON.stringify(pw).slice(1, -1)} | uri ${encodeURIComponent(pw)} | esc ${pw.replace(/[\\'"]/g, "\\$&")}`;
    expect(redactSecret(text, pw)).toBe("raw ••• | json ••• | uri ••• | esc •••");
  });

  it("长的先抹：一个写法把另一个整个含在里面（密码以反斜杠结尾 → JSON 写法 a\\\\ 含原样 a\\），不留半截、不多出占位", () => {
    const pw = "a\\";
    expect(redactSecret(String.raw`{"pw":"a\\"}`, pw)).toBe('{"pw":"•••"}');
    // 单个反斜杠：JSON 写法 \\ 抹成一个占位，不是两个
    expect(redactSecret(String.raw`x \\ y`, "\\")).toBe("x ••• y");
  });

  it("纯字母数字的密码：各种写法都等于原样，不产生多余的抹法（没有误抹别的文字）", () => {
    expect(secretForms("hunter2")).toEqual(["hunter2"]);
    expect(redactSecret("无法输入 hunter2 / HUNTER2 / hunter / 2", "hunter2")).toBe("无法输入 ••• / HUNTER2 / hunter / 2");
  });

  it("畸形 UTF-16（落单的代理对）：encodeURIComponent 会抛 URIError，只跳过那一种写法，其余照抹、不抛错", () => {
    const pw = 'x"\ud800y';
    expect(() => redactSecret(`bad ${pw}`, pw)).not.toThrow();
    expect(redactSecret(`bad ${pw}`, pw)).toBe("bad •••");
    // JSON.stringify 对落单代理对输出 \ud800 转义（良构 JSON）：这一种写法照抹
    expect(redactSecret(`json ${JSON.stringify(pw).slice(1, -1)}`, pw)).toBe("json •••");
  });

  it("secretForms：去重、去空、长的在前；非空串都至少含原样", () => {
    expect(secretForms("hunter2")).toEqual(["hunter2"]);
    const forms = secretForms('a"b');
    expect(forms).toContain('a"b');
    expect(forms).toContain('a\\"b');
    expect(new Set(forms).size).toBe(forms.length);
    for (let i = 1; i < forms.length; i += 1) expect(forms[i - 1]!.length).toBeGreaterThanOrEqual(forms[i]!.length);
  });
});

describe("redactError", () => {
  const SECRET = "S3cret-Pass!";

  it("message 带密码：换成抹干净的新 Error（原对象不被改动）", () => {
    const orig = new Error(`无法输入「${SECRET}」`);
    const out = redactError(orig, SECRET) as Error;
    expect(out).toBeInstanceOf(Error);
    expect(out).not.toBe(orig);
    expect(out.message).toBe("无法输入「•••」");
    expect(orig.message).toContain(SECRET); // 原对象没被动过
    // 抹干净的新 Error 里到处找不到密码：message / name / 序列化
    expect(`${out.name} ${out.message} ${String(out)} ${JSON.stringify({ ...out })}`).not.toContain(SECRET);
  });

  it("message 不带密码：原样返回同一个对象（调用方的 instanceof / 属性判断不受影响）", () => {
    class Custom extends Error {
      code = "E_X";
    }
    const orig = new Custom("键码输入模式只支持英文字母、数字和常见符号");
    expect(redactError(orig, SECRET)).toBe(orig);
  });

  it("保留 name 和字符串类型的 code（并且这两个字段里的密码也抹）", () => {
    const orig = Object.assign(new Error(`bad ${SECRET}`), { name: "KoffiError", code: `E_${SECRET}` });
    const out = redactError(orig, SECRET) as Error & { code?: string };
    expect(out.name).toBe("KoffiError");
    expect(out.code).toBe("E_•••");
    expect(out.message).toBe("bad •••");
  });

  it("抛的是字符串：带密码就换成抹干净的 Error，不带就原样", () => {
    const out = redactError(`bad argument: ${SECRET}`, SECRET) as Error;
    expect(out).toBeInstanceOf(Error);
    expect(out.message).toBe("bad argument: •••");
    expect(redactError("别的错误", SECRET)).toBe("别的错误");
  });

  it("抛的是普通对象 / null / undefined：没有 message 可抹，原样返回，不抛错", () => {
    const o = { code: 1 };
    expect(redactError(o, SECRET)).toBe(o);
    expect(redactError(null, SECRET)).toBeNull();
    expect(redactError(undefined, SECRET)).toBeUndefined();
  });

  it("拿不到密码（空串 / undefined）：原样返回同一个对象", () => {
    const orig = new Error(`bad ${SECRET}`);
    expect(redactError(orig, "")).toBe(orig);
    expect(redactError(orig, undefined)).toBe(orig);
  });

  it("message 里只有密码的 JSON 序列化写法（原样的不在）：同样换成抹干净的新 Error", () => {
    const pw = 'p"a\\ss';
    const orig = Object.assign(new Error(`请求格式不对：${JSON.stringify({ password: pw })}`), { code: `E_${encodeURIComponent(pw)}` });
    expect(orig.message).not.toContain(pw);
    const out = redactError(orig, pw) as Error & { code?: string };
    expect(out).not.toBe(orig);
    expect(out.message).toBe('请求格式不对：{"password":"•••"}');
    expect(out.code).toBe("E_•••");
    const all = `${out.name} ${out.message} ${out.code}`;
    for (const piece of ['p"a', 'p\\"a', "p%22a", "a\\\\ss", "a%5Css"]) expect(all, piece).not.toContain(piece);
  });
});
