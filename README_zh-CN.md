# pi-deepread

[English](README.md) | 简体中文

面向 [Pi](https://pi.dev) 的轻量网页搜索与本地文档读取扩展。单文件实现，注册 3 个工具，不堆砌服务商。

- **`web_search`** — 基于 DeepSeek `/v1/tools/search`，强制开启 `need_content: true`。每次搜索直接返回提取好的**整页正文**，而不是短短的摘要片段。
- **`fetch_content`** — 网页内容通过 DeepSeek `/v1/tools/fetch` 提取；本地文档（PDF、Office、EPUB、图片、音频等）通过 `anymd` / `pdftotext` 在本地转换，**完全不上传**任何内容。
- **`get_search_content`** — 搜索和抓取的内容按 `responseId` 缓存在本地磁盘。支持分页读取，或通过 `findText` 快速检索正文段落。

常规搜索由 DeepSeek 负责（单次调用约 0.005 元）。Exa 仅作为可选后备，用于覆盖 DeepSeek 索引较弱的盲区（微信公众号、小红书、V2EX、YouTube 等）或主接口报错兜底。

## 安装

```bash
# 从 npm 安装（推荐）
pi install npm:pi-deepread

# 或直接从本地目录安装
pi install /path/to/pi-deepread

# 或在单次会话中临时试用（不写入配置）
pi -e /path/to/pi-deepread
```

> **注意：** 如果你之前安装了 `pi-web-access`，请先卸载它。两个扩展注册了同名的工具（`web_search`、`fetch_content`、`get_search_content`），同时存在会发生冲突：
>
> ```bash
> pi remove npm:pi-web-access
> ```

## 鉴权配置

如果 Pi 本身已经配置了 DeepSeek API Key，你不需要做任何额外配置——`pi-deepread` 会在发起请求时直接读取 Pi 的 `auth.json`。

密钥读取优先级：

1. `<agent dir>/web-search.json` 中的 `deepseekApiKey`
2. 环境变量 `DEEPSEEK_API_KEY`
3. Pi 原生 `auth.json` 中的 `deepseek` 配置

Exa 仅作为可选后备，可通过同名配置文件中的 `exaApiKey` 或环境变量 `EXA_API_KEY` 设置。

配置文件示例（`~/.pi/agent/web-search.json`）：

```json
{
  "deepseekApiKey": "sk-...",
  "exaApiKey": "exa-...",
  "fetch": { "timeout": 45, "gapMs": 900 },
  "ssrf": { "allowRanges": ["198.18.0.0/15"] }
}
```

配置项的值也支持命令替换，例如：`"deepseekApiKey": "!jq -r .deepseek.key ~/.pi/agent/auth.json"`。

> **开启了 TUN 代理（Clash、Surge、sing-box 等）？**
> Fake-IP 模式下所有公网域名都会被解析成 `198.18.0.0/15` 的保留地址。扩展默认拦截私有地址以防范 SSRF，会导致普通网页被误判为内网。在配置中添加 `"ssrf": { "allowRanges": ["198.18.0.0/15"] }` 即可放行。仅在你的代理确实接管该网段时开启。

## 本地文档解析

本地文件全部在本地处理，保护隐私且不消耗任何网络流量：

| 输入格式 | 解析路径 |
|---|---|
| `.pdf`, `.docx`, `.pptx`, `.xlsx`, `.epub`, `.csv` 等 | [anymd](https://github.com/SylphxAI/anymd) → Markdown（保留标题层级、表格、图注与 OCR） |
| `.pdf`（未安装 anymd 时） | `pdftotext`（纯文本兜底） |
| 图片 / 音频 / 字幕 | anymd（OCR 识别 / 语音转写） |
| 网页 URL | DeepSeek 抓取，失败时退回普通 HTTP 读取 |

本地解析依赖安装（可选）：

```bash
# 推荐安装：支持丰富的文档结构化提取
npm i -g @sylphx/anymd

# 仅当你需要 OCR 识别图片或扫描版 PDF 时安装
brew install tesseract tesseract-lang
```

**中文 OCR 修复：** anymd 默认调用 `tesseract <image> stdout` 时不带语言参数，导致中文扫描件会被识别为一串乱码。`pi-deepread` 内置了 `bin/tesseract` shim 脚本，在未指定语言时自动补充 `-l chi_sim+eng`（可通过环境变量 `ANYMD_TESS_LANGS` 覆盖）。

## 实测数据

所有指标均为本机真实测试：

| 测试场景 | 实测结果 | 说明 |
|---|---|---|
| `need_content: false`（接口默认） | 单条约 431 字 | 仅返回短摘要，无正文 |
| `need_content: true`（本扩展启用） | 单条 3.7k–12.6k 字 | 直接获取整页提取文本，调用单价同为 0.005 元 |
| query 长度上限 | 硬限制 128 字符 | 超过该长度 DeepSeek 直接返回 `HTTP 400` |
| 抓取并发表现 | 并发 1–3 表现平稳 | 并发达到 10 时约 30% 请求触发 `HTTP 429` |
| `fetch_content`（抓取 4 个 URL） | 5.71 秒 → **2.85 秒** | 串行 vs 3 并发槽位优化 |
| `web_search`（3 组查询变体） | ~1.2 秒 → **0.45 秒** | 搜索并发优化 |
| arXiv 论文（15 页） | anymd：4.1 万字，26 个标题，146 行表格（耗时 0.22s） | pdftotext：5.9 万字，0 标题，双栏排版错乱（耗时 0.09s） |

## 边界与限制

- **128 字符限制**：DeepSeek 会把 `domainFilter` 和 `recencyFilter` 编译后的 `site:` 和 `after:` 算子字符算进总长度。超过 128 字符时，若配置了 Exa 会自动切至 Exa 处理；若未配置则直接报错，并在错误信息中显示完整的查询文本。
- **搜索盲区**：微信公众号、小红书和部分 V2EX 内容不在 DeepSeek 索引中；YouTube 链接常解析到 `music.youtube.com`。配置 Exa key 后遇到此类内容会自动转由 Exa 搜索。
- **本地缓存**：搜索与抓取内容保存在 `<agent dir>/cache/web/`，每小时自动清理（最长保留 7 天，最多 200 个文件，上限 64 MB）。
- **状态排查**：在 Pi 中执行 `/web-status` 命令，可查看当前生效的 API 密钥、路由策略、超时时间、OCR shim 检测状态及缓存占用。

## 本地开发

```bash
git clone https://github.com/pumblus/pi-deepread
pi -e ./pi-deepread          # 直接加载本地目录，无需安装
```

扩展主体代码为单文件：[`extensions/web-access.ts`](extensions/web-access.ts)。

关于 `need_content` 探索、128 字符限制、429 并发墙以及 OCR shim 的完整技术细节与取舍，请参阅 [`docs/BUILD_LOG_zh-CN.md`](docs/BUILD_LOG_zh-CN.md)。

## 鸣谢与灵感来源

本项目灵感来源于忒修斯的船板（[@Arcadia_Bao](https://x.com/Arcadia_Bao/article/2111711040757006401)）对 DeepSeek Search/Fetch 接口实测与 `need_content: true` 用法的分享。

## License

[MIT](LICENSE) © Eric Zhou
