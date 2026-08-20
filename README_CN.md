## AI Translator - Chrome扩展程序

### 概述

AI Translator是一款Chrome扩展程序，使用AI技术在任意网页上翻译文本。支持两种翻译模式：**划词翻译**和**整页翻译**，并提供三种AI后端选项：**OpenAI**、**Google Gemini**和**Ollama**（本地）。

### 主要功能

- **划词翻译**：选中页面上的任意文本，点击 **T** 按钮即可在弹窗中查看翻译结果。
- **反向翻译**：在可编辑字段中，点击 **R** 按钮可将文本翻译回检测到的源语言。
- **整页翻译**：通过扩展弹窗一键翻译整个页面。动态新增的内容会自动翻译。
- **多AI服务支持**：
  - **OpenAI**：7个模型可选 — `gpt-4o-mini`、`gpt-4o`、`gpt-4-turbo`、`gpt-4.1-nano`、`gpt-4.1-mini`、`gpt-4.1`、`gpt-3.5-turbo`。
  - **Google Gemini**：基于API密钥，模型可选 — `gemini-3.6-flash`、`gemini-3.5-flash`、`gemini-3.5-flash-lite`、`gemini-3.1-flash-lite`、`gemini-2.5-flash`、`gemini-2.5-flash-lite`、`gemini-2.5-pro`。
  - **Ollama**：连接到本地Ollama服务器，自动加载可用模型。
- **自动语言检测**：根据字符模式自动检测英语、越南语、日语、韩语、汉语、法语、德语、西班牙语、葡萄牙语、俄语、泰语、印尼语、意大利语、荷兰语、阿拉伯语、印地语。
- **16种目标语言**：越南语、英语、日语、汉语、韩语、法语、德语、西班牙语、葡萄牙语、俄语、泰语、印尼语、意大利语、荷兰语、阿拉伯语、印地语。
- **3种翻译风格**：`口语化`、`礼貌`、`商务`。
- **可拖拽调整大小的弹窗**：可拖动标题移动翻译弹窗，拖动边缘调整大小。
- **一键复制**：点击复制按钮快速复制翻译结果。
- **智能语言切换**：如果目标语言与源语言相同，会自动切换（如英语 ↔ 越南语）。
- **设置同步**：所有设置存储在`chrome.storage.sync`中，可在多设备间同步。
- **多语言界面**：支持中英文界面切换。

### 工作原理

1. **内容脚本 (`content.js`)**
   - 监听页面上的文本选择。
   - 在选中文本附近显示浮动 **T** 按钮（可编辑字段还会显示 **R** 按钮）。
   - 打开一个可拖拽/可调整大小的弹窗（Shadow DOM）显示翻译结果。
   - 检测源语言，从`chrome.storage.sync`加载配置，向后台脚本发送`translate`消息。
   - 处理整页翻译：遍历DOM，收集文本节点（跳过代码/脚本/URL），分批发送到后台，将文本替换为翻译结果。
   - 使用`MutationObserver`在整页翻译时自动翻译动态添加的内容。

2. **后台Service Worker (`background.js`)**
   - 接收内容脚本发来的`translate`和`translateBatch`消息。
   - 根据选定的服务提供商将请求路由到 **OpenAI API** 或 **Ollama API**。
   - 构建包含源语言/目标语言和风格指令的系统提示词。
   - 使用编号格式处理批量翻译以确保准确性。
   - 同时处理`getOllamaModels`消息，从Ollama服务器获取可用模型列表。

3. **设置弹窗 (`popup.html`、`popup.js`)**
   - 点击工具栏中的扩展图标时显示的UI。
   - **服务提供商选择**：在OpenAI、Gemini和Ollama之间切换。
   - **OpenAI配置**：API密钥输入（带显示/隐藏切换）、模型选择器。
   - **Ollama配置**：服务器URL、带刷新按钮的模型选择器。
   - **翻译风格**：口语化 / 礼貌 / 商务 单选按钮。
   - **目标语言**：16种语言的下拉选择。
   - **翻译此页面**按钮：在当前标签页触发整页翻译。
   - **界面语言**：中英文切换下拉框。

