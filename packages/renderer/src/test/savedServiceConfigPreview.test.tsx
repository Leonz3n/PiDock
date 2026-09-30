import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ShellTaskOpResult } from "../data/shellBridge";
import { afterEach, expect, it, vi } from "vitest";
import { SavedServiceConfigPreview, savedServicePreviewFromMain } from "../components/SavedServiceConfigPreview";
const props = { projectId: "project", taskId: "task-a", serviceId: "service-a", templateVersion: 1 };
const preview = { scope: "saved-config", taskId: props.taskId, serviceId: props.serviceId, templateVersion: 1, state: "ready", rows: [
  { key: "PORT", value: "3000", masked: false, source: "共享模板" },
  { key: "API_TOKEN", value: "••••••••", masked: true, source: "本机私有配置" },
] };
afterEach(() => { cleanup(); delete window.pidock; });
it("reads only on explicit request and displays masked pinned saved-layer values", async () => {
  const serviceCatalogOp = vi.fn(async () => ({ ok: true, payload: preview }));
  window.pidock = { serviceCatalogOp };
  render(<SavedServiceConfigPreview {...props} />);
  expect(serviceCatalogOp).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "读取配置预览" }));
  expect(await screen.findByText("3000")).toBeInTheDocument();
  expect(screen.getByText("••••••••")).toBeInTheDocument();
  expect(screen.getByText(/业务默认配置：未读取/)).toBeInTheDocument();
  expect(serviceCatalogOp).toHaveBeenCalledWith({ op: "previewConfig", projectId: props.projectId, taskId: props.taskId, serviceId: props.serviceId });
});
it("reports missing private references without an empty-success table", async () => {
  window.pidock = { serviceCatalogOp: vi.fn(async () => ({ ok: true, payload: { ...preview, state: "blocked", error: "private-reference-unavailable", rows: [] } })) };
  render(<SavedServiceConfigPreview {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "读取配置预览" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("本机私有引用缺失或无效");
  expect(screen.queryByRole("table")).toBeNull();
});
it("discards a late preview when switching tasks", async () => {
  let finish: ((result: ShellTaskOpResult) => void) | undefined;
  const pending = new Promise<ShellTaskOpResult>((resolve) => { finish = resolve; });
  window.pidock = { serviceCatalogOp: vi.fn(() => pending) };
  const { rerender } = render(<SavedServiceConfigPreview {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "读取配置预览" }));
  rerender(<SavedServiceConfigPreview {...props} taskId="task-b" />);
  finish?.({ ok: true, payload: preview });
  await waitFor(() => expect(screen.getByRole("button", { name: "读取配置预览" })).toBeEnabled());
  expect(screen.queryByRole("table")).toBeNull();
});
it("rejects raw private values, foreign identities and wrong pinned versions", () => {
  expect(savedServicePreviewFromMain({ ...preview, rows: [{ key: "API_TOKEN", value: "raw-private", masked: true, source: "本机私有配置" }] }, props.taskId, props.serviceId, 1)).toBeNull();
  expect(savedServicePreviewFromMain({ ...preview, rawEnv: "leaked" }, props.taskId, props.serviceId, 1)).toBeNull();
  expect(savedServicePreviewFromMain(preview, "other-task", props.serviceId, 1)).toBeNull();
  expect(savedServicePreviewFromMain(preview, props.taskId, props.serviceId, 2)).toBeNull();
});
