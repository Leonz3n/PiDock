# Windows 安装资产改为 MSI（替换 NSIS 单一 EXE），保留 x64 架构与签名门禁

Status: accepted (2026-10-13; 人工决定)

MVP 规格与发布门禁把 Windows 首发资产写成**单一 x64 `.exe` 安装包（NSIS）**（`.scratch/pidock-mvp/spec.md:113`（US-70）、同文件「安装包与 GitHub Release」节（锚点 `#安装包与-github-release`）与验收用例表中「安装包构建与发布」「安装与升级」两行；本 ADR 不引用这些位置的行号，因为该节随后被插入的取代说明改动了行号。另见 `docs/mvp-validation-plan.md:95,116`、`docs/design-notes.md:210`、`docs/product-design-closure.md:50`）。本决策**取代**该资产格式，其余（x64 架构、签名门禁、发布一致性要求）不变。

## 决定

Windows x64 的安装资产改为 **MSI**：

- `packages/shell/electron-builder.config.cjs` 的 `win.target` 由 `nsis` 改为 `msi`（`arch: ["x64"]` 不变）。
- NSIS 配置块按 MSI 的真实选项集改写；**NSIS 专有键一律删除**，不与 MSI 混用。已核实的差异（读自已安装的 `app-builder-lib@26.15.3` 自己的 schema，不是外部文档）：
  - `oneClick`、`perMachine`、`artifactName` 在 `MsiOptions` 中**合法**；
  - `allowToChangeInstallationDirectory` **不在** `MsiOptions` 内（`additionalProperties:false`），MSI 的安装目录由模板推导，必须删除；
  - `guid` 是 NSIS 概念，MSI 的对应物是 `upgradeCode`。
- `packages/shell/package.json` 的 `package:win` 由 `--win nsis --x64` 改为 `--win msi --x64`。
- **安装范围保持按用户**（`perMachine:false`）与**交互式安装**（`oneClick:false`），即沿用原 NSIS 块表达的同一意图；这两项是 MSI 合法键。
- `upgradeCode` **不显式写死**：由 `appId`（`com.pidock.desktop`）按固定命名空间推导（`MsiTarget.js:48-50`）。因此**改动 `appId` 会改变升级身份**，属于本决策的已知约束；若日后需要跨 `appId` 改名仍可升级，再单独决定是否固定 `upgradeCode`。
- macOS 的 `mac`/`dmg`/`electronDist`/`afterSign` 路径**不受影响**（只有 `--win` 影响 `wantsWindows` 覆盖）。

## 后果与边界（必须如实记录）

- **MSI 不是纯配置改动就能验证的**：构建需要 WiX `4.0.0.5512.2`（构建时下载，`MsiTarget.js:73`），非 Windows 宿主还要跑 x86_64 版 Wine（`toolsets/wine.js:8-14`）。**darwin-arm64 主机**（本 ADR 的决策环境）**未构建、未安装、未升级验证过任何 MSI**；此前连 NSIS 交叉构建都已记录为失败（`docs/electron-packaging.md` 的「Windows x64 候选状态」节）。
  - **更新（2026-10-14，#58，win32-x64 主机）：**在 Windows 主机上 MSI 确实构建成功，且安装/启动/覆盖升级/卸载均已实测（逐条证据见 `docs/electron-packaging.md` 的「Windows x64 MSI 实测」节）。同时暴露一条本 ADR 未预见的必需条件：**msi 目标必须有 `win.icon`**——MSI 模板只在 `iconPath` 存在时才发 `<Icon>`，而 `MsiTarget` 无条件引用它，缺图标即 `light.exe` LGHT0094；产物未签名。
- **安装/卸载/升级与 Authenticode 签名验收必须在 Windows 上完成**；在这些结果出现前，**任何文档或报告都不得声称 Windows 资产可用或签名通过**。
  - **更新（2026-10-14，#58）：**代码签名仍未验收（该主机 0 张证书，MSI 与 `PiDock.exe` 的 `Get-AuthenticodeSignature` 均为 `NotSigned`）；干净系统安装、多用户账户、>1 版本升级矩阵也仍未验证。不得据上述实测声明 Windows 资产已签名或可在干净系统上发布。
- 纯配置层可在任意平台验证的部分（配置可加载、`win.target` 为 `msi`、无 NSIS 专有键残留、MSI 块键均在 `MsiOptions` 允许集内、mac 路径未变）由自动化检查守住；这类检查**不证明** MSI 产物存在。
- **历史研究记录不改写**：`docs/desktop-runtime-research.md`、`docs/browser-automation-validation.md`、`docs/design-notes.md:158,169,238` 等属于当时的选项空间调研（`docs/design-notes.md:238` 已声明其保留为历史），保持原样；只有**现行要求类文档**（规格、验证计划、打包状态、设计结论）按本决策更新为 MSI。
- 本决策**不**关闭任何工单，也不勾选任何验收格；`#15` 的 Windows 侧验收仍为未验证状态。
