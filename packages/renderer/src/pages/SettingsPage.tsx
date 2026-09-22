import { useEffect, useState } from "react";
import { Button, Field, KeyValue, Panel } from "../components/ui";
import { useHostStore } from "../stores/host";
import { useUiStore } from "../stores/ui";

/**
 * 本机设置：原型在 2026-09-20 由用户确认，展示默认应用配置目录并编辑
 * workspaceRoot。属于本机设置，不进入项目共享模板。
 */
export function SettingsPage() {
  const settings = useHostStore((state) => state.localSettings);
  const setWorkspaceRoot = useHostStore((state) => state.setWorkspaceRoot);
  const pushToast = useUiStore((state) => state.pushToast);
  const openModal = useUiStore((state) => state.openModal);
  const workspaceRoot = settings?.workspaceRoot;
  const [root, setRoot] = useState(workspaceRoot ?? "");

  useEffect(() => {
    if (workspaceRoot !== undefined) setRoot(workspaceRoot);
  }, [workspaceRoot]);

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-base font-medium text-ink">本机设置</h1>
        <p className="mt-1 text-xs text-muted">本机设置只保存在当前机器，不写入项目共享模板；凭据通过安全存储引用。</p>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="应用配置目录">
          <KeyValue
            rows={[
              ["应用配置目录", settings?.configDir ?? "—"],
              ["默认配置文件", settings?.configFile ?? "—"],
            ]}
          />
          <p className="mt-3 text-[11px] text-muted">
            用于应用本机设置；Windows 对应用户主目录下的 .pi\dock。项目共享模板仍保存在项目中。
          </p>
        </Panel>

        <Panel title="默认任务根目录">
          <Field label="默认任务根目录" hint="新任务会在这个位置创建独立文件夹。修改后只影响后续新任务，已有任务不迁移。">
            <input
              aria-label="默认任务根目录"
              value={root}
              onChange={(event) => setRoot(event.target.value)}
              placeholder="例如：D:\PiDockTasks"
              className="rounded-md border border-line px-2 py-1.5 text-sm"
            />
          </Field>
          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="text-[11px] text-muted">目录属于本机设置，不写入项目共享模板；原型仅保存输入，不检查磁盘或创建目录。</p>
            <Button
              size="sm"
              variant="primary"
              onClick={async () => {
                try {
                  await setWorkspaceRoot(root);
                  pushToast("本机默认目录已保存到内存；已有任务不迁移");
                } catch (error) {
                  pushToast(error instanceof Error ? error.message : String(error));
                }
              }}
            >
              保存设置
            </Button>
          </div>
        </Panel>
      </div>

      <Panel title="本机仓库绑定" actions={<Button size="sm" onClick={() => openModal({ type: "repo-binding" })}>编辑绑定</Button>}>
        <p className="text-xs text-muted">
          已登记仓库在这台机器上的实际检出路径；任务创建独立工作副本，不直接写入原仓库。路径仅保存在本机，不读取磁盘。
        </p>
      </Panel>
    </div>
  );
}
