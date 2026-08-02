import { describe, expect, it } from "vitest";

import {
  buildOpenPathSpec,
  buildRevealInFolderSpec,
} from "@/lib/local-file-os";

describe("buildRevealInFolderSpec", () => {
  it("macOS 用 open -R", () => {
    expect(buildRevealInFolderSpec("/tmp/a.txt", "darwin")).toEqual({
      command: "open",
      args: ["-R", "/tmp/a.txt"],
    });
  });

  it("Windows 用 explorer /select", () => {
    expect(buildRevealInFolderSpec("C:\\foo\\bar.txt", "win32")).toEqual({
      command: "explorer",
      args: ["/select,C:\\foo\\bar.txt"],
    });
  });
});

describe("buildOpenPathSpec", () => {
  it("macOS 用 open", () => {
    expect(buildOpenPathSpec("/tmp/a.txt", "darwin")).toEqual({
      command: "open",
      args: ["/tmp/a.txt"],
    });
  });

  it("Windows 用 cmd start", () => {
    expect(buildOpenPathSpec("C:\\foo\\bar.txt", "win32")).toEqual({
      command: "cmd",
      args: ["/c", "start", "", "C:\\foo\\bar.txt"],
    });
  });
});
