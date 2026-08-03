/** 让桌面壳通过系统默认应用打开本地路径。 */
export const requestOpenLocalPath = async (
  absolutePath: string,
  fetcher: typeof fetch = fetch,
): Promise<void> => {
  const res = await fetcher("/api/system/open-path", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: absolutePath }),
  });
  if (res.ok) return;

  const data = (await res.json().catch(() => null)) as {
    error?: string;
  } | null;
  throw new Error(data?.error ?? `打开失败（HTTP ${res.status}）`);
};

export const requestRevealLocalPath = async (
  absolutePath: string,
  fetcher: typeof fetch = fetch,
): Promise<void> => {
  const res = await fetcher("/api/system/reveal-in-folder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: absolutePath }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error ?? `在文件管理器中显示失败（HTTP ${res.status}）`);
  }
};
