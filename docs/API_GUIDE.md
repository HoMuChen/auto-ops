# auto-ops API 使用指南

> **狀態：** v0.1（pre-release）。API 形狀可能會變，會在 commit message 標 `breaking:` 通知。
> **權威 spec：** OpenAPI 自動產生 — 開發伺服器跑起來後 → http://127.0.0.1:8080/docs

---

## 1. 整體架構（給 UI 團隊看）

```
        ┌──────────────────────────────────────────────────────┐
        │  你（UI / Shopify Embedded App / 第三方）            │
        └──────────────────────────────┬───────────────────────┘
                                       │  REST + SSE
                                       │  Authorization: Bearer <Supabase JWT>
                                       │  x-tenant-id: <UUID>
                                       ▼
        ┌──────────────────────────────────────────────────────┐
        │  auto-ops API  (Fastify, port 8080)                  │
        │  ─ Auth middleware (verify JWT, JIT 建 user row)     │
        │  ─ Tenant middleware (檢查 x-tenant-id 是會員)        │
        │  ─ Routes / OpenAPI (Zod-validated)                  │
        └──────────────────────────────┬───────────────────────┘
                                       │
              ┌────────────────────────┼─────────────────────────┐
              ▼                        ▼                         ▼
      ┌─────────────┐         ┌──────────────────┐      ┌────────────────┐
      │ Supabase    │         │ TaskWorker        │      │ OpenRouter     │
      │ Postgres +  │         │ (poll + claim +   │      │ (LLM 通道)      │
      │ pgvector    │         │  LangGraph 跑)    │      │                │
      └─────────────┘         └──────────────────┘      └────────────────┘
```

**重點：**
- 所有 API 路徑前綴 `/v1`（health / docs 除外）
- 所有 mutation / 多數 read 都需要 **JWT + x-tenant-id**（除了少數 user 全局端點）
- Task 的 LLM 跑通是 **非同步的** — UI 應該透過 SSE 看 log，或 polling 任務狀態

---

## 2. 環境

| 環境 | Base URL |
|---|---|
| Local dev | `http://127.0.0.1:8080` |
| Swagger UI | `http://127.0.0.1:8080/docs` |
| OpenAPI JSON | `http://127.0.0.1:8080/docs/json` |

UI 開發時可以從 OpenAPI JSON 自動產 client（推薦 `openapi-typescript` 產 types，或 `openapi-fetch` 產 typed client）。

---

## 3. 認證

我們**沒有**自己的登入端點 — auth 完全靠 **Supabase**：

1. UI 用 `@supabase/supabase-js`（或 GoTrue 直接）做註冊 / 登入
2. 拿到 Supabase 簽的 **access token**
3. 對 auto-ops API 的所有 `/v1/*` 請求都帶：

```
Authorization: Bearer <SUPABASE_ACCESS_TOKEN>
```

JWT 必須含 `sub`（user UUID）和 `email`，否則 401。

**第一次 auth 自動建 `users` row** — 不用呼叫任何 provisioning 端點。

### Server 怎麼驗 token

API server **不**自己簽發 token，只 verify。新版 Supabase（CLI v2 / 啟用
asymmetric keys 的 hosted project）用 **ES256** 簽 access token，public key
放在：

```
${SUPABASE_URL}/auth/v1/.well-known/jwks.json
```

Server 從這個 JWKS 抓 key 驗，不需要 shared secret。Legacy 專案還在用
**HS256** 的話，把 shared secret 放 `SUPABASE_JWT_SECRET`，server 會看 JWT
header `alg` 自動分流（`ES256/RS256` → JWKS、`HS256` → secret）。

### Supabase 的兩把 key（API key，不是 JWT）

CLI v2 之後，`supabase status` 顯示的是：

| Key | 給誰 | 等同於舊名 |
|---|---|---|
| `sb_publishable_…` | browser / UI | anon key |
| `sb_secret_…` | server-only（admin endpoints） | service_role key |

UI 端跑 `@supabase/supabase-js` 用 publishable key；secret key **不可** 進
browser bundle。auto-ops API server 不需要 publishable key，只需要
`SUPABASE_URL`（拿 JWKS 用）。

### Local dev：拿 access token 的最快方式

兩種：

