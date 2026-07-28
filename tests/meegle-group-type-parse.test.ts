import { describe, expect, it } from "vitest";
import { parseGroupTypeFromWorkitem } from "../src/lib/server/meegle-cli";

/**
 * group_type 解析回归——2026-07-27 线上实测踩坑：
 * 服务端对 group_type 逻辑字段返回 field_key=null，按 key 匹配扑空 →
 * 误判「无群」→ 二次分享重复建群 + 重复 bind 报 field validation failed。
 * 兜底按值形状（value ∈ auto/bind/disabled）识别。
 */
describe("parseGroupTypeFromWorkitem", () => {
  it("field_key=null 的真实返回形状（bind）也能解析", () => {
    // 按 2026-07-27 workitem get --fields '["group_type"]' 的真实响应裁剪
    const resp = {
      work_item_attribute: { create_time: "2026-07-27T13:17:47+08:00" },
      work_item_fields: [
        {
          field_key: null,
          field_value: {
            group_id: "oc_32f007e017104085a5424b476215e0c4",
            label: "绑定现有群",
            value: "bind",
          },
        },
      ],
    };
    const got = parseGroupTypeFromWorkitem(resp);
    expect(got).not.toBeNull();
    expect(got?.value).toBe("bind");
    expect(got?.groupId).toBe("oc_32f007e017104085a5424b476215e0c4");
  });

  it("field_key 正常带 group_type 时照常解析（auto）", () => {
    const resp = {
      work_item_fields: [
        {
          field_key: "group_type",
          field_value: { value: "auto", label: "自动拉群", group_id: "oc_a" },
        },
      ],
    };
    const got = parseGroupTypeFromWorkitem(resp);
    expect(got?.value).toBe("auto");
    expect(got?.groupId).toBe("oc_a");
  });

  it("disabled（无 group_id）解析出 value", () => {
    const resp = {
      work_item_fields: [
        { field_key: null, field_value: { value: "disabled", label: "不拉群" } },
      ],
    };
    const got = parseGroupTypeFromWorkitem(resp);
    expect(got?.value).toBe("disabled");
    expect(got?.groupId).toBeUndefined();
  });

  it("形状不符（普通字段）不误识别", () => {
    const resp = {
      work_item_fields: [
        { field_key: null, field_value: { value: "P1", label: "优先级" } },
        { field_key: "name", field_value: "测试需求" },
      ],
    };
    expect(parseGroupTypeFromWorkitem(resp)).toBeNull();
  });

  it("空返回 → null", () => {
    expect(parseGroupTypeFromWorkitem({ work_item_fields: [] })).toBeNull();
  });
});
