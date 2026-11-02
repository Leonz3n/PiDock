# 交接包检查记录

检查日期：2026-11-02。范围为本地设计资料；不是生产功能验收，也不声称已经在 Google Stitch 导入成功。

- Google `@google/design.md` 0.4.0 lint：**0 errors、0 warnings、1 info**。包含 23 个颜色、7 组文字、7 级圆角、8 个间距与 24 个组件；原始结果见 [design-lint.json](validation/design-lint.json)。
- 使用同一 CLI 实际导出 DTCG、Tailwind v4 CSS、Tailwind v3 JSON。通过 `tools/normalize-tokens.py` 修正字体列表，保留字体回退顺序；不会把整串列表作为单一字体名。
- 14 张 JPEG 已逐图联系表复核；替换了渲染异常图。尺寸由打包脚本验证，04 保留完整对话框，其余裁剪规则见 [参考说明](reference/README.md)。
- 文档本地 Markdown 链接、JSON 解析、文本末尾换行与行尾空白通过打包检查。
- MANIFEST.json 记录所有交付文件的字节数与 SHA-256，清单自身不参与递归哈希。ZIP 只包含 `stitch-apple/`，通过 CRC 与逐文件哈希校验。
- 本包的生成未修改生产源码、既有 Quiet Ledger 候选、GitHub Issues 或 Google 服务。截图来自独立内存演示页，原用户页保持打开。

复验：在本目录运行 `python3 tools/normalize-tokens.py`、`python3 tools/package.py`。重新编辑 DESIGN.md 后应先运行 README 中的 lint/export 命令并更新此记录；脚本不自动宣称新的视觉评审或产品验收结果。
