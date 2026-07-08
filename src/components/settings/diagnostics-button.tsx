"use client";

/**
 * 「导出诊断包」按钮（V0.11.9、设置页顶部、跟「检查更新」并排）
 *
 * 出问题时让同事点一下、把生成的 txt 发过来即可——不用教人找日志目录。
 * 内容：版本 / IDE 探测 / 脱敏配置 / main.log 尾部（见 server/diagnostics.ts）。
 * 成功后 toast 落盘路径 + 自动复制路径到剪贴板。
 */

import { useState } from "react";
import { FileDown, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

export const DiagnosticsButton = () => {
  // 导出中：防双击
  const [exporting, setExporting] = useState(false);

  const handleExport = async () => {
    setExporting(true);
    try {
      const appVersion = (window as { __appVersion?: string }).__appVersion;
      const res = await fetch("/api/system/diagnostics-export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appVersion }),
      });
      const data = (await res.json()) as { path?: string; error?: string };
      if (!res.ok || !data.path) {
        toast.error(`导出失败：${data.error ?? `HTTP ${res.status}`}`);
        return;
      }
      await navigator.clipboard.writeText(data.path).catch(() => {});
      toast.success("诊断包已导出（路径已复制）", { description: data.path });
    } catch (err) {
      toast.error(
        `导出失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setExporting(false);
    }
  };

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={exporting}
      onClick={() => void handleExport()}
      title="导出版本 / IDE 探测 / 日志尾部（已脱敏）、发给维护者排查"
    >
      {exporting ? <Loader2 className="animate-spin" /> : <FileDown />}
      导出诊断包
    </Button>
  );
};
