# Agent 编程规范 (Chrome 插件 Manifest V3 + DeepSeek 专属版)

## 1. 项目架构与规范
- **规范标准**：必须严格遵循 **Chrome Extension Manifest V3 (MV3)** 规范，严禁使用 MV2 过期 API。
- **构建命令**：运行 `npm run build` 或 `pnpm build` 进行编译。
- **三大上下文隔离原则（切记勿混淆）**：
  1. **Background (Service Worker)**：无 DOM access，短命进程，不可使用 `window`/`document`，不可用全局变量存长期状态。
  2. **Content Script**：可操作宿主页面 DOM，运行在隔离环境，无法直接访问宿主页面的 JS 全局变量。
  3. **Popup / Options**：独立前端 UI 页面，生命周期随弹窗关闭而终止。

---

## 2. 动手前的分析流程（DeepSeek 必读）
1. **检查 Manifest 配置**：涉及新 API、页面注入或跨域请求时，**必须先读取并更新 `manifest.json`**（检查 `permissions`、`host_permissions` 和 `content_scripts` 声明）。
2. **厘清消息通信链路**：若涉及多模块交互，修改前先明确消息走向（例如：`Content Script -> chrome.runtime.sendMessage -> Service Worker -> chrome.storage`）。
3. **读取源码**：修改代码前，先确认目标文件所处的上下文类型，避免写出跨环境调用代码。

---

## 3. Chrome 插件核心代码规则
- **现代 Promise 语法**：绝大部分 `chrome.*` API 统一使用 `await chrome.xxx()` 语法，不再使用 Callback 回调函数。
- **Service Worker 状态持久化**：
  - **严禁使用全局变量保存数据**！Service Worker 随时会被 Chrome 挂起回收。
  - 所有持久化数据必须调用 `await chrome.storage.local.get/set()` 处理。
- **消息通信规范 (Message Passing)**：
  - 监听器 `chrome.runtime.onMessage.addListener` 中若需进行**异步响应**（如在内部发起 fetch），回调函数**必须返回 `true`**，否则 `sendResponse` 会提前失效。
  - 消息 Payload 必须使用清晰的结构：`{ action: 'FETCH_DATA', payload: { ... } }`。
- **DOM 与安全规范**：
  - Content Script 插入节点时，防范 XSS 风险，优先使用 `textContent` 或 `document.createElement`，禁止滥用 `innerHTML`。
- **局部增量修改 (Unified Diff)**：
  - 修改代码时仅替换受影响的逻辑，**严禁一次性重写覆盖整个 `manifest.json` 或主逻辑代码**。

---

## 4. 自动构建与闭环验证
- **即时编译验证**：每次修改完代码后，**必须主动调用终端工具**运行构建命令（如 `npm run build`），确保 TypeScript 类型和打包构建无报错。
- **精准定位报错上下文**：当逻辑异常时，明确区分报错来源（Background 检查 `chrome://extensions` 的背景页日志，Content Script 检查网页 DevTools）。