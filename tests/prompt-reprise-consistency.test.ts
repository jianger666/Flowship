/**
 * 第六轮 review A5：`prompts/_shared.md` §5 与 `prompts/_super.md` 对「[USER_MESSAGE] 改类要不要先复述」
 * 的写法不能互相冲突。
 *
 * 背景：_super.md 已明确「明确的小改动」（消息里写清改哪里 + 改成什么、只动单点 / 少数几处）可以跳过
 * ask_user 复述直接改，其余改类必须先复述；_shared.md 还写着「改类才弹 ask_user 复述」（读起来是一律复述），
 * agent 两处都会读到。这条测试只钉「两处对同一件事的说法一致」，不钉具体措辞。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const prompt = (name: string): string =>
  readFileSync(path.join(process.cwd(), "prompts", name), "utf8");

describe("[USER_MESSAGE] 改类复述规则：_shared.md 与 _super.md 口径一致", () => {
  const superMd = prompt("_super.md");
  const sharedMd = prompt("_shared.md");

  it("前提：_super.md 把「明确的小改动」定义为可跳过复述", () => {
    expect(superMd).toMatch(/\*\*明确的小改动\*\*[:：]直接改[^\n]*不弹复述/);
  });

  it("_shared.md 描述该流程的那一行：同样提到「明确的小改动」可跳过复述，不再是无条件「改类才弹复述」", () => {
    const line = sharedMd
      .split("\n")
      .find((l) => l.includes("[USER_MESSAGE]") && l.includes("二分类"));
    expect(line, "找不到 _shared.md 里描述 [USER_MESSAGE] 二分类的那一行").toBeTruthy();
    expect(line).toContain("明确的小改动");
    expect(line).not.toContain("改类才弹 ask_user 复述");
  });
});