### 安装与使用

#### 1. 安装为未打包扩展

1. 克隆或下载此仓库。
2. 打开Chrome（或任何基于Chromium的浏览器，如Edge、Brave）。
3. 访问 `chrome://extensions/`。
4. 启用**开发者模式**。
5. 点击**加载已解压的扩展程序**并选择 `ai-translator` 文件夹。

#### 2. 配置AI服务提供商

1. 点击浏览器工具栏中的 **AI Translator** 扩展图标。
2. 选择服务提供商：
   - **OpenAI**：粘贴API密钥，选择模型，点击**保存**。
   - **Gemini**：粘贴API密钥，选择模型，点击**保存**。
   - **Ollama**：输入Ollama服务器地址（默认：`http://localhost:11434`），点击刷新按钮加载模型，选择模型，点击**保存**。
3. 选择默认的**风格**和**目标语言**。

> 注意：API密钥存储在浏览器的`chrome.storage.sync`中，**不会**包含在源代码中。

#### 3. 翻译选中的文本

1. 打开任意网页。
2. **选中**要翻译的文本。
3. 点击选中文本附近出现的 **T** 按钮。
4. 翻译弹窗显示：
   - 检测到的源语言 → 目标语言。
   - 下拉框可更改目标语言或风格。
   - **复制**按钮可复制结果。
5. 拖动弹窗标题可重新定位，或拖动边缘调整大小。

#### 4. 翻译整个页面

1. 点击工具栏中的扩展图标。
2. 点击**翻译此页面**（绿色按钮）。
3. 显示进度："翻译中... X/Y 批次"。
4. 点击**恢复原文**（橙色按钮）可恢复原始文本。

### 项目结构

| 文件 | 描述 |
|------|------|
| `manifest.json` | Manifest V3配置：权限、脚本、图标 |
| `background.js` | Service Worker — 处理OpenAI/Ollama API调用、批量翻译 |
| `content.js` | 核心逻辑 — 文本选择、触发按钮、弹窗UI、页面翻译、DOM监听 |
| `content.css` | 触发按钮和加载指示器的样式 |
| `popup.html` | 设置弹窗UI |
| `popup.js` | 设置逻辑 — 提供商切换、保存/加载配置、Ollama模型加载 |
| `popup.css` | 设置弹窗样式 |
| `_locales/en/messages.json` | 英文界面语言文件 |
| `_locales/zh/messages.json` | 中文界面语言文件 |
| `icons/` | 扩展图标（16/48/128像素） |

### 权限与安全

| 权限 | 用途 |
|------|------|
| `storage` | 存储API密钥、提供商、模型、风格和目标语言 |
| `activeTab` | 访问当前标签页进行页面内翻译 |
| `declarativeNetRequest` | 去除Origin头以兼容Ollama本地主机CORS |
| `host_permissions: https://api.openai.com/*` | 连接到OpenAI API |
| `host_permissions: https://generativelanguage.googleapis.com/*` | 连接到Google Gemini API |
| `host_permissions: http://localhost:*/*`、`http://127.0.0.1:*/*` | 连接到本地Ollama服务器 |

- API密钥**仅存储在本地**的`chrome.storage.sync`中。
- 代码仓库中没有任何配置文件包含硬编码的API密钥。

### 技术细节

- 纯JavaScript，无打包工具或构建步骤。
- 后台脚本作为Manifest V3 Service Worker运行。
- 翻译弹窗使用**Shadow DOM**隔离宿主页面的样式。
- 批量翻译使用并发限制：OpenAI **5个并发请求**，Ollama **2个**。
- `MutationObserver`在整页翻译期间监听动态添加的内容，并在500ms批处理窗口内自动翻译。
- 文本过滤跳过代码块、脚本、样式表、画布、SVG、输入字段、URL和纯数字。
- API参数：`temperature: 0.3`，`max_tokens: 1024`（单个）/ `4096`（批量）。
