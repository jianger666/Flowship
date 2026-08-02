/**
 * 团队 wk-harness 的本机配置（`~/.wk/config.yaml`）读写——落盘层
 *
 * 这个文件不是 Flowship 独占的——团队里不用 Flowship、直接在 Cursor IDE 里手敲
 * `wk:*` 的同事也读同一份。所以：
 * - **只改我们管的那几个键**（`doc_repo.local_path` / `delivery_hub` 的地址、
 *   Token 与两个同步开关），
 *   同段里同事配的其它键（`provider` / `url` / `operator_account` …）连同注释原样保留
 * - 解析 / 生成口径跟官方脚本对齐（`wk-delivery-sync.read_simple_delivery_yaml`）
 *
 * 文本 ↔ 配置的纯逻辑都在 `@/lib/wk-config`（客户端也 import 得动、便于单测）、
 * 本文件只负责路径 + 读写，并按原样 re-export 那些常量 / 类型。
 *
 * 两个配置分别是什么：
 * - `doc_repo.local_path`：wk 流程产物落盘的 WK 产出目录（`requirements/<REQ-ID>/…`），
 *   跟业务代码仓分开
 * - `delivery_hub.*`：团队 Delivery Hub。`base_url` 是服务器地址，`token` 用于上传材料
 *   和同步状态鉴权；`require_baseline` /`require_sync`（跑指令前拉最新产物 / 产物变更
 *   推回）由我们固定写 true、设置页不给开关。地址留空 = 三个连接键一起删 = 不接入。
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import {
  applyWkConfig,
  configFromYaml,
  DEFAULT_HUB_BASE_URL,
  EMPTY_WK_CONFIG,
} from "@/lib/wk-config";
import type { WkConfig, WkConfigInput } from "@/lib/wk-config";

import { dataRoot } from "./data-root";

export {
  applyWkConfig,
  configFromYaml,
  DEFAULT_HUB_BASE_URL,
  EMPTY_WK_CONFIG,
  isWkTruthy,
  parseSimpleYaml,
} from "@/lib/wk-config";
export type { WkConfig, WkConfigInput } from "@/lib/wk-config";

/** `~/.wk/config.yaml` 的绝对路径 */
export const wkConfigPath = (): string =>
  path.join(homedir(), ".wk", "config.yaml");

/**
 * 仅供服务端需要向 Delivery Hub 发鉴权请求时读取。
 *
 * 不挂进 `WkConfig`，避免 GET /api/system/wk-config 或任意客户端状态意外拿到明文。
 */
export const readWkHubToken = async (): Promise<string> => {
  try {
    const raw = await fs.readFile(wkConfigPath(), "utf8");
    return configFromYaml(raw).hubToken;
  } catch {
    return "";
  }
};

/**
 * 「默认 Hub 地址这件事已经处理过」的标记（放 app 自己的数据目录、不污染共享 YAML）。
 *
 * 为什么非得单独记一笔：`~/.wk/config.yaml` 里「没有 base_url」有两种含义——
 * ① 全新用户还没配过（该给团队默认地址）② 用户手动清空了（= 不接入 Hub）。
 * 文件本身分不出来（清空时三个键一起删），只看文件就会让「清空地址」永远弹回默认值。
 * 而两个 `require_*` 固定为 true 之后，清空地址是 Hub 挂掉时用户唯一的自救路，不能堵死。
 *
 * 文件内容是当时那个地址，纯为排查方便，没有任何逻辑读它。
 */
const hubDefaultMarkPath = (): string =>
  path.join(dataRoot(), "wk-hub-default-applied");

const hubDefaultHandled = async (): Promise<boolean> => {
  try {
    await fs.access(hubDefaultMarkPath());
    return true;
  } catch {
    return false;
  }
};

/** 打标记；失败只 warn——大不了下次再走一遍同样的判断，幂等 */
const markHubDefaultHandled = async (url: string): Promise<void> => {
  try {
    const target = hubDefaultMarkPath();
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `${url}\n`, "utf8");
  } catch (err) {
    console.warn("[wk-config] 记录默认 Hub 地址标记失败：", err);
  }
};

/** 纯读文件；不存在 / 读不动一律返回空配置（不抛） */
const readWkConfigFile = async (): Promise<WkConfig> => {
  let raw: string;
  try {
    raw = await fs.readFile(wkConfigPath(), "utf8");
  } catch {
    return { ...EMPTY_WK_CONFIG };
  }
  return configFromYaml(raw);
};

/**
 * 把托管键写回 `~/.wk/config.yaml`，**其余内容原样保留**。
 *
 * 先落临时文件再 rename：这份配置是同事也在读的共享文件，中途崩了也不能留下半截内容。
 */
export const writeWkConfig = async (cfg: WkConfigInput): Promise<void> => {
  const target = wkConfigPath();
  let existing = "";
  try {
    existing = await fs.readFile(target, "utf8");
  } catch {
    /* 首次写入 */
  }

  const next = applyWkConfig(existing, cfg);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  try {
    await fs.writeFile(tmp, next, "utf8");
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
};

/**
 * 读本机 wk 配置，顺带**在第一次接触这份配置时把团队默认 Hub 地址落进文件**。
 *
 * 为什么必须落文件、而不是内存里补一下：团队 python 脚本
 * （`doc-quality-gate.py` → `wk-delivery-baseline.py`）自己去读 `~/.wk/config.yaml`，
 * 我们内存里的默认值对它们不存在——不写进去 = 默认地址等于没生效。
 *
 * 只播种一次（见 {@link hubDefaultMarkPath}）：之后地址完全由用户说了算，
 * 包括「清空 = 不接入 Hub」。
 */
export const readWkConfig = async (): Promise<WkConfig> => {
  const cfg = await readWkConfigFile();
  if (await hubDefaultHandled()) return cfg;

  // 用户（或同事）已经配过地址 → 不插手，但记一笔，免得他之后清空又被我们塞回默认值
  if (cfg.hubBaseUrl) {
    await markHubDefaultHandled(cfg.hubBaseUrl);
    return cfg;
  }

  const seeded: WkConfig = {
    ...cfg,
    hubBaseUrl: DEFAULT_HUB_BASE_URL,
    requireBaseline: true,
    requireSync: true,
  };
  try {
    await writeWkConfig(seeded);
  } catch (err) {
    // 写不进去就别谎报「已生效」——脚本读的是文件，返回真实状态更诚实
    console.warn("[wk-config] 写入默认 Delivery Hub 地址失败：", err);
    return cfg;
  }
  await markHubDefaultHandled(DEFAULT_HUB_BASE_URL);
  return seeded;
};
