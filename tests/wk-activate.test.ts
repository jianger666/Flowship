/**
 * Delivery Hub REQ 激活：字段校验 + Hub draft/confirm 协议
 */
import { describe, expect, it } from "vitest";

import {
  activateRequirementInHub,
  postHubJson,
  WkActivateError,
} from "@/lib/server/wk-activate";
import {
  DEMAND_PARTY_OPTIONS,
  isDemandPartyCode,
  isValidPlannedOnlineDate,
  isValidSemanticCode,
  matchHubOwnerValue,
  parseActivationOwners,
  validateWkActivateInput,
  wkActivateFieldErrors,
} from "@/lib/wk-activate";
import {
  HUB_ACTIVATE_PATH,
  HUB_ACTIVATION_DRAFT_PATH,
  HUB_HARNESS_TOKEN_HEADER,
} from "@/lib/wk-hub";

describe("wk activate 字段", () => {
  it("需求方码表覆盖 Hub 那 12 项", () => {
    expect(DEMAND_PARTY_OPTIONS.map((item) => item.value)).toEqual([
      "PM",
      "TECH",
      "HR",
      "BRAND",
      "SALES",
      "GROWTH",
      "ACADEMIC_OPS",
      "TEACHING",
      "CURRICULUM",
      "FINANCE",
      "USER_RESEARCH",
      "CS",
    ]);
    expect(isDemandPartyCode("TECH")).toBe(true);
    expect(isDemandPartyCode("教务")).toBe(false);
  });

  it("计划上线日只认真实 YYYY-MM-DD", () => {
    expect(isValidPlannedOnlineDate("2026-08-20")).toBe(true);
    expect(isValidPlannedOnlineDate("2026/08/20")).toBe(false);
    expect(isValidPlannedOnlineDate("2026-02-30")).toBe(false);
  });

  it("语义编码至少要有字母或数字", () => {
    expect(isValidSemanticCode("OPENSEA")).toBe(true);
    expect(isValidSemanticCode("  a1  ")).toBe(true);
    expect(isValidSemanticCode("---")).toBe(false);
    expect(isValidSemanticCode("")).toBe(false);
  });

  it("缺项按字段回填 error", () => {
    expect(wkActivateFieldErrors({})).toEqual({
      semanticCode: "请填写",
      businessLine: "请选择",
      techOwner: "请选择",
      plannedOnlineDate: "请选择",
    });
    expect(wkActivateFieldErrors({ semanticCode: "FOO" })).toEqual({
      businessLine: "请选择",
      techOwner: "请选择",
      plannedOnlineDate: "请选择",
    });
    expect(
      wkActivateFieldErrors({
        semanticCode: "FOO",
        businessLine: "TECH",
        techOwner: "clj",
      }),
    ).toEqual({
      plannedOnlineDate: "请选择",
    });
    expect(
      wkActivateFieldErrors({
        semanticCode: "FOO",
        businessLine: "TECH",
        techOwner: "clj",
        plannedOnlineDate: "2026-08-20",
      }),
    ).toEqual({});
  });

  it("完整输入才过 validate", () => {
    expect(
      validateWkActivateInput({
        projectUrl: "https://project.feishu.cn/foo/bar/detail/1",
        projectName: "ELA",
        semanticCode: "ELA",
        businessLine: "TECH",
        plannedOnlineDate: "2026-08-20",
        techOwner: "clj",
      }),
    ).toBeNull();
    expect(
      validateWkActivateInput({
        projectUrl: "",
        projectName: "ELA",
        semanticCode: "ELA",
        businessLine: "TECH",
        plannedOnlineDate: "2026-08-20",
        techOwner: "clj",
      }),
    ).toBe("缺少飞书工作项链接");
    expect(
      validateWkActivateInput({
        projectUrl: "https://project.feishu.cn/foo/bar/detail/1",
        projectName: "ELA",
        semanticCode: "ELA",
        businessLine: "TECH",
        plannedOnlineDate: "2026-08-20",
        techOwner: "",
      }),
    ).toBe("请选择技术 Owner");
  });

  it("Hub Owner 候选按 label / value 对飞书姓名预填账号", () => {
    const owners = parseActivationOwners([
      { label: "陈禄江", value: "clj" },
      { label: "肖康", value: "xk" },
    ]);
    expect(owners).toEqual([
      { label: "陈禄江", value: "clj" },
      { label: "肖康", value: "xk" },
    ]);
    expect(matchHubOwnerValue(owners, "陈禄江")).toBe("clj");
    expect(matchHubOwnerValue(owners, "clj")).toBe("clj");
    expect(matchHubOwnerValue(owners, "路人")).toBe("");
    expect(
      matchHubOwnerValue(
        [
          { label: "禄江", value: "chenlujiang" },
          { label: "Austin", value: "austin.cao" },
        ],
        "陈禄江",
      ),
    ).toBe("chenlujiang");
    expect(
      matchHubOwnerValue(
        [
          { label: "禄江", value: "a" },
          { label: "陈禄", value: "b" },
        ],
        "陈禄江",
      ),
    ).toBe("");
    expect(parseActivationOwners({ data: owners })).toEqual([]);
  });
});

