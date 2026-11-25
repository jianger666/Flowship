/**
 * 签名之后核对「指定要求」（designated requirement）里确实是预期的自签证书。
 * 发版 CI 和本机 test 包（scripts/lib/electron-test-signing.mjs）共用这一份判断。
 *
 * `codesign -d -r-` 打印的指定要求里，证书那一段有两种写法：
 *   - 证书被系统标成「受信任」时（发版 CI 里 add-trusted-cert 之后）：certificate root = H"<sha1>"
 *   - 证书没被信任时（本机自己生成的测试证书）：certificate leaf = H"<sha1>"
 * 两种写法语义一致：自签证书的链里只有它自己，leaf 就是 root。系统「辅助功能 / 屏幕录制」的授权、钥匙串条目的访问控制
 * 记的都是这条要求；实测未受信任的自签证书签出的包，`codesign -v -R='certificate root = H"…"'` 与 `certificate leaf = H"…"` 同样通过，
 * 所以新旧版本只要是同一张证书，不管打印成哪种写法，之前的授权都认。
 */

/**
 * @param {string} output  `codesign -d -r- <app>` 的输出（stdout 与 stderr 合并）
 * @param {string} fingerprint  证书的 SHA-1 指纹（40 位十六进制；大小写 / 冒号分隔都行）
 * @returns {boolean}
 */
export const designatedRequirementNamesCertificate = (output, fingerprint) => {
  const fp = String(fingerprint ?? "")
    .trim()
    .replace(/:/g, "")
    .toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(fp)) return false;
  return new RegExp(`certificate (?:root|leaf) = H"${fp}"`, "i").test(String(output ?? ""));
};
