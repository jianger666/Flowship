/**
 * Q13-09：`stripAnsi`——剥掉终端控制序列，让预览 dev server 的输出能被正则探到 URL、`logTail` 不是转义乱码。
 *
 * 真实形态来自实测：picocolors 1.1.1（vite 用的）在 `FORCE_COLOR=0` 下照样上色，
 * `cyan("http://localhost:" + bold("5173") + "/")` 得到 `ESC[36mhttp://localhost:ESC[1m5173ESC[22m/ESC[39m`。
 *
 * 变异（逐个换掉正则的某一段，对应用例都会红）：
 *  - CSI 参数字节 `[0-?]` 缩成 `[0-9]` → 「私有模式 ESC[?25l」那条红；
 *  - CSI 中间字节 `[ -/]` 删掉 → 「带中间字节的 CSI」红；CSI 终止字节缩成字母 → 「终止字节不只是字母」红；
 *  - 去掉全局标志 g → 「同一行里有多段序列」红；
 *  - OSC 只认 BEL / 只认 ST → 两条超链接各红一条；OSC 允许吞掉 ESC（`[^BEL]`）→ 「OSC 没有结束符」红；
 *  - 「其余序列」终止字节放开 `[` / `]` → 「不完整的 CSI / OSC 原样」红；
 *  - 删掉 `includes(ESC)` 快速路径不改变结果（纯性能），不在此处求杀。
 */
import { describe, expect, it } from "vitest";

import { stripAnsi } from "@/lib/strip-ansi";

const ESC = "\u001b";
const BEL = "\u0007";

describe("stripAnsi：真实输出形态", () => {
  it("vite：端口单独加粗，ESC 码把 `localhost:` 与端口隔开——剥完是干净的 URL", () => {
    const raw = `${ESC}[36mhttp://localhost:${ESC}[1m5173${ESC}[22m/${ESC}[39m`;
    expect(stripAnsi(raw)).toBe("http://localhost:5173/");
  });

  it("整段 URL 上色：尾部的 ESC[39m 不会留在地址后面", () => {
    expect(stripAnsi(`${ESC}[36mhttp://localhost:3000${ESC}[39m`)).toBe("http://localhost:3000");
  });

  it("一整行启动横幅：箭头 / 加粗 / 中文都在，只有转义被去掉", () => {
    const raw = `  ${ESC}[32m➜${ESC}[39m  ${ESC}[1m本地${ESC}[22m:   ${ESC}[36mhttp://localhost:${ESC}[1m5173${ESC}[22m/${ESC}[39m`;
    expect(stripAnsi(raw)).toBe("  ➜  本地:   http://localhost:5173/");
  });

  it("同一行里有多段序列：全部剥掉（不是只剥第一段）", () => {
    expect(stripAnsi(`${ESC}[31ma${ESC}[0m ${ESC}[32mb${ESC}[0m ${ESC}[33mc${ESC}[0m`)).toBe("a b c");
  });

  it("多行文本：每一行都干净，换行原样保留", () => {
    const raw = `${ESC}[2K${ESC}[1Gcompiling${ESC}[0m\n${ESC}[32mready${ESC}[39m in 320 ms\n`;
    expect(stripAnsi(raw)).toBe("compiling\nready in 320 ms\n");
  });
});

