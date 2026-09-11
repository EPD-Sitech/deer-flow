# DeerFlow × three-vrm 数字人设计方案

- 状态：MVP 已实现（前端浏览器端 VRM 数字人 + 流式 TTS），本文档同时作为
  已落地实现的设计说明与后续增强路线图
- 相关提交：`59c5ab45`（浏览器端 3D VRM 数字人 + 流式 TTS）、
  `291b4c4d`（TTS 暂停/继续 + 调整默认姿势）
- 依赖：`@pixiv/three-vrm` ^3.5.5、`@pixiv/three-vrm-animation` ^3.5.5、
  `three` ^0.185.1、`node-edge-tts` ^1.2.10（前端 / `frontend/`）

## 1. 背景与目标

DeerFlow 是一个 LangGraph 驱动的 AI 超级体系统，前端为 Next.js 聊天界面，
后端 Gateway 提供 REST + SSE 流式运行。传统聊天只以文字/卡片呈现「智能」，
缺少具身化的表达载体。

本项目在现有聊天页内交付一个**浏览器端 3D 数字人**（基于 VRM 人体模型 + VRMA
动作），把 DeerFlow 的流式回答**实时朗读**出来，并用**振幅驱动口型**让数字人
「开口说话」，从而把 AI 的回复从纯文本提升为可听、可见、可互动的数字人对话。

设计目标：

1. **零后端改动**——数字人完全跑在前端，TTS 走前端 Next.js 路由，不动 Gateway
   与 nginx 代理链路。
2. **不侵入现有聊天流**——在 `values/` 之上消费已有流式消息，独立于 LangGraph
   SDK 的 `throttle:true` 主循环，避免与其竞态。
3. **首屏 JS 预算友好**——three.js 全链路动态导入，只有真正渲染数字人时才下载。
4. **具备身位与表演能力**——预置模型与 VRMA 动作、口型、眨眼、呼吸、手势。

## 2. 总体架构

```
DeerFlow 聊天线程 (useThread)
        │  stream messages (values)
        ▼
  use-avatar-speaker.ts        ← 从句读流中切句，喂给 SpeechQueue
        │  append(sentence)
        ▼
     SpeechQueue (tts-client.ts)   ← 排队、限并发、重试、缓存、暂停/继续/停止
        │  POST /tts (node-edge-tts)  → mp3 Blob
        ▼
   HTMLAudioElement → LipSyncEngine (WebAudio AnalyserNode)  → getMouthOpen()
        │                                                    │
        ▼                                                    ▼
   AvatarCanvas (React 边界)                          VRM 表情(setValue)
        │  动态 import VrmScene (three.js 舞台)
        ▼
   VrmScene (vrm-scene.ts)  ← WebGL 渲染循环 / 口型 / 眨眼 / 呼吸 / 手势 / VRMA
```

分层职责：

- **React 层**（`avatar-dock.tsx`、`avatar-canvas.tsx`）只负责：拖拽停靠窗、
  加载已保存模型、朗读控制（暂停/继续/停止/重播/解锁）、把 `VrmScene` 挂到
  容器并喂入 `mouthProvider`。`motion-choreography.ts` 编排动作：空闲时循环比耶、
  打招呼和展示全身；点击模型依次摆姿势、比耶、转圈；朗读优先切换为摆姿势。模型
  上传入口和动作切换入口当前不在数字人面板展示。
- **Speech 层**（`use-avatar-speaker.ts`、`tts-client.ts`、`lip-sync.ts`、
  `markdown-to-speech.ts`）负责把 markdown 回答切成可朗读句子、串行合成与播放、
  输出每帧口型张开度。
- **渲染层**（`vrm-scene.ts`）与 React 解耦的 three.js 舞台类，自带 `requestAnimationFrame`
  渲染循环。

## 3. 关键模块设计

### 3.1 停靠窗与状态（avatar-dock.tsx + dock-storage.ts）

- 桌面端右下角固定悬浮窗（`isMobile` 时不渲染），可拖拽、可折叠。
- 偏好（位置、折叠、voice/rate/muted）存 `deerflow.avatar-dock` 本地键，
  独立于共享 `LocalSettings`，避免改动 settings schema。
- 挂载点在 `chat-page.tsx`：`{isAdmin ? <AvatarDock /> : null}`，当前仅管理员可见。
- 上传校验：`.vrm` 为 GLB 容器（magic `glTF`），上限 `MAX_MODEL_BYTES`=80MB；
  成功模型经 IndexedDB（`deerflow-avatar` 库，键 `avatar.vrm`）持久化，避免超出
  localStorage 配额且不需服务端上传路径。

### 3.2 流式朗读（use-avatar-speaker.ts）

