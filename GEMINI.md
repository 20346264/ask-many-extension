# 同问 AI · 多模型工作台 (AskMany Extension)

本文件为 Antigravity 针对当前项目的上下文指引与规范说明。在对本项目进行分析、开发、重构或调试时，请严格遵守以下架构原则与约定。

---

## 1. 项目概述

* **项目定位**：基于 Chrome Extension Manifest V3 的多 AI 并排问答工作台。
* **核心价值**：在一个独立标签页中同时嵌入 ChatGPT、DeepSeek、Claude、Gemini、通义千问、腾讯元宝等主流模型，一次输入并行派发、支持附件上传，并在回答完成后一键收集生成对比分析。
* **技术特点**：纯原生现代 JavaScript（Vanilla JS / ES Modules），**无需 npm 构建或打包器**，代码修改后重载扩展即可直接生效。直接复用用户在浏览器中的原生登录态，无需额外配置 API Key。

---

## 2. 核心架构与模块职责

```
extension/
├── manifest.json       # Chrome MV3 配置文件（权限、声明、内容脚本配置）
├── background.js       # 后台 Service Worker（管理面板生命周期、动态网络头改写、消息中继）
├── panel.html          # 工作台主界面结构与样式
├── panel.js            # 工作台核心控制器（多模型状态、两阶段并发发送编排、对比收集）
├── content.js          # 目标站点 Content Script（接收指令并操作对应站点的 DOM）
├── adapters.js         # 站点核心适配器（各站 DOM 选择器、附件注入逻辑、回答提取）
├── icons/              # 扩展各尺寸图标
└── README.md           # 面向用户的安装与使用说明
```

### 关键通信与控制流
1. **网络穿透 (Frame Unblocking)**：
   * 多数 AI 站点禁止通过 iframe 嵌入。`background.js` 在面板打开时，通过 `chrome.declarativeNetRequest.updateSessionRules` 动态创建规则，移除目标站点响应中的 `x-frame-options` 和 `content-security-policy`。
   * **安全红线**：改头规则必须限制在 `tabIds: [tabId]` 内，并在面板关闭时自动注销，杜绝全局点击劫持风险。
2. **跨域消息中继**：
   * 由于面板与 iframe 跨源，无法直接 `postMessage`。
   * 路径：`panel.js` → `background.js` (根据 `tabId` 和 `frameId` 路由) → `content.js`。
3. **两阶段提问对齐 (Prepare-and-Fire)**：
   * 各站点由于网络延时、输入框渲染和附件解析速度不一，发送耗时不同。
   * **Stage 1 (prepare)**：填入文字、注入附件、等待发送按钮就绪；
   * **Stage 2 (fire)**：各 iframe 全部就绪后，面板并发触发提交，确保各模型作答时序对齐。

---

## 3. 开发与调试指南

### 本地加载与更新
1. 打开 Chrome 浏览器访问 `chrome://extensions/`。
2. 开启右上角 **“开发者模式”**。
3. 点击 **“加载已解压的扩展程序”**，选择本目录 (`extension`)。
4. **修改代码后**：
   * 在 `chrome://extensions/` 找到本扩展，点击 **刷新** 图标。
   * 重新打开或刷新工作台面板页面。

### 调试分层
* **调试面板 UI 与编排逻辑**：在打开的工作台标签页右键选择“检查”（Inspect）。
* **调试后台网络规则与消息转发**：在 `chrome://extensions/` 扩展卡片上点击“查看视图：Service Worker”。
* **调试特定 AI 站点的 DOM 交互**：在工作台页面中，右键点击对应模型的 iframe 区域选择“检查”，或者在 DevTools Console 的上下文下拉框中切换到对应站点的 frame。

---

## 4. 编码规范与开发准则

### 1. 站点变更隔离准则 (Single Source of Truth)
* **当目标站点更新或改版时，原则上只需修改 `adapters.js`**。
* 严禁在 `content.js` 或 `panel.js` 中硬编码具体站点的 CSS 选择器或特殊处理逻辑。
* 每个 Adapter 需保证包含：`id`, `name`, `url`, `host`, `input()`, `sendBtn()`, `answers()`, 以及可选的文件支持定义 (`fileInput`, `uploadedChips`, `fileRoutes`)。

### 2. 附件处理与上传安全
* 附件传输通过 base64 经由 `chrome.runtime.sendMessage` 投递。
* 单文件上限建议控制在 20MB 以内，总大小在 40MB 以内，防止 IPC 消息管道溢出崩溃。
* 附件注入优先级高于文本填入（避免部分站点的 ProseMirror 或富文本编辑器因上传卡片重建 DOM 导致文字被冲掉）。

### 3. 输入法（IME）保护
* 在监听键盘快捷键（如 `Enter` 提交）时，务必处理 `e.isComposing` 或键码 229，防止中文输入法候选词选字时误触提问。

### 4. 保持轻量与零构建
* 维持原生 JS 开发模式，避免无必要引入 Webpack/Vite 等构建流程，保持“修改即测试”的高效反馈循环。

### 5. Git 提交与发布准则
* **严禁主动提交或推送代码**：日常功能开发、改动、重构或调试完成后，**绝对不要主动执行 git commit / git push，也不要主动创建 GitHub release**。
* **严格受控于用户指令**：只有在用户明确提及“提交”、“推送到 github”、“发布 release”等要求时，才可以执行 git 提交与发布操作。
