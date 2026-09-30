export interface ServiceTemplateView {
  projectId: string;
  serviceId: string;
  version: number;
  descriptor: { name: string; program: string; args: string[]; ports: number[]; runType: "long-lived" | "prepare" | "one-shot" };
  sharedKeys: string[];
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ServiceBindingView {
  taskId: string;
  serviceId: string;
  templateVersion: number;
  rootId: string;
  subdir: string;
  privateKeys: string[];
}
export function serviceBindingsFromMain(value: unknown, taskId: string): ServiceBindingView[] | null {
  if (!Array.isArray(value) || value.length > 500) return null;
  const result: ServiceBindingView[] = [];
  for (const row of value) {
    if (!object(row) || Object.keys(row).sort().join(",") !== "privateKeys,rootId,serviceId,subdir,taskId,templateVersion" ||
        row["taskId"] !== taskId || typeof row["serviceId"] !== "string" || !/^s-[0-9a-f-]{36}$/i.test(row["serviceId"]) ||
        !Number.isSafeInteger(row["templateVersion"]) || (row["templateVersion"] as number) < 1 ||
        typeof row["rootId"] !== "string" || typeof row["subdir"] !== "string" || !Array.isArray(row["privateKeys"]) ||
        row["privateKeys"].some((key) => typeof key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) return null;
    result.push({ taskId, serviceId: row["serviceId"], templateVersion: row["templateVersion"] as number,
      rootId: row["rootId"], subdir: row["subdir"], privateKeys: [...row["privateKeys"]] as string[] });
  }
  return new Set(result.map((row) => row.serviceId)).size === result.length ? result : null;
}

/** Public projection only: machine paths, reference names and values do not enter the page model. */
export function serviceTemplatesFromMain(value: unknown, projectId: string): ServiceTemplateView[] | null {
  if (!Array.isArray(value) || value.length > 500) return null;
  const result: ServiceTemplateView[] = [];
  for (const entry of value) {
    if (!object(entry) || !object(entry["descriptor"]) || !Array.isArray(entry["sharedKeys"]) ||
        Object.keys(entry).sort().join(",") !== "descriptor,projectId,serviceId,sharedKeys,version" ||
        entry["projectId"] !== projectId || typeof entry["serviceId"] !== "string" ||
        !/^s-[0-9a-f-]{36}$/i.test(entry["serviceId"]) || !Number.isSafeInteger(entry["version"]) || (entry["version"] as number) < 1) return null;
    const descriptor = entry["descriptor"];
    if (typeof descriptor["name"] !== "string" || !descriptor["name"] || typeof descriptor["program"] !== "string" ||
        !descriptor["program"] || !Array.isArray(descriptor["args"]) || descriptor["args"].some((arg) => typeof arg !== "string") ||
        !Array.isArray(descriptor["ports"]) || descriptor["ports"].some((port) => !Number.isInteger(port) || port < 1 || port > 65535) ||
        !["long-lived", "prepare", "one-shot"].includes(descriptor["runType"] as string) ||
        entry["sharedKeys"].some((key: unknown) => typeof key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) return null;
    result.push({ projectId, serviceId: entry["serviceId"], version: entry["version"] as number,
      descriptor: { name: descriptor["name"], program: descriptor["program"], args: [...descriptor["args"]] as string[],
        ports: [...descriptor["ports"]] as number[], runType: descriptor["runType"] as ServiceTemplateView["descriptor"]["runType"] },
      sharedKeys: [...entry["sharedKeys"]] as string[] });
  }
  if (new Set(result.map((row) => row.serviceId)).size !== result.length) return null;
  return result;
}
