/**
 * 增强包 E1 的 op 扩展点（契约 §14.0）。
 *
 * 三个模块各管一组新 op，互不引用：
 *   - input.mjs（V1）：mouse / fill_form
 *   - read.mjs （V2）：read / inspect / network_detail / save
 *   - env.mjs  （V3）：upload / downloads
 *   - page-env.mjs（V5）：dialog / emulate
 *   - E2（契约 §15）：permissions / storage / net-rules(net_rules, net_export) / perf / sources / debug / touch / record / clipboard
 *
 * 每个模块导出：
 *   OPS                       本模块负责的 op 名（数组）
 *   normalize(op, args, h)    参数校验，返回规整后的 args；非法抛 BAD_ARGS（h 见 index.mjs 的 OP_HELPERS）
 *   createHandlers(deps)      返回 { [op]: async (taskId, args, signal) => result }
 *
 * index.mjs 的 dispatch 在 BASE_OPS 之外的 op 一律走这里。
 */
import * as input from "./input.mjs";
import * as read from "./read.mjs";
import * as env from "./env.mjs";
import * as pageEnv from "./page-env.mjs";
// 增强包 E2（契约 §15）：每个切片一个模块文件，由对应开发者填实现；这里只管登记
import * as permissions from "./permissions.mjs";
import * as storage from "./storage.mjs";
import * as netRules from "./net-rules.mjs";
import * as perf from "./perf.mjs";
import * as sources from "./sources.mjs";
import * as debug from "./debug.mjs";
import * as touch from "./touch.mjs";
import * as record from "./record.mjs";
import * as clipboard from "./clipboard.mjs";

export const OP_MODULES = Object.freeze([input, read, env, pageEnv, permissions, storage, netRules, perf, sources, debug, touch, record, clipboard]);

/** 全部新增 op 名（顺序 = 模块顺序） */
export const EXTRA_OPS = Object.freeze(OP_MODULES.flatMap((m) => [...m.OPS]));

/** 命中返回规整后的 args；不是新增 op 返回 undefined（交给调用方报「未知操作」） */
export const normalizeExtraOpArgs = (op, args, helpers) => {
  for (const m of OP_MODULES) {
    if (m.OPS.includes(op)) return m.normalize(op, args, helpers);
  }
  return undefined;
};

/** 汇总各模块的 handler 表；同名 op 后面的覆盖前面的（正常不会发生，OPS 互不相交由单测保证） */
export const createExtraHandlers = (deps) => {
  const out = {};
  for (const m of OP_MODULES) Object.assign(out, m.createHandlers(deps));
  return out;
};
