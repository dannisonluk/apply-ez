# apply-ez — 研究與架構方案

> 目標：由 `ineedajob` 抽出 job scraper，打造成 Android app —— 每 4 小時自動爬工作、列出新職位，加一層 LLM 摘要 / 抽取，並支援「用戶揀選後自動申請」。
> 日期：2026-09-22

---

## 0. 已確認決定（2026-09-22）

| 項目 | 決定 |
|---|---|
| Repo | **Public** → GitHub Actions 無限分鐘 |
| App | **Expo**，鎖 2025 年中至尾版本（唔用最新） |
| 自動申請 | **所有申請都要最後一步人手確認** |
| Push 通知 | **要** |
| Resume | **3 份**：tech / programmer、data + business analyst、general |
| LLM 層 | **Qwen3.8 27B (free)** 主力，**Nemotron 3.5 Lightning (free)** fallback |

---

## 1. TL;DR

| 問題 | 結論 |
|---|---|
| Scraper 可唔可以直接抽？ | ✅ 可以。`adapters/**` + `job-pipeline.ts` + `rate-limit.ts` 係純邏輯，零 infra 依賴 |
| 要唔要 Redis / BullMQ / Prisma？ | ❌ 唔需要。換成 GitHub Actions cron + Supabase Postgres |
| 免費 hosting 得唔得？ | ✅ 可以做到 $0（public repo + Supabase Free + Cloudflare R2） |
| 自動申請可行？ | ✅ 可行，但全部保留最後人手確認 |
| LLM 用邊個？ | **Qwen3.8 27B (free)** —— 見第 4 節 |

---

## 2. 現有 ineedajob scraper 拆解

位置：`../ineedajob`（pnpm + turbo monorepo，即 9to6.hk 項目）

### 2.1 可原封搬走（純邏輯，冇 infra 依賴）

| 路徑 | 內容 | 依賴 |
|---|---|---|
| `services/scraper/src/adapters/**` | 12 個公司 adapter + `corporate-careers` 平台層（Workday / Taleo / SuccessFactors / PageUp / Eightfold / Oracle / SHKP / Towngas 自家） | `playwright`、`robots-parser` |
| `services/scraper/src/lib/job-pipeline.ts` | Zod 正規化 + 去重（`prepareJobsForIngest`） | `@ineedajob/types` |
| `services/scraper/src/lib/rate-limit.ts` | robots.txt 檢查 + 節流 + retry | `robots-parser`、`undici` |
| `services/scraper/src/lib/job-enrichment.ts`、`job-standardizer.ts` | 由 title 推導輕量 metadata（目前無 LLM） | 無 |
| `packages/types` | `jobIngestSchema`、`jobSourceSchema` 等 Zod contract | `zod` |

### 2.2 要換走嘅 orchestration 層

| 路徑 | 現況 | 換成 |
|---|---|---|
| `src/main.ts` | node-cron + BullMQ + Prisma `ScraperTarget` 表驅動 | GitHub Actions scheduled workflow（每 4 小時） |
| `src/queue/scrape-queue.ts` | BullMQ + Redis | 直接刪除 |
| `src/lib/api-client.ts` | POST 去 `services/api` 嘅 `/internal/jobs/ingest` | 直接寫 Supabase（或經 PostgREST） |
| `packages/db` | Prisma + Postgres + 20+ 業務表（評論／討論區／訂閱…） | 精簡 schema，只留 companies / jobs / runs / applications |

### 2.3 現有 12 個爬取目標

Cathay Pacific、AIA、AXA、Manulife、HSBC、HK Express、Swire、Towngas、MTR、CLP、Morgan Stanley、SHKP

- 現時每個 target 有自己嘅 cron（`30 */6`、`40 */6`…），即每 6 小時一次
- 改成每 4 小時：統一 `0 */4 * * *` 即可
- `config` 內有 `maxPages` / `maxJobs` / `includeDetailPages` / `fullCrawl` 等參數，可直接沿用
- `includeDetailPages` 會開多一個 page 抓詳情 → 時間同成本主要來源，亦係 LLM 摘要嘅資料來源（需要 JD 全文）

