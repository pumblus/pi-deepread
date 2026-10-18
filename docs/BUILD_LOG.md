# 我是怎么把 pi-deepread 做出来的

> 不是教程。这是一份踩坑记录：我想要的、我猜错的、最后为什么变成现在这样。
> 代码大部分是 AI 写的，需求、取舍和验收是我的。所有数字都是本机实测。

---

## 0. 起点：我想要"能读全文"的搜索

起因是看到忒修斯的船板那篇 [DeepSeek Search/Fetch 实测](https://x.com/Arcadia_Bao/article/2111711040757006401)。里面有一句让我立刻坐直的话：

> 默认必须开 `need_content: true`，不加价，仍 0.005 元/次。

意思是一次搜索请求，返回的不只是标题和摘要，还有每条的**整页正文**——文章里测到单条 4,100 到 18,000 字，arXiv 页面平均 28,717 字。

我当时用的是 `pi-web-access`，它的做法是"搜索拿 snippet，需要正文再抓一次"。也就是两次请求、两次延迟。如果一次就能拿到正文，很多"搜完再抓"的动作可以直接省掉。

于是就动手了。下面是真正花时间的部分。

---

## 1. 第一个坑：我的机器把所有域名解析成内网地址

装上第一版、调用抓取，报错：

```
Error: Blocked internal address for x.com: 198.18.0.14.
This address is in 198.18.0.0/15, commonly used by TUN/fake-IP proxies.
```

我第一反应是"扩展的 SSRF 检查写错了"，因为 `x.com` 显然是公网。

**其实是**：我机器上开着 TUN 模式的代理，所有域名都被映射成 `198.18.x.x` 的伪 IP（fake-IP），请求由代理按域名转发。而 `198.18.0.0/15` 是保留段，扩展的 SSRF 防护（防止恶意网页诱导 AI 去访问内网和云元数据接口）当然会拦。

**改法**：配置里加

```json
{ "ssrf": { "allowRanges": ["198.18.0.0/15"] } }
```

**这个取舍要说清楚**：等于告诉工具"这个网段是安全的"。在 TUN 代理下它确实全被代理接管，风险很低；但如果哪天你不在代理环境里，这个豁免就变成真的开口子。所以它是 opt-in，不是默认值。

---

## 2. 第二个坑：想读的那篇文章本身读不到

配置修好之后，`x.com` 返回 `HTTP 403`。换成 `r.jina.ai` 代理：

```json
{"code":403,"name":"AbuseAlleviationError","message":"Anonymous access to domain x.com blocked until Sun Oct 18 2026..."}
```

两条路都堵死。最后是让人把文章正文贴给我看的。

**教训**：抓取工具的失败模式分三类——网络层（超时/429）、站点层（403/登录墙）、平台层（Jina 这类第三方代理自己的封禁名单）。第三类最容易被误判成"我的配置有问题"，实际上跟你无关。

---

## 3. 第三个坑（最关键）：`need_content` 默认是关的

这是整件事的转折点。我先用 curl 直接打 API 验证，不开 `need_content`：

```
content_len = 0
summary_len = 431
```

只有一段 431 字的摘要。开了之后：

```
content_len = 3739 / 12614
authority = 3, rerank_score ≈ 2.19
```

**如果我没做这一步直接写代码，会得到"能跑但没用"的东西**：搜索正常返回、有标题有链接，看起来一切正常，只是永远拿不到正文，然后我会以为是 API 的问题去查文档。

所以顺序很重要：**先用 curl 把 API 的真实行为摸清楚，再写扩展**。扩展只是把已验证的行为固定下来。

顺带记两个好用的原生字段：`authority`（0–4，≥3 极权威）和 `rerank_score`（0–3，≥1.5 优质）——都是 DeepSeek 直接给的，不用自己算。

---

## 4. 第四个坑：query 硬限 128 字符，而且算子也算进去

我把 `domainFilter` 和 `recencyFilter` 编译成 `site:` / `after:` 拼进 query，觉得很优雅——少一个参数、少一层歧义。然后 200 字符的 query 直接被打回：

```
HTTP 400 {"error":{"message":"'query' must be at most 128 characters (request_id: ...)"}}
```

**改法**：拼完先量长度，超了就整条转给 Exa（它没有这个限制）；没有 Exa key 就报错，并把拼好的 query 原样打在错误信息里，让人一眼看到是哪里超的。

这个设计后来救了我很多次——错误信息里带上下文，比"400 Bad Request"有用一百倍。

---

## 5. 第五个坑：并发 10 会被限流，并发 3 不会

文章里的实测数据：10 线程并发时约 30% 的请求在 0.6 秒内返回 `HTTP 429`（不计费）；把并发压到 1–3、或者串行且间隔 0.8–1.0 秒，就完全正常。

我第一版是**纯串行 + 固定间隔 900ms**——绝对安全，但一批 5 个 URL 要 30 秒，其中大半时间在等间隔。

这里有个反直觉的点：`429` 是**不计费**的，所以"多打几次、被限流就重试"在经济上不亏，但在延迟上很亏。最终方案是**3 个槽位 + 起始间隔 gap/3**：

- 同时在飞的请求最多 3 个（不触发限流）
- 新请求的发起时刻彼此间隔 300ms（900/3），批量场景下比串行快 3 倍

实测 4 个 URL：串行估算 5.71 秒 → 实际 2.85 秒。

---

## 6. 岔路：我一度想去改别人 dist 里的一个数字

`pi-web-access` 的源码里，DeepSeek 结果被这一行截断：

```js
snippet: (text4(entry.summary) || text4(entry.snippet)).slice(0, MAX_SNIPPET_CHARS4)
// MAX_SNIPPET_CHARS4 = 800
```

请求体里也压根没发 `need_content`（`grep -c need_content dist/index.js` → 0）。上游 issue [#582](https://github.com/earendil-works/pi/issues/582) 开着、没人接。

我试过打补丁：两个锚点在 bundle 里各命中一次，改完 `node --check` 也过了。但想想还是放弃了——

- 升级一次就白改
- 1MB 的单文件 bundle 里塞私货，出问题没法定位
- 我真正想要的不是"800 改成 8000"，而是"正文落盘、能分页、能按段落找"

**于是改成自己写一个**。1300 行、零运行时依赖、单文件。事后看这是整件事里最正确的决定。

---

## 7. 第七个坑：anymd 自己也有 SSRF 检查，而且不给你关

文档类（PDF/Office/EPUB/图片）我用 [anymd](https://github.com/SylphxAI/anymd) 本地转 Markdown。它支持直接喂 URL，我本来想省掉下载那一步：

```
anymd: https://arxiv.org/pdf/1706.03762: URL host 'arxiv.org' resolves to a non-public address (SSRF protection).
```

跟坑 1 是同一个根因：TUN 代理把 `arxiv.org` 解析成 `198.18.7.138`。区别在于 anymd 是编译好的 Rust 二进制，`strings` 里翻遍了也没有任何绕过开关。

**改法**：永远先下载到本地临时文件（30MB 上限、流式落盘），再把文件路径喂给 anymd。既绕开了它的 SSRF，也顺手拿到了大小上限和临时文件清理。

**顺带一个坑中坑**：一开始我是 `arrayBuffer()` 全量读进内存再写盘，30MB 的文件 × 3 并发 = 90MB 峰值。改成流式之后，峰值只有几十 KB。

---

## 8. 第八个坑：中文扫描件全是乱码

anymd 调 tesseract 的方式是 `tesseract <image> stdout`——**不带 `-l`**，默认只认英文。中文 PDF 扫出来是这样：

```
_Image text is not extracted by default; pass `ocr: true` to OCR it (needs a local `tesseract`)._
```

（这是没开 OCR 的情况。开了 OCR、但没指定语言，出来的是拉丁字母乱码。）

**改法**：写了个 12 行的 shell shim，塞在 PATH 前面：

```bash
for arg in "$@"; do
  case "$arg" in -l|--oem|--psm) exec /opt/homebrew/bin/tesseract "$@" ;; esac
done
exec /opt/homebrew/bin/tesseract -l "${ANYMD_TESS_LANGS:-chi_sim+eng}" "$@"
```

调用方自己指定了语言就原样转发，没指定就补 `chi_sim+eng`。这个 shim 现在随包发布在 `bin/tesseract`，装上就有中文 OCR（前提是 `brew install tesseract-lang`）。

---

## 9. 本地解析到底值不值得：三个工具对比

为了确认 anymd 不是"看起来高级但更差"，我拿两篇论文做了对照实验（Attention Is All You Need，15 页；GPT-3，75 页）：

| 工具 | 字符 | 标题 | 表格行 | 行尾连字符 | 坏字符 | 耗时 |
|---|---|---|---|---|---|---|
| anymd | 41,026 | **26** | **146** | 0 | 0 | 0.22s |
| pdftotext -layout | 59,444 | 0 | 0 | 16 | 15 | 0.09s |
| pdftotext（raw） | 39,919 | 0 | 0 | 0 | 15 | 0.11s |
| mutool -F txt | 40,067 | 0 | 0 | 16 | 16 | 0.14s |

结论不是"anymd 更好"，而是**它们的失败方式不同**：

- 传统工具输出的是"文本流"，双栏论文里两栏会交错——`ensembles, by over 2 BLEU` 后面紧跟另一栏的句子，短行占比 61%，模型读起来是碎的。
- anymd 输出的是"文档结构"：`## 3 Model Architecture` → `### 3.1 Encoder and Decoder Stacks`，表格还原成 Markdown 管道表（`|Self-Attention|O(n^2 · d)|O(1)|O(1)|`），图注变成 `![Figure 1: ...](path.png)`，还能标页码。
- 代价是慢 2–4 倍（绝对值 0.2 秒 vs 0.09 秒），以及偶发的表格列错位。

**公式两者都救不了**。anymd 给的是 `Attention(Q, K, V ) = softmax( √ )V (1) d_k`——根号里的内容丢了位置。这是 PDF 本身的锅，不是工具能修的。

---

## 10. 最后一个坑：打包时 `import.meta.url` 是 undefined

扩展在本机是直接放 `~/.pi/agent/extensions/` 下跑的，定位同包目录我用 `import.meta.url`。打成 npm 包、用 `pi -e` 加载之后，OCR shim 死活找不到：

```
[pi-deepread] shim:  exists: false
```

**原因**：Pi 用 jiti 加载扩展，模块被转成 CJS 执行，`import.meta` 在这个时候是空的。

**改法**：先试 `import.meta.url`（ESM 场景），拿不到再退回 `eval("typeof __dirname === 'string' ? __dirname : ''")`（CJS 场景），两个都失败就干脆不注入 shim——中文 OCR 失效，但其他功能正常。降级要静默，不能因为找不到一个可选组件就整个挂掉。

---

## 我没有做的

- **YouTube 字幕/封面**：DeepSeek 的 YouTube 结果常落在 `music.youtube.com`，要额外处理；不做。
- **图片搜索**：我的使用场景里不需要。
- **存储 gzip**：能省 70% 磁盘，但要加解压代码、读取变慢；7 天 / 200 文件 / 64MB 的清理策略已经够用。
- **会话内 URL 缓存**：收益是重复抓同一个链接时省一次请求，风险是拿到旧内容。重复抓取本来就不常见，不值。
- **并发调到 5+**：能再快一点，但 429 的概率跟着涨。3 是实测的安全边界。

---

## 如果你也想做类似的扩展

按重要性排：

1. **先 curl，再写码**。把 API 的真实返回、错误信息、边界全部摸一遍。我这次最大的收获（`need_content`）完全来自这一步。
2. **把错误信息写全**。超长 query 要把拼好的串打出来，抓取失败要逐条列原因。你未来 90% 的调试都靠它。
3. **降级要静默、主路径要响**。OCR shim 找不到就跳过；但 DeepSeek 挂了必须明确告诉你切到了 Exa。
4. **别改别人 dist**。升级会毁掉一切，而且你真正想要的东西通常不是那一个数字。
5. **把数字记下来**。不是给别人看的，是为了三天后你还能判断"这次是不是真的变慢了"。
