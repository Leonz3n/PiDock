# PiDock 外观主题设计

本文件是当前唯一 UI 设计 [PiDock.pen](PiDock.pen) 的明暗主题配套说明。设计总入口见 [README.md](README.md)；旧候选设计已清理。本文件不代表应用主题切换已经实现。

## 视觉方向

日间采用暖灰背景、纸白表面和深灰文字；夜间采用炭灰背景与浅灰文字。强调色统一为低饱和雾蓝。减少大面积纯白、纯黑和高饱和强调，保持内容与控件的层次。状态使用文字与颜色共同表达，沿用不使用绿色的约束。

| 语义色 | 日间 | 夜间 |
| --- | --- | --- |
| bg-canvas | #F3F1EC | #202226 |
| bg-surface | #FAF8F4 | #282B30 |
| bg-sidebar | #EAE7E1 | #1C1E22 |
| bg-sunken | #E6E3DD | #23252A |
| bg-code | #ECE9E3 | #25282D |
| ink-primary | #30343B | #DDDCD7 |
| ink-secondary | #555B64 | #BABBC0 |
| ink-muted | #60666F | #9498A1 |
| border-light | #DCD8D0 | #393D44 |
| border-strong | #BDB7AE | #616873 |
| accent-primary | #4B638D | #ADC2E8 |
| accent-soft | #E1E7F0 | #303D52 |
| status-settled | #496174 | #AFBFCD |
| status-settled-soft | #E3E8EB | #2D3741 |
| status-attention | #805C28 | #D7B578 |
| status-attention-soft | #F0E6D4 | #3B3226 |
| status-danger | #9E4943 | #E3A19A |
| status-danger-soft | #F2E2DE | #402D2D |
| on-solid | #FFFFFF | #20242B |
| overlay | #24262B66 | #0D0F1499 |

## 外观交互

- 设置中心增加「外观」，继续占满窗口，保留返回任务工作区入口。
- 提供「日间」「夜间」「跟随系统」三种偏好，默认跟随系统。
- 选择后立即更新 PiDock 界面并保存偏好；系统模式响应操作系统的外观变化，手动模式保持用户选择。
- 外观偏好由 PiDock 管理；Pi Agent 的 models.json、mcp.json 等原生运行配置继续按各自用途管理。
- 模式切换保留当前任务、会话、未发送输入及执行状态。模型与推理强度继续使用紧邻的紧凑控件。

## Pencil 主题结构

使用 mode: light / dark 主题轴和同名语义色变量。现有 11 个业务画板已设为日间；各节点通过变量支持切换。补充了 4 个夜间业务预览和 2 个外观设置画板：

| 画板 | 节点 | 坐标 |
| --- | --- | --- |
| S01 夜间任务对话 | R7HvXE | 0, 2940 |
| S03B 夜间供应商编辑 | ahVjF | 1520, 2940 |
| S02 夜间新建任务 | F5NKK | 3040, 2940 |
| S06 夜间紧凑窗口 | prEPL | 4560, 2940 |
| S11 外观设置（日间） | Pkb7d | 0, 3920 |
| S11 外观设置（夜间） | L28xKD | 1520, 3920 |

按钮文字和图标使用 on-solid，遮罩使用 overlay，避免固定白色在夜间主题下失去对比。

## 验证

- 17 个画板的 Pencil 布局检查：0 处裁切或溢出。
- 检查正文、次级、辅助文字在五种中性表面上的对比，以及强调按钮、强调状态与三个状态色组：共 40 组不透明颜色组合，最低 4.52:1，均达到普通文字 4.5:1 的对比阈值。
- 此数值针对指定颜色组合，不涵盖禁用态透明度、所有控件边界或完整应用的无障碍验收。
- 已查看日间对话、夜间对话、供应商表单、新建任务、720×560 紧凑窗口及明暗外观设置截图。

完整颜色与对比数值见 [appearance.tokens.json](appearance.tokens.json)。