### 2.4 現有 pipeline 已經幫到手嘅嘢

`job-pipeline.ts` 已經處理好：
- URL / domain 正規化（防止公司 domain 被污染）
- 薪酬 min/max 對調修正、experience 上限 60 年
- `employmentType` 映射到產品 taxonomy，同時保留 `rawEmploymentType`
- 批次內去重（`source|externalId`）
- 失敗 job 分類為 `normalize` / `validate` / `dedupe` 三個 stage

呢啲直接搬，唔使重寫。

---

## 3. 目標架構

### 3.1 全流程

```
① Scheduler        GitHub Actions schedule: cron '0 */4 * * *'
        ↓
② Scraper          12 個 adapter（Playwright headless chromium）
        ↓
③ Pipeline         prepareJobsForIngest → 正規化 + 去重
        ↓
④ New-job diff     upsert：first_seen_at 為新、last_seen_at 更新
        ↓
⑤ LLM 層           只跑新 job：summarize JD + 抽結構化欄位
        ↓
⑥ Supabase         Postgres（jobs / apply_queue / applications / profile）
        ↓
⑦ Expo App         列出 first_seen_at DESC，未讀 badge + push 通知
        ↓
⑧ 用戶揀工         揀 resume（tech / data / general）→ insert apply_queue
        ↓
⑨ Auto-apply       Playwright 由 R2 拎 resume → 填表 → **用戶撳最後一下 Submit**
        ↑
   Cloudflare R2   3 份 resume（presigned URL，TTL 15 分鐘）
```

### 3.2 建議 schema

```sql
companies(
  id uuid pk, slug text unique, name text,
  careers_url text, ats_platform text
)

jobs(
  id uuid pk, company_id uuid fk,
  source text, external_id text,            -- unique(source, external_id)
  title text, location text, url text, apply_url text,
  employment_type text, department text,
  published_at timestamptz,
  application_deadline timestamptz,
  experience_min int,
  first_seen_at timestamptz default now(),  -- ← 「新工」判斷依據
  last_seen_at  timestamptz default now(),
  status text default 'ACTIVE',             -- ACTIVE / EXPIRED
  -- LLM 層
  summary text,
  summary_lang text,
  extracted jsonb,
  enrich_status text default 'PENDING',     -- PENDING / OK / FAILED / SKIPPED
  enrich_model text,
  enriched_at timestamptz,
  raw jsonb
)

scrape_runs(
  id uuid pk, adapter text, started_at timestamptz, finished_at timestamptz,
  inserted int, updated int, enriched int, error_count int, log jsonb
)

apply_queue(
  id uuid pk, job_id uuid fk, status text,  -- PENDING/PREPARED/NEEDS_HUMAN/DONE/FAILED
  resume_key text,                          -- 用邊份 resume
  payload jsonb, created_at timestamptz, updated_at timestamptz, log jsonb
)

applications(
  id uuid pk, job_id uuid fk, status text,
  applied_at timestamptz, evidence_url text -- 提交前截圖
)

profile(
  id uuid pk, full_name text, email text, phone text,
  autofill jsonb,                           -- 學歷 / 工作經驗 / screening 答案
  resumes jsonb                             -- { tech: key, data: key, general: key }
)
```

「新工」邏輯：唔使額外表。`first_seen_at > 用戶上次開啟 app 嘅時間` 就係新。App 只需存一個 local `last_opened_at`。

### 3.3 Resume 結構（R2）

```
resume/
  tech-programmer.pdf
  data-business-analyst.pdf
  general.pdf
```

- Private bucket + **presigned URL（TTL 15 分鐘）**，唔好開 public
- 申請時由用戶揀，或由 LLM 嘅 `jobFunction` 自動建議（例：`data` → data-business-analyst）
- **PII 絕對唔可以送去 free model**（見 4.5）

