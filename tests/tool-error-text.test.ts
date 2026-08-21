import { describe, expect, it } from "vitest";

import { humanizeToolErrorText } from "@/lib/tool-error-text";

describe("humanizeToolErrorText", () => {
  it("拆 MCP content[].text，不把 JSON 外壳给人看", () => {
    expect(
      humanizeToolErrorText({
        content: [
          {
            type: "text",
            text: "ripgrep (rg) is not available and could not be downloaded",
          },
        ],
        details: {},
      }),
    ).toBe("ripgrep (rg) is not available and could not be downloaded");
  });

  it("字符串化的同一份 JSON 也能拆", () => {
    expect(
      humanizeToolErrorText(
        '{"content":[{"type":"text","text":"ripgrep (rg) is not available and could not be downloaded"}],"details":{}}',
      ),
    ).toBe("ripgrep (rg) is not available and could not be downloaded");
  });

  it("普通字符串原样返回", () => {
    expect(humanizeToolErrorText("ENOENT")).toBe("ENOENT");
  });
});
