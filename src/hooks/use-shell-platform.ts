"use client";

import { useEffect, useState } from "react";

import {
  getShellPlatform,
  type ShellPlatform,
} from "@/lib/platform-shortcuts";

/** 客户端壳平台（mount 后读 preload；SSR 初值为 ""） */
export const useShellPlatform = (): ShellPlatform => {
  const [platform, setPlatform] = useState<ShellPlatform>("");
  useEffect(() => {
    setPlatform(getShellPlatform());
  }, []);
  return platform;
};
