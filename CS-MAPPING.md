# C# → JS 源码对应关系与导读

> 本文件记录 Patrick's Parabox C# 源码 (`Assembly-CSharp/`) 与 JS 移植版 (`src/`) 的对应关系。
> 供后续开发时快速定位逻辑。

## 核心引擎

| C# 文件 | JS 文件 | 对应内容 |
|----------|---------|---------|
| `Block.cs` | `src/core/model.js` (`createBlock`) | 方块数据模型：字段定义、isPlayer/flipH/hue/sat/val/possessable 等 |
| `Level.cs` | `src/core/model.js` (`createLevel`) | 关卡容器：width/height、blocks/floors 网格、exitBlock、infZone |
| `Floor.cs` | `src/core/model.js` (`createFloor`) | 地板：Button/PlayerButton/LevelPortal/Info/FastTravel |
| `Phantom.cs` | `src/core/engine.js` (`buildRenderPhantoms`) | Enter/Exit 过渡残影 |
| `Movement.cs` | `src/core/engine.js` | **核心规则引擎**：tryImpulse/Slide/Enter/Exit/Push/Eat/Possess/Nudge/InnerPush/Shed/Inf |
| `UndoManager.cs` | `src/core/engine.js` (`undoTurn/redoTurn/restartLevel`) | 结构化 Turn delta 撤消/重做系统 |
| `World.cs` | `src/core/engine.js` + `src/runtime/controller.js` | 全局协调：DoNextMultiPlayerImpulse、ComputeBlockLists、win detection |
| `Projection.cs` | `src/core/engine.js` (`computeProjectionFromTrail`) | Enter/Exit 投影动画偏移 |
| `Util.cs` | `src/parser/invariant.js` | ParseBool/ParseFloat/Clamp/Lerp/SignInt 工具函数 |

## 关卡解析与资源

| C# 文件 | JS 文件 | 对应内容 |
|----------|---------|---------|
| `LoadLevel.cs` | `src/parser/level.js` | .bytes 关卡文本解析器：Block/Wall/Floor/Ref 行、嵌套、坐标系转换 |
| `LevelProperties.cs` | `src/parser/level.js` (flags) | attemptOrder/shed/innerPush/drawStyle 解析 |
| `Localization.cs` | `src/parser/localization.js` | localization.bytes CSV 解析（引号转义语义） |
| — | `src/parser/resources.js` | puzzle_data/palettes/puzzle_lines 解析，关卡文本加载 |

## 渲染

| C# 文件 | JS 文件 | 对应内容 |
|----------|---------|---------|
| `Draw.cs` | `src/render/canvas-renderer.js` | **主渲染器**：DrawBlock/DrawWall/DrawBlockBorder/DrawFace/DrawInfEffect/DrawFlipShine |
| `Autotile.cs` | `src/render/canvas-renderer.js` (`computeWallTileIndex`) | 墙体自动贴图索引计算（48 种邻接模式） |
| `Particle.cs` | — | 粒子效果（JS 未实现） |

## 运行时/UI

| C# 文件 | JS 文件 | 对应内容 |
|----------|---------|---------|
| `Controls.cs` | `src/runtime/controller.js` (keydown handler) | 键盘输入抽象 |
| `Prefs.cs` | `src/runtime/controller.js` (localStorage) | MoveDelay/Language 偏好持久化 |
| `UndoInput.cs` | `src/runtime/controller.js` (animation block) | 动画期间屏蔽输入、按住加速 |
| `FastTravel.cs` | — | Hub 快速移动（JS 未实现） |
| `Gallery.cs` | — | 画廊浏览器（JS 未实现） |
| `Hub.cs` | — | Hub 关卡流（JS 未实现） |
| `Break.cs` | — | Break 模式（JS 未实现） |
| `SaveFile.cs` | `src/runtime/records.js` | Best record 持久化/回放 |

## 关键函数对照表

| 功能 | C# | JS |
|------|-----|-----|
| 发起移动 | `Movement.Impulse(block, dx, dy)` | `tryImpulse(state, blockId, direction)` → engine.js:89 |
| 滑动 | `Movement.AttemptToSlide` | `attemptToSlide` → engine.js:325 |
| 进入 | `Movement.AttemptToEnter` | `attemptToEnter` → engine.js:709 |
| 退出 | `Movement.AttemptToExit` | `attemptToExit` → engine.js:838 |
| 碰撞解决 | `Movement.AttemptToMoveToSpot` | `attemptToMoveToSpot` → engine.js:675 |
| 移动解析 | `Movement.ResolveMove` | `resolveMove` → engine.js:940 |
| 占据 | Attempt.Possess | `attemptPossess` → engine.js:638 |
| 墙色 | `Draw.ComputeWallColor` | `computeDrawWallHsv` → canvas-renderer.js:592 |
| 块色 | `Draw.ComputeBlockColor` | `computeDrawBlockHsv` → canvas-renderer.js:523 |
| 边框粗细 | `Draw.ComputeBorderThickness` | `computeBorderThicknessBlock` → canvas-renderer.js:292 |
| 边框绘制 | `Draw.DrawBlockBorder` | `drawBlockBorder` → canvas-renderer.js:1619 |
| 无穷效果 | `Draw.DrawInfEffect` | `drawInfinityEffect` → canvas-renderer.js:2316 |
| 面部绘制 | `Draw.DrawFace` | `drawFace` → canvas-renderer.js:2580 |
| 区间绘制 | `Draw.SetDrawRect` | `pixelOutsetRect` → canvas-renderer.js:796 |
| 翻转光泽 | `Draw.DrawFlipShine` | `drawFlipShine` → canvas-renderer.js:2356 |
| 多玩家 | `World.DoNextMultiPlayerImpulse` | `runInputCommand` 循环 → engine.js:39-54 |
| 撤消 | `UndoManager.Undo` | `undoTurn` → engine.js:161 |
| 重做 | `UndoManager.Redo` | `redoTurn` → engine.js:187 |
| 按钮评估 | `World.CheckPuzzlesAction` | `updateButtonsPressed` → model.js:217 |
| 方块列表 | `World.ComputeBlockLists` | `computeBlockLists` → model.js:243 |
| 边界计算 | `LoadLevel.ComputeLevelBorders` | `computeLevelWallMask` → canvas-renderer.js:445 |
| 克隆判定 | `Draw.cloneIntensity` | `resolveCloneIntensity` → canvas-renderer.js:372 |
| 翻转判定 | `Draw.flipIntensity` | `resolveFlipIntensity` → canvas-renderer.js:394 |

## 关键常量和配置

| C# | JS | 说明 |
|----|-----|------|
| `ENTER_LENGTH = 0.5f` | `ENTER_LENGTH = 0.5` | 进入动画时长（秒） |
| `Projection.cs` 常量 | `canvas-renderer.js` 常量 | 投影偏移/缩放 |
| `minDrawSize` | `MIN_EXPANDED_NESTED_SIZE = 48` | 嵌套展开最小尺寸 |
| `MaxSublevelRenderDepth` | `MAX_SUBLEVEL_RENDER_DEPTH = 4` | 递归渲染最大深度 |
| `MoveDelay` | `controller.currentState.prefs.moveDelay` | 移动动画时长 |
| `res_scale` | — | 资源缩放（JS 不需要） |

## 文件读取顺序（理解项目的最佳路径）

1. `src/core/model.js` — 数据结构
2. `src/parser/level.js` — 关卡如何加载
3. `src/core/engine.js` — 规则如何运转
4. `src/render/canvas-renderer.js` — 如何绘制
5. `src/runtime/controller.js` — 如何交互
