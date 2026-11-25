/**
 * 把文字 / 错误里的开机密码抹掉。
 *
 * 密码只在极少几处「在手上」：解锁器取出它到输入完之间、保存它的那一刻。这几处调用的原生层 / 驱动 / 钥匙串一旦抛错，
 * 错误文字里万一回显了入参（「无法输入 xxx」「bad arg xxx」），就会顺着返回值一路进到事件、审计、日志、
 * 给 AI 的错误文案（还会被飞书转述）。这些下游本来都没有密码，也没法再认出它——只有密码还在手上的这一层认得，
 * 所以由这一层在错误出门之前先抹一遍（宁可多抹一道）。
 *
 * 只抹「整串密码」：驱动 / 原生层若只回显了其中几个字符，认不出来。
 *
 * 「整串」不只是原样那一种（第三轮评审：只做精确子串匹配，密码含 `"` 或 `\` 时，原生层 / 管道把入参 JSON 序列化后回显的那份就漏了）：
 * 同一个密码在这些常见序列化里长得不一样，也一并抹——
 * - JSON 字符串里的样子（`"` → `\"`、`\` → `\\`、控制字符 → `\uXXXX`）：管道协议是 JSON，原生层报「请求格式不对」时常把整段请求带出来；
 * - `encodeURIComponent`（URL / 表单里）；
 * - 反斜杠转义引号的写法（`'` → `\'`、`"` → `\"`、`\` → `\\`）：shell / JS 字面量 / `util.inspect` 一类的回显。
 * 不在此列的（有意）：base64 / hex / 二次编码——驱动与原生层不会这样回显一个键盘输入的字符串，猜不全也没必要。
 */

/** 抹掉之后留下的占位（和设置页 toast 的 scrubSecret 一致） */
export const SECRET_MASK = "•••";

/**
 * 一个密码在几种常见序列化里的所有写法（去重、去空、**长的在前**）。
 * 长的在前：某个变体若把另一个写法整个含在里面，先抹长的才不会留下半截（比如 `\\` 被短的先抹掉一半）。
 * 个别变体生成失败（畸形 UTF-16 让 `encodeURIComponent` 抛 URIError 之类）就跳过那一种，不影响其余。
 * @param {string} secret 非空
 * @returns {string[]}
 */
export const secretForms = (secret) => {
  const forms = new Set([secret]);
  /** @param {() => string} make */
  const add = (make) => {
    try {
      const v = make();
      if (typeof v === "string" && v !== "") forms.add(v);
    } catch {
      /* 这一种写法生成不出来：跳过 */
    }
  };
  add(() => JSON.stringify(secret).slice(1, -1));
  add(() => encodeURIComponent(secret));
  add(() => secret.replace(/[\\'"]/g, "\\$&"));
  return [...forms].sort((a, b) => b.length - a.length);
};

/**
 * 文字里出现的所有 secret（含上面几种序列化写法）换成占位。secret 不是非空字符串时原样返回
 * （拿不到密码就没法抹，不要因此改动文字）。
 * @param {unknown} text
 * @param {unknown} secret
 * @returns {string}
 */
export const redactSecret = (text, secret) => {
  const s = typeof text === "string" ? text : String(text);
  if (typeof secret !== "string" || secret === "") return s;
  let out = s;
  for (const form of secretForms(secret)) out = out.split(form).join(SECRET_MASK);
  return out;
};

/**
 * 错误对象里的 message 带着 secret（任一写法）时，换成一个抹干净的新 Error（保留 name / 字符串类型的 code）；没带就原样返回同一个对象，
 * 调用方的 instanceof / 属性判断不受影响。抛的不是 Error（字符串之类）同样处理。
 * @param {unknown} err
 * @param {unknown} secret
 * @returns {unknown}
 */
export const redactError = (err, secret) => {
  if (typeof secret !== "string" || secret === "") return err;
  const message = typeof err === "string" ? err : /** @type {any} */ (err)?.message;
  const text = typeof message === "string" ? message : String(err);
  if (!secretForms(secret).some((form) => text.includes(form))) return err;
  const clean = new Error(redactSecret(text, secret));
  const anyErr = /** @type {any} */ (err);
  if (typeof anyErr?.name === "string" && anyErr.name !== "Error") clean.name = redactSecret(anyErr.name, secret);
  if (typeof anyErr?.code === "string") /** @type {any} */ (clean).code = redactSecret(anyErr.code, secret);
  return clean;
};
