import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

export const KEYCHAIN_SERVICE = "cursor-delegate";
export const LEGACY_KEYCHAIN_SERVICE = "com.openai.codex.cursor-delegate";
export const KEYCHAIN_ACCOUNT = "cursor-sdk-key";
export const CREDENTIAL_FILE_ENV = "CURSOR_DELEGATE_CREDENTIAL_FILE";

function runPowerShell(script, args = [], input) {
  const candidates = ["powershell.exe", "pwsh.exe"];
  let lastError;

  for (const command of candidates) {
    const result = spawnSync(
      command,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script, ...args],
      {
        encoding: "utf8",
        input,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );

    if (!result.error && result.status === 0) return result.stdout;
    lastError =
      result.error ??
      new Error(result.stderr?.trim() || `${command} exited with ${result.status}`);
  }

  throw lastError ?? new Error("PowerShell is unavailable");
}

function windowsCredentialPath() {
  const base = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  return join(base, "cursor-delegate", "cursor-api-key.bin");
}

function legacyWindowsCredentialPath() {
  const base = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  return join(base, "Codex", "cursor-delegate", "cursor-api-key.bin");
}

/**
 * 用户级兼容凭据文件。它刻意不放进仓库：便于宿主沙箱读取，同时避免误提交。
 * 可用 CURSOR_DELEGATE_CREDENTIAL_FILE 覆盖，方便受管设备统一下发路径。
 */
export function credentialFilePath({
  platform = process.platform,
  environment = process.env,
  homeDirectory = homedir(),
} = {}) {
  if (environment[CREDENTIAL_FILE_ENV]) {
    return environment[CREDENTIAL_FILE_ENV];
  }
  if (platform === "darwin") {
    return join(
      homeDirectory,
      "Library",
      "Application Support",
      "cursor-delegate",
      "credentials",
    );
  }
  if (platform === "win32") {
    const base =
      environment.APPDATA || join(homeDirectory, "AppData", "Roaming");
    return join(base, "cursor-delegate", "credentials");
  }
  const base = environment.XDG_CONFIG_HOME || join(homeDirectory, ".config");
  return join(base, "cursor-delegate", "credentials");
}

export function readFileCredential(filePath = credentialFilePath()) {
  if (!existsSync(filePath)) return "";
  return readFileSync(filePath, "utf8").trim();
}

function restrictWindowsFileToCurrentUser(filePath) {
  const script = String.raw`
$path = $args[0]
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$acl = Get-Acl -LiteralPath $path
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
  $identity,
  [System.Security.AccessControl.FileSystemRights]::FullControl,
  [System.Security.AccessControl.AccessControlType]::Allow
)
$acl.SetAccessRule($rule)
Set-Acl -LiteralPath $path -AclObject $acl
`;
  runPowerShell(script, [filePath]);
}

/**
 * 兼容文件模式：macOS/Linux 用 0600；Windows 移除继承 ACL、只保留当前用户。
 * 比系统凭据库弱，但在受限 agent/sandbox 中读取更稳定。
 */
