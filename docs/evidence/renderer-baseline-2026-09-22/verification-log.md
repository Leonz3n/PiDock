# 渲染层证据验证日志（2026-09-22 第三轮整改）

本文件由第三轮整改实际运行后写入，记录四道检查、证据脚本与三处变异验证的真实输出；避免这些结论只以散文形式留在评审文档里。所有命令在仓库根 `/Users/leonz3n/Workspace/github/pi-agent-ui` 执行，Node 经 PATH 固定为 24.21.0。

## 1. 四道检查（`--force`，绕开 turbo 缓存）

```text
$ pnpm typecheck --force
$ turbo run typecheck --force
• turbo 2.11.2

   • Packages in scope: @pidock/renderer
   • Running typecheck in 1 package
   • Remote caching disabled

@pidock/renderer:typecheck: cache bypass, force executing d7b3bdc08b1339a5
@pidock/renderer:typecheck: $ tsc -p tsconfig.json --noEmit

 Tasks:    1 successful, 1 total
Cached:    0 cached, 1 total
  Time:    1.032s 

exit=0

$ pnpm test --force
$ turbo run test --force
• turbo 2.11.2

   • Packages in scope: @pidock/renderer
   • Running test in 1 package
   • Remote caching disabled

@pidock/renderer:test: cache bypass, force executing fca8ed02620d799c
@pidock/renderer:test: $ vitest run
@pidock/renderer:test: 
@pidock/renderer:test:  RUN  v3.2.7 /Users/leonz3n/Workspace/github/pi-agent-ui/packages/renderer
@pidock/renderer:test: 
@pidock/renderer:test:  ✓ src/test/directories.test.ts (7 tests) 2ms
@pidock/renderer:test:  ✓ src/test/configRows.test.ts (9 tests) 2ms
@pidock/renderer:test:  ✓ src/test/virtualList.test.tsx (9 tests) 45ms
@pidock/renderer:test:  ✓ src/test/adapter.test.ts (15 tests) 66ms
@pidock/renderer:test:  ✓ src/test/stores.test.ts (3 tests) 41ms
@pidock/renderer:test:  ✓ src/test/codeblock.test.tsx (1 test) 117ms
@pidock/renderer:test:  ✓ src/test/tokens.test.ts (11 tests) 4ms
@pidock/renderer:test:  ✓ src/test/settings.test.tsx (2 tests) 228ms
@pidock/renderer:test:  ✓ src/test/directoriesFlow.test.tsx (7 tests) 471ms
@pidock/renderer:test:  ✓ src/test/modals.test.tsx (2 tests) 695ms
@pidock/renderer:test:    ✓ rename modals > does not save a stale rename draft from one modal into the other  477ms
@pidock/renderer:test:  ✓ src/test/env.test.tsx (5 tests) 798ms
@pidock/renderer:test:    ✓ environment scope editing > adds and edits KEY/VALUE rows, requiring a valid non-duplicate KEY but allowing an empty VALUE  438ms
@pidock/renderer:test:  ✓ src/test/app.test.tsx (9 tests) 1019ms
@pidock/renderer:test:    ✓ PiDock renderer flows > renders tool panels from adapter data instead of hardcoded fixtures  356ms
@pidock/renderer:test: 
@pidock/renderer:test:  Test Files  12 passed (12)
@pidock/renderer:test:       Tests  80 passed (80)
@pidock/renderer:test:    Start at  09:56:36
@pidock/renderer:test:    Duration  1.72s (transform 422ms, setup 888ms, collect 1.60s, tests 3.49s, environment 3.00s, prepare 498ms)
@pidock/renderer:test: 

 Tasks:    1 successful, 1 total
Cached:    0 cached, 1 total
  Time:    2.13s 

exit=0

$ pnpm build --force
$ turbo run build --force
• turbo 2.11.2

   • Packages in scope: @pidock/renderer
   • Running build in 1 package
   • Remote caching disabled

@pidock/renderer:build: cache bypass, force executing 9ec117c693862357
@pidock/renderer:build: $ vite build
@pidock/renderer:build: vite v7.3.6 building client environment for production...
@pidock/renderer:build: transforming...
@pidock/renderer:build: ✓ 150 modules transformed.
@pidock/renderer:build: rendering chunks...
@pidock/renderer:build: computing gzip size...
@pidock/renderer:build: dist/index.html                              0.68 kB │ gzip:   0.45 kB
@pidock/renderer:build: dist/assets/index-BOrT_W5S.css              20.22 kB │ gzip:   4.77 kB
@pidock/renderer:build: dist/assets/json-Cp-IABpG.js                 2.87 kB │ gzip:   0.81 kB │ map:     4.35 kB
@pidock/renderer:build: dist/assets/github-light-DAi9KRSo.js        11.23 kB │ gzip:   2.54 kB │ map:    15.44 kB
@pidock/renderer:build: dist/assets/bash-Yzrsuije.js                41.52 kB │ gzip:   6.13 kB │ map:    56.55 kB
@pidock/renderer:build: dist/assets/engine-javascript-ZX5pI3G3.js   59.14 kB │ gzip:  20.70 kB │ map:   205.52 kB
@pidock/renderer:build: dist/assets/core-BXnl5npm.js               113.64 kB │ gzip:  36.30 kB │ map:   440.34 kB
@pidock/renderer:build: dist/assets/tsx-COt5Ahok.js                175.58 kB │ gzip:  16.55 kB │ map:   236.76 kB
@pidock/renderer:build: dist/assets/typescript-BPQ3VLAy.js         181.13 kB │ gzip:  16.08 kB │ map:   244.43 kB
@pidock/renderer:build: dist/assets/index-Eg6rqaMe.js              366.29 kB │ gzip: 111.05 kB │ map: 1,467.45 kB
@pidock/renderer:build: ✓ built in 669ms

 Tasks:    1 successful, 1 total
Cached:    0 cached, 1 total
  Time:    991ms 

exit=0

$ pnpm lint --force
$ turbo run lint --force
• turbo 2.11.2

   • Packages in scope: @pidock/renderer
   • Running lint in 1 package
   • Remote caching disabled

@pidock/renderer:lint: cache bypass, force executing 1f28e99c728a68fc
@pidock/renderer:lint: $ eslint . --max-warnings 0

 Tasks:    1 successful, 1 total
Cached:    0 cached, 1 total
  Time:    826ms 

exit=0
```

