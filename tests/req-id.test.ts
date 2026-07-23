/**
 * deriveReqId：绑飞书 story → REQ-<数字id>；否则 → REQ-TASK-<id 末段大写>
 * URL 边界与 extractFeishuStoryId 对齐（detail/<digits> 优先、≥6 位数字兜底）
 */
import { describe, expect, it } from "vitest";

import { deriveReqId } from "@/lib/req-id";

describe("deriveReqId", () => {
  it("绑了 Meegle story URL → REQ-<story 数字 id>", () => {
    expect(
      deriveReqId({
        id: "t_1779873168206_hr7qin",
        feishuStoryUrl:
          "https://project.feishu.cn/wk-dm/story/detail/7042596005",
      }),
    ).toBe("REQ-7042596005");
  });

  it("没绑飞书链接 → REQ-TASK-<task id 最后一段大写>", () => {
    expect(
      deriveReqId({
        id: "t_1779873168206_hr7qin",
      }),
    ).toBe("REQ-TASK-HR7QIN");
  });

  it("飞书链接为空串 / 空白 → 同没绑，走 TASK 兜底", () => {
    expect(
      deriveReqId({
        id: "t_1_abc",
        feishuStoryUrl: "   ",
      }),
    ).toBe("REQ-TASK-ABC");
    expect(
      deriveReqId({
        id: "t_1_xyz",
        feishuStoryUrl: "",
      }),
    ).toBe("REQ-TASK-XYZ");
  });

  it("URL 无 detail 段但有 ≥6 位数字 → 仍抠出 id（与 extractFeishuStoryId 兜底一致）", () => {
    expect(
      deriveReqId({
        id: "t_1_abc",
        feishuStoryUrl: "https://project.feishu.cn/?id=12345678",
      }),
    ).toBe("REQ-12345678");
  });

  it("URL 绑了但抠不出数字 id → 回退 REQ-TASK-…", () => {
    expect(
      deriveReqId({
        id: "t_99_fallback",
        feishuStoryUrl: "https://project.feishu.cn/wk-dm/story/abc",
      }),
    ).toBe("REQ-TASK-FALLBACK");
  });

  it("bug detail URL 同样能抠数字（detail/<digits> 不限 story）", () => {
    expect(
      deriveReqId({
        id: "t_1_x",
        feishuStoryUrl: "https://project.feishu.cn/wk-dm/bug/detail/999888777",
      }),
    ).toBe("REQ-999888777");
  });
});
