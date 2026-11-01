# pi-deepread

[English](README.md) | 简体中文

专为 [Pi](https://pi.dev) 打造的高效网页搜索与本地文档读取扩展。仅注册 3 个轻量工具，常驻 Prompt 额外开销**约 1k tokens**，单文件架构，告别臃肿的供应商堆叠。

很多 AI 智能体的搜索工具需要“两步走”：先搜索拿一堆 800 字左右的片段短语，模型发现信息不够，再发起二次请求去抓取网页正文。`pi-deepread` 依托 DeepSeek 的 `need_content: true` 特性，在第一次发起搜索时就将完整网页正文一次性带回——每次搜索依然只需 ¥0.005。

它还能让 Pi 直接在你的电脑本地读取 PDF、Word 文档、表格以及图片。所有转换均在本地完成，无需上传云端，彻底杜绝隐私泄露风险。

- **`web_search`** — 基于 DeepSeek 发起网页搜索（强制开启 `need_content: true`）。直接返回提取好的网页正文，并明确标注内容状态（完整 / 部分 / 摘要）。你可以直接对已缓存的文本进行翻页浏览，免去重复请求；仅在确有需要时才定向补抓深层内容。
- **`fetch_content`** — 读取任意网页正文或本地文件。网页默认走 DeepSeek 阅读器解析；若遭遇站点拦截或付费墙，自动并发回退至阅读代理与 Wayback Machine 网页快照。读取本地文件（`.pdf`、`.docx`、`.xlsx`、`.epub`、图片、音频）时，直接在本机调用 `anymd` 或 `pdftotext` 转换——只需传入本地文件路径，数据不出本地设备。
- **`get_search_content`** — 通过 `responseId` 访问已保存的搜索与抓取结果。既能按页阅读长篇文档，也能通过 `findText` 关键词定位并直接跳转到目标段落。

常规搜索统一由 DeepSeek 承载（每次调用仅 ¥0.005）。Exa 作为可选的备用路由，专门用来补足 DeepSeek 难以索引的盲区内容（微信公众号、小红书、V2EX、YouTube 等）或在 API 故障时提供兜底。即使不配置 Exa Key，上述特定平台也会自动走免密钥的回退通道，不会直接报错中断。

---

## 极速安装

```bash
# 从 npm 安装（推荐）
pi install npm:pi-deepread

# 或从本地目录安装
pi install /path/to/pi-deepread

# 也可以在单次会话中临时试用（不保存配置）
pi -e /path/to/pi-deepread
```

> **注意：** 如果你此前安装了 `pi-web-access`，请先将其卸载。两个扩展注册了完全相同的工具名（`web_search`、`fetch_content`、`get_search_content`），共存会导致冲突：
>
> ```bash
> pi remove npm:pi-web-access
> ```

---

## 密钥与参数配置

如果你平时已经在 Pi 里使用 DeepSeek，通常无需额外配置。`pi-deepread` 会自动从 Pi 的 `auth.json` 中读取密钥。

密钥解析优先级：

1. `<agent dir>/web-search.json` 中的 `deepseekApiKey`
2. 环境变量 `DEEPSEEK_API_KEY`
3. Pi 的 `auth.json` 中的 `deepseek` 字段

### 可选的 Exa Key

Exa 仅作为 DeepSeek 索引盲区（微信公众号、小红书、V2EX、YouTube）和偶发网络异常时的可选后备通道。即使未配置 Exa Key，这些平台的查询依然会尝试免密钥替代方案（如搜狗、`sov2ex`、阅读代理等）。不过，**配置 Exa Key 之后，在中文社交平台与 YouTube 上的检索覆盖率和响应速度会有显著提升**；如果你经常查询这类内容，推荐配上。

你可以在配置文件中指定 `exaApiKey`，或通过环境变量 `EXA_API_KEY` 传入。

### 配置文件示例

保存至 `~/.pi/agent/web-search.json`：

```json
{
  "deepseekApiKey": "sk-...",
  "exaApiKey": "exa-...",
  "fetch": { "timeout": 45, "gapMs": 900 },
  "ssrf": { "allowRanges": ["198.18.0.0/15"] }
}
```

配置项也支持动态执行 Shell 命令获取密钥：  
`"deepseekApiKey": "!jq -r .deepseek.key ~/.pi/agent/auth.json"`

> **正在使用 TUN / Fake-IP 模式代理（如 Clash、Surge、sing-box）？**  
> Fake-IP 代理通常会将外部域名映射到 `198.18.0.0/15` 保留网段。`pi-deepread` 默认会拦截私有内网 IP 以防御 SSRF 攻击。若请求因此被拦截并提示私有内网地址错误，只需在配置中添加 `"ssrf": { "allowRanges": ["198.18.0.0/15"] }` 即可放行。请仅在代理确实接管了该网段时开启。

---

## 本地文档阅读

传入本地路径时，所有文档均在本机直接解析，绝不上传到任何外部云服务：

| 文件格式 | 解析器 | 输出效果 |
|---|---|---|
| `.pdf`, `.docx`, `.pptx`, `.xlsx`, `.epub`, `.csv` | [anymd](https://github.com/SylphxAI/anymd) | 排版清晰的 Markdown，完整保留标题层级、表格、图注与 OCR 结果 |
| `.pdf`（未安装 anymd 时） | `pdftotext` | 纯文本兜底读取 |
| 图片 / 音频 / 字幕文件 | anymd | OCR 提取文本、媒体文件元数据或内嵌字幕 |
| 网页 URL | DeepSeek fetch | 提取为 Markdown 文本；遇到异常自动回退至内置 HTTP 阅读器 |

### 安装本地解析器（可选）

```bash
# 推荐安装：结构化 Markdown 转换器
npm i -g @sylphx/anymd

# 仅在你需要对图片或扫描版 PDF 进行 OCR 文字识别时安装
brew install tesseract tesseract-lang
```

**中文 OCR 修复补丁：** `anymd` 默认调用 `tesseract <image> stdout` 时不附带语言参数，容易把中文扫描件误识别成乱码英文字符串。`pi-deepread` 内置了一个透明的 `bin/tesseract` 补丁脚本，只要未传入自定义语言参数，就会自动补上 `-l chi_sim+eng`（也可通过环境变量 `ANYMD_TESS_LANGS` 自定义覆盖）。

---

## 实测对比与数据表现

以下数据均在本地真实网络请求下实测得出（非模拟数据；字符数反映页面提取长度，不直接等同于语义准确度）：

| 测试场景 | 实测表现 | 具体含义 |
|---|---|---|
| `need_content: false`（官方默认行为） | 约 431 字符 | 仅返回简短的搜索摘要片段 |
| `need_content: true`（本扩展默认开启） | 3,700–12,600 字符 | 首次搜索直接带回整页提取正文，费用同样是 ¥0.005 |
| 多域名抓取并发（6 个不同站点） | 9.31 秒 → **1.85 秒** | 按目标域名独立调度，告别死板的全局并发瓶颈 |
| 同一 URL 连续二次抓取 | 7.04 秒 → **1 毫秒** | 会话内热缓存极速秒回 |
| 单次搜索结果去重（6 条结果） | 平均 1–3 个冗余域名 | 预先多取 2 条结果，再剔除重复链接与通稿，保持信息密度 |
| arXiv 论文页面抓取 | 6.44 秒 → **0.80 秒** | 检测到存在 HTML 版本（`/html/`）时优先抓取，跳过笨重的 PDF 转换 |
| 付费墙文章抓取（实测 6 个站点） | 0/6 → **5/6** 成功获取正文 | 阅读代理与 Wayback Machine 快照并行竞速提取 |
| 15 页 arXiv 论文解析 | anymd：4.1 万字，26 个层级标题，146 行表格（0.22 秒） | `pdftotext`：5.9 万字，无标题层级，双栏排版错乱（0.09 秒） |
| 常驻 Prompt 占用（3 个工具） | 5,896 → **3,494 字符**（约 971 tokens） | 将操作指引收敛在工具返回中，避免白白侵占系统提示词空间 |

运行 `npm run check` 可执行离线测试套件。如需对真实 API 进行连通性压测，可运行 `WEB_BENCH_LIVE=1 node bench/scenarios.ts all`（会消耗实际 API 额度）。详细测试规范与覆盖边界请参阅[测试与验证文档](docs/TESTING_zh-CN.md)。

---

## 关键细节与边界处理

- **128 字符查询限制**：DeepSeek 会把 `site:` 和 `after:` 等过滤算子计入 128 字符的搜索长度限制。一旦搜索词超长，`pi-deepread` 会平滑修剪（优先精简过滤算子，再在词边界安全截断），并在返回中明确告知调整情况，绝不粗暴抛错中断任务。
- **搜索引擎盲区**：微信公众号、小红书以及部分 V2EX 讨论帖不在 DeepSeek 的常规索引库中，而 YouTube 链接也偶发会被误定向至音乐主页。如果配置了 Exa Key，扩展会自动转交 Exa 处理；若未配置，则会通过免密钥路由（如 `sov2ex`、搜狗、阅读代理）与 DeepSeek 结果合并输出。若检索结果实质为登录拦截页面，扩展会自动剔除。
- **付费墙与反爬防护**：`fetch_content` 会按照“DeepSeek 优先 → 本地直连 → 阅读代理与 Wayback Machine 并行竞速”的链路依次尝试。此外它还具备页面结构智能判断能力：若内容主要充斥着导航栏、登录引导或空白 JavaScript 壳，扩展会将其准确判定为拦截墙并据实告知，绝不拿无效的空壳代码假装正文。
- **本地缓存清理**：搜索与抓取内容会自动缓存在 `<agent dir>/cache/web/` 目录下。写入新缓存时，每小时至多触发一次清理检查（默认保留 7 天以内、不超过 200 个文件或总容量 64 MB 以内的数据）。
- **状态快速排查**：在 Pi 会话中输入 `/web-status` 命令，即可直观查看当前生效的 API 密钥、工作路由、超时配置、OCR 补丁状态以及本地缓存占用情况。

---

## 本地开发调试

```bash
git clone https://github.com/pumblus/pi-deepread
pi -e ./pi-deepread          # 直接加载本地代码目录进行调试
```

扩展主体代码收敛于单文件之中：[`extensions/web-access.ts`](extensions/web-access.ts)。

关于项目开发过程中的取舍、调试细节以及架构演进，欢迎翻阅开发手记：[`docs/BUILD_LOG_zh-CN.md`](docs/BUILD_LOG_zh-CN.md)。

---

## 致谢与开源协议

本项目灵感来源于 [@Arcadia_Bao](https://x.com/Arcadia_Bao/article/2111711040757006401) 关于 DeepSeek `need_content: true` 参数的评测分享。

本项目遵循 [MIT](LICENSE) 开源协议 © Eric Zhou

### 准确性与合理使用提示

搜索摘要与简短摘录绝不会被当作完整的正文重复喂给模型。抓取成功的完整正文会在当次会话中安全复用。通过历史网页快照拉取到的内容会明确附带快照来源链接。音频和视频文件会提取现存的元数据或已有字幕轨；若需自动语音识别转文字，需自行接入转录工具。所有本地文档转换均在你的设备上闭环执行。
