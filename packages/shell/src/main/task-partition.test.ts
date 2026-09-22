import { describe, expect, it } from "vitest";
import { taskPartitionName } from "./task-partition.js";

describe("taskPartitionName", () => {
  it("is stable for the same task id", () => {
    expect(taskPartitionName("Task Alpha", "workspace-a")).toBe(
      taskPartitionName("Task Alpha", "workspace-a"),
    );
  });

  it("separates different task ids deterministically", () => {
    expect(taskPartitionName("task-a", "workspace-a")).not.toBe(
      taskPartitionName("task-b", "workspace-a"),
    );
    expect(taskPartitionName("task-a", "workspace-a")).not.toBe(
      taskPartitionName("task-a", "workspace-b"),
    );
  });

  it("creates an Electron persistent partition with a readable slug", () => {
    expect(taskPartitionName("Task / Alpha 42", "workspace-a")).toMatch(
      /^persist:pidock-task-task-alpha-42-[a-f0-9]{12}$/,
    );
  });

  it("rejects an empty task id", () => {
    expect(() => taskPartitionName("   ")).toThrow("taskId");
  });
});