**(a) Supabase Studio (http://127.0.0.1:54323)**
- 左欄 Authentication → 建一個用戶 → 拿 access token

**(b) 直接呼叫 GoTrue**
```bash
# apikey 用 supabase status 顯示的 Publishable key（sb_publishable_…）
curl -X POST 'http://127.0.0.1:54321/auth/v1/signup' \
  -H 'apikey: <PUBLISHABLE_KEY>' \
  -H 'Content-Type: application/json' \
  -d '{"email":"u@example.com","password":"password123"}'
# → 回 access_token（ES256 簽的）
```

---

## 4. Multi-Tenant

一個 user 可以屬於多個 tenant（角色：`owner` / `admin` / `operator` / `viewer`）。

幾乎所有 `/v1/*` 端點需要：

```
x-tenant-id: <UUID>
```

如果 user 不是該 tenant 的成員 → **403 forbidden**。

**例外**（不需要 `x-tenant-id`）：
- `GET /v1/me` — 看自己有哪些 tenant
- `POST /v1/tenants` — 新建 tenant（caller 自動變 owner）
- `GET /health`

---

## 5. 完整使用者旅程

### Story：「老闆第一次登入 → 啟用 SEO Expert → 派任務 → 看結果」

```
                                    UI 動作                  API 呼叫
─────────────────────────────────────────────────────────────────────────────────
[註冊/登入 Supabase]            ──>                 (Supabase 自己處理)
                                                    ↓ 拿到 JWT

[檢查有沒有 workspace]          GET /v1/me          回 { user, tenants: [] }
                                                    ↓ 空，導向 onboarding

[建第一個 workspace]            POST /v1/tenants    {name,slug,plan} → 回 tenant
                                                    ↓ 拿到 tenant.id

[列可聘員工]                    GET /v1/agents      回 [seo-strategist, shopify-blog-writer,
  顯示卡片：                                          product-planner, product-designer, shopify-publisher, ...]
  - ✓ Shopify 部落格寫手 (ready)                            每個含 ready / credentials
  - ✓ SEO 策略師 (ready)                              checklist / configSchema
  - ✗ 產品企劃師 (need product-designer enabled)
  - ✗ 產品設計師 (need shopify-publisher enabled)
  - ✗ Shopify 商品發布員 (need creds)
                                                    ↓ 老闆點 Shopify 部落格寫手

[啟用 Shopify 部落格寫手]               POST /v1/agents/    回 { enabled:true, config }
  渲染 configSchema 表單           shopify-blog-writer/
  (targetLanguages, brandTone…)    activate
                                                    ↓

[首頁兩個入口擇一]              ──── A 老闆已想清楚 ──────────────────────────
  A. 直接派任務                 POST /v1/tasks          回 task (status:'todo')
  B. 先聊一下再派任務            {brief, params?}        ↓ 拿 task.id
                                ──── B 模糊念頭 ──────────────────────────────
  user 輸入：「幫我寫一篇        POST /v1/intakes        回 intake + reply +
   夏季女裝的 SEO 文章」          {message}              readyToFinalize=false
                                ↓ 多輪對話 (POST /v1/intakes/:id/messages)
                                ↓ 對話到 readyToFinalize=true
                                POST /v1/intakes/:id/   回 { intake, task }
                                  finalize              ↓ task.status='todo'

[Kanban 顯示卡片進 In Progress]  GET /v1/tasks/:id     polling 或 SSE 看更新
[Log 即時跳動]                   /stream  (SSE)         接收 agent.questions.asked 等

── 若任務由 SEO 策略師派生（有 research.eeatHook）────────────────────────────
[卡片變 Waiting，顯示 EEAT 問題]  GET /v1/tasks/:id    status='waiting',
                                                        output.eeatPending 有 questions
  user 回答問題                  POST /v1/tasks/:id/   回 task (status:'todo')
                                  feedback {feedback}    ↓ worker 重跑寫稿
[卡片進 In Progress 再跑一次]    /stream  (SSE)         接收 agent.draft.ready
── 一般流程（直接寫稿）─────────────────────────────────────────────────────────

[卡片變 Waiting，顯示草稿]       GET /v1/tasks/:id     status='waiting',
                                                        output.pendingToolCall 已設
  user 點 [Approve]              POST /v1/tasks/:id/   回 task (status:'done')
                                  approve {finalize:true}

  user 點 [Feedback]             POST /v1/tasks/:id/   回 task (status:'todo')
   輸入「語氣再活潑」              feedback {feedback}    ↓ worker 重跑
```

---

## 5.1 三個介面，分工清楚（重要！前端架構必看）

每個 task 有三個獨立的資料面，UI 應該分開渲染：

| 介面 | 來源 | 角色 | 特性 |
|---|---|---|---|
| **Logs** | `GET /v1/tasks/:id/logs` + SSE | 時間軸 — 任務跑了什麼 | 機器產生、密度高、適合放「展開細節」 |
| **Messages** | `GET /v1/tasks/:id/messages` | 對話 — user 與 agent 的往返 | 短、口語化（員工口頭匯報、user feedback、EEAT 問答） |
| **Output.artifact** | `GET /v1/tasks/:id` 的 `task.output.artifact` | 產出物 — 真正交付的東西 | 一個扁平 markdown-first 物件，**所有 agent 共用同一個形狀**，前端不再 dispatch on kind |

**核心原則：**
- `messages` 不再夾帶 HTML / JSON 大段預覽 — 那是 artifact 的工作
- artifact 的形狀**固定**：`{ report, body?, refs? }`，沒有 `kind` 欄位、沒有 per-agent renderer
- 內容用 **markdown** 表達 — 前端只要一顆 markdown 元件就能渲染所有 agent 的 artifact
- `refs` 是自由欄位袋（IDs、URLs、發布戳記等），對 UI 來說是「Details 折疊面板」

### Artifact 合約

```ts
interface Artifact {
  /** Markdown 匯報 — 給老闆看的「我為什麼這樣做」敘事，
   *  也是下游 agent 讀的權威來源。一律用 markdown 元件渲染（如 <ReactMarkdown>）。 */
  report: string;

  /** 選填的 markdown 交付物（文章正文、商品描述）。只有「會產出內容」的
   *  agent 會給；同樣用 markdown 元件渲染，放在 `report` 下方。 */
  body?: string;

  /** 自由結構的細節包 — IDs、URL、語言、tags、發布戳記等。
   *  由產生它的 agent 自己定 schema，UI 顯示成「Details」小面板。
   *  發布動作完成後框架會塞 `refs.published`（如 `{ articleId, articleUrl, status }`）。 */
  refs?: Record<string, unknown>;
}
```

### 前端渲染規則（不再 dispatch on kind）

```tsx
function ArtifactPanel({ artifact }: { artifact: Artifact }) {
  return (
    <article>
      {/* 1. 一律先渲染 report（markdown 匯報） */}
      <ReactMarkdown>{artifact.report}</ReactMarkdown>

      {/* 2. 若有 body 就在下方渲染（也是 markdown，例如文章正文 / 商品描述） */}
      {artifact.body && (
        <section className="deliverable">
          <ReactMarkdown>{artifact.body}</ReactMarkdown>
        </section>
      )}

      {/* 3. 發布完成 — 框架會在 refs.published 蓋章 */}
      {artifact.refs?.published && <PublishedBadge meta={artifact.refs.published} />}

      {/* 4. 其餘 refs.* 自由顯示 — 例如 imageUrls、tags、askedAt 等，
            可以做一個可摺疊的 Details 面板 */}
      {artifact.refs && <DetailsPanel refs={artifact.refs} />}
    </article>
  );
}
```

> **新 agent 不需要前端改 code**：未來新增 agent 不會引入新的 artifact 類型，
> 它只會寫好 `report` / `body` / `refs`，UI 完全不用 dispatch。

### 各 agent 慣用的 `refs` 內容（僅供前端參考，不需依賴）

| Agent | `report` | `body` | 常見 `refs.*` |
|---|---|---|---|
| `seo-strategist` | ✓ 規劃匯報 + 文章列表 | — | — |
| `product-planner` | ✓ 規劃匯報 + variants 列表 | — | — |
| `shopify-blog-writer` Stage 1（EEAT 問題） | ✓ 為什麼問 + 問題清單（嵌在 markdown 裡） | — | `askedAt` |
| `shopify-blog-writer` Stage 2（草稿） | ✓ 寫作切角匯報 | ✓ 文章正文 markdown | `title`, `summaryHtml`, `tags`, `language`, `author?`；發布後 `published: BlogPublishedMeta` |
| `product-designer` | ✓ 設計匯報（含 `![](url)` 內嵌圖片） | ✓ 商品描述 markdown | `title`, `tags`, `vendor`, `productType?`, `language`, `imageUrls` |
| `shopify-publisher` | ✓ 同 designer 帶來的內容 | ✓ 同上 | 同 designer + `ready: true`；發布後 `published: ProductPublishedMeta` |
| `supervisor` 釐清提問 | ✓ 一句話 markdown 問題 | — | — |

### 發布戳記（`refs.published`）

當 task 走 pendingToolCall 路徑（`shopify.publish_article` / `shopify.create_product`），
`/approve(finalize:true)` 之後框架會把 tool 的 return value 塞進 `artifact.refs.published`：

```ts
// blog-writer 發完文章
artifact.refs.published = {
  articleId: 4242,
  blogId: 200,
  blogHandle: 'editorial',
  handle: 'xia-ri-chuan-da-5-ge-bi-bei-dan-pin',
  articleUrl: 'https://demo-shop.myshopify.com/admin/articles/4242',
  publishedAt: null,
  status: 'draft',
};

// shopify-publisher 上架商品
artifact.refs.published = {
  productId: 9876543210,
  handle: 'linen-oversized-shirt',
  adminUrl: 'https://demo-shop.myshopify.com/admin/products/9876543210',
  status: 'draft',
};
```

UI 看到 `refs.published` 就顯示 badge / 連結即可，不需要看其他欄位來判斷狀態。

### 看板卡片渲染建議

| 階段 | conversation 顯示 | artifact panel 顯示 |
|---|---|---|
| `task.input` | user 的 brief | (尚未產生) |
| `agent.started` 後 | 進行中… | (空) |
| `waiting`（EEAT 問題階段） | progressNote: 「有兩個 EEAT 問題想請老闆回答」 | `report`（markdown 匯報內含問題清單）+ 回答框 |
| `waiting`（草稿） | progressNote: 「草稿好了，老闆看一下開頭那段」 | `report`（匯報）+ `body`（文章 markdown） |
| `done`（已發布） | progressNote: 「已發布到 Shopify ✓」 | 同上 + `refs.published` 顯示「去後台看」連結 |

---

## 6. Endpoints 詳解

### 系統 / 用戶

#### `GET /health`
無需 auth。回 `{ status: 'ok', uptime: number }`。

#### `GET /v1/me`
需要 JWT，**不用 x-tenant-id**。回：
```json
{
  "user": { "id": "uuid", "email": "u@example.com" },
  "tenants": [
    { "tenantId": "uuid", "slug": "demo", "name": "Demo Shop", "plan": "basic", "role": "owner" }
  ]
}
```

`tenants` 為空 → UI 顯示「建立第一個 workspace」流程。

---

### Tenants

#### `POST /v1/tenants`
需要 JWT。建 tenant + caller 變 owner，一個 transaction。
```json
// Request
{ "name": "Demo Shop", "slug": "demo", "plan": "basic" }

// Response 201
{
  "id": "uuid",
  "name": "Demo Shop",
  "slug": "demo",
  "plan": "basic",
  "createdAt": "2026-05-01T00:00:00Z",
  ...
}
```

`slug` 規則：小寫英數 + dash，2-60 字。重複 → 409。

---

### Agents

#### `GET /v1/agents`
列所有 agent 的 manifest + tenant 啟用狀態。
```json
[
  {
    "id": "seo-strategist",
    "name": "SEO 策略師",
    "description": "規劃 SEO 內容戰略：把高層 brief 拆成多個聚焦主題，每個主題都派發為獨立的 Shopify 部落格寫手執行任務。",
    "defaultModel": { "model": "anthropic/claude-sonnet-4.6", "temperature": 0.2 },
    "toolIds": ["serper.search"],
    "requiredCredentials": [],
    "configSchema": {
      /* maxTopics, defaultLanguages, brandTone, preferredKeywords,
         skills: { seoFundamentals(default:true), aiSeo(default:true), geo(default:true) } */
    },
    "metadata": { "kind": "strategy" },
    "enabled": false,
    "ready": true,
    "credentials": [],
    "config": {}
  },
  {
    "id": "shopify-blog-writer",
    "name": "Shopify 部落格寫手",
    "description": "依聚焦 brief 撰寫一篇多語 SEO 部落格文章，待人工核准後發布到租戶的 Shopify 部落格。",
    "defaultModel": { "model": "anthropic/claude-sonnet-4.6", "temperature": 0.4 },
    "toolIds": ["shopify.publish_article"],
    "requiredCredentials": [
      {
        "provider": "shopify",
        "description": "Shopify Admin API token + store URL — needed to publish blog articles",
        "setupUrl": "https://help.shopify.com/...",
        "bound": false
      }
    ],
    "configSchema": {
      /* targetLanguages, brandTone, bannedPhrases, preferredKeywords,
         publishToShopify, blogHandle, defaultAuthor, publishImmediately, credentialLabel,
         skills: { seoFundamentals(default:true), eeat(default:true), aiSeo(default:false), geo(default:false) } */
    },
    "enabled": false,
    "ready": false,  ← creds 未綁所以 false
    "credentials": [{"provider":"shopify","bound":false,"description":"..."}]
  },
  {
    "id": "product-planner",
    "name": "產品企劃師",
    "description": "規劃產品內容策略：透過 Serper 研究競品切角，產出多組內容變體（平台 × 語言 × 受眾），並為每個變體派發一筆產品設計師任務。",
    "defaultModel": { "model": "anthropic/claude-sonnet-4.6", "temperature": 0.2 },
    "toolIds": ["serper.search"],
    "requiredCredentials": [],
    "configSchema": {
      /* maxVariants(default:5), defaultLanguages(default:['zh-TW']),
         brandTone, preferredKeywords, useSerperSearch(default:true),
         skills: { seoFundamentals(default:true), productPositioning(default:true), ecommerceMarketing(default:true) } */
    },
    "metadata": { "kind": "strategy" },
    "enabled": false,
    "ready": true,   ← 不需要 creds；但需要 product-designer 同時啟用
    "credentials": []
  },
  {
    "id": "product-designer",
    "name": "產品設計師",
    "description": "依產品企劃師產出的 markdown brief 生成產品圖片與文案，再派發發布員 agent 上架到已啟用的平台。",
    "defaultModel": { "model": "anthropic/claude-sonnet-4.6", "temperature": 0.3 },
    "toolIds": ["images.generate", "images.edit"],
    "requiredCredentials": [],
    "configSchema": {
      /* defaultVendor, defaultLanguage(default:'zh-TW'),
         skills: { productPhotography(default:true), socialMediaImages(default:true) } */
    },
    "enabled": false,
    "ready": true,   ← 不需要 creds；但需要至少一個 publisher agent 同時啟用
    "credentials": []
  },
  {
    "id": "shopify-publisher",
    "name": "Shopify 商品發布員",
    "description": "把現成的 ProductContent 包上架到租戶的 Shopify 商店；預期 task.input.params.content 為 ProductContent 物件。",
    "toolIds": ["shopify.create_product"],
    "requiredCredentials": [
      {
        "provider": "shopify",
        "description": "Shopify Admin API token + store URL — needed to create products",
        "setupUrl": "https://help.shopify.com/...",
        "bound": false
      }
    ],
    "configSchema": {
      /* shopify: { credentialLabel, autoPublish(default:false) } */
    },
    "metadata": { "kind": "publisher" },
    "ready": false,  ← creds 未綁所以 false
    "credentials": [{"provider":"shopify","bound":false,"description":"..."}]
  }
]
```

#### `GET /v1/agents/:agentId`
單一 agent，內容同上但加上 `promptOverride` / `toolWhitelist`。

#### `POST /v1/agents/:agentId/activate`
驗證 creds 都備好 + config 通過 manifest.configSchema → 啟用。所有 agent 對所有 tenant 可見，沒有 plan-tier 限制。
```json
// shopify-blog-writer 範例
{
  "config": {
    "targetLanguages": ["zh-TW"],
    "brandTone": "professional"
  },
  "promptOverride": null,        // 可選
  "toolWhitelist": null          // 可選；填了會限制 agent 只能用列表內的 tool
}

// product-planner 範例
{
  "config": {
    "maxVariants": 3,
    "defaultLanguages": ["zh-TW"],
    "brandTone": "warm, professional",
    "useSerperSearch": true
  }
}

// product-designer 範例
{
  "config": {
    "defaultLanguage": "zh-TW",
    "defaultVendor": "Acme",
    "skills": { "productPhotography": true, "socialMediaImages": true }
  }
}

// shopify-publisher 範例
{
  "config": {
    "shopify": { "autoPublish": false }
  }
}

// Response 200
{ "enabled": true, "config": { /* validated, with defaults applied */ } }
```

**錯誤情境：**
| HTTP | code | 意思 |
|---|---|---|
| 400 | `validation_error` | config 不通過 Zod schema → `details.fieldErrors` 有具體欄位 |
| 404 | `not_found` | agentId 不存在 |
| 409 | `conflict` | required credentials 還沒綁 → `details.missing` 列出哪些 provider |

#### `POST /v1/agents/:agentId/deactivate`
204 No Content。`enabled=false`，但 config 保留（再啟用會復原）。

---

### Credentials Vault

跨 agent 共享。一個 provider 一份憑證（之後支援多帳號 via `label`）。

#### `GET /v1/credentials`
列出已綁，**不回 secret**。
```json
[
  {
    "id": "uuid",
    "provider": "shopify",
    "label": null,
    "metadata": { "storeUrl": "shop.myshopify.com" },
    "createdAt": "2026-05-01T00:00:00Z"
  }
]
```

#### `PUT /v1/credentials/:provider`
upsert。`provider` ∈ `{shopify, threads, instagram, facebook}`。
```json
// Shopify 的範例
{
  "secret": "shpat_xxx",                          // Admin API access token
  "metadata": { "storeUrl": "shop.myshopify.com" },
  "label": null                                   // 之後支援多店時填
}
```

> **MVP 注意：** `secret` 目前是明文存 DB（local dev OK）。Production 要前端傳 plaintext，後端再加密 at-rest。Roadmap 上。

#### `DELETE /v1/credentials/:id`
204。

---

### Tasks — 建立（派任務的入口）

派任務有 **兩個入口**，依老闆對任務的清晰度自行選：

| 入口 | 何時用 | 流程 |
|---|---|---|
| `POST /v1/tasks` | 老闆已經想清楚了，brief 一句話講完就能跑 | 直接建 task → `todo` → worker 撿走 |
| `POST /v1/intakes` | 老闆只有模糊念頭，需要先聊一下才知道要做什麼 | 跟 intake agent 對話到 readyToFinalize → `/finalize` 才建 task |

兩個流程**不會混淆**：intake 對話是獨立實體（`task_intakes` 表），不會出現在看板上；只有 finalize 之後 spawn 的 task 才會。

#### `POST /v1/tasks`
這是 user 在「對話框」打字按 send 時呼叫的端點。直接寫一筆 `tasks` row（status='todo'）+ 一筆 user message，worker 會非同步 poll 走。supervisor 在執行中需要釐清時，澄清會走 HITL gate（task 進 `waiting`）— 那是「執行中的 HITL」，跟 intake 的「執行前的釐清」是兩回事。
```json
// Request
{
  "brief": "幫我規劃夏季女裝的 SEO 並發布",
  "preferredAgent": "shopify-blog-writer",         // 可選；不給就讓 Supervisor 路由
  "params": { "language": "zh-TW" },              // 可選；任意 KV 給 agent 參考
  "scheduledAt": "2026-05-02T08:00:00Z",          // 可選；未來時間 → 排程
  "imageIds": ["uuid-from-uploads", "..."]         // 可選；先 POST /v1/uploads 拿 id
}

// Response 201 — task 物件
{
  "id": "uuid",
  "status": "todo",
  "title": "幫我規劃夏季女裝的 SEO 並發布",
  ...
}
```

**帶圖片的流程：**
1. 先 `POST /v1/uploads`（multipart）→ 拿到 `{ id, url }`
2. 把 `id` 放進 `imageIds` 陣列一起送 `POST /v1/tasks`
3. 後端把圖片 IDs 存進第一條 user message；worker 跑任務時把圖片解析成 delivery URL 傳給支援 vision 的 agent

**之後：**
- 沒有 `scheduledAt`（或 `scheduledAt` 已過）的任務，server 會**立即觸發** worker，不等 poll interval
- 有未來 `scheduledAt` 的任務等到排程時間才執行
- 跑完一輪後 status → `waiting` 或 `done`
- UI 用 `GET /v1/tasks/:id` polling 或 `/v1/tasks/:id/stream` SSE

---

### Intakes — 前置釐清對話（pre-task chat）

老闆有時候自己也說不清楚要做什麼。intake 提供「先聊一下、確定好了再建任務」的入口；對話過程**完全獨立於看板**（`task_intakes` 表），看板只看到 finalize 後 spawn 的 task。

**Intake agent 的特性：**
- 不上 supervisor LangGraph、不持久化 checkpoint，純粹是 LLM 一輪一輪跟老闆對話
- 每輪都會更新 `draftTitle` / `draftBrief`（老闆隨時看得到「目前 AI 理解的任務長什麼樣」）
- 偵測到資訊夠了會把 `readyToFinalize=true`，UI 應該開啟「建立任務」按鈕
- 用一個比 supervisor 輕的 model（`anthropic/claude-sonnet-4.6`，code-fixed）

**生命週期：**
```
open ──/finalize──> finalized   (spawn 一張新 task)
open ──/abandon──> abandoned    (對話被丟掉，沒有 task)
```

#### `POST /v1/intakes`
開新對話。第一句話 + intake agent 的第一個回覆會在同一筆 INSERT 寫入。
```json
// Request
{
  "message": "幫我寫篇 SEO 文章",
  "imageIds": ["uuid-from-uploads"]   // 可選；先 POST /v1/uploads 拿 id
}

// Response 201
{
  "intake": {
    "id": "uuid",
    "status": "open",
    "messages": [
      { "role": "user", "content": "幫我寫篇 SEO 文章", "imageIds": ["uuid"], "createdAt": "2026-05-01T..." },
      { "role": "assistant", "content": "了解，老闆要寫幾篇？目標客群是哪一塊？", "createdAt": "2026-05-01T..." }
    ],
    "draftTitle": "SEO 文章撰寫",
    "draftBrief": "老闆要產出 SEO 文章，內容尚需釐清主題與目標客群。",
    "finalizedTaskId": null,
    "finalizedAt": null,
    "createdAt": "...",
    "updatedAt": "..."
  },
  "reply": "了解，老闆要寫幾篇？目標客群是哪一塊？",
  "readyToFinalize": false,
  "missingInfo": ["數量", "目標客群"]
}
```

#### `POST /v1/intakes/:intakeId/messages`
接續對話一輪。state 必須是 `open`，否則 422。
```json
// Request
{
  "message": "一篇就好，目標客群 25-35 歲女性",
  "imageIds": ["uuid-from-uploads"]   // 可選；附圖給這一輪
}

// Response 200 — 同 POST /v1/intakes 的 shape
{ "intake": { ... }, "reply": "...", "readyToFinalize": true, "missingInfo": [] }
```

#### `POST /v1/intakes/:intakeId/finalize`
把 intake 收尾、spawn 一張真實的 task。**Idempotent** — 重打回傳同一張 task。
```json
// Request — body 全可選；不給就用 agent 維護的 draft
{
  "title": "夏季穿搭 SEO 文章",        // 可選 override
  "brief": "撰寫一篇 SEO 文章，主題...", // 可選 override
  "preferredAgent": "shopify-blog-writer" // 可選；給了 worker 直接 pin 這顆 agent
}

// Response 200
{
  "intake": {
    "id": "uuid",
    "status": "finalized",
    "finalizedTaskId": "task-uuid",
    "finalizedAt": "2026-05-01T...",
    ...
  },
  "task": {
    "id": "task-uuid",
    "status": "todo",
    "title": "夏季穿搭 SEO 文章",
    "description": "撰寫一篇 SEO 文章，主題...",
    "kind": "execution",
    "input": { "brief": "...", "intakeId": "intake-uuid" },
    ...
  }
}
```

**錯誤情境：**
| HTTP | code | 意思 |
|---|---|---|
| 422 | `illegal_state` | intake 已經是 `finalized` / `abandoned`；或 draft 還沒生出 title/brief |
| 404 | `not_found` | intakeId 不存在 / 不屬於該 tenant |

`task.input.intakeId` 會回填 intake id — 之後若想做「從 task 反查當初的對話脈絡」按鈕，這就是連結。

**圖片如何流進 task：** intake 對話裡所有 user message 的 `imageIds` 在 finalize 時會自動合併，寫進 spawned task 的第一條 message。worker 拿到任務時就能把圖片解析成 delivery URL 傳給 agent — 不需要在 `/finalize` 再傳一次。

#### `POST /v1/intakes/:intakeId/abandon`
丟掉對話。state 必須是 `open`，否則 422。回 200 + intake row（status='abandoned'）。

#### `GET /v1/intakes?status=`
列當前 tenant 的 intakes（最新更新在前）。`status` 可選 filter (`open` / `finalized` / `abandoned`)。

#### `GET /v1/intakes/:intakeId`
單一 intake 完整資訊（含整段 messages 陣列）。

---

### Tasks（看板的核心）

#### `GET /v1/tasks?status=&parentTaskId=`
列當前 tenant 所有任務（最新在前）。

> ⚠️ 目前還沒有分頁（已知 issue），會在資料量起來前補。

#### `GET /v1/tasks/:taskId`
單一任務完整資訊。狀態欄位：
| 欄位 | 意義 |
|---|---|
| `status` | `todo / in_progress / waiting / done / failed` |
| `kind` | `strategy`（會裂變出子任務）或 `execution`（單一可交付成果）。詳見「任務裂變」 |
| `output.artifact` | 任務當前階段的 markdown deliverable — 形狀 `{ report, body?, refs? }`（見「§5.1 三個介面」） |
| `output.pendingToolCall` / `output.spawnTasks` / `output.eeatPending` | HITL 控制欄位 — 不是 artifact，但前端要看這些決定要不要顯示 Approve / Spawn 按鈕 |
| `output.toolExecutedAt` / `output.spawnedAt` | 框架戳記，做 idempotency 用，前端可忽略 |
| `error` | 失敗原因 |
| `assignedAgent` | 上次跑的 agent id（execution 子任務在建立時就帶這個值）|
| `parentTaskId` | 若是裂變子任務，指向父任務 |
| `scheduledAt` / `completedAt` / 各 timestamp | ISO 8601 |

#### `GET /v1/tasks/:taskId/messages`
對話 thread（user 的 brief、agent 的回覆、user 的 feedback）。

#### `GET /v1/tasks/:taskId/logs?since=ISO`
原子 log 列表。每個 log 含 `event` (e.g. `agent.draft.ready`)、`message`、`data`。

#### `GET /v1/tasks/:taskId/stream`  ← **SSE**
單一任務即時 log。詳見下節。

#### `GET /v1/stream`  ← **SSE（tenant-wide）**
整個 tenant 所有任務的即時 log，合流在同一個 stream。每條事件多一個 `taskId` 欄位，讓前端知道這條 log 屬於哪張看板卡片。詳見下節。

#### `GET /v1/logs?since=&until=&limit=`
Tenant-wide 歷史 log **REST 查詢**（非 SSE）。適合初始載入或翻歷史。
```
?since=<ISO>    起點（exclusive）
?until=<ISO>    終點（inclusive）
?limit=<n>      最多幾筆，上限 1000，預設 500
```
每筆格式同 SSE `data` payload（多一個 `id` UUID 欄位）。

#### `GET /v1/stream/cursor`
回傳目前登入 user 在這個 tenant 的「已讀游標」：
```json
{ "cursor": "2026-05-03T10:00:00.000Z" }   // 或 null（第一次連線前）
```

#### `PUT /v1/stream/cursor`
前端主動打點「我讀到這裡了」。Body：
```json
{ "cursor": "2026-05-03T10:00:00.000Z" }   // ISO 8601，必填
```
→ 204 No Content。之後 `GET /v1/stream` 無 `?since` 時會從這個時間點 replay。

#### `POST /v1/tasks/:taskId/approve`
HITL 核准。
```json
// finalize:true → 任務結案，三種行為依 task 內容自動分流：
//   1. strategy task → 原子地建立所有 output.spawnTasks 列出的子任務（見「任務裂變」）
//   2. execution task 且 output.pendingToolCall 存在 → 框架幫你呼叫該 tool
//      （Shopify create_product 等寫入操作）, 結果寫到 output.toolResult, status='done'
//   3. execution task 純文字（沒 pendingToolCall） → 直接 status='done'
// finalize:false (預設) → 重新排回 worker（讓下一個 agent 跑或讓 supervisor 決定 done）
{ "finalize": true }
```
422 → 任務不在 `waiting` 狀態。

> 對 strategy 任務再次呼叫 finalize-approve **目前會 422**（done → done 是非法 transition）。
> 後端的 `finalizeStrategyTask` 本身有 idempotency 保護（不會重複建子任務），但 approve API
> 不會代你重試。Client 收到 200 後就把這個父任務當作已結案。

#### `POST /v1/tasks/:taskId/feedback`
HITL 修改要求。會 append 一條 user message 到對話 thread，task → todo，worker 會帶著新 feedback 再跑。
```json
{ "feedback": "標題改短一點，副標多 emoji" }
```

#### `POST /v1/tasks/:taskId/discard`
直接 fail 任務。`output` 保留，`error.message='Discarded by user'`。

---

### SSE (Server-Sent Events) — Log 即時跳動

兩個 SSE endpoint，協定完全相同，差別只在範圍：

| Endpoint | 範圍 | 用途 |
|---|---|---|
| `GET /v1/tasks/:taskId/stream` | 單一任務 | 任務 detail 頁的即時 log |
| `GET /v1/stream` | 整個 tenant 所有任務 | 看板首頁的即時活動 feed |

**Headers（兩個 endpoint 相同）：**
```
Authorization: Bearer <JWT>
x-tenant-id: <UUID>
Accept: text/event-stream
Last-Event-ID: <ISO timestamp>   ← 斷線重連時帶，server 從此時間點之後 replay
```

**Query string：**
- `?since=<ISO>` — 指定 replay 起點（覆蓋 cursor 與 `Last-Event-ID`）

**協定：**
- Connect 時先 replay 歷史 log，replay 起點依優先順序：
  1. `Last-Event-ID` header（斷線重連，瀏覽器 `EventSource` 自動帶）
  2. `?since=<ISO>` query string
  3. 該 user 的「已讀游標」（`PUT /v1/stream/cursor` 設定）
  4. 最近 24 小時（首次連線，尚無游標）
- **注意**：per-task stream（`/tasks/:taskId/stream`）無 cursor 機制，無 `?since` 時 replay 全部歷史（上限 500 筆）
- 之後即時推送新事件
- 每 15 秒一個 `: keep-alive` heartbeat 防 proxy 斷線

**已讀游標（`GET /v1/stream` 專屬）：**

「送到」≠「讀到」— server 不自動推進游標。前端在 user 實際看到一批 log 後，主動呼叫 `PUT /v1/stream/cursor` 打點。下次重開頁面 / 換裝置連線，server 從游標位置開始 replay，不會重送已讀內容。

要查看更早的歷史：不需要重開 SSE，改打 `GET /v1/logs?since=<older-time>` REST 查詢，兩者獨立。

**事件格式 — per-task stream：**
```
id: 2026-05-01T00:00:00.123Z
event: agent.draft.ready
data: {"event":"agent.draft.ready","message":"草稿完成","speaker":"shopify-blog-writer","at":"2026-05-01T00:00:00.123Z"}

```

**事件格式 — tenant-wide stream（多一個 `taskId`）：**
```
id: 2026-05-01T00:00:00.123Z
event: agent.draft.ready
data: {"taskId":"abc-123","event":"agent.draft.ready","message":"草稿完成","speaker":"shopify-blog-writer","at":"2026-05-01T00:00:00.123Z"}

```

**常見 event 類型：**
| event | 何時 |
|---|---|
| `task.started` | 任務進入 graph |
| `agent.started` | 某 agent 開始跑 |
| `agent.questions.asked` | Blog Writer Stage 1：EEAT 問題產生（artifact 為 `report`-only） |
| `agent.draft.ready` | Blog Writer Stage 2：草稿完成（artifact 帶 `report` + `body`） |
| `agent.plan.ready` | SEO 策略師 / 產品企劃師計畫完成（artifact 為 `report`-only） |
| `agent.content.ready` | 產品設計師文案 + 圖片完成（artifact 帶 `report` + `body`） |
| `tool.calling.<name>` | tool loop 呼叫某個 tool 前（e.g. `tool.calling.serper_search`） |
| `tool.result.<name>` | tool loop 收到結果後 |
| `task.waiting` | 進入 HITL gate |
| `task.completed` | done |
| `task.failed` | 失敗 |
| `tool.started` | 框架開始執行 pendingToolCall（HITL 通過後） |
| `tool.completed` | tool 成功，結果蓋章在 `task.output.artifact.refs.published` |
| `tool.failed` | tool 失敗，task 轉 failed |

**`agent.*.ready` 事件的 `data` 欄位會帶 `artifactShape`**（`'report'` 或 `'report+body'`），方便前端在不打 `GET /v1/tasks/:id` 的情況下先預測 artifact panel 的高度／佈局：
```js
// 收到 SSE 事件
{ event: 'agent.draft.ready', data: { artifactShape: 'report+body', title: '夏日穿搭...' }, ... }
```

**JS 範例 — 單一任務：**
```js
const res = await fetch(`${API_BASE}/v1/tasks/${taskId}/stream`, {
  headers: {
    Authorization: `Bearer ${jwt}`,
    'x-tenant-id': tenantId,
    Accept: 'text/event-stream',
  },
});
// 用 fetch + ReadableStream parse SSE（EventSource 不支援 custom headers）
const reader = res.body.getReader();
// ... TextDecoder + 解 "id:\nevent:\ndata:\n\n" 區塊
```

**JS 範例 — tenant-wide（看板首頁用）：**
```js
// 開連線 — server 自動從 cursor 或 24h 前 replay
const res = await fetch(`${API_BASE}/v1/stream`, {
  headers: {
    Authorization: `Bearer ${jwt}`,
    'x-tenant-id': tenantId,
    Accept: 'text/event-stream',
  },
});
const reader = res.body.getReader();
// data.taskId 告訴你這條 log 屬於哪張卡
// e.g. { taskId: 'abc-123', event: 'agent.plan.ready', message: '...', at: '...' }

// 當用戶滾動看完一批 log，打點已讀（e.g. 記錄最後一條的 at）
await fetch(`${API_BASE}/v1/stream/cursor`, {
  method: 'PUT',
  headers: { Authorization: `Bearer ${jwt}`, 'x-tenant-id': tenantId, 'Content-Type': 'application/json' },
  body: JSON.stringify({ cursor: lastSeenAt }),  // ISO 8601
});

// 要翻歷史（不重開 SSE）
const history = await fetch(
  `${API_BASE}/v1/logs?since=2026-05-01T00:00:00Z&limit=200`,
  { headers: { Authorization: `Bearer ${jwt}`, 'x-tenant-id': tenantId } },
).then(r => r.json());
```

---

## 6.v shopify-blog-writer 的三段式流程（EEAT → 草稿 → 發布）

當任務由 SEO 策略師派生，且 `task.input.research.eeatHook` 不為空時，
Blog Writer 會走**三段式流程**，否則走兩段式（直接草稿 → 發布）。

```
三段式（有 eeatHook）：
  worker 跑 → Stage 1: 產 EEAT 問題 → task waiting (output.eeatPending 已設)
  user POST /feedback 回答 → task todo
  worker 跑 → Stage 2: 寫稿 → task waiting (output.pendingToolCall 已設)
  user POST /approve(finalize:true) → 發 Shopify → task done

兩段式（直接任務、無 eeatHook）：
  worker 跑 → 寫稿 → task waiting (output.pendingToolCall 已設)
  user POST /approve(finalize:true) → 發 Shopify → task done
```

### Stage 1 output 形狀（EEAT 問題 — `report`-only artifact）

問題清單直接嵌在 `report` 的 markdown 裡（讓老闆可以一邊看「為什麼問」一邊看「問題」）。
真正的結構化清單在 `output.eeatPending`，runner 用它判斷 Stage 2 該不該觸發。

```json
{
  "id": "task-uuid",
  "status": "waiting",
  "assignedAgent": "shopify-blog-writer",
  "output": {
    "artifact": {
      "report": "## 為什麼需要老闆親身經驗\n\nGoogle 評估內容品質時，**第一手體驗（E-E-A-T 的 Experience）**是 2024 後最重要的訊號。競品都用通用形容詞（「透氣」「舒適」），所以只要老闆給具體數字／場景，文章可信度立刻拉開。\n\n## 兩個問題的用途\n\n- 第一題的洗滌數字 → 放在開頭引言，建立信任\n- 第二題的台北氣候體驗 → 放在「適合場景」段，解決讀者最在意的痛點\n\n## 我想請老闆回答\n\n1. **這件亞麻衣料洗了幾次開始起球？** _(具體數字比形容詞更有說服力)_\n2. _(可選)_ 台北夏天 35 度穿起來感覺如何？",
      "refs": { "askedAt": "2026-05-02T03:00:00Z" }
    },
    "eeatPending": {
      "questions": [
        { "question": "這件亞麻衣料洗了幾次開始起球？", "hint": "具體數字比形容詞更有說服力", "optional": false },
        { "question": "台北夏天 35 度穿起來感覺如何？", "optional": true }
      ],
      "askedAt": "2026-05-02T03:00:00Z"
    }
  }
}
```

UI 應該渲染：
- artifact panel：把 `artifact.report` 用 markdown 渲染就好（問題清單已嵌在裡面）
- 若需要 typed 的問題清單做表單（每題一個 input），讀 `output.eeatPending.questions`
- CTA：[回答問題 / 傳給 Writer] → `POST /feedback` 把老闆的回答傳入
- 不顯示 [Approve]（這個階段沒有 pendingToolCall）

老闆透過 `/feedback` 傳答案後，task 回到 `todo`，worker 再跑 Stage 2 寫稿。

---

## 6.w Pending Tool Call — 寫入型 agent 的兩段式 HITL

某些 agent 需要實際**寫**到外部系統（發部落格、上架商品、發貼文…）。這種 agent 跑完
LLM 後**不會**直接打 API；它會把「想呼叫的 tool + 參數」放到 `output.pendingToolCall`，
停在 `waiting` 等 user 按 Approve，框架才在 approve 路徑裡 deterministic 地把 tool 點燃。

目前帶 `pendingToolCall` 的 agent：
- `shopify-blog-writer` → `shopify.publish_article`（發部落格文章，**MVP 主流程**）
- `shopify-publisher` → `shopify.create_product`（上架商品；由 `product-designer` 產生的子任務呼叫）

### 範例：shopify-blog-writer 發部落格

#### `waiting` 狀態的 `output` 形狀

```json
{
  "id": "task-uuid",
  "kind": "execution",
  "status": "waiting",
  "assignedAgent": "shopify-blog-writer",
  "output": {
    "artifact": {
      "report": "## 寫作切角\n\n這篇我特別強調**機能性麻料適合台灣濕熱夏天**，因為 SERP 前 10 名都在講材質歷史，沒人講實際穿著體驗。\n\n## 結構亮點\n\n- 開頭直接放老闆親身分享的洗滌數字（10 次無起球）\n- 第 3 段插入比較表（亞麻 vs 棉 vs Tencel）\n- 結尾 CTA 引導到 listing 頁\n\n## 風險提醒\n\n字數 1500，比預期多 200 字，但因為加了表格與引用，閱讀體驗更好。",
      "body": "# 夏日穿搭 5 個必備單品\n\n## 選對材質讓夏天更舒服\n\n挑選夏季衣料時…\n\n| 材質 | 透氣度 | 易皺度 |\n|---|---|---|\n| 亞麻 | ★★★★★ | 高 |\n| 棉 | ★★★★ | 中 |\n| Tencel | ★★★ | 低 |\n\n…",
      "refs": {
        "title": "夏日穿搭 5 個必備單品",
        "summaryHtml": "5 個夏季必備單品挑選指南，含材質與搭配建議。",
        "tags": ["夏季穿搭", "女裝", "購物指南"],
        "language": "zh-TW",
        "author": "Editorial Team"
      }
    },
    "publishToShopify": true,
    "pendingToolCall": {
      "id": "shopify.publish_article",
      "args": {
        "title": "夏日穿搭 5 個必備單品",
        "bodyHtml": "<h2>選對材質讓夏天更舒服</h2>...",
        "summaryHtml": "5 個夏季必備單品挑選指南，含材質與搭配建議。",
        "tags": ["夏季穿搭", "女裝", "購物指南"],
        "author": "Editorial Team"
      }
    }
  }
}
```

> 注意：`pendingToolCall.args.bodyHtml` 是框架在 publish 階段把 `artifact.body`（markdown）
> 轉成 HTML 後丟進 Shopify 的版本，不是 artifact 上直接給的欄位。UI 渲染都用 `artifact.body`（markdown）。

UI 應該渲染：
- conversation：assistant 最新一句 progressNote（「草稿好了，老闆看一下…」）
- artifact panel：用 markdown 元件先渲染 `artifact.report`，下方再渲染 `artifact.body`（同一個 markdown 元件即可）
- 中間：「按 Approve 後會發到 Shopify 部落格 `<blogHandle 或第一個 blog>`，狀態 `<draft 或 published>`」
- CTA：[Approve & Publish] (`finalize:true`) / [Feedback]

#### `finalize:true` 之後

框架把 publish 結果蓋進 `artifact.refs.published`（artifact 形狀其餘不變）：

```json
{
  "artifact": {
    "report": "## 寫作切角\n…（同上）",
    "body": "# 夏日穿搭 5 個必備單品\n…（同上）",
    "refs": {
      "title": "夏日穿搭 5 個必備單品",
      "summaryHtml": "5 個夏季必備單品挑選指南…",
      "tags": ["夏季穿搭", "女裝", "購物指南"],
      "language": "zh-TW",
      "author": "Editorial Team",
      "published": {
        "articleId": 4242,
        "blogId": 200,
        "blogHandle": "editorial",
        "handle": "xia-ri-chuan-da-5-ge-bi-bei-dan-pin",
        "articleUrl": "https://demo-shop.myshopify.com/admin/articles/4242",
        "publishedAt": null,
        "status": "draft"
      }
    }
  },
  // pendingToolCall 被消化清空
  "toolExecutedAt": "2026-05-01T04:43:33.840Z"
}
```

UI 拿到 200 後可立刻顯示「已草稿到 Shopify，[去後台看](artifact.refs.published.articleUrl)」。
若 `refs.published.status='published'` 表示已對讀者公開。

#### shopify-blog-writer 啟用設定（`POST /v1/agents/shopify-blog-writer/activate` 的 config）

```json
{
  "config": {
    "targetLanguages": ["zh-TW", "en"],
    "brandTone": "professional, slightly playful",
    "preferredKeywords": ["女裝", "夏季"],

    "publishToShopify": true,            // 預設 true；false 則僅產草稿不發
    "blogHandle": "editorial",           // 不填→第一個 blog（多數店只有一個 "news"）
    "defaultAuthor": "Auto-Ops Bot",     // LLM 沒給 author 時用這個
    "publishImmediately": false,         // false→draft，true→直接 published 上線

    "skills": {
      "seoFundamentals": true,           // SEO 基本原則（預設 true）
      "eeat": true,                      // EEAT 體驗問答流程（預設 true）
      "aiSeo": false,                    // AI 搜尋平台最佳化（預設 false）
      "geo": false                       // GEO 內容結構原則（預設 false）
    }
  }
}
```

> shopify-blog-writer **必須**綁 Shopify credentials 才能 activate（即使 `publishToShopify=false`），
> 因為框架不知道 user 之後會不會切回 publish。Activation 時若沒 creds 會回 409。

### 範例：shopify-publisher 上架商品

`shopify-publisher` 是 `product-designer` 的執行子任務，**本身不呼叫 LLM**。它從 `task.input.params.content`（`ProductContent` 物件）讀商品資料，直接映射成 `shopify.create_product` 的參數。

#### `waiting` 狀態的 `output` 形狀

```json
{
  "id": "child-task-uuid",
  "kind": "execution",
  "status": "waiting",
  "assignedAgent": "shopify-publisher",
  "output": {
    "artifact": {
      "report": "## 設計重點\n\n從 designer 接手的商品，準備上架到 Shopify。\n\n## 生成的圖片\n\n![圖 1](https://assets.example.com/img-1.png)\n\n## 即將執行\n\n按 Approve 後會以 `draft` 狀態建立 product，不會直接公開。",
      "body": "# Linen Oversized Shirt\n\n輕薄亞麻，台灣夏天通勤首選。\n\n- 180g 不悶熱\n- 可機洗",
      "refs": {
        "title": "Linen Oversized Shirt",
        "tags": ["linen", "summer"],
        "vendor": "Acme",
        "language": "zh-TW",
        "imageUrls": ["https://assets.example.com/img-1.png"],
        "ready": true
      }
    },
    "pendingToolCall": {
      "id": "shopify.create_product",
      "args": {
        "title": "Linen Oversized Shirt",
        "bodyHtml": "<p>輕薄亞麻…</p>",
        "tags": ["linen", "summer"],
        "vendor": "Acme",
        "images": [{ "url": "https://assets.example.com/img-1.png" }]
      }
    }
  }
}
```

`finalize:true` approve 後，框架把上架結果蓋進 `artifact.refs.published`：

```json
"artifact": {
  "report": "## 設計重點…（同上）",
  "body": "# Linen Oversized Shirt…（同上）",
  "refs": {
    "title": "Linen Oversized Shirt",
    "tags": ["linen", "summer"],
    "vendor": "Acme",
    "language": "zh-TW",
    "imageUrls": ["https://assets.example.com/img-1.png"],
    "ready": true,
    "published": {
      "productId": 9876543210,
      "handle": "linen-oversized-shirt",
      "adminUrl": "https://demo-shop.myshopify.com/admin/products/9876543210",
      "status": "draft"
    }
  }
}
```

### Tool 失敗

Shopify 回 4xx/5xx → executor 捕捉 → 寫 `task.error.message`、status=`failed`，
`/approve` 也會回 5xx 給你（不是 200）。UI 應該：
- 顯示 task 的 error.message（會包含 Shopify 原始 error 訊息片段）
- 提供「重試」按鈕（roadmap：發 retry endpoint，暫時要 user 重派一張新卡）

常見失敗：
- `blogHandle "xxx" not found` → 該店沒有這個 blog handle，去 `/admin/blogs` 確認
- `Shopify API 401` → access token 失效或權限不足（要 read_/write_content scope）
- `Shopify API 422` → article 內容違反 Shopify 規則（極少見，title 太長之類）

### Idempotency

- 第二次呼叫 approve(finalize=true)：executor 看到 `output.toolExecutedAt` 已戳就直接回現狀 task，**不會重複呼叫 Shopify**
- 但若第一次呼叫已轉成 `done`，state machine 會擋下 done → done 的 transition；這時 approve 會回 422（safe to ignore on UI side — 已成功）

---

## 6.y product-planner → product-designer → shopify-publisher 商品上架流程

### 概念

商品上架拆成三個角色：

| Agent | 種類 | LLM | 職責 |
|---|---|---|---|
| `product-planner` | strategy | ✓ | 看商品 brief → 搜尋競品 SERP → 規劃 N 個 content variants（不同平台 / 語言 / 受眾切角） → 交由人審 → spawn designer 子任務 |
| `product-designer` | execution → strategy | ✓ | 收 variant spec → tool loop 生圖 → 寫 HTML 文案 → 交由人審 → spawn publisher 子任務 |
| `shopify-publisher` | execution | ✗ | 讀 `task.input.params.content` → 直接映射 `shopify.create_product` 參數 → HITL 等核准 |

**啟用順序：** 三個 agent 必須對同一個 tenant 同時啟用。`shopify-publisher` 需要先綁 Shopify credential。

```
PUT  /v1/credentials/shopify              { secret, metadata: { storeUrl } }
POST /v1/agents/product-planner/activate  { config: { defaultLanguages, maxVariants } }
POST /v1/agents/product-designer/activate { config: { defaultLanguage, defaultVendor } }
POST /v1/agents/shopify-publisher/activate { config: { shopify: { autoPublish: false } } }
```

### 完整流程

```
user POST /v1/tasks { brief: "上架這件亞麻衫，做電商版跟 Instagram 版" }
   ↓ worker 撿走 → supervisor 路由 → product-planner
   ↓ Pass 1: serper_search 研究競品切角（若有 SERPER_API_KEY）
   ↓ Pass 2: 規劃 2 個 variants（shopify 版 + instagram 版）
   → 父任務 status='waiting', kind='strategy'
     output.spawnTasks = [
       { assignedAgent: 'product-designer', input: { variantSpec: { platform:'shopify', ... }, originalImageIds: [] } },
       { assignedAgent: 'product-designer', input: { variantSpec: { platform:'instagram', ... }, originalImageIds: [] } }
     ]

user POST /v1/tasks/:plannerTaskId/approve { finalize: true }
   ↓ 框架原子建出 2 張 product-designer 子任務（status='todo'）
   → 父任務 status='done'

worker 撿走 designer 子任務（pinnedAgent='product-designer'）
   ↓ Pass 1: tool loop 生圖（images.generate / images.edit）
   ↓ Pass 2: LLM 產 title / bodyHtml / tags / vendor
   → designer 子任務 status='waiting', kind='strategy'（因回傳 spawnTasks）
     output.spawnTasks = [{ assignedAgent: 'shopify-publisher', input: { content: {...} } }]

user POST /v1/tasks/:designerTaskId/approve { finalize: true }
   ↓ 框架原子建出 shopify-publisher 孫任務（status='todo'）
   → designer 子任務 status='done'

worker 撿走 publisher 孫任務（pinnedAgent='shopify-publisher'）
   ↓ shopify-publisher 讀 task.input.params.content，映射 pendingToolCall
   → 孫任務 status='waiting'
     output.pendingToolCall = { id: 'shopify.create_product', args: {...} }

user POST /v1/tasks/:pubTaskId/approve { finalize: true }
   ↓ 框架呼叫 shopify.create_product → 寫入 output.toolResult
   → 孫任務 status='done'
```

### product-planner 父任務的 `output` 形狀（waiting 時）

`product-planner` 是純規劃 agent — artifact 只有 `report`（含 variants 列表），沒有 `body`。
真正要 spawn 的子任務在 `output.spawnTasks`。

```json
{
  "id": "planner-uuid",
  "kind": "strategy",
  "status": "waiting",
  "assignedAgent": "product-planner",
  "output": {
    "artifact": {
      "report": "## 規劃摘要\n\n做了 2 個版本互補：\n\n- **Shopify 電商版**：主打通勤族痛點（台灣濕熱、機能透氣）\n- **Instagram 版**：主打週末風格、視覺感更強\n\n## 競品研究發現\n\nSERP 上前 10 名都缺少**台灣在地穿著體驗**的描述，這是我們的差異化切角。\n\n## 規劃的 variants\n\n### 1. 亞麻短袖 - 電商版 (zh-TW, shopify)\n- **切角**：機能透氣，台灣濕熱夏天通勤族\n- **賣點**：180g 亞麻不悶熱、可機洗\n- **要生的圖**：hero shot（白底）— required\n\n### 2. 亞麻短袖 - IG 版 (zh-TW, instagram)\n- **切角**：週末風格…\n…"
    },
    "spawnTasks": [
      {
        "title": "亞麻短袖 - 電商版 (zh-TW)",
        "assignedAgent": "product-designer",
        "input": {
          "variantSpec": {
            "platform": "shopify",
            "language": "zh-TW",
            "marketingAngle": "機能透氣，台灣濕熱夏天通勤族",
            "keyMessages": ["180g 亞麻不悶熱", "可機洗"],
            "copyBrief": { "tone": "warm, professional", "featuresToHighlight": ["fabric weight"], "forbiddenClaims": [] },
            "imagePlan": [
              { "purpose": "hero shot", "styleHint": "clean white background", "priority": "required" }
            ]
          },
          "originalImageIds": []
        }
      },
      { "title": "亞麻短袖 - IG 版 (zh-TW)", "assignedAgent": "product-designer", "input": { "...": "..." } }
    ]
  }
}
```

UI 應該渲染：
- artifact panel：用 markdown 元件渲染 `artifact.report`（規劃匯報＋variants 概觀）
- 下方提示：「即將建立 N 張設計師子卡」清單（從 `output.spawnTasks` 拿 title / assignedAgent）
- CTA：[Approve & Spawn] (`finalize:true`) / [Feedback]（要求調整規劃）

### product-designer 子任務的 `output` 形狀（waiting 時）

Designer 同時產出 `report`（含內嵌圖片）+ `body`（商品描述 markdown），refs 帶圖片 URL 與 metadata。

```json
{
  "id": "designer-uuid",
  "kind": "strategy",
  "status": "waiting",
  "assignedAgent": "product-designer",
  "output": {
    "artifact": {
      "report": "## 文案切角\n\nvariantSpec 是 shopify 電商版（zh-TW），主打**通勤族**。我把切角放在「機能透氣」+ 「台灣濕熱通勤體驗」，跟競品的單純材質介紹做區隔。\n\n## 圖片配置\n\n生了 3 張：hero（白底）、lifestyle（捷運場景）、detail（質地特寫）。比 imagePlan 多生一張 detail 圖，因為這個材質感是賣點。\n\n## 待確認\n\n- 「180g 不悶熱」這個數據是 brief 給的，需老闆確認準確性\n\n## 生成的圖片\n\n![圖 1](https://assets.example.com/img-1.png)\n\n![圖 2](https://assets.example.com/img-2.png)\n\n![圖 3](https://assets.example.com/img-3.png)",
      "body": "# Linen Oversized Shirt\n\n輕薄亞麻，台灣夏天通勤首選。\n\n- 180g 不悶熱\n- 可機洗\n- 適合 28–35°C 通勤穿著",
      "refs": {
        "title": "Linen Oversized Shirt",
        "tags": ["linen", "summer", "taiwan"],
        "vendor": "Acme",
        "language": "zh-TW",
        "imageUrls": [
          "https://assets.example.com/img-1.png",
          "https://assets.example.com/img-2.png",
          "https://assets.example.com/img-3.png"
        ]
      }
    },
    "spawnTasks": [
      {
        "title": "Linen Oversized Shirt → Shopify 商品發布員",
        "assignedAgent": "shopify-publisher",
        "input": { "content": { /* ProductContent — 內含 progressNote、傳給 publisher */ } }
      }
    ]
  }
}
```

UI 應該渲染：
- artifact panel：先 markdown 渲染 `artifact.report`（圖片自動顯示，因為是 `![](url)` 嵌在 markdown 裡），再渲染 `artifact.body`（商品描述）
- 旁邊小面板：`refs.title` / `refs.vendor` / `refs.tags` / `refs.imageUrls` 縮圖列
- 「即將建立 1 張子卡：shopify-publisher」
- CTA：[Approve & Spawn] (`finalize:true`) / [Feedback]（要求修改文案或重生圖）

**Feedback 重生圖：** 用戶說「背景換成木紋」→ POST /feedback → designer 重跑 → LLM 呼叫 `images.edit`（以前一輪的圖片 URL 為 source）→ 新圖取代舊圖。若 feedback 只改文案、不提圖片，LLM 不呼叫任何 image tool，舊圖自動保留。

### product-planner 啟用設定

```json
{
  "config": {
    "maxVariants": 5,                    // 最多幾個 variant，預設 5
    "defaultLanguages": ["zh-TW"],       // 預設語言，brief 沒指定時用
    "brandTone": "warm, professional",   // 選填；傳給設計師的品牌語調
    "preferredKeywords": [],             // 選填；優先納入的 keyword cluster
    "useSerperSearch": true,             // true → 搜尋競品 SERP 後再規劃
    "skills": {
      "seoFundamentals": true,
      "productPositioning": true,        // USP 挖掘 + 受眾分群框架
      "ecommerceMarketing": true         // 電商內容切角 + 轉換文案原則
    }
  }
}
```

### product-designer 啟用設定

```json
{
  "config": {
    "defaultLanguage": "zh-TW",
    "defaultVendor": "Acme",             // 選填；brief 沒提到廠商時用
    "skills": {
      "productPhotography": true,        // 商品攝影構圖原則（ratio、組圖邏輯）
      "socialMediaImages": true          // 各平台圖片規格（1:1、4:5、9:16 等）
    }
  }
}
```

> 圖片生成需要同時設定 Cloudflare R2（`CLOUDFLARE_*` env）+ OpenAI key（`OPENAI_API_KEY`）。
> 若 env 缺一，Pass 1 工具為空，designer 跳過生圖直接寫文案。

---

## 6.x 任務裂變 (Task Spawning) — Strategy → Execution

### 概念

兩種任務 `kind`，狀態機完全相同，UI 渲染要分開：

| kind | 誰建的 | 例子 | 結束時 |
|---|---|---|---|
| `strategy` | user 透過 `POST /v1/tasks` 派一個「規劃型」brief，supervisor 路由到 strategist agent | 「規劃夏季女裝 SEO」「規劃這 20 個 SKU 的上架排程」 | `finalize=true` 的 approve **會原子地建出 N 個子任務** |
| `execution` | strategy 父任務 finalize 時自動建出，或 user 直接派一個明確 brief | 「寫這一篇 SEO 文章」「上架這個商品」 | 一般 done |

> **kind 是動態的**：`POST /v1/tasks` 預設建 `kind: 'execution'`。當 worker 跑完發現
> agent 回傳了 `spawnTasks`，runner 會把任務升級為 `kind: 'strategy'`。所以 UI 不能
> 在 task 剛建立時就決定渲染樣式，要在 status 變 `waiting` 後再讀 `kind`。

### Strategy 任務的 `output` 形狀

當 strategy 任務進入 `waiting`（「計畫好了，等你核准」）時：
```json
{
  "id": "parent-uuid",
  "kind": "strategy",
  "status": "waiting",
  "output": {
    "artifact": {
      "report": "## 規劃摘要\n\n規劃了 3 篇夏季 SEO 文章，主軸是把材質知識和台灣濕熱氣候結合。\n\n## 三篇定位\n\n1. **夏季穿搭 5 個必備單品**（zh-TW，commercial）— 主賣 listing；目標字數 1200\n2. **永續夏季布料指南**（en，informational）— 建立權威\n3. **亞麻保養 FAQ**（zh-TW，long-tail）— 導流到 #1\n\n## 競品缺口\n\nSERP 前 10 名都沒有針對**台灣濕熱氣候**的具體建議，這是我們的差異化切角。我特別在 topic #1 加了 EEAT hook 請老闆分享親身洗滌與穿著體驗。"
    },
    "spawnTasks": [
      {
        "title": "夏季穿搭 5 個必備單品",
        "assignedAgent": "shopify-blog-writer",
        "input": {
          "brief": "...",
          "primaryKeyword": "夏季穿搭",
          "language": "zh-TW",
          "research": {
            "searchIntent": "commercial",
            "paaQuestions": ["Is linen good for summer?", "..."],
            "relatedSearches": ["linen vs cotton", "..."],
            "competitorTopAngles": ["fabric guides"],
            "competitorGaps": ["no Taiwan humidity specifics"],
            "targetWordCount": 1200,
            "eeatHook": "老闆分享亞麻在台灣濕熱夏天的親身洗滌與穿著體驗"
          }
        }
      },
      { "title": "Sustainable summer fabrics buyer guide", "assignedAgent": "shopify-blog-writer", "..." : "..." }
    ]
  }
}
```

> seo-strategist 是純規劃 agent，artifact 只有 `report`（沒有 `body`、沒有 `refs`）。
> 結構化 topic 資料（writerBrief、PAA、competitorGaps 等）在 `output.spawnTasks[*].input.research`，
> approve 後會原樣複製到子任務。

UI 應該渲染：
- conversation：assistant 最新一句 progressNote（「規劃了 3 篇主軸是…」）
- artifact panel：用 markdown 元件渲染 `artifact.report`（已內含三篇定位 + 競品缺口分析）
- 下方提示：「即將建立 N 張子卡」清單（從 `output.spawnTasks` 拿 title / assignedAgent）
- CTA：[Approve & Spawn] (`finalize:true`) / [Feedback]（要求調整計畫）

### `finalize=true` 之後

- 父任務 `status='done'`
- `output.spawnedAt` / `output.spawnedTaskIds` 被寫入（idempotency 用）
- N 個子任務被建出，`parent_task_id` 指向父，`kind='execution'`，`assignedAgent` 已綁定，`status='todo'`

UI 拿到 200 回應後立刻刷新 task 列表（或 SSE/polling），就會看到子任務出現。

### 子任務的執行

每張子卡：
- worker 撿走 → 跑 graph → supervisor 看見 `pinnedAgent`（從 `task.assignedAgent` 來）→ **跳過 LLM 路由直接呼叫該 agent**
- agent 跑完同樣會 `awaitingApproval=true` → 子卡進 `waiting` → user 各自 approve/feedback

換句話說每張子卡都是完整獨立的 HITL 流程，UI 不需特別處理「父子關係」就能 work，只是在
列表上分組顯示更直覺。

### 看板渲染建議

```
┌─ 父卡 (kind: strategy) ─────────────────────────────────┐
│  📋 規劃夏季女裝 SEO     status: done                    │
│  Plan: 2 篇文章                                          │
│   └─ 子卡 #1  夏季穿搭 5 個必備單品   status: waiting   │
│   └─ 子卡 #2  Sustainable summer …    status: in_progress│
└──────────────────────────────────────────────────────────┘
```

要列出某父任務的所有子任務：`GET /v1/tasks?parentTaskId=<父uuid>`
要列出所有「頂層任務」（沒有父）：`GET /v1/tasks?parentTaskId=null` *(查詢字串現用 `null` 字串還沒支援，目前先過濾 client-side)*

---

## 7. Error 格式

**所有錯誤都是統一的 envelope：**
```json
{
  "error": {
    "code": "validation_error",
    "message": "Request validation failed",
    "statusCode": 400,
    "details": { "fieldErrors": { "brief": ["brief is required"] } }
  }
}
```

**Code 對應：**
| HTTP | code | 何時 |
|---|---|---|
| 400 | `validation_error` | Zod 驗證失敗（`details` 有 fieldErrors） |
| 401 | `unauthorized` | JWT 缺 / 壞 / 過期 |
| 403 | `forbidden` | 不是 tenant 成員、plan 不夠 |
| 404 | `not_found` | resource 不存在或不屬於該 tenant |
| 409 | `conflict` | slug 重複、creds 缺 |
| 422 | `illegal_state` | task 狀態不對（如 approve 一個 done 的 task） |
| 502 | `external_<service>_error` | Shopify / OpenRouter / Cloudflare 失敗 |
| 500 | `internal_error` | 兜底，不會洩漏 stack |

---

## 8. TypeScript Types（自動產 client 用）

最快路徑：
```bash
pnpm dlx openapi-typescript http://127.0.0.1:8080/docs/json -o src/api-types.ts
```

或手動定義關鍵 type（隨 API 演進更新）：
```ts
type TaskStatus = 'todo' | 'in_progress' | 'waiting' | 'done' | 'failed';

type TaskKind = 'strategy' | 'execution';

interface Task {
  id: string;
  status: TaskStatus;
  kind: TaskKind;
  title: string;
  description: string | null;
  output: Record<string, unknown> | null;
  error: { message: string; stack?: string } | null;
  assignedAgent: string | null;
  parentTaskId: string | null;
  scheduledAt: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  // ...
}

/**
 * EEAT two-stage gate — set on `output.eeatPending` when shopify-blog-writer
 * has asked experience questions and is waiting for the boss to reply via /feedback.
 * Once the boss replies, `eeatPending` stays in output (historical record) but
 * Stage 2 runs and `output.pendingToolCall` gets set instead.
 */
interface EeatPending {
  questions: {
    question: string;
    hint?: string;
    optional?: boolean;
  }[];
  askedAt: string;  // ISO 8601
}

/** Strategy task output shape — `output.spawnTasks` is what will be spawned on finalize. */
interface SpawnTaskRequest {
  title: string;
  description?: string;
  assignedAgent: string;
  input: Record<string, unknown>;  // includes `research: TopicResearch` when from SEO 策略師
  scheduledAt?: string;
}

/** SERP research block forwarded from SEO 策略師 into writer task input. */
interface TopicResearch {
  searchIntent: 'informational' | 'commercial' | 'transactional' | 'navigational';
  paaQuestions: string[];
  relatedSearches: string[];
  competitorTopAngles: string[];
  competitorGaps: string[];
  targetWordCount: number;
  eeatHook: string;  // non-empty string triggers Blog Writer EEAT Stage 1
}

/** Write-tool gate — `output.pendingToolCall` is fired by the framework on finalize. */
interface PendingToolCall {
  id: string;                          // e.g. 'shopify.create_product'
  args: Record<string, unknown>;       // matches the tool's input schema
}

/**
 * Artifact — markdown-first deliverable on task.output.artifact.
 * Same shape across all agents; UI does NOT dispatch on a kind. See §5.1.
 */
interface Artifact {
  /** Markdown narrative — the canonical surface humans + downstream agents read.
   *  Render with a markdown component (e.g. <ReactMarkdown>). */
  report: string;
  /** Optional markdown deliverable (article body, product description). Only
   *  content-producing agents emit this. Render with the same markdown
   *  component beneath `report`. */
  body?: string;
  /** Free-form structured contract — IDs, URLs, scheduling, publish stamps.
   *  Producer-defined; UI shows it as a small details panel. After publishing,
   *  `refs.published` is stamped (e.g., `{ articleId, articleUrl, status }`). */
  refs?: Record<string, unknown>;
}

/** Optional helper types for `refs.published` — the framework stamps one of
 *  these onto `artifact.refs.published` after the publish tool runs.
 *  These are loose contracts; UI should treat `refs.published` as untyped
 *  unless it knows which publish tool ran. */
interface BlogPublishedMeta {
  articleId: number;
  blogId: number;
  blogHandle: string;
  handle: string;
  articleUrl: string;
  publishedAt: string | null;
  status: 'published' | 'draft';
}

interface ProductPublishedMeta {
  productId: number;
  handle: string;
  adminUrl: string;
  status: 'active' | 'draft';
}

type IntakeStatus = 'open' | 'finalized' | 'abandoned';

interface IntakeMessage {
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

interface Intake {
  id: string;
  status: IntakeStatus;
  messages: IntakeMessage[];
  draftTitle: string | null;
  draftBrief: string | null;
  finalizedTaskId: string | null;
  finalizedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What POST /v1/intakes and /v1/intakes/:id/messages return. */
interface IntakeTurnResult {
  intake: Intake;
  reply: string;
  readyToFinalize: boolean;
  missingInfo: string[];
}

interface AgentStatus {
  id: string;
  name: string;
  description: string;
  toolIds: string[];
  requiredCredentials: { provider: string; description: string; setupUrl?: string; bound: boolean }[];
  configSchema: Record<string, unknown> | null;  // JSON Schema
  enabled: boolean;
  ready: boolean;
  config: Record<string, unknown>;
}
```

---

## 9. UI 端開發注意事項

1. **ConfigSchema 是 JSON Schema** — 用任何 JSON-Schema-driven form lib（react-jsonschema-form、formily、@autoform/react 等）就能自動渲染啟用表單。
2. **Optimistic update for status changes** — `/approve` 等回應夠快，不一定要顯示 loading；但 task 後續變化（worker 跑 → waiting）不是同步的，必須 polling 或 SSE。
3. **Idempotency** — 同一個 brief 連按兩次「派任務」會建兩個 task。client side debounce + 顯示「處理中」。後端 idempotency keys 在 roadmap。
4. **Long-poll vs SSE** — 看板列表頁用 polling（5–10s），任務 detail 頁用 SSE。
5. **Token refresh** — Supabase JWT 過期 supabase-js 會幫你 refresh；但記得 refresh 完更新 fetch 的 token cache。
6. **`requiredCredentials.setupUrl`** — 顯示成「[如何取得?]」連結，跳新分頁。
7. **每個 agent 的 model 是 fixed**（在 code 裡決定，不開放 user 選），所以 UI 不該有 model picker。

---

## 10. 已知限制（roadmap 內，可能影響你做 UI 的決策）

| 缺什麼 | 影響 |
|---|---|
| 沒分頁 | tasks list 暫時就回所有 |
| 沒 webhook | 後端任務狀態變化沒法主動通知 UI；只能 SSE / polling |
| credentials 明文存 DB | 顯示 secret 預覽（明碼）的 UI 別做，未來會改加密 |
| 沒 rate limit | 任意 client 短時間內可灌 N 次 POST /v1/tasks；UI 自己擋 |
| 沒 RLS 兜底 | 不影響 UI；純粹是後端安全防線 |
| `parentTaskId=null` query 還沒解析 | 列「頂層任務」目前要 client-side filter `parentTaskId === null` |
| shopify-blog-writer 文章無附圖 | 文章本身不夾圖；`product-designer` 支援圖片生成（需 R2 + OpenAI env），blog writer 尚未接 |
| shopify-blog-writer 必綁 Shopify creds | 即使打算只用 `publishToShopify=false` 純草稿，activate 仍要 creds；roadmap 改為動態 required |
| product-planner / product-designer 需同時啟用 | `product-planner` 需要 `product-designer` 存在；`product-designer` 需要至少一個 `kind=publisher` agent。若缺少，worker 跑到 invoke 時會 throw |

---

## 11. 開發伺服器啟動（後端同學給你跑時的 cheat sheet）

```bash
# 1. 起 Supabase local
supabase start

# 2. 跑 migration（建表）
pnpm db:migrate

# 3. 在 .env 填好 OPENROUTER_API_KEY（沒填 LLM 會 503）

# 4. 起 API
pnpm dev          # → http://127.0.0.1:8080
                  # → http://127.0.0.1:8080/docs (Swagger)
                  # → http://127.0.0.1:54323 (Supabase Studio)
```

---

## 12. 有問題找誰

- 規格疑問 → 先看 `requirements.md`，再問
- API 怪 → 看 `http://127.0.0.1:8080/docs/json` 才是真相，這份是輔助
- bug → 在 repo 開 issue，附 `reqId`（每個 response header 都有）
