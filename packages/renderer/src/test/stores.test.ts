import { createMemoryHost } from "../data/memoryHost";
import { useDraftStore } from "../stores/drafts";
import { useEventsStore } from "../stores/events";
import { useHostStore } from "../stores/host";

describe("renderer state boundaries", () => {
  it("keeps the draft and references in the draft store after a failed run", async () => {
    const host = createMemoryHost();
    useHostStore.setState({ adapter: host, workspace: undefined, approvals: [], attention: [] });
    useDraftStore.setState({ drafts: {} });
    useEventsStore.setState({ liveMessages: {}, runs: {} });
    useDraftStore.getState().setText("release", "failed", "修复构建并重试");
    useDraftStore.getState().addReference("release", "failed", {
      id: "ref-1",
      kind: "file",
      label: "build.log:48",
      detail: "构建日志",
    });

    const result = await useHostStore.getState().sendMessage("release", "failed", "修复构建并重试", [
      { id: "ref-1", kind: "file", label: "build.log:48", detail: "构建日志" },
    ]);

    expect(result.state).toBe("failed");
    expect(useDraftStore.getState().getDraft("release", "failed")).toEqual({
      text: "修复构建并重试",
      references: [{ id: "ref-1", kind: "file", label: "build.log:48", detail: "构建日志" }],
    });
    expect(useHostStore.getState().session("release", "failed")?.runState).toBe("failed");
  });

  it("clears the draft only after a run reports a non-failure outcome", async () => {
    const host = createMemoryHost();
    useHostStore.setState({ adapter: host, workspace: undefined, approvals: [], attention: [] });
    useDraftStore.setState({ drafts: {} });
    useEventsStore.setState({ liveMessages: {}, runs: {} });

    const result = await useHostStore.getState().sendMessage("release", "main", "检查构建", []);
    expect(result.state).toBe("completed");
    useDraftStore.getState().clear("release", "main");
    expect(useDraftStore.getState().getDraft("release", "main")).toEqual({ text: "", references: [] });
  });

  it("projects Host data into the store without leaving approval logic in components", async () => {
    const host = createMemoryHost();
    useHostStore.setState({ adapter: host, workspace: undefined, approvals: [], attention: [] });
    await useHostStore.getState().refresh();
    expect(useHostStore.getState().approvals).toHaveLength(2);
    await useHostStore.getState().simulateExpiry("approval-deploy");
    const approval = useHostStore.getState().approvals.find((item) => item.id === "approval-deploy");
    expect(approval?.status).toBe("expired");
    expect(approval?.executed).toBe(false);
  });
});