describe("stripAnsi：三类序列", () => {
  it("CSI：颜色 / 清行 / 移动光标 / 单独的 reset", () => {
    expect(stripAnsi(`${ESC}[0m`)).toBe("");
    expect(stripAnsi(`a${ESC}[mb`)).toBe("ab"); // 参数可以省略（等价于 ESC[0m）
    expect(stripAnsi(`${ESC}[38;5;208morange${ESC}[0m`)).toBe("orange");
    expect(stripAnsi(`${ESC}[2K${ESC}[1G${ESC}[3A`)).toBe("");
  });

  it("CSI 终止字节不只是字母（~ / @ / `）", () => {
    expect(stripAnsi(`a${ESC}[3~b${ESC}[2@c${ESC}[5\`d`)).toBe("abcd");
  });

  it("CSI 私有模式（参数字节里有 ?）：隐藏 / 显示光标", () => {
    expect(stripAnsi(`${ESC}[?25lbuilding${ESC}[?25h`)).toBe("building");
  });

  it("CSI 带中间字节（ESC [ 0 空格 q：设置光标形状）", () => {
    expect(stripAnsi(`x${ESC}[0 qy`)).toBe("xy");
  });

  it("OSC 8 终端超链接：以 BEL 结束", () => {
    const raw = `${ESC}]8;;http://localhost:3000${BEL}http://localhost:3000${ESC}]8;;${BEL}`;
    expect(stripAnsi(raw)).toBe("http://localhost:3000");
  });

  it("OSC 8 终端超链接：以 ST（ESC \\）结束", () => {
    const raw = `${ESC}]8;;http://localhost:3000${ESC}\\打开预览${ESC}]8;;${ESC}\\`;
    expect(stripAnsi(raw)).toBe("打开预览");
  });

  it("OSC 窗口标题", () => {
    expect(stripAnsi(`${ESC}]0;vite dev${BEL}ready`)).toBe("ready");
  });

  it("其余 ESC 序列：重置 / 存取光标 / 选字符集 / 孤立的 ST", () => {
    expect(stripAnsi(`a${ESC}cb${ESC}7c${ESC}8d${ESC}(Be${ESC}\\f`)).toBe("abcdef");
  });
});

describe("stripAnsi：不瞎剥", () => {
  it("没有 ESC 字符：原样返回（包括看起来像序列的字面文本）", () => {
    const s = "plain [36m text [0m ]8;;x";
    expect(stripAnsi(s)).toBe(s);
    expect(stripAnsi("")).toBe("");
  });

  it("不完整的 CSI（被切在两个 chunk 之间的前半截）：原样保留、不吃正文", () => {
    expect(stripAnsi(`abc${ESC}[3`)).toBe(`abc${ESC}[3`);
    expect(stripAnsi(`abc${ESC}[`)).toBe(`abc${ESC}[`);
    expect(stripAnsi(`abc${ESC}`)).toBe(`abc${ESC}`);
  });

  it("OSC 没有结束符：原样保留（不会一路吞到行尾）", () => {
    const raw = `abc${ESC}]8;;http://localhost:3000 后面的正文`;
    expect(stripAnsi(raw)).toBe(raw);
  });

  it("OSC 内容里出现另一个 ESC：不跨过它去找结束符", () => {
    // 第一段 OSC 没结束就来了 ESC[1m：OSC 不剥，后面完整的 CSI 照剥
    expect(stripAnsi(`${ESC}]8;;x${ESC}[1mbold${ESC}[22m${BEL}`)).toBe(`${ESC}]8;;xbold${BEL}`);
  });

  it("半截 ESC[ 后面紧跟别的序列：只剥完整的那段", () => {
    expect(stripAnsi(`${ESC}[${ESC}[31mred${ESC}[0m`)).toBe(`${ESC}[red`);
  });
});

describe("stripAnsi：线性时间（dev server 的每个输出块都过这里）", () => {
  it("两万段没有结束符的 OSC：原样返回、不超时（回溯爆炸会把默认 5 秒用满）", () => {
    const raw = `${ESC}]8;;x`.repeat(20_000);
    expect(stripAnsi(raw)).toBe(raw);
  });

  it("五万个半截 ESC[ 后面跟一个终止字节：只有最后那段完整的被剥", () => {
    const raw = `${ESC}[`.repeat(50_000) + "m";
    expect(stripAnsi(raw)).toBe(`${ESC}[`.repeat(49_999));
  });
});

describe("stripAnsi：【已知局限】不处理的形态（要改请连同源码注释一起改）", () => {
  it("DCS / APC 这类字符串型序列：只剥掉开头与结尾的转义、负载文字原样留下", () => {
    expect(stripAnsi(`a${ESC}Ptmux;xyz${ESC}\\b`)).toBe("atmux;xyzb");
    expect(stripAnsi(`a${ESC}_payload${ESC}\\b`)).toBe("apayloadb");
  });

  it("C1 单字节控制符（U+009B 等）不处理：dev server 的输出里基本不会出现", () => {
    expect(stripAnsi("a\u009b31mb")).toBe("a\u009b31mb");
  });
});