---

## 4. LLM 摘要 / 抽取層

### 4.1 目標

喺 pipeline 加一層 bot：summarize JD + 抽出結構化欄位（job posting 基本資料、deadline、YOE、工作安排等）。

### 4.2 設計原則

1. **Deterministic 先行，LLM 補漏。** 現有 adapter 已經抽到 `applicationDeadline`、`experienceMin`、`department`、`workSchedule`、`topMetadata`。LLM 只負責「整段摘要」+ 補回 deterministic 抽唔到嘅欄位，唔好重複抽已有嘅嘢。
2. **只跑新 job。** 用 `first_seen_at` 判斷，同一條 job 只 summarize 一次，結果永久 cache 落 DB。唔好每次開 app 都叫。
3. **Fail-soft。** LLM 係獨立 stage，所有 error 都要 catch，寫 `enrich_status = FAILED`，**唔可以令 scrape 失敗**。
4. **分開處理中英文。** HK 職位英文為主，但都有中文 JD，需要 prompt 明確指示輸出語言。

### 4.3 模型比較（OpenRouter，2026-09-22 實測）

| 指標 | Nemotron 3.5 Lightning (free) | Qwen3.8 27B (free) |
|---|---|---|
| 架構 | MoE 30B 總 / 3B active | Dense 27B（VLM，支援圖像） |
| Context | 1.0M | 262K |
| Intelligence Index | 12.9 | **33.7** |
| Coding Index | 26.8 | **68.1** |
| Agentic Index | 3.5 | **45.8** |
| AA-LCR（長 context 推理） | 60.3% | **82.0%** |
| GDPval-AA（實際工作任務） | 6.2% | **45.4%** |
| 非幻覺率 | 62.4% | **69.7%** |
| Tool call error rate | 2.60% | **0.21%** |
| Structured output error rate | 未列出 | ⚠️ **34.12%** |
| Latency P50 | 2.41 s | **0.91 s** |
| Throughput P50 | 24 tok/s | 27 tok/s |
| Availability（3 日） | 87.44% | **94.34%** |
| 發佈日期 | 2026-08-11 | 2026-08-14 |

### 4.4 結論：**Qwen3.8 27B** 主力，Nemotron 做 fallback

理由：
- 我哋做嘅係「抽取事實」（deadline、YOE），**非幻覺率 69.7% vs 62.4%** 直接影響品質
- JD 全文 + 指示係長 prompt，**AA-LCR 82.0% vs 60.3%** 差好遠
- **GDPval-AA 45.4 vs 6.2** —— Nemotron 喺「真實工作任務」上幾乎唔合格。佢係為 throughput 而設嘅模型，唔係 reasoning 模型
- Latency 同 availability 都係 Qwen 好

Nemotron 唯一優勢係 1.0M context 同 3B active（理論上 free tier 容量更鬆），但我哋嘅 JD 只有 1–5K token，262K 綽綽有餘。

⚠️ **實作上最關鍵嘅一點**：Qwen 嘅 **structured output error rate 高達 34.12%**。
→ **唔好用 strict `json_schema`**，改用 **tool calling / function calling**（error rate 只 0.21%），再配 Zod 驗證 + 失敗重試一次（轉 Nemotron）。呢個決定會直接影響成敗。

### 4.5 Free tier 限制（決定成敗）

| 條件 | 每分鐘 | 每日 |
|---|---|---|
| 累積買過 < 10 credits | 20 | **50** |
| 累積買過 ≥ 10 credits | 20 | **1,000** |

- 50 req/day 好緊張 —— 12 間公司每日新增職位可能已經 20–50 條
- **建議一次性買 US$10 credits**，解鎖 1,000 req/day。之後仍然可以全用 free model，$10 唔會扣（唔夠 $10 帳戶仲會有 `402` 風險）