核心：**边生成边朗读，不等整轮结束**。

- 观察线程最后一条带文本的 AI 消息（`findLastAi`），用 `spokenLenRef` 记录已
  入队的字符偏移、`streamingKeyRef` 记录「当前正在流的答案」的身份。
- 按句切分：遇到 `。！？；\n` 即成句入队；长时间无终止符的段落按逗号或
  `MAX_STREAM_CHARS`=40 字符强制冲刷，保证长答案也能渐进朗读。
- 新答案开始（key 变化）时：清空上一轮队列、`queue.stop()`、重置偏移；
  静音（muted）时跳读并停播。
- 一轮结束（`isLoading` 变 false）时：把残留片段 flush 一次。
- 用户手动停止后保留当前回答快照，停止按钮变为圆形重播按钮；回答仍在
  流式生成时会更新快照，但不会自动恢复朗读，点击重播后按当前 voice/rate
  从头合成整段回答。
- `getMouthOpen()` 直接透传给渲染层，每帧由渲染循环读取，避免 React 重渲染。

### 3.3 语音合成队列（tts-client.ts + lip-sync.ts + markdown-to-speech.ts）

`SpeechQueue` 一个实例负责整段回答：

- **分批**：`toSpeechChunks()` 先 `stripMarkdown()`（去代码/表格/链接/标题只留
  可朗读文本），再用 `splitIntoChunks()` 按句与长度边界切块（`MAX_CHUNK_CHARS`=120），
  总长上限 `MAX_TOTAL_CHARS`=8000。
- **串行 drain**：同一时间只允许一个 drain 循环（`activeLoopToken`），
  `append()` 只在空闲状态启动，后续 `append` 由正在运行的循环下一轮拾取，避免
  触发端点并发上限（`MAX_CONCURRENT`=4）。`stop()` 抬升 `drainToken` 使循环退出。
- **合成**：`POST /tts`，带 text/voice/rate；失败按 `[1000,3000]` 指数重试 3 次。
- **播放**：单个复用 `<audio>`，`waitFinished` 用可挂起的守卫定时器兜底超时；
  `pause()` 区分「已加载可暂停」与「仍在拉取（停拉保洁仍保留 pending）」。
- **口型**：`LipSyncEngine` 通过 WebAudio `AnalyserNode.getByteFrequencyData` 读
  每帧响度；autoplay 被拦（`blocked`）时用 `estimateSpeechSeconds` 估算时长做
  合成包络，数字人仍会动。

### 3.4 TTS 路由（src/app/tts/route.ts）

- **刻意不在 `/api/**` 之下**——nginx 把 `/api/` 转发到 Python Gateway，放这里
  在统一入口 :2026 下会 404；`/tts` 落到前端上游，Gateway 与 nginx 配置零改动。
- `node-edge-tts` 加载 Azure 边缘语音，语音白名单正则（`VOICE_PATTERN`）、每请求
  `TTS_MAX_CHARS`=2000 硬上限（防开放中继）、按客户端限流（60s/30 次）、并发上限
  （4）、内存音频缓存（64MB LRU）、临时目录探测与超时（20s）。

### 3.5 渲染舞台（vrm-scene.ts）

- **与 React 解耦**的 three.js 舞台类 `VrmScene`：动态导入避免污染首屏预算，
  自带渲染循环、WebGL 上下文、模型生命周期，摆脱 React 重渲染。
- **模型加载**：GLTFLoader + `VRMLoaderPlugin`；VRM 0.x 需 `rotateVRM0` 转向；
  `removeUnnecessaryVertices`/`combineSkeletons` 减面并关 `frustumCulled`。
- **手臂放松**：VRoid 默认演示姿势两臂平举（「八」字），按手臂朝下逐步旋转
  上臂至手垂贴身体。
- **程序化表现**（非 VRMA 播放时）：双手/前臂/脊柱/胸/头由两组低频正弦叠加出
  「呼吸 + 游走手势」，说话时 `GESTURE_SPEAK_BOOST`=1.6 放大；眨眼按随机间隔用
  `sin` 包络驱动 `blink`。
- **口型**：只驱动模型实际具备的口型表情（`detectMouthKeys` 过滤），
  `MOUTH_WEIGHTS` 让各嘴型权重不同更自然，`MOUTH_SMOOTHING` 平滑。
- **相机**：保持上半身取景，滚轮缩放、左键平移、右键旋转。
- **VRMA 动作**：`VRMAnimationLoaderPlugin` 加载，使用
  `createVRMAnimationClip` 将动作重定向到 normalized 骨骼，再由
  `VRMHumanoid.update()` 同步到目标模型的 raw 骨骼；播放动作时挂起程序化
  手势/摇摆以免冲突。通过 normalized rig retarget 可避免不同模型的局部骨骼
  轴差异导致拇指穿过手掌；动作之间使用 350ms 交叉淡化，停止时平滑恢复
  rest pose。

