/**
 * 模型参数里哪些给用户调、哪些藏掉走默认。
 *
 * Cursor SDK 的 parameters 会带思考档 + 上下文窗口等。上下文选来选去没人用、
 * 也容易跟默认窗口拧着，UI 不画、params 里也不带（SDK 用它自己的默认）。
 */

import {
  isDefaultThinkingValue,
  isThinkingParamId,
} from "@/lib/custom-effort";
import type { ModelParameter } from "@/lib/types";

const hiddenId = (id: string): boolean => {
  const k = id.trim().toLowerCase();
  return k === "context" || k === "contextwindow" || k === "context_window";
};

const hiddenName = (name?: string): boolean => {
  const n = name?.trim() ?? "";
  return n === "上下文" || n.toLowerCase() === "context";
};

export const isHiddenModelParam = (p: {
  id: string;
  displayName?: string;
}): boolean => hiddenId(p.id) || hiddenName(p.displayName);

export const visibleModelParameters = (
  parameters?: ModelParameter[],
): ModelParameter[] | undefined => {
  if (!parameters) return parameters;
  const next = parameters.filter((p) => !isHiddenModelParam(p));
  return next.length === parameters.length ? parameters : next;
};

export const withoutHiddenModelParams = <T extends { id: string }>(
  params?: T[],
): T[] | undefined => {
  if (!params) return params;
  const next = params.filter((p) => !hiddenId(p.id));
  if (next.length === 0) return undefined;
  return next.length === params.length ? params : next;
};

/** Default 思考档不发给后端（省略 = 上游自己的默认） */
export const withoutUnsetThinkingParams = <
  T extends { id: string; value: string },
>(
  params?: T[],
): T[] | undefined => {
  if (!params) return params;
  const next = params.filter(
    (p) => !(isThinkingParamId(p.id) && isDefaultThinkingValue(p.value)),
  );
  if (next.length === 0) return undefined;
  return next.length === params.length ? params : next;
};

export const withoutHiddenModelSelection = <
  T extends { id: string; params?: Array<{ id: string; value: string }> },
>(
  model: T,
): T => {
  const params = withoutUnsetThinkingParams(
    withoutHiddenModelParams(model.params),
  );
  if (params === model.params) return model;
  return { ...model, params };
};
