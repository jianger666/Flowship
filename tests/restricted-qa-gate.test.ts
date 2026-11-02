/**
 * 受限答疑准入闸（P0 硬化）纯函数层——真跑 decideRestrictedQaAdmission / describeRestrictedQaDenial /
 * 本租户学习。路由级（走 routeGroupInboundMessage）在 group-route-restricted-qa-gate.test.ts。
 *
 * 第 11 轮起**没有「按群开关」**（用户决定答疑默认开）：入参里不再有 `enabled`、也没有 `disabled` 这个拒绝原因。
 *
 * 注意（R7-2）：生产里真正生效的只有「机器人发件人拒绝」。租户 / 外部成员两道的判定逻辑在这里钉住，
 * 但当前 lark-cli compact 事件里没有 tenant_key / external 标记，生产里拿不到数据、这两道恒不拦；
 * 这里的用例是「将来数据源补上后的语义」，不要读成「现在已经防住外部租户」。
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetOwnTenantKeyForTest,
  decideRestrictedQaAdmission,
  describeRestrictedQaDenial,
  getOwnTenantKey,
  learnOwnTenantKey,
} from "@/lib/server/feishu-bridge/restricted-qa-gate";

const base = { senderIsBot: false } as const;

beforeEach(() => {
  __resetOwnTenantKeyForTest();
});

describe("decideRestrictedQaAdmission", () => {
  it("真人 + 无租户 / 外部信息 → 放行（默认放行，没有开关这一步）", () => {
    expect(decideRestrictedQaAdmission({ ...base })).toEqual({ allow: true });
  });

  it("老调用方多传的 enabled / 老 meta 里的开关值一律无效：传 false / undefined / null 也照样放行", () => {
    for (const enabled of [undefined, false, null, 0, "false"] as unknown[]) {
      expect(
        decideRestrictedQaAdmission({ ...base, enabled } as never),
      ).toEqual({ allow: true });
    }
  });

  it("机器人发件人 → bot_sender（即使租户一致）", () => {
    expect(
      decideRestrictedQaAdmission({
        ...base,
        senderIsBot: true,
        senderTenantKey: "t1",
        ownTenantKey: "t1",
      }),
    ).toEqual({ allow: false, reason: "bot_sender" });
  });

  it("租户：两边都有且不一致 → tenant_mismatch；一致 → 放行", () => {
    expect(
      decideRestrictedQaAdmission({ ...base, senderTenantKey: "t_other", ownTenantKey: "t_own" }),
    ).toEqual({ allow: false, reason: "tenant_mismatch" });
    expect(
      decideRestrictedQaAdmission({ ...base, senderTenantKey: "t_own", ownTenantKey: "t_own" }),
    ).toEqual({ allow: true });
  });

  it("租户：任一边拿不到（undefined / 空串 / 纯空白）都不拦——不猜", () => {
    for (const missing of [undefined, "", "   "]) {
      expect(
        decideRestrictedQaAdmission({ ...base, senderTenantKey: missing, ownTenantKey: "t_own" }),
      ).toEqual({ allow: true });
      expect(
        decideRestrictedQaAdmission({ ...base, senderTenantKey: "t_x", ownTenantKey: missing }),
      ).toEqual({ allow: true });
    }
  });

  it("外部成员标记：明确为 true → external_member；false / undefined → 放行", () => {
    expect(decideRestrictedQaAdmission({ ...base, senderExternal: true })).toEqual({
      allow: false,
      reason: "external_member",
    });
    expect(decideRestrictedQaAdmission({ ...base, senderExternal: false })).toEqual({
      allow: true,
    });
  });

  it("优先级：bot_sender > tenant_mismatch > external_member（只回报第一道拒绝原因）", () => {
    const all = {
      senderIsBot: true,
      senderTenantKey: "a",
      ownTenantKey: "b",
      senderExternal: true,
    };
    expect(decideRestrictedQaAdmission({ ...all })).toMatchObject({ reason: "bot_sender" });
    expect(decideRestrictedQaAdmission({ ...all, senderIsBot: false })).toMatchObject({
      reason: "tenant_mismatch",
    });
    expect(
      decideRestrictedQaAdmission({ ...all, senderIsBot: false, senderTenantKey: "b" }),
    ).toMatchObject({ reason: "external_member" });
  });
});

describe("describeRestrictedQaDenial", () => {
  it("每个原因都有中文文案、带提问人名，且文案之间互不相同", () => {
    const reasons = ["bot_sender", "tenant_mismatch", "external_member"] as const;
    const texts = reasons.map((r) => describeRestrictedQaDenial(r, "李四"));
    for (const t of texts) {
      expect(t).toContain("李四");
      expect(/[\u4e00-\u9fa5]/.test(t)).toBe(true);
    }
    expect(new Set(texts).size).toBe(reasons.length);
  });

  it("没有「未开启 / 去设置里开」这类开关文案（开关已删）", () => {
    const reasons = ["bot_sender", "tenant_mismatch", "external_member"] as const;
    for (const r of reasons) {
      const t = describeRestrictedQaDenial(r, "李四");
      expect(t).not.toMatch(/未开启|开启「|允许群成员/);
    }
  });
});

describe("本租户学习", () => {
  it("没学到之前 getOwnTenantKey 是 null；学到后可读；空值不覆盖已学到的", () => {
    expect(getOwnTenantKey()).toBeNull();
    learnOwnTenantKey(undefined);
    learnOwnTenantKey("   ");
    expect(getOwnTenantKey()).toBeNull();
    learnOwnTenantKey("t_own");
    expect(getOwnTenantKey()).toBe("t_own");
    learnOwnTenantKey("");
    learnOwnTenantKey(undefined);
    expect(getOwnTenantKey()).toBe("t_own");
  });
});
