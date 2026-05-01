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
2. 拿到 Supabase 簽的 **JWT (HS256)**
3. 對 auto-ops API 的所有 `/v1/*` 請求都帶：

```
Authorization: Bearer <SUPABASE_JWT>
```

JWT 必須含 `sub`（user UUID）和 `email`，否則 401。

**第一次 auth 自動建 `users` row** — 不用呼叫任何 provisioning 端點。

### Local dev：拿 JWT 的最快方式

兩種：

**(a) Supabase Studio (http://127.0.0.1:54323)**
- 左欄 Authentication → 建一個用戶 → 拿 access token

**(b) 直接呼叫 GoTrue**
```bash
curl -X POST 'http://127.0.0.1:54321/auth/v1/signup' \
  -H 'apikey: <ANON_KEY>' \
  -H 'Content-Type: application/json' \
  -d '{"email":"u@example.com","password":"password123"}'
# → 回 access_token
```
（`<ANON_KEY>` 在 `.env` 的 `SUPABASE_ANON_KEY`）

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

[列可聘員工]                    GET /v1/agents      回 [seo-expert, shopify-ops, ...]
  顯示卡片：                                        每個含 ready / credentials
  - ✓ SEO Expert (ready)                            checklist / configSchema
  - ✗ Shopify Ops (need creds)
                                                    ↓ 老闆點 SEO Expert

[啟用 SEO Expert]               POST /v1/agents/    回 { enabled:true, config }
  渲染 configSchema 表單           seo-expert/
  (targetLanguages, brandTone…)    activate
                                                    ↓

[首頁有「對話框」可派任務]      POST /v1/conversations  回 task (status:'todo')
  user 輸入：「幫我寫一篇        {brief, params?}        ↓ 拿 task.id
   夏季女裝的 SEO 文章」

[Kanban 顯示卡片進 In Progress]  GET /v1/tasks/:id     polling 或 SSE 看更新
[Log 即時跳動]                   /stream  (SSE)         接收 agent.draft.ready 等

[卡片變 Waiting，顯示草稿]       GET /v1/tasks/:id     status='waiting', output 有 draft
  user 點 [Approve]              POST /v1/tasks/:id/   回 task (status:'done')
                                  approve {finalize:true}

  user 點 [Feedback]             POST /v1/tasks/:id/   回 task (status:'todo')
   輸入「語氣再活潑」              feedback {feedback}    ↓ worker 重跑
```

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
    "id": "seo-expert",
    "name": "AI SEO Expert",
    "description": "Researches keywords and writes multilingual SEO content.",
    "availableInPlans": ["basic", "pro", "flagship"],
    "defaultModel": { "model": "anthropic/claude-opus-4.7", "temperature": 0.4 },
    "toolIds": [],
    "requiredCredentials": [],
    "configSchema": { /* JSON Schema for the activation form */ },
    "enabled": false,
    "ready": true,
    "planAllowed": true,
    "credentials": [],
    "config": {}
  },
  {
    "id": "shopify-ops",
    "toolIds": ["shopify.create_product", "shopify.update_product"],
    "requiredCredentials": [
      {
        "provider": "shopify",
        "description": "Shopify Admin API token + store URL — needed to create products",
        "setupUrl": "https://help.shopify.com/...",
        "bound": false
      }
    ],
    "configSchema": { /* ... */ },
    "ready": false,  ← creds 未綁所以 false
    "credentials": [{"provider":"shopify","bound":false,"description":"..."}]
  }
]
```

#### `GET /v1/agents/:agentId`
單一 agent，內容同上但加上 `promptOverride` / `toolWhitelist`（pro 用戶可調）。

#### `POST /v1/agents/:agentId/activate`
驗證 plan + creds 都備好 + config 通過 manifest.configSchema → 啟用。
```json
// Request
{
  "config": {
    "shopify": { "defaultVendor": "Acme", "autoPublish": false },
    "defaultLanguage": "zh-TW"
  },
  "promptOverride": null,        // 可選
  "toolWhitelist": null          // 可選；填了會限制 agent 只能用列表內的 tool
}

// Response 200
{ "enabled": true, "config": { /* validated, with defaults applied */ } }
```

**錯誤情境：**
| HTTP | code | 意思 |
|---|---|---|
| 400 | `validation_error` | config 不通過 Zod schema → `details.fieldErrors` 有具體欄位 |
| 403 | `forbidden` | tenant plan 不含此 agent（plan upgrade 推銷時機） |
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

### Conversations（派任務的入口）

#### `POST /v1/conversations`
這是 user 在「對話框」打字按 send 時呼叫的端點。
```json
// Request
{
  "brief": "幫我規劃夏季女裝的 SEO 並發布",
  "preferredAgent": "seo-expert",                 // 可選；不給就讓 Supervisor 路由
  "params": { "language": "zh-TW" },              // 可選；任意 KV 給 agent 參考
  "scheduledAt": "2026-05-02T08:00:00Z"           // 可選；未來時間 → 排程
}

// Response 201 — task 物件
{
  "id": "uuid",
  "status": "todo",
  "title": "幫我規劃夏季女裝的 SEO 並發布",
  ...
}
```

**之後：**
- worker（後端）會在 `WORKER_POLL_INTERVAL_MS`（dev=2s）內撿走
- 跑完一輪後 status → `waiting` 或 `done`
- UI 用 `GET /v1/tasks/:id` polling 或 `/v1/tasks/:id/stream` SSE

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
| `output` | 任務最後輸出（agent 的 draft、shopify 上架結果等） |
| `error` | 失敗原因 |
| `assignedAgent` | 上次跑的 agent id |
| `parentTaskId` | 若是裂變子任務 |
| `scheduledAt` / `completedAt` / 各 timestamp | ISO 8601 |

#### `GET /v1/tasks/:taskId/messages`
對話 thread（user 的 brief、agent 的回覆、user 的 feedback）。

#### `GET /v1/tasks/:taskId/logs?since=ISO`
原子 log 列表。每個 log 含 `event` (e.g. `agent.draft.ready`)、`message`、`data`。

#### `GET /v1/tasks/:taskId/stream`  ← **SSE**
即時 log。詳見下節。

#### `POST /v1/tasks/:taskId/approve`
HITL 核准。
```json
// finalize:true → 任務直接結案 (status='done')
// finalize:false (預設) → 重新排回 worker（讓下一個 agent 跑或讓 supervisor 決定 done）
{ "finalize": true }
```
422 → 任務不在 `waiting` 狀態。

#### `POST /v1/tasks/:taskId/feedback`
HITL 修改要求。會 append 一條 user message 到對話 thread，task → todo，worker 會帶著新 feedback 再跑。
```json
{ "feedback": "標題改短一點，副標多 emoji" }
```

#### `POST /v1/tasks/:taskId/discard`
直接 fail 任務。`output` 保留，`error.message='Discarded by user'`。

---

### SSE (Server-Sent Events) — Log 即時跳動

**Endpoint:** `GET /v1/tasks/:taskId/stream`
**Headers:**
```
Authorization: Bearer <JWT>
x-tenant-id: <UUID>
Accept: text/event-stream
Last-Event-ID: <ISO timestamp>   ← 重連時帶，server 從此時間點之後 replay
```

**協定：**
- Connect 時先 replay 該 task 從 `?since=ISO`（或 `Last-Event-ID`）以後的歷史 log
- 之後即時推送
- 每 15 秒一個 `: keep-alive` heartbeat 防 proxy 斷線

**事件格式：**
```
id: 2026-05-01T00:00:00.123Z
event: agent.draft.ready
data: {"event":"agent.draft.ready","message":"SEO draft ready, awaiting approval","data":{"length":1234},"at":"2026-05-01T00:00:00.123Z"}

```

**常見 event 類型：**
| event | 何時 |
|---|---|
| `task.started` | 任務進入 graph |
| `agent.started` | 某 agent 開始跑 |
| `agent.draft.ready` | SEO draft 完成 |
| `agent.listing.ready` | Shopify listing 草稿完成 |
| `task.waiting` | 進入 HITL gate |
| `task.completed` | done |
| `task.failed` | 失敗 |
| `tool.shopify.create_product` | (未來) tool 被呼叫 |

**JS 範例：**
```js
const url = new URL('/v1/tasks/abc/stream', API_BASE);
// EventSource 不支援 custom headers，所以 token 走 query
// 或用 fetch + ReadableStream 自己 parse SSE。實務上推薦後者：
const res = await fetch(url, {
  headers: {
    Authorization: `Bearer ${jwt}`,
    'x-tenant-id': tenantId,
    Accept: 'text/event-stream',
  },
});
const reader = res.body.getReader();
// ... 用 TextDecoder + 解 "id:\nevent:\ndata:\n\n" 區塊
```

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

interface Task {
  id: string;
  status: TaskStatus;
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

interface AgentStatus {
  id: string;
  name: string;
  description: string;
  toolIds: string[];
  requiredCredentials: { provider: string; description: string; setupUrl?: string; bound: boolean }[];
  configSchema: Record<string, unknown> | null;  // JSON Schema
  enabled: boolean;
  ready: boolean;
  planAllowed: boolean;
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
| 沒 rate limit | 任意 client 短時間內可灌 N 次 /conversations；UI 自己擋 |
| 沒 task 裂變 helper | 「策略型任務 → 10 篇執行任務」這個流程後端還沒做完，UI 暫時只有單任務 |
| 沒 RLS 兜底 | 不影響 UI；純粹是後端安全防線 |

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
