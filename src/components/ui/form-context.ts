"use client";

import { createContext, useContext } from "react";

/** Form.disabled 下发给控件；独立文件避免 Form ↔ Field 循环引用 */
export const FormDisabledContext = createContext(false);

export const useFormDisabled = (): boolean => useContext(FormDisabledContext);
