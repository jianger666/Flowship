/**
 * tests/helpers/source-text.ts 自测：接线类 grep 测试靠它剥注释、按结构对账条件，它自己判错了，那些测试就是摆设
 */
import { describe, expect, it } from "vitest";

import { blockAfter, enclosingIfConditions, maskLiterals, stripComments } from "./helpers/source-text";

describe("stripComments", () => {
  it("行注释、块注释都剥掉；长度不变（下标 / 行号与原文一致）；换行保留", () => {
    const src = "const a = 1; // 尾注释\n/* 块\n注释 */ const b = 2;\n";
    const out = stripComments(src);
    expect(out).toHaveLength(src.length);
    expect(out).not.toContain("尾注释");
    expect(out).not.toContain("块");
    expect(out.split("\n")).toHaveLength(src.split("\n").length);
    expect(out).toContain("const a = 1;");
    expect(out).toContain("const b = 2;");
  });

  it("注释里照抄的那句代码不算数（这是剥注释的全部意义）", () => {
    const src = "// endMidRunForeignContent(task.id);\nfoo();\n/* endMidRunForeignContent(task.id); */\n";
    expect(stripComments(src)).not.toContain("endMidRunForeignContent");
  });

  it("字符串 / 模板文本里的 // 和 /* 不是注释（URL、路径通配）", () => {
    const src = [
      'const u = "https://example.com/a"; const g = \'src/**/*.ts\';',
      "const t = `http://x.test/${name}//y`;",
      "after();",
    ].join("\n");
    const out = stripComments(src);
    expect(out).toContain("https://example.com/a");
    expect(out).toContain("src/**/*.ts");
    expect(out).toContain("http://x.test/${name}//y");
    expect(out).toContain("after();");
  });

  it("正则字面量里的 // 和 /* 不是注释；除号后面的 // 才是注释", () => {
    const src = [
      "const re = /a\\/\\/b|[/*]x/g; const half = total / 2; // 真注释",
      "const q = /https?:\\/\\//.test(u);",
      "next();",
    ].join("\n");
    const out = stripComments(src);
    expect(out).toContain("/a\\/\\/b|[/*]x/g");
    expect(out).toContain("total / 2;");
    expect(out).not.toContain("真注释");
    expect(out).toContain("/https?:\\/\\//.test(u);");
    expect(out).toContain("next();");
  });

  it("return / typeof 之后的 / 是正则开头，标识符 / 右括号之后的 / 是除号", () => {
    const out = stripComments("function f(x) { return /a\\/\\/b/.test(x) ? (x) / 2 : y / 3; } // 尾");
    expect(out).toContain("return /a\\/\\/b/.test(x)");
    expect(out).toContain("(x) / 2");
    expect(out).toContain("y / 3;");
    expect(out).not.toContain("尾");
  });

  it("模板字符串的 ${} 里是代码：里面的注释照剥、里面的嵌套模板 / 花括号不乱", () => {
    const src = "const t = `a ${ fn({ k: 1 } /* 注 */) } b ${ `inner ${ 2 }` } // 不是注释`; tail();";
    const out = stripComments(src);
    expect(out).not.toContain("注 ");
    expect(out).toContain("// 不是注释`;");
    expect(out).toContain("tail();");
  });

  it("转义的引号 / 反引号不会提前结束字面量", () => {
    const src = 'const s = "a \\" // 还在字符串里"; const t = `x \\` // 还在模板里`; done(); // 真注释';
    const out = stripComments(src);
    expect(out).toContain("// 还在字符串里");
    expect(out).toContain("// 还在模板里");
    expect(out).not.toContain("真注释");
    expect(out).toContain("done();");
  });
});

describe("maskLiterals", () => {
  it("字符串 / 正则 / 模板文本的内容变成 _（定界符与 ${} 里的代码保留），长度不变", () => {
    const src = 'f("a && (b", /x\\)/, `t(${ g(1) })`)';
    const masked = maskLiterals(src);
    expect(masked).toHaveLength(src.length);
    expect(masked).toBe('f("_______", /___/, `__${ g(1) }_`)');
  });
});

describe("enclosingIfConditions", () => {
  const SRC = `
    if (a) {
      unrelated();
    }
    if (
      !sameSession &&
      !isOwner &&
      mode !== "chat" && // 注释里的 && 不算
      note === "a && b" &&
      (x || y) &&
      !(await deps.guardEnabled())
    ) {
      try {
        const boot = 1;
        if (boot && (await deps.wake(taskId))) {
          inner();
        }
      } catch (e) {
        recover();
      }
    }
    trailing();
  `;
  const clean = stripComments(SRC);

  it("按顶层 && 切成条件项：字符串里的 &&、括号里的 || 不切；取反保留", () => {
    expect(enclosingIfConditions(clean, "deps.wake(")).toEqual([
      "!sameSession",
      "!isOwner",
      'mode !== "chat"',
      'note === "a && b"',
      "(x || y)",
      "!(await deps.guardEnabled())",
    ]);
  });

  it("needle 在某个 if 的条件里不算「圈在块里」：继续往外找外层块 if", () => {
    // deps.wake( 出现在内层 if 的条件里 → 返回的是外层那个 if 的条件
    expect(enclosingIfConditions(clean, "deps.wake(")[0]).toBe("!sameSession");
    // inner() 在内层 if 的块里 → 内层的条件
    expect(enclosingIfConditions(clean, "inner()")).toEqual(["boot", "(await deps.wake(taskId))"]);
  });

  it("条件被取反 / 删掉：对账的数组变了（这是把条件钉成结构的意义）", () => {
    const flipped = clean.replace("!(await deps.guardEnabled())", "(await deps.guardEnabled())");
    expect(enclosingIfConditions(flipped, "deps.wake(")).not.toEqual(enclosingIfConditions(clean, "deps.wake("));
    const dropped = clean.replace("!isOwner &&", "");
    expect(enclosingIfConditions(dropped, "deps.wake(")).not.toContain("!isOwner");
  });

  it("注释里的 if / 注释里的 needle 不算", () => {
    const src = stripComments("// if (fake) { wake(); }\nif (real) {\n  // wake();\n  other();\n}\nwake();");
    expect(() => enclosingIfConditions(src, "wake();")).toThrow(/没有被任何块 if 包着|找不到/);
  });

  it("找不到 needle / 没有包着它的块 if：抛错，不静默返回空数组", () => {
    expect(() => enclosingIfConditions(clean, "nope()")).toThrow(/找不到/);
    expect(() => enclosingIfConditions(clean, "trailing()")).toThrow(/没有被任何块 if 包着/);
  });
});

describe("blockAfter", () => {
  const src = stripComments(`
    const run = async () => {
      try {
        a();
      } finally {
        // endMidRunForeignContent(id);
        cleanup("}"); 
      }
      after();
    };
  `);

  it("取 head 之后第一个 {…} 块：字符串里的花括号不干扰", () => {
    const block = blockAfter(src, "} finally");
    expect(block).toContain('cleanup("}");');
    expect(block).not.toContain("after()");
    expect(block).not.toContain("endMidRunForeignContent");
  });

  it("head 以 { 结尾也行；找不到抛错", () => {
    expect(blockAfter(src, "const run = async () => {")).toContain("after();");
    expect(() => blockAfter(src, "nope")).toThrow(/找不到/);
  });
});
