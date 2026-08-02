import { mkdtempSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  credentialFilePath,
  readFileCredential,
  storeFileCredential,
} from "../.cursor/skills/cursor-delegate/scripts/credential-store.mjs";

describe("cursor-delegate credential compatibility file", () => {
  it("uses a per-user path on macOS, Windows, and Linux", () => {
    expect(
      credentialFilePath({
        platform: "darwin",
        environment: { NODE_ENV: "test" },
        homeDirectory: "/Users/alice",
      }),
    ).toBe(
      "/Users/alice/Library/Application Support/cursor-delegate/credentials",
    );
    expect(
      credentialFilePath({
        platform: "win32",
        environment: {
          NODE_ENV: "test",
          APPDATA: "C:\\Users\\alice\\AppData\\Roaming",
        },
        homeDirectory: "C:\\Users\\alice",
      }),
    ).toBe(
      path.join(
        "C:\\Users\\alice\\AppData\\Roaming",
        "cursor-delegate",
        "credentials",
      ),
    );
    expect(
      credentialFilePath({
        platform: "linux",
        environment: {
          NODE_ENV: "test",
          XDG_CONFIG_HOME: "/home/alice/.xdg",
        },
        homeDirectory: "/home/alice",
      }),
    ).toBe("/home/alice/.xdg/cursor-delegate/credentials");
  });

  it("honors the explicit credential file override", () => {
    expect(
      credentialFilePath({
        platform: "win32",
        environment: {
          NODE_ENV: "test",
          CURSOR_DELEGATE_CREDENTIAL_FILE: "D:\\keys\\cursor",
        },
        homeDirectory: "C:\\Users\\alice",
      }),
    ).toBe("D:\\keys\\cursor");
  });

  it("writes a trimmed 0600 file on POSIX and reads it back", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "cursor-delegate-"));
    const filePath = path.join(directory, "nested", "credentials");

    storeFileCredential("  test-secret  ", filePath, "darwin");

    expect(readFileCredential(filePath)).toBe("test-secret");
    expect(readFileSync(filePath, "utf8")).toBe("test-secret\n");
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });
});
