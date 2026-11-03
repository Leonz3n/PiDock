import { describe, expect, it } from "vitest";
import { SHARED_DIR_MANAGED_PROTECTION, SHARED_DIR_MANAGED_PROTECTION_SHORT, sharedDirRefusalText } from "./sharedDirProtection";

describe("[Pencil T06] #141 受管保护的界面文案", () => {
  it("说清范围、真实路径键、持有者与具名恢复，并明确外部编辑器豁免", () => {
    expect(SHARED_DIR_MANAGED_PROTECTION).toContain("受管保护");
    expect(SHARED_DIR_MANAGED_PROTECTION).toContain("真实路径");
    expect(SHARED_DIR_MANAGED_PROTECTION).toContain("祖先／后代重叠");
    expect(SHARED_DIR_MANAGED_PROTECTION).toContain("实际持有者");
    expect(SHARED_DIR_MANAGED_PROTECTION).toContain("lock-owner-dead");
    expect(SHARED_DIR_MANAGED_PROTECTION).toContain("ADR 0006");
    // 不以「文件已隔离」冒充保护语义（唯一出现是明确的否定句）。
    expect(SHARED_DIR_MANAGED_PROTECTION).not.toContain("文件已隔离");
    expect(SHARED_DIR_MANAGED_PROTECTION).toContain("不会把这种情况报告成已隔离");
    expect(SHARED_DIR_MANAGED_PROTECTION_SHORT).toContain("ADR 0006");
  });

  it("拒绝 → 保留 Host 的持有者说明；恢复 → 说清是被具名接管；未知 → 不改写成成功", () => {
    expect(sharedDirRefusalText(undefined)).toBeNull();
    expect(sharedDirRefusalText("")).toBeNull();
    const locked = sharedDirRefusalText("shared-path-locked: 真实路径 /srv/docs 正由任务 task-a 的会话 main 写入（Host 实例 h · 进程 42）");
    expect(locked).toContain("写入未执行");
    expect(locked).toContain("task-a");
    expect(locked).toContain("进程 42");
    const recovered = sharedDirRefusalText("lock-owner-dead: 共享真实路径 /srv/docs 的写入持有者已不存在（任务 task-gone）");
    expect(recovered).toContain("具名恢复");
    expect(recovered).toContain("task-gone");
    expect(sharedDirRefusalText("shared-path-lock-unreadable: 记录损坏")).toContain("不静默强夺");
    expect(sharedDirRefusalText("shared-path-lock-unavailable: 锁不可用")).toContain("未取得互斥");
    expect(sharedDirRefusalText("task-host-closing")).toBe("Host 拒绝：task-host-closing");
  });
});
