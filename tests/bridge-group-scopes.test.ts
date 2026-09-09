/**
 * 群功能权限探针 + scope 缺失翻译（测试机器人实盘：四个群 scope 缺了但主灯全绿）。
 */
import { describe, expect, it } from "vitest";

import {
  buildScopeAuthUrl,
  probeGroupScopes,
  REQUIRED_GROUP_SCOPES,
} from "@/lib/server/feishu-bridge/probe";
import { describeScopeShortage } from "@/lib/server/route-helpers";

describe("probeGroupScopes", () => {
  it("四个群 scope 全缺 → 红 + 深链", async () => {
    const r = await probeGroupScopes([], "cli_test");
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual([...REQUIRED_GROUP_SCOPES]);
    expect(r.authUrl).toBe(
      buildScopeAuthUrl("cli_test", REQUIRED_GROUP_SCOPES),
    );
    expect(r.detail).toContain("群 @ 解析");
  });

  it("齐 → 绿且无深链", async () => {
    const r = await probeGroupScopes([...REQUIRED_GROUP_SCOPES], "cli_test");
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.authUrl).toBeUndefined();
  });
});

describe("describeScopeShortage", () => {
  it("测试机器人实报错 → 点名缺的 scope + 指到设置页", () => {
    const out = describeScopeShortage(
      "access denied: app cli_aac269da35399cf9 has not applied for the required scope(s): im:chat:readonly, im:chat, im:chat.group_info:readonly, im:chat.members:read",
    );
    expect(out).toContain("im:chat.members:read");
    expect(out).toContain("设置页飞书桥接");
  });

  it("无关错误 → null（调用方原样走）", () => {
    expect(describeScopeShortage("fetch failed")).toBeNull();
    expect(describeScopeShortage("")).toBeNull();
  });

  it("P2 脏包：列表后跟英文句子 → 散文不进 scope 名", () => {
    const out = describeScopeShortage(
      "access denied: app cli_xxx has not applied for the required scope(s): im:chat, im:chat.read. Please apply in console.",
    );
    expect(out).toContain("im:chat.read");
    expect(out).not.toContain("Please");
    expect(out).not.toContain("console");
  });

  it("P2 脏包：列表后跟中文后缀 → 后缀不进 scope 名", () => {
    const out = describeScopeShortage(
      "has not applied for the required scope(s): im:chat。请去控制台开通",
    );
    expect(out).toContain("im:chat");
    expect(out).not.toContain("请去控制台");
  });

  it("P3 口径：不断言必须重进，只给补救分支", () => {
    const out = describeScopeShortage(
      "has not applied for the required scope(s): im:chat",
    );
    expect(out).toContain("若开通后仍不好使");
    expect(out).not.toContain("开通并重进群");
  });

  it("P3 行名：指设置页实盘存在的“权限齐全”行", () => {
    const out = describeScopeShortage(
      "has not applied for the required scope(s): im:chat",
    );
    expect(out).toContain("权限齐全");
    expect(out).not.toContain("群功能权限");
  });

  it("P3 统一：群探针 detail 自带同样的重进补救后缀", async () => {
    const r = await probeGroupScopes([], "cli_test");
    expect(r.detail).toContain("若开通后仍不好使");
  });
});
