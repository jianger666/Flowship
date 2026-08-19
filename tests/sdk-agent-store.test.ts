import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  cursorSdkStoreDir,
  SDK_AGENT_STORE_DIRNAME,
  withCursorJsonlStore,
} from "@/lib/server/sdk-agent-store";

describe("cursorSdkStoreDir", () => {
  const prev = process.env.FLOWSHIP_DATA_DIR;

  afterEach(() => {
    if (prev === undefined) delete process.env.FLOWSHIP_DATA_DIR;
    else process.env.FLOWSHIP_DATA_DIR = prev;
  });

  it("落在 dataRoot 下的 sdk-agent-store，不写用户主目录", () => {
    process.env.FLOWSHIP_DATA_DIR = path.join("/tmp", "fe-ai-flow-store-test");
    const dir = cursorSdkStoreDir();
    expect(dir).toBe(
      path.join("/tmp", "fe-ai-flow-store-test", SDK_AGENT_STORE_DIRNAME),
    );
    expect(dir).not.toContain(`${path.sep}.cursor${path.sep}`);
  });
});

describe("withCursorJsonlStore", () => {
  it("调用方已传 store 时不覆盖", async () => {
    const existing = { kind: "already" };
    const out = await withCursorJsonlStore({
      local: { cwd: "/x", store: existing },
    });
    expect(out.local?.store).toBe(existing);
  });
});