export function storeFileCredential(
  apiKey,
  filePath = credentialFilePath(),
  platform = process.platform,
) {
  const directory = dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(filePath, `${apiKey.trim()}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  if (platform === "win32") {
    try {
      restrictWindowsFileToCurrentUser(filePath);
    } catch (error) {
      unlinkSync(filePath);
      throw new Error(
        `Credential file ACL could not be restricted: ${error.message}`,
      );
    }
  } else {
    chmodSync(filePath, 0o600);
  }
}

export function clearFileCredential(filePath = credentialFilePath()) {
  if (existsSync(filePath)) unlinkSync(filePath);
}

function readMacCredential() {
  for (const service of [KEYCHAIN_SERVICE, LEGACY_KEYCHAIN_SERVICE]) {
    try {
      const apiKey = execFileSync(
        "/usr/bin/security",
        [
          "find-generic-password",
          "-a",
          KEYCHAIN_ACCOUNT,
          "-s",
          service,
          "-w",
        ],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        },
      ).trim();
      if (apiKey) return apiKey;
    } catch {
      // 新服务不存在时兼容旧版 Codex 命名空间。
    }
  }
  return "";
}

function readWindowsCredential() {
  const credentialPath = [
    windowsCredentialPath(),
    legacyWindowsCredentialPath(),
  ].find((candidate) => existsSync(candidate));
  if (!credentialPath) return "";

  const script = String.raw`
$encrypted = [System.IO.File]::ReadAllBytes($args[0])
$plain = [System.Security.Cryptography.ProtectedData]::Unprotect(
  $encrypted,
  $null,
  [System.Security.Cryptography.DataProtectionScope]::CurrentUser
)
[Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($plain))
`;
  return runPowerShell(script, [credentialPath]).trim();
}

function readLinuxCredential() {
  return execFileSync(
    "secret-tool",
    ["lookup", "application", "cursor-delegate", "account", KEYCHAIN_ACCOUNT],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  ).trim();
}

export function loadCursorApiKey() {
  const environmentKey = process.env.CURSOR_API_KEY?.trim();
  if (environmentKey) {
    return { apiKey: environmentKey, source: "environment" };
  }

  try {
    const apiKey = readFileCredential();
    if (apiKey) return { apiKey, source: "credential-file" };
  } catch {
    // 不可读文件继续回退系统凭据库，最终统一报告未配置。
  }

  try {
    let apiKey = "";
    if (process.platform === "darwin") apiKey = readMacCredential();
    else if (process.platform === "win32") apiKey = readWindowsCredential();
    else if (process.platform === "linux") apiKey = readLinuxCredential();

    if (apiKey) return { apiKey, source: "os-credential-store" };
  } catch {
    // A missing or locked credential store is reported as unconfigured.
  }

  return { apiKey: "", source: null };
}

export function storeMacCredential() {
  const result = spawnSync(
    "/usr/bin/security",
    [
      "add-generic-password",
      "-U",
      "-a",
      KEYCHAIN_ACCOUNT,
      "-s",
      KEYCHAIN_SERVICE,
      "-l",
      "Cursor Delegate SDK Key",
      "-w",
    ],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`security exited with ${result.status}`);
  }
}

export function storeWindowsCredential(apiKey) {
  const credentialPath = windowsCredentialPath();
  mkdirSync(dirname(credentialPath), { recursive: true });

  const script = String.raw`
$plain = [Console]::In.ReadToEnd()
$bytes = [System.Text.Encoding]::UTF8.GetBytes($plain)
$encrypted = [System.Security.Cryptography.ProtectedData]::Protect(
  $bytes,
  $null,
  [System.Security.Cryptography.DataProtectionScope]::CurrentUser
)
[System.IO.File]::WriteAllBytes($args[0], $encrypted)
`;
  runPowerShell(script, [credentialPath], apiKey);
}

export function storeLinuxCredential(apiKey) {
  const result = spawnSync(
    "secret-tool",
    [
      "store",
      "--label=Cursor Delegate SDK Key",
      "application",
      "cursor-delegate",
      "account",
      KEYCHAIN_ACCOUNT,
    ],
    {
      encoding: "utf8",
      input: apiKey,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `secret-tool exited with ${result.status}`);
  }
}

export function clearStoredCredential() {
  if (process.platform === "darwin") {
    for (const service of [KEYCHAIN_SERVICE, LEGACY_KEYCHAIN_SERVICE]) {
      const result = spawnSync(
        "/usr/bin/security",
        [
          "delete-generic-password",
          "-a",
          KEYCHAIN_ACCOUNT,
          "-s",
          service,
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      if (
        result.status !== 0 &&
        !result.stderr?.includes("could not be found")
      ) {
        throw new Error(
          result.stderr?.trim() || `security exited with ${result.status}`,
        );
      }
    }
    return;
  }

  if (process.platform === "win32") {
    for (const credentialPath of [
      windowsCredentialPath(),
      legacyWindowsCredentialPath(),
    ]) {
      if (existsSync(credentialPath)) unlinkSync(credentialPath);
    }
    return;
  }

  if (process.platform === "linux") {
    const result = spawnSync(
      "secret-tool",
      ["clear", "application", "cursor-delegate", "account", KEYCHAIN_ACCOUNT],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(result.stderr?.trim() || `secret-tool exited with ${result.status}`);
    }
    return;
  }

  throw new Error(`Unsupported platform: ${process.platform}`);
}