其他注意：
- Free model 需要喺 OpenRouter settings 開 **prompt training / logging opt-in**，唔開會回 `404 No endpoints found matching your data policy`
- **因為 free model 嘅 prompt 會被 log，resume / profile 等 PII 絕對唔可以送去 free model。** JD 係公開資料，無問題
- 實作要限流（concurrency 2–3，尊重 20 req/min）+ 429 exponential backoff
- 開 run 之前用 `GET /api/v1/key` 查 `free_model_daily_requests.remaining`，唔夠就跳過 enrichment 留返下次

### 4.6 成本估算

只跑新 job：假設每日 30 條新 job，每條 input ~3K token / output ~300 token
→ 約 30 req/day，遠低於 1,000 req/day 上限 → **買咗 $10 credits 之後完全免費**

---

## 5. 免費 hosting 比較

### 5.1 定時爬蟲（最大挑戰：需要 headless Chromium）

| 方案 | 免費額度 | 評價 |
|---|---|---|
| **GitHub Actions（public repo）** | **無限分鐘** | ✅ **已選**。2,000 min/月限制只適用於 private repo |
| GitHub Actions（private repo） | 2,000 min/月、artifact 500MB | ⚠️ 估算 12 targets × 6 次/日 ≈ 3,000–4,500 min/月，會爆額 |
| Oracle Cloud Always Free（ARM VM） | 4 OCPU / 24GB RAM，永久免費 | ✅ 後備方案（想長駐 worker 時用） |
| Cloudflare Workers + Browser Rendering | 100k req/日；免費 2 並發 browser | ⚠️ Playwright 唔可以喺 Workers 跑，要改寫成 puppeteer binding |
| Render / Railway / Koyeb free | 已大幅收緊 | ❌ 唔建議 |

⚠️ GitHub Actions 兩個陷阱：
1. Scheduled workflow 喺 repo **60 日冇 commit** 之後會自動停用
2. 免費 plan 嘅 schedule 會延遲（peak hour 可能遲 5–30 分鐘）

### 5.2 資料庫

| 方案 | 免費額度 | 備註 |
|---|---|---|
| **Supabase Free** | 500MB Postgres、1GB storage、5GB egress、2 個 project | ✅ **已選**。內建 PostgREST，可以直接當 REST API 用 |
| Neon Free | 0.5GB Postgres | ✅ 冷啟動較慢 |
| Cloudflare D1 | 5GB SQLite、500 萬行讀/日 | ✅ 同 R2/Workers 同生態，但係 SQLite |

容量估算：每條 job 約 1–2KB，500MB ≈ 25–50 萬條。對 12 間公司嚟講極度充裕。
⚠️ Supabase Free 7 日冇 API 請求會 pause —— 但每 4 小時都有寫入，唔會中。

### 5.3 Resume 儲存

| 方案 | 免費額度 | 備註 |
|---|---|---|
| **Cloudflare R2** | 10GB 儲存、**egress 完全免費**、100 萬 Class A / 1000 萬 Class B ops | ✅ **已選**。S3-compatible，presigned URL 直讀 |
| Supabase Storage | 1GB | 可用，但 R2 大 10 倍且 egress 免費 |

### 5.4 App

**Expo**（已選），鎖 2025 年中至尾版本。

⚠️ 需要注意：用舊 SDK 會同最新 Expo Go 唔兼容 → 要改用 **development build**（EAS Build 免費額度足夠）。另外部分新 library 可能要降版本。開工時要先確認實際 SDK 版本。

### 5.5 Push 通知

| 方案 | 免費 | 備註 |
|---|---|---|
| **Expo Push** | ✅ 免費 | 用 Expo app 時最順，唔使額外服務 |
| ntfy.sh | ✅ 完全免費、免帳號 | 後備，或做 server-side 警報 |
| Firebase Cloud Messaging | ✅ 免費 | Expo Push 底層其實都係 FCM |

---

## 6. 自動申請（auto-apply）

### 6.1 目標網站用咩 ATS

由現有 adapter 睇到：Workday、Taleo、SuccessFactors、PageUp、Eightfold、Oracle，加 HSBC / SHKP / Towngas / Cathay 自家系統。