结论：`typecheck` / `test` / `build` / `lint` 全部退出码 0；测试 12 个文件 80 例通过。

## 2. 证据脚本（dev server 4335 + 原型只读服务 4319）

退出码：measure=0、anchor=0、brand=0、capture=0。

### measure-baseline.mjs

```text
{
  "tokens": {
    "accent": "#233c78",
    "bg": "#f6f7f8",
    "ink": "#252b30",
    "radiusPanel": "10px",
    "bodyBackground": "rgba(0, 0, 0, 0)",
    "shellBackground": "rgb(246, 247, 248)",
    "headingText": "需要处理",
    "headingColor": "rgb(37, 43, 48)"
  },
  "usage": {
    "total": 240,
    "virtualized": "true",
    "declaredHeight": 420,
    "viewportHeight": 420,
    "rowHeight": 34,
    "overscan": 6,
    "expected": 19,
    "expectedAttribute": 19,
    "rendered": 19,
    "heightMatchesDeclared": true,
    "rowsMatchExpected": true
  },
  "sessions": {
    "total": 43,
    "virtualized": "true",
    "declaredHeight": 280,
    "viewportHeight": 280,
    "rowHeight": 56,
    "overscan": 6,
    "expected": 11,
    "expectedAttribute": 11,
    "rendered": 11,
    "heightMatchesDeclared": true,
    "rowsMatchExpected": true
  },
  "sessionTabs": 4,
  "runHistory": {
    "total": 47,
    "virtualized": "true",
    "declaredHeight": 280,
    "viewportHeight": 280,
    "rowHeight": 40,
    "overscan": 6,
    "expected": 13,
    "expectedAttribute": 13,
    "rendered": 13,
    "heightMatchesDeclared": true,
    "rowsMatchExpected": true
  },
  "settings": {
    "heading": "本机设置",
    "workspaceRoot": "~/PiDockTasks",
    "showsConfigDir": true
  },
  "errors": [],
  "expectationMismatches": []
}

wrote /Users/leonz3n/Workspace/github/pi-agent-ui/docs/evidence/renderer-baseline-2026-09-22/measurements.json
```

### verify-anchor.mjs（结尾）

```text
      }
    },
    "pageErrors": [],
    "no-page-errors": {
      "pass": true,
      "detail": []
    }
  },
  "failed": false
}

wrote /Users/leonz3n/Workspace/github/pi-agent-ui/docs/evidence/renderer-baseline-2026-09-22/anchor-follow-verification.json
```

### verify-brand.mjs（结尾）

```text
      }
    },
    "pageErrors": [],
    "no-page-errors": {
      "pass": true,
      "detail": []
    }
  },
  "failed": false
}

wrote /Users/leonz3n/Workspace/github/pi-agent-ui/docs/evidence/renderer-baseline-2026-09-22/brand-mark-verification.json
```

