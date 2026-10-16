/**
 * API Key 归属信息缓存的 key 指纹（S13-15 隐私修正）
 *
 * 旧实现把 `长度:前4位:后4位` 明文写进 localStorage——前后各 4 位本身就是 key 的一部分，
 * 不该落在浏览器存储里。现在改成对「完整 key」做两路不同种子的 cyrb53 哈希（≈106 bit、
 * 同步、纯函数），只用于判断缓存是不是这把 key 的，无法还原 key 片段。
 * 姓名 / 邮箱等 info 仍缓存（用于进页秒出、避免闪烁），随 key 清空 / 更换即作废。
 */

// cyrb53：轻量非加密哈希（够做缓存归属判定）
const cyrb53 = (str: string, seed: number): number => {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i += 1) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
};

/** key 指纹：`h` 前缀 + 两路哈希的 36 进制串（不含冒号、与旧格式可区分） */
export const keyHashOf = (apiKey: string): string =>
  `h${cyrb53(apiKey, 0).toString(36)}${cyrb53(apiKey, 0x9e3779b1).toString(36)}`;

/** 旧格式指纹（`长度:前4:后4`，含 key 片段）——读到就应删除 */
export const isLegacyKeyHash = (keyHash: unknown): boolean =>
  typeof keyHash === "string" && keyHash.includes(":");
