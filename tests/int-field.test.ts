/**
 * 端口 / DB 整数输入的失焦校验（S13-16）：留空回填默认、非法 / 越界拒绝
 */
import { describe, expect, it } from "vitest";

import { PORT_MAX, PORT_MIN, parseIntField } from "@/lib/int-field";

const port = { min: PORT_MIN, max: PORT_MAX, fallback: 22 };

describe("parseIntField", () => {
  it("留空（含纯空白）→ empty + 回填默认值（编辑中不回填、失焦才回填）", () => {
    expect(parseIntField("", port)).toEqual({ status: "empty", value: 22 });
    expect(parseIntField("   ", port)).toEqual({ status: "empty", value: 22 });
  });

  it("合法端口 1 / 22 / 65535 → ok", () => {
    expect(parseIntField("1", port)).toEqual({ status: "ok", value: 1 });
    expect(parseIntField("2222", port)).toEqual({ status: "ok", value: 2222 });
    expect(parseIntField("65535", port)).toEqual({ status: "ok", value: 65535 });
  });

  it("越界（0 / 65536 / 负数）→ invalid、不回填", () => {
    expect(parseIntField("0", port).status).toBe("invalid");
    expect(parseIntField("65536", port).status).toBe("invalid");
    expect(parseIntField("-1", port).status).toBe("invalid");
    expect(parseIntField("70000", port).status).toBe("invalid");
  });

  it("非整数 / 科学计数 / 进制前缀 / 夹杂字符 → invalid", () => {
    for (const bad of ["1.5", "1e3", "0x10", "22abc", "abc", "--1"]) {
      expect(parseIntField(bad, port).status).toBe("invalid");
    }
  });

  it("DB 序号范围 0–N：0 合法、负数非法、留空回填 0", () => {
    const db = { min: 0, max: 1023, fallback: 0 };
    expect(parseIntField("0", db)).toEqual({ status: "ok", value: 0 });
    expect(parseIntField("15", db)).toEqual({ status: "ok", value: 15 });
    expect(parseIntField("-1", db).status).toBe("invalid");
    expect(parseIntField("", db)).toEqual({ status: "empty", value: 0 });
  });

  // `<input type="number">` 里敲了非法字符（`22e`、`2-2`、`--`）时，浏览器的 `.value` 是空串（只有 `validity.badInput` 为真），
  // 文本层看上去和「用户清空」一模一样——不区分的话，端口会被静默回填成默认值并提交（用户以为是把 2222 打错了，
  // 实际 SSH 端口悄悄变回 22）。调用方把 `badInput` 传进来，必须按「非法、不回填、不提交」处理。
  it("浏览器判定输入非法（badInput）时，即使文本是空串也不能当成「留空回填」", () => {
    expect(parseIntField("", port, { badInput: true })).toEqual({ status: "invalid" });
    expect(parseIntField("   ", port, { badInput: true })).toEqual({ status: "invalid" });
    // badInput 只会让结果更严：合法文本理论上不会同时 badInput，但若同时出现也按非法算（以浏览器判定为准）
    expect(parseIntField("2222", port, { badInput: true }).status).toBe("invalid");
  });

  it("badInput 未传 / 为 false 时行为不变（留空照常回填）", () => {
    expect(parseIntField("", port, { badInput: false })).toEqual({ status: "empty", value: 22 });
    expect(parseIntField("", port, {})).toEqual({ status: "empty", value: 22 });
    expect(parseIntField("2222", port, { badInput: false })).toEqual({ status: "ok", value: 2222 });
  });
});

// 组件层契约：IntInput 必须把浏览器的 validity.badInput 读出来传给 parseIntField，
// 否则上面的纯函数修了也没人调用（没有渲染环境，只能靠源码断言接线）
describe("IntInput 接线", () => {
  it("失焦时读取 validity.badInput 并传给 parseIntField", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/components/ui/int-input.tsx", "utf8");
    expect(src).toMatch(/validity\.badInput/);
    expect(src).toMatch(/parseIntField\(\s*text\s*,\s*\{[^}]*\}\s*,\s*\{\s*badInput\s*\}\s*\)/);
  });
});