### capture.mjs（结尾；原型侧 favicon 404 已显式告警）

```text
  "prototypeErrors": [
    {
      "page": "http://127.0.0.1:4319/?variant=A",
      "kind": "console",
      "message": "Failed to load resource: the server responded with a status of 404 (File not found)"
    }
  ],
  "prototypeErrorsAnnounced": true
}

wrote /Users/leonz3n/Workspace/github/pi-agent-ui/docs/evidence/renderer-baseline-2026-09-22/capture-errors.json
prototype reported 1 error(s) (prototypes/ is read-only, not fixed here): Failed to load resource: the server responded with a status of 404 (File not found)
```

## 3. 变异验证（临时改动后运行、随即 `git checkout` 还原）

### 3.1 VirtualList 改回 content box 推导

改动：`resolveViewportHeight` 候选顺序改为优先 `contentBox`。

```text
   × resolveViewportHeight > prefers the border box so a bordered element keeps the height it was given 4ms
   × resolveViewportHeight > falls back to the layout rect, then the content box, when borderBoxSize is unavailable 0ms
   ✓ resolveViewportHeight > never returns a non-positive height 0ms
   × resolveViewportHeight > is stable when a bordered element's measurement is fed back (would shrink on content-box code) 0ms
   ✓ viewportWindowSize > matches ceil(viewportHeight / rowHeight) + overscan, capped at the item count 0ms
   × VirtualList with a bordered viewport > keeps its declared height across repeated resize notifications 25ms
   ✓ VirtualList with a bordered viewport > renders exactly the expected window for a bordered list 4ms
   ✓ VirtualList with a bordered viewport > treats an unbordered viewport the same as a bordered one with matching boxes 3ms
   ✓ VirtualList with a bordered viewport > stops observing when it unmounts 2ms
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 4 ⎯⎯⎯⎯⎯⎯⎯
 Test Files  1 failed (1)
      Tests  4 failed | 5 passed (9)
```

结论：9 例中 **4 例失败**（border-box 取值、rect 回退、回灌稳定性、组件级高度保持）。

### 3.2 重命名模态共用泄漏草稿

改动：模块级 `leakedDraftValue` 由任务重命名模态写入、会话模态读取，模拟修复前的 `draftValue || modal.value` 保存路径。

```text
   × rename modals > does not save a stale rename draft from one modal into the other 340ms
   ✓ rename modals > still renames the session it was opened for 201ms
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯
 Test Files  1 failed (1)
      Tests  1 failed | 1 passed (2)
```

结论：**1 例失败**（`does not save a stale rename draft from one modal into the other`）。

### 3.3 向 `ui.tsx` 植入绿色工具类

改动：在 `ui.tsx` 加入 `text-green-500`。

```text
   ✓ design tokens carry no green > detects green across hex, rgb() and hsl() forms and spares neutral or blue colours (self-check) 1ms
   ✓ design tokens carry no green > flags green hidden in arbitrary-value escapes, and still spares a blue one (self-check) 0ms
   ✓ design tokens carry no green > parses the required tokens 0ms
   ✓ design tokens carry no green > keeps every colour out of the green band 0ms
   ✓ design tokens carry no green > keeps the accent in the blue band 0ms
   ✓ design tokens carry no green > uses no green keywords or green rgb()/hsl() literals in raw token values 0ms
   ✓ component sources carry no green either > flags a Tailwind green utility (self-check) 0ms
   ✓ component sources carry no green either > collected the renderer sources to scan 0ms
   × component sources carry no green either > uses no Tailwind green utility in components 3ms
   × component sources carry no green either > uses no green keyword in component sources 1ms
   ✓ component sources carry no green either > uses no chromatic green colour literal in component sources 0ms
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯
 Test Files  1 failed (1)
      Tests  2 failed | 9 passed (11)
```

结论：`tokens.test.ts` 11 例中 **2 例失败**—— Tailwind 绿色工具类检测与绿色关键字检测各命中一条；早前评审记的「token test fails」未记具体条数，这里补足为 2。

## 4. 时间相关（不可逐字节复现）字段

`renderer/task-deploy.png` 中的审批面板把 `expiresAt`（`Date.now() + 24h` 经 `toLocaleString`）渲染为文本，因此截图内容随运行时刻变化。其余 JSON 在本机可复现，但不声称跨主机逐字节一致（见 `docs/renderer-baseline-review.md` 的更正说明）。

生成时间：2026-09-22T09:57:28+0800

