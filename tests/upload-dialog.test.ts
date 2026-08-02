import { describe, expect, it } from "vitest";

import {
  preferredExistingCategory,
  resolveUploadSkillNames,
  uploadNameStatus,
  uploadOwnershipDisabledReason,
  type UploadActionRow,
} from "@/components/settings/skills-panel/upload-dialog-logic";

const action = (
  overrides: Partial<UploadActionRow> = {},
): UploadActionRow => ({
  id: "action-1",
  label: "Hello World",
  skill: "hello-world",
  disabledReason: null,
  ...overrides,
});

describe("共享库上传弹窗", () => {
  it("已存在于其它分类的 action 仍保留在选择结果中", () => {
    const names = resolveUploadSkillNames({
      mode: "action",
      picked: new Set(["action-1"]),
      appSkills: [],
      actions: [action()],
    });

    expect(names).toEqual(["hello-world"]);
    expect(
      uploadNameStatus("hello-world", "fe", {
        "hello-world": ["other"],
      }),
    ).toEqual({ conflict: "other" });
  });

  it("单个已上传 action 自动沿用原分类，以覆盖更新", () => {
    expect(
      preferredExistingCategory(["hello-world"], {
        "hello-world": ["other"],
      }),
    ).toBe("other");
    expect(
      uploadNameStatus("hello-world", "other", {
        "hello-world": ["other"],
      }),
    ).toBe("overwrite");
  });

  it("已存在项只有服务端确认本人可更新时才解除置灰", () => {
    const categories = { "hello-world": ["other"] };
    expect(
      uploadOwnershipDisabledReason("hello-world", categories, {
        "hello-world": { category: "other", canUpdate: true },
      }),
    ).toBeNull();
    expect(
      uploadOwnershipDisabledReason("hello-world", categories, {
        "hello-world": {
          category: "other",
          canUpdate: false,
          reason: "由 Alice 上传，当前账号无权覆盖",
        },
      }),
    ).toBe("由 Alice 上传，当前账号无权覆盖");
  });

  it("已存在项拿不到归属预检时 fail closed，新名字仍可上传", () => {
    expect(
      uploadOwnershipDisabledReason(
        "hello-world",
        { "hello-world": ["other"] },
        {},
      ),
    ).toContain("无法确认");
    expect(
      uploadOwnershipDisabledReason("new-action", {}, {}),
    ).toBeNull();
  });

  it("多个现存分类混选时不擅自选择分类", () => {
    expect(
      preferredExistingCategory(["hello-world", "release-review"], {
        "hello-world": ["other"],
        "release-review": ["be"],
      }),
    ).toBeNull();
  });

  it("本地来源不可上传的 action 不进入上传列表", () => {
    expect(
      resolveUploadSkillNames({
        mode: "action",
        picked: new Set(["action-1"]),
        appSkills: [],
        actions: [action({ disabledReason: "挂载的是团队 skill，不可传" })],
      }),
    ).toEqual([]);
  });
});