共通流程：開帳號（email + password）→ 好多要 email 驗證 → 上載 CV → 系統 parse → 多頁 form（個人資料、工作經驗、學歷、screening questions、期望薪酬、通知期、簽證、EEO、聲明）。
**大部分仲有 CAPTCHA**，Workday 同 Taleo 更有 anti-bot。

### 6.2 因為「全部要人手確認」，流程統一成三步

```
PREPARE   系統自動填好表 / 寫好 email
   ↓
REVIEW    用戶喺 app 內 WebView（或 email preview）檢查
   ↓
SUBMIT    用戶撳最後一下
```

呢個模式同時適用於兩種申請方式：

**A. 網頁表單（WebView autofill）**
- App 內 WebView 打開 `apply_url`
- 注入 autofill script：由 R2 presigned URL 拎 resume、自動填姓名 / email / 電話 / 學歷 / 工作經驗
- ✅ 唔使繞 CAPTCHA、唔違反 ToS、唔會交錯
- 遇到 CAPTCHA 就直接交返用戶處理

**B. Email 申請**
- 部分公司（尤其 HK 中小企、部分 corporate）接受 email 申請
- 用 Gmail API / Resend 自動 compose（subject = 職位名、body = template、attach resume）
- 用戶 preview 後撳 Send

### 6.3 全自動 ATS 填表（後期，逐步擴展）

同 scraper 一樣寫 per-platform `apply adapter`（Playwright）。難度排序（易 → 難）：

`Greenhouse / Lever` → `SuccessFactors / PageUp` → `Oracle / Eightfold` → `Taleo` → `Workday`

每個 adapter 嘅責任只係「填到最後一步為止」，Submit 永遠留返用戶。

### 6.4 風險 / 合規

- 大部分招聘網站 ToS 禁止自動化提交，亦有 robots.txt 限制
- 代用戶開帳號可能違反條款
- 大量自動申請會令帳號被封 / IP 被 ban
- 對策：**human-in-the-loop**（已決定）、每平台限制申請頻率、保留完整 log + 提交前截圖 evidence

### 6.5 技術流程

```
App 撳「申請」（揀 resume）
   → POST /apply → insert apply_queue(status = PENDING, resume_key)
   → Worker poll PENDING
       ├─ GitHub Actions：用 repository_dispatch API 觸發 workflow（啟動延遲 10–30 秒）
       └─ 或 Oracle VM 長駐 worker（即時）
   → Playwright 填表（resume 由 R2 presigned URL 拎）→ 截圖
   → status = NEEDS_HUMAN，push 通知用戶
   → 用戶喺 app 內確認 → SUBMIT → status = DONE
```

---

## 7. 分階段實作計劃

| 階段 | 內容 | 產出 |
|---|---|---|
| **P0** | 抽 scraper 成獨立 package，本地跑通 12 個 adapter | `packages/scraper-core` |
| **P1** | GitHub Actions cron + Supabase + R2；4 小時一次；new-job diff | 全自動 pipeline |
| **P2** | LLM 層：Qwen3.8 27B（tool calling）+ Zod 驗證 + Nemotron fallback | 摘要 + 結構化欄位 |
| **P3** | Expo app：新工列表、新工 badge、詳情頁、Expo Push | 可安裝 app |
| **P4** | 3 份 resume 管理 + 輔助填表（WebView autofill） | 一鍵填表 |
| **P5** | 申請隊列 + worker：先做 Email apply，再逐個 ATS 加 adapter | 半自動申請 |

---

## 8. 下一步

P0 開始：抽 scraper。要先確認：
1. 實際 Expo SDK 版本（2025 中至尾 → 邊個 patch）
2. OpenRouter 帳號有冇 ≥ 10 credits（決定 LLM 層可唔可以每日跑到 1,000 req）
3. 3 份 resume 嘅實際檔名 / 格式（PDF only？要唔要 .docx）
