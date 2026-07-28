/**
 * REQ-ID：**只认用户手填、系统绝不猜**
 *
 * 曾经有一条派生链（飞书链接 → `REQ-<storyId>`、再兜底 `REQ-TASK-<task id 末段>`），
 * 已整条删除——团队 wk-harness 规范（SKILL.md:49）要求「没有 REQ-ID 必须先要求补充、
 * 不要猜测」，编号由需求 owner 跑完 `wk:biz-confirm` 后分发。本文件锁的就是「不猜」：
 * 没手填 → `resolveReqId` 返 null（门禁跳过、prompt 不注入），而不是造一个出来。
 *
 * 手填值会被拼进 `requirements/<REQ-ID>` 路径，所以非法字面（路径穿越 / 空格）必须挡在门外。
 */
import { describe, expect, it } from "vitest";

import {
  isValidReqId,
  normalizeReqId,
  reqIdPatchValue,
  resolveReqId,
} from "@/lib/req-id";

describe("isValidReqId / normalizeReqId", () => {
  it("字母数字开头 + . _ - 合法", () => {
    expect(isValidReqId("REQ-7042596005")).toBe(true);
    expect(isValidReqId("REQ_DEMO.v2")).toBe(true);
    expect(isValidReqId("2026Q3-001")).toBe(true);
  });

  it("路径穿越 / 空格 / 空串 / 点开头一律非法", () => {
    // 这几个会被拼进 requirements/<REQ-ID>，放过去就是任意路径写入
    expect(isValidReqId("../../etc")).toBe(false);
    expect(isValidReqId("REQ/../x")).toBe(false);
    expect(isValidReqId("REQ\\x")).toBe(false);
    expect(isValidReqId(".hidden")).toBe(false);
    expect(isValidReqId("REQ 123")).toBe(false);
    expect(isValidReqId("")).toBe(false);
  });

  it("normalizeReqId：去空白后合法才留、否则 undefined", () => {
    expect(normalizeReqId("  REQ-1  ")).toBe("REQ-1");
    expect(normalizeReqId("   ")).toBeUndefined();
    expect(normalizeReqId(undefined)).toBeUndefined();
    expect(normalizeReqId("../x")).toBeUndefined();
  });
});

describe("resolveReqId：有就是有、没有就是 null（不派生）", () => {
  it("手填了就用手填值", () => {
    expect(resolveReqId({ reqId: "REQ-MANUAL-1" })).toBe("REQ-MANUAL-1");
    expect(resolveReqId({ reqId: "  REQ-7042596005  " })).toBe(
      "REQ-7042596005",
    );
  });

  // ⚠️ 回归锁：这两条以前会分别派生出 REQ-<storyId> / REQ-TASK-<id 末段>——
  // 规范明令「没有 REQ-ID 必须先要求补充、不要猜测」，猜出来的编号会在 WK 产出目录里留空壳
  it("没手填 → null，绑没绑飞书链接都一样", () => {
    expect(resolveReqId({})).toBeNull();
    expect(resolveReqId({ reqId: undefined })).toBeNull();
    expect(resolveReqId({ reqId: "" })).toBeNull();
    expect(resolveReqId({ reqId: "   " })).toBeNull();
  });

  it("手填非法字面 → null，不让脏值进路径", () => {
    expect(resolveReqId({ reqId: "../../etc" })).toBeNull();
    expect(resolveReqId({ reqId: "REQ 123" })).toBeNull();
  });
});

describe("reqIdPatchValue（新建表单 / 编辑弹窗共用的提交判定）", () => {
  it("填了什么存什么（去首尾空白）", () => {
    expect(reqIdPatchValue("REQ-CUSTOM-9")).toBe("REQ-CUSTOM-9");
    expect(reqIdPatchValue("  REQ-CUSTOM-9  ")).toBe("REQ-CUSTOM-9");
  });

  // 编辑弹窗里清空编号 = 「这个 task 没有 REQ-ID」，必须落 null 让后端删字段；
  // 落 undefined 的话 PATCH 里压根没这个 key、旧值会留着
  it("空 / 纯空白 → null（清空语义）", () => {
    expect(reqIdPatchValue("")).toBeNull();
    expect(reqIdPatchValue("   ")).toBeNull();
  });

  it("非法字面原样上送、不在客户端静默吞掉（服务端 400 才有提示）", () => {
    expect(reqIdPatchValue("REQ 123")).toBe("REQ 123");
    expect(reqIdPatchValue("../../etc")).toBe("../../etc");
  });
});
