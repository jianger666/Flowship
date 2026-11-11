/* eslint-disable @typescript-eslint/no-explicit-any -- 假 tab 与被测 .mjs 无类型声明，any 是刻意的 */
/**
 * R6 真机回归：closed-shadow 的 CDP 探测必须各自独占 objectGroup。
 *
 * 现象：录屏每帧会用 `probeFocusSecretCdp` 复核焦点（它现在只剩录屏这一个调用方；AI 的 type / press_key / drag 已不再做焦点 / 落点复核）。
 * 只要有两次探测并发，且共用一个固定 group，先跑完的那个 `Runtime.releaseObjectGroup` 就会让另一个手里的 objectId 失效
 * （"Could not find object with given id"）→ 探针抛错 → unknown → 误判成「无法确认」。
 * 当年的真机 smoke-suite FLOW 24 约 1/4 概率复现（那时并发的另一方是 AI 的 type 焦点复核，表现为 type 被误拒）。fail-closed 没漏，但会误伤；
 * 现在即使调用方只剩录屏，「每次探测独占 group」这条约束照旧要钉住。
 */
import { describe, expect, it } from "vitest";

import { IS_FRAME_FN, NEXT_FOCUS_OPEN_FN, probeFocusSecretCdp } from "../electron-app/browser/closed-shadow.mjs";
import { SECRET_ELEMENT_PROBE_SOURCE } from "../electron-app/browser/secret-field.mjs";

/** 带「对象按 group 存活」语义的假 CDP：release 某 group 后，该 group 的 objectId 再被用就报 Could not find object */
const makeTab = (hook?: (method: string, params: any) => Promise<void>) => {
  const alive = new Map<string, string>(); // objectId → group
  const releasedGroups: string[] = [];
  const usedGroups = new Set<string>();
  let n = 0;
  const reg = (group: string) => {
    const id = `obj-${n++}`;
    alive.set(id, group);
    usedGroups.add(group);
    return id;
  };
  const need = (id: string) => {
    if (!alive.has(id)) throw new Error("Could not find object with given id");
  };
  const tab: any = {
    releasedGroups,
    usedGroups,
    send: async (method: string, params: any = {}) => {
      await hook?.(method, params);
      switch (method) {
        case "Runtime.evaluate":
          return { result: { subtype: "node", objectId: reg(params.objectGroup) } };
        case "DOM.resolveNode":
          return { object: { objectId: reg(params.objectGroup) } };
        case "DOM.describeNode":
          need(params.objectId);
          return { node: { shadowRoots: [] } };
        case "Runtime.callFunctionOn": {
          need(params.objectId);
          const fn = String(params.functionDeclaration);
          if (fn === IS_FRAME_FN) return { result: { value: false } };
          if (fn === SECRET_ELEMENT_PROBE_SOURCE) return { result: { value: false } };
          if (fn === NEXT_FOCUS_OPEN_FN) return { result: { subtype: "null", value: null } };
          return { result: { subtype: "null", value: null } };
        }
        case "Runtime.releaseObjectGroup":
          releasedGroups.push(params.objectGroup);
          for (const [id, g] of [...alive]) if (g === params.objectGroup) alive.delete(id);
          return {};
        default:
          return {};
      }
    },
  };
  return tab;
};

describe("closed-shadow 探测：每次探测独占 objectGroup（R6 真机回归）", () => {
  it("两次探测用的 group 不同，且各自 release 自己的 group", async () => {
    const tab = makeTab();
    expect(await probeFocusSecretCdp(tab, null)).toBe("safe");
    expect(await probeFocusSecretCdp(tab, null)).toBe("safe");
    expect(tab.usedGroups.size).toBe(2);
    expect(new Set(tab.releasedGroups).size).toBe(2);
    expect([...tab.usedGroups].sort()).toEqual([...tab.releasedGroups].sort());
  });

  it("并发：B 在 A 的终判之前整个跑完并 release → A 仍然 safe（共用 group 时 A 会抛 → unknown）", async () => {
    let started = false;
    let pB: Promise<string> | null = null;
    const tab: any = makeTab(async (method, params) => {
      if (method === "Runtime.callFunctionOn" && String(params.functionDeclaration) === SECRET_ELEMENT_PROBE_SOURCE && !started) {
        started = true;
        pB = probeFocusSecretCdp(tab, null);
        await pB;
      }
    });
    const a = await probeFocusSecretCdp(tab, null);
    expect(started).toBe(true);
    expect(await pB).toBe("safe");
    expect(a).toBe("safe");
  });
});