### 3.6 国际化

所有文案走 `core/i18n/locales/{zh-CN,en-US}.ts` 的 `avatar` 键（标题「AI小易」、
上传/复位/口型不支持/暂停/继续/停止/语音开启失败/动作名等），遵循现有 i18n
模式。

## 4. 数据流与边界

- 数字人只**读** `thread.messages`（`useThread`），不写线程状态、不干预运行，
  与 LangGraph 主循环（`throttle:true`）解耦。
- `VrmScene` 通过 `setMouthProvider(() => getMouthOpen())` 以**引用**方式接入口型，
  `avatar-canvas` 用 `latest` ref 持有最新闭包，渲染循环内读取，不回灌 React。
- 事件归属：UI 层仅悬挂容器并喂 mouth 值；渲染循环、WebGL、模型生命周期都在
  舞台类内部，避免 React 重渲染抖动 WebGL。

## 5. 安全与限制

- TTS 语音白名单、文本长度硬上限、按客户端限流、音频响应 `Cache-Control: private`，
  防止把 `/tts` 变成公共代理。
- VRM 模型上传仅存浏览器 IndexedDB，不落服务端、不入库，避免仓库体积与上传面。
- `TTS_ENABLED=false` 环境变量可整体关闭 TTS。
- 无键盘/无障碍适配（容器 `aria-hidden`），数字人为可选增强，不影响核心聊天。

## 6. 已实现能力矩阵

| 能力 | 说明 |
| --- | --- |
| VRM 模型存储 | 已保存的 `.vrm` 从 IndexedDB 加载，默认模型作为回退 |
| 默认模型 | `public/images/models/avatar.vrm`（可选，缺失即提示上传） |
| VRMA 动作 | 空闲循环比耶、打招呼、展示全身；点击依次摆姿势、比耶、转圈；朗读时摆姿势 |
| 流式朗读 | 边生成边朗读，按句切块，停顿/继续/停止/静音 |
| 口型 | WebAudio 振幅驱动 + blocked 时合成包络 |
| 程序化表现 | 眨眼/呼吸/手势/头动，说话时放大 |
| 交互 | 拖拽、折叠、缩放、平移、旋转 |

## 7. 测试

- `core/avatar/*` 纯函数（`markdown-to-speech.ts`）可无 DOM 单测：
  `frontend/tests/unit/core/avatar/`。
- `tts-client`/`lip-sync`/`vrm-scene` 涉及 DOM/WebGL，按现有
  `*.dom.test.ts` 与 E2E（mock 后端）策略覆盖。

## 8. 后续增强路线图（Roadmap）

### P1 体验完善
- 数字人入口开放到所有用户（当前仅 `isAdmin`），或做成按用户设置开关。
- 语气/表情联动：据文本情绪挑 VRM Expression（happy/sad/angry）。
- 停顿打断：用户发新消息时自动 `stop()` 当前朗读，避免与用户输入打架。
- 更多动作分组（演讲、坐姿、握拳 v 字）与动作自动休憩轮换。

### P2 多模态与对齐
- **字级/词级时间戳**对齐：若后端流式消息能带增量 chunk，可把 `append` 粒度
  从「句」细化到「词」，口型更跟读（当前振幅驱动在会话速度下已足够自然）。
- 可选 Web Speech API 作为无后端 TTS 的降级（需考虑音质与首帧策略）。
- 单人/多人场景：多模型并行、Canvas + WebGL 双渲染。

### P3 平台化
- 把数字人做成可复用前端扩展/插件，暴露
  `mouthProvider`、`VrmScene` 生命周期、事件钩子，供不同品牌/渠道复用。
- 与 `langgraph` 后端打通语音→文字（复用 `core/voice-input`），实现**全语音**对话
  闭环：用户说话 → 识别转文字 → agent 回答 → 数字人朗读。

### P4 性能与工程
- 弱设备降级：检测 WebGL 支持/帧率，自动降采样、关闭手势、退回 2D 头像。
- 懒加载与流式资产：VRM/VRMA 走 CDN 与浏览器缓存，监听 `visibilitychange`
  暂停渲染循环以省电。
- 与 `pnpm perf:check` 路由预算对齐，持续守住首屏 JS 红线。

## 9. 文档同步约定

按仓库「文档随代码同步」策略：任何数字人能力变更需同步
`frontend/AGENTS.md`（架构/命令）与 `README.md`（用户可见），并新增 `core/avatar/`
相关单测。
