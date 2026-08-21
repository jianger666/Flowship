import { describe, expect, it } from "vitest";

import {
  isHiddenModelParam,
  visibleModelParameters,
  withoutHiddenModelParams,
  withoutHiddenModelSelection,
} from "@/lib/model-params";

describe("model-params", () => {
  it("藏掉上下文，思考档留下", () => {
    expect(isHiddenModelParam({ id: "context" })).toBe(true);
    expect(isHiddenModelParam({ id: "contextWindow" })).toBe(true);
    expect(isHiddenModelParam({ id: "thinking", displayName: "思考" })).toBe(false);
    expect(isHiddenModelParam({ id: "foo", displayName: "上下文" })).toBe(true);

    const parameters = [
      { id: "thinking", displayName: "思考", values: [{ value: "high" }] },
      { id: "context", displayName: "上下文", values: [{ value: "200k" }] },
    ];
    expect(visibleModelParameters(parameters)?.map((p) => p.id)).toEqual(["thinking"]);
    expect(
      withoutHiddenModelParams([
        { id: "thinking", value: "high" },
        { id: "context", value: "200k" },
      ]),
    ).toEqual([{ id: "thinking", value: "high" }]);
    expect(withoutHiddenModelParams([{ id: "context", value: "200k" }])).toBeUndefined();
    expect(
      withoutHiddenModelSelection({
        id: "claude-4.5",
        params: [
          { id: "thinking", value: "high" },
          { id: "context", value: "1m" },
        ],
      }).params,
    ).toEqual([{ id: "thinking", value: "high" }]);
    expect(
      withoutHiddenModelSelection({
        id: "qwen",
        params: [{ id: "thinking", value: "default" }],
      }).params,
    ).toBeUndefined();
  });
});
