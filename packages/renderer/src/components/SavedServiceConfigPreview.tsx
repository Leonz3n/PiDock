import { useEffect, useRef, useState } from "react";
import { serviceCatalogThroughShell } from "../data/shellBridge";
import { Icon } from "./Icon";
import { Button } from "./ui/button";

type Preview = { state: "ready"; rows: { key: string; value: string; masked: boolean; source: string }[] } |
  { state: "blocked"; error: "private-reference-unavailable" | "environment-resolution-failed" };

export function savedServicePreviewFromMain(value: unknown, taskId: string, serviceId: string, version: number): Preview | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row["scope"] !== "saved-config" || row["taskId"] !== taskId || row["serviceId"] !== serviceId ||
      row["templateVersion"] !== version || !Array.isArray(row["rows"]) || row["rows"].length > 160) return null;
  if (Object.keys(row).sort().join(",") !== (row["state"] === "blocked"
      ? "error,rows,scope,serviceId,state,taskId,templateVersion" : "rows,scope,serviceId,state,taskId,templateVersion")) return null;
  if (row["state"] === "blocked") {
    if (row["rows"].length || !["private-reference-unavailable", "environment-resolution-failed"].includes(String(row["error"]))) return null;
    return { state: "blocked", error: row["error"] as "private-reference-unavailable" | "environment-resolution-failed" };
  }
  if (row["state"] !== "ready" || row["error"] !== undefined) return null;
  const rows: Extract<Preview, { state: "ready" }>["rows"] = [];
  for (const item of row["rows"]) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const entry = item as Record<string, unknown>;
    if (Object.keys(entry).sort().join(",") !== "key,masked,source,value" || typeof entry["key"] !== "string" ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry["key"]) || entry["key"].length > 100 || typeof entry["value"] !== "string" || entry["value"].length > 4096 ||
        typeof entry["masked"] !== "boolean" || !["共享模板", "本机私有配置"].includes(String(entry["source"])) ||
        (entry["masked"] && entry["value"] !== "••••••••") ||
        ((entry["source"] === "本机私有配置" || /PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE_KEY/i.test(entry["key"])) && !entry["masked"])) return null;
    rows.push({ key: entry["key"], value: entry["value"], masked: entry["masked"], source: entry["source"] as string });
  }
  if (new Set(rows.map((entry) => entry.key)).size !== rows.length) return null;
  return { state: "ready", rows };
}

export function SavedServiceConfigPreview({ projectId, taskId, serviceId, templateVersion }: {
  projectId: string; taskId: string; serviceId: string; templateVersion: number;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const epoch = useRef(0);
  useEffect(() => {
    const token = epoch;
    token.current++; setPreview(null); setError(null); setPending(false);
    return () => { token.current++; };
  }, [projectId, taskId, serviceId, templateVersion]);
  const load = async () => {
    const request = ++epoch.current;
    setPending(true); setPreview(null); setError(null);
    const result = await serviceCatalogThroughShell({ op: "previewConfig", projectId, taskId, serviceId });
    if (epoch.current !== request) return;
    setPending(false);
    const parsed = result.ok ? savedServicePreviewFromMain(result.payload, taskId, serviceId, templateVersion) : null;
    if (!parsed) { setError("保存配置预览无法核对，请重试"); return; }
    setPreview(parsed);
  };
  return <section aria-label="保存配置预览" className="mt-3 text-xs">
    <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-medium">保存配置预览 · v{templateVersion}</h4><Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => void load()}><Icon name="refresh" />{pending ? "正在解析" : "读取配置预览"}</Button></div>
    <p className="mt-2 text-muted">业务默认配置：未读取 · 任务覆盖：未接线 · 运行时绑定：未接线</p>
    {error && <p role="alert" className="mt-2 text-[#ad4545]">{error}</p>}
    {preview?.state === "blocked" && <p role="alert" className="mt-2 text-[#ad4545]">{preview.error === "private-reference-unavailable" ? "本机私有引用缺失或无效，无法生成完整预览" : "环境变量引用解析失败，无法生成完整预览"}</p>}
    {preview?.state === "ready" && <div className="mt-2"><table className="w-full table-fixed text-left"><thead className="border-b border-line text-muted"><tr><th className="w-1/3 py-2 font-medium">KEY</th><th className="w-1/3 py-2 font-medium">VALUE</th><th className="py-2 font-medium">来源</th></tr></thead><tbody>{preview.rows.map((row) => <tr key={row.key} className="border-b border-line"><td className="break-all py-2 pr-2">{row.key}</td><td className="break-all py-2 pr-2">{row.value}</td><td className="break-words py-2">{row.source}</td></tr>)}</tbody></table>{!preview.rows.length && <p className="py-2 text-muted">已保存的共享与私有层无变量</p>}</div>}
  </section>;
}
