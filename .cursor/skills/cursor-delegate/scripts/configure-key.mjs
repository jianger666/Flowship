#!/usr/bin/env node

import process from "node:process";
import {
  clearFileCredential,
  clearStoredCredential,
  credentialFilePath,
  loadCursorApiKey,
  storeFileCredential,
  storeLinuxCredential,
  storeMacCredential,
  storeWindowsCredential,
} from "./credential-store.mjs";
import { ensureCursorSdkInstalled } from "./sdk-runtime.mjs";

function readSecret(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY || !process.stdin.setRawMode) {
      reject(new Error("A terminal is required for hidden key input"));
      return;
    }

    let value = "";
    const input = process.stdin;
    process.stdout.write(prompt);
    input.setEncoding("utf8");
    input.setRawMode(true);
    input.resume();

    const finish = (error) => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value.trim());
    };

    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          finish(new Error("Cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= " ") value += character;
      }
    };

    input.on("data", onData);
  });
}

async function main() {
  const storageIndex = process.argv.indexOf("--storage");
  const storage = storageIndex >= 0 ? process.argv[storageIndex + 1] : "os";
  if (storage !== "os" && storage !== "file" && storage !== "all") {
    throw new Error("--storage must be os, file, or all");
  }

  if (process.argv.includes("--clear")) {
    if (storage === "file" || storage === "all") clearFileCredential();
    if (storage === "os" || storage === "all") clearStoredCredential();
    process.stdout.write(`Cursor SDK credential removed from ${storage}.\n`);
    return;
  }
  if (storage === "all") {
    throw new Error("--storage all is only valid together with --clear");
  }

  const sdk = await ensureCursorSdkInstalled();
  if (sdk.installed) {
    process.stdout.write(`Cursor SDK installed in ${sdk.runtimeDirectory}.\n`);
  }

  if (storage === "file") {
    if (process.argv.includes("--migrate")) {
      const existing = loadCursorApiKey();
      if (!existing.apiKey) {
        throw new Error("No existing credential is available to migrate");
      }
      storeFileCredential(existing.apiKey);
    } else {
      const apiKey = await readSecret("Cursor SDK key: ");
      if (!apiKey) throw new Error("Key cannot be empty");
      storeFileCredential(apiKey);
    }
    process.stdout.write(
      `Cursor SDK credential stored in compatibility file ${credentialFilePath()}.\n`,
    );
  } else if (process.platform === "darwin") {
    process.stdout.write("Enter the Cursor SDK key in the macOS Keychain prompt.\n");
    storeMacCredential();
  } else if (process.platform === "win32") {
    const apiKey = await readSecret("Cursor SDK key: ");
    if (!apiKey) throw new Error("Key cannot be empty");
    storeWindowsCredential(apiKey);
  } else if (process.platform === "linux") {
    const apiKey = await readSecret("Cursor SDK key: ");
    if (!apiKey) throw new Error("Key cannot be empty");
    storeLinuxCredential(apiKey);
  } else {
    throw new Error(
      `Unsupported platform ${process.platform}; set CURSOR_API_KEY instead.`,
    );
  }

  const configured = loadCursorApiKey();
  if (!configured.apiKey) {
    throw new Error("Credential was stored but could not be read back");
  }
  process.stdout.write(`Cursor SDK credential configured via ${configured.source}.\n`);
}

main().catch((error) => {
  process.stderr.write(`Failed to configure Cursor SDK credential: ${error.message}\n`);
  process.exitCode = 1;
});