const validInput = {
  projectUrl: "https://project.feishu.cn/foo/bar/detail/1",
  projectName: "ELA体验课报告",
  semanticCode: "ELA",
  businessLine: "TECH",
  plannedOnlineDate: "2026-08-20",
  techOwner: "clj",
  techOwnerName: "陈禄江",
};

describe("activateRequirementInHub", () => {
  it("草案已激活则复用 existingReqId、不再 confirm", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const result = await activateRequirementInHub(validInput, async (path, body) => {
      calls.push({ path, body });
      return {
        alreadyActivated: true,
        existingReqId: "ELA-123-2026082001",
      };
    });
    expect(result).toEqual({
      reqId: "ELA-123-2026082001",
      alreadyActivated: true,
    });
    expect(calls).toEqual([
      {
        path: HUB_ACTIVATION_DRAFT_PATH,
        body: {
          projectUrl: validInput.projectUrl,
          semanticCode: "ELA",
        },
      },
    ]);
  });

  it("未激活则带 Hub 账号 confirm，写出 REQ-ID", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const result = await activateRequirementInHub(validInput, async (path, body) => {
      calls.push({ path, body });
      if (path === HUB_ACTIVATION_DRAFT_PATH) {
        return { alreadyActivated: false };
      }
      return { reqId: "ELA-1-2026082001" };
    });
    expect(result).toEqual({
      reqId: "ELA-1-2026082001",
      alreadyActivated: false,
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({
      path: HUB_ACTIVATE_PATH,
      body: {
        trackingProvider: "FEISHU_PROJECT",
        projectUrl: validInput.projectUrl,
        projectName: "ELA体验课报告",
        businessLine: "TECH",
        semanticCode: "ELA",
        plannedOnlineDate: "2026-08-20",
        techOwner: "clj",
        techOwnerName: "陈禄江",
        techOwnerResolveMode: "ACCOUNT_ONLY",
        requiresBizVerify: true,
        deliveryMode: "UNCONFIRMED",
      },
    });
  });

  it("没有 Owner 账号直接拒绝、不打 Hub", async () => {
    await expect(
      activateRequirementInHub({ ...validInput, techOwner: "  " }, async () => ({})),
    ).rejects.toThrow(WkActivateError);
  });
});

describe("postHubJson", () => {
  it("带 X-Delivery-Harness-Token，401 改成中文鉴权失败", async () => {
    const fakeFetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const headers = new Headers(init?.headers);
      expect(headers.get(HUB_HARNESS_TOKEN_HEADER)).toBe("tok");
      return new Response(
        JSON.stringify({ success: false, message: "Harness 内部同步 token 无效" }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    await expect(
      postHubJson("http://hub.test", "tok", HUB_ACTIVATE_PATH, {}, fakeFetch),
    ).rejects.toMatchObject({
      message: "Delivery Hub 鉴权失败，去设置页 → 团队检查 Token",
      status: 401,
    });
  });

  it("success:false 把 Hub 原文抛出来", async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({ success: false, message: "项目名称不能为空" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    await expect(
      postHubJson("http://hub.test", "tok", HUB_ACTIVATE_PATH, {}, fakeFetch),
    ).rejects.toMatchObject({ message: "项目名称不能为空" });
  });
});
