這是一份為我們這個「AI 電商自動營運系統」量身打造的產品與技術規格書（PRD & Tech Spec）。這份文件將作為開發第一階段（MVP）的最高指導原則。

---

# 📄 產品與技術規格書 (PRD & Tech Spec)
**產品名稱：** 暫定 (AI 電商數位員工平台 - Shopify 首發版)
**產品定位：** 專為電商老闆打造的「AI 數位員工團隊」，透過多智能體協作與看板系統，實現多語系圖文生成、SEO 營運與自動化上架。

---

## 壹、功能規格 (Functional Specifications)

### 1. 多租戶與代理人配置模組 (Multi-tenancy & Configuration)
* **多租戶架構：** 系統支援多商家註冊，資料絕對隔離。
* **金鑰保險箱 (Credential Vault)：** 提供安全介面讓用戶綁定各平台 Token。
    * Shopify: Store URL, Admin API Access Token.
    * 社群平台 (未來擴充): Threads, IG 等 OAuth 授權。
* **員工啟用與配置：** 根據訂閱方案，用戶可自由「聘用（啟用）」不同的 AI 代理人，並設定基礎品牌語氣與偏好。

### 2. 自然語言派發與對話模組 (Conversational Dispatch)
* **對話式任務輸入：** 用戶可透過自然語言下達模糊或明確的任務指令（例：「幫我規劃夏季女裝的 SEO 並發布」）。
* **持續性對話確認：** 系統（Supervisor）在參數不足時，會主動向用戶提問，直到任務參數收集齊全，隨後將其轉化為實體看板卡片。

### 3. 看板與任務引擎 (Kanban Task Engine)
看板系統是任務管理的視覺化中樞，所有主任務與子任務皆為「一等公民」，共用相同的生命週期。
* **任務狀態機 (Task States)：**
    * **Todo：** 已建立但尚未觸發的任務（包含未來排程）。
    * **In Progress：** AI 員工執行中。介面上需即時顯示「原子化 Log」（如：搜集資料中、修圖中）。
    * **Waiting (Gate/HITL)：** 需要人類決策的節點。
        * *Approve (確認)：* 進入下一步驟或轉為 Done。
        * *Feedback (回饋)：* 用戶輸入修改指令（如：「語氣再活潑一點」），卡片退回 In Progress，AI 讀取歷史對話後重新生成。
    * **Done：** 任務徹底完成。
    * **Failed：** 任務失敗或用戶主動 Discard，保留錯誤日誌。
* **任務裂變機制 (Task Spawning)：** 策略型任務完成後，可透過排程工具自動產生多個獨立的執行型任務（如：產出 10 篇獨立的定期發文任務），子任務具備完整且獨立的審核與執行流程。

### 4. 數位員工陣容 (AI Agent Roles)
* **AI 營運助理 (Ops Assistant)：** 處理去背、規格表整理、呼叫 Shopify API 上架商品與圖片。
* **AI SEO 專員 (SEO Expert)：** 負責關鍵字搜尋、多語系部落格文章撰寫。
* **領域專家 (Domain Experts - 進階功能)：** 如服飾、3C、家居專家，透過特定的 Prompt 與 RAG 知識庫，產出具備產業深度與靈魂的文案。

### 5. 商業與訂閱模式 (SaaS Pricing)
採用「包月訂閱制」，將功能包裝為薪資架構：
* **基礎版 (實習團隊)：** 包含基礎營運助理、一般 SEO 寫手，限制每月處理筆數。
* **專業版 (專業團隊)：** 解鎖指定領域專家模型，並提供 Cloudflare 進階修圖與擴圖功能。
* **旗艦版 (全端團隊)：** 解鎖數據分析師與客服主任，支援專屬知識庫 (RAG) 匯入。

---

## 貳、技術規格 (Technical Specifications)

### 1. 系統架構 (System Architecture)
採用 **Headless (無頭) 微服務架構**，徹底解耦前後端與 AI 引擎。
* **核心服務層：** Node.js 微服務 (提供 RESTful / tRPC API)。負責接收請求、狀態同步、呼叫底層資料庫。
* **前端展示層 (MVP)：** 自有 SaaS 獨立後台（建議 React/Next.js），透過 API 溝通。未來可封裝為 Shopify Embedded App。

### 2. AI 智能體編排 (AI Orchestration)
* **核心框架：** `LangGraph.js` (TypeScript 完全支援)。
* **架構模式：** 採用 Supervisor / Router Pattern (主管路由模式)。
    * **Supervisor Node：** 負責理解意圖、動態派發任務給其他 Worker Nodes。
    * **Worker Nodes：** 定義各種 AI 員工的職責、Prompt 與 Tools。
* **混合編排：** 邏輯流轉由 AI 動態決定，但關鍵動作（如呼叫 Shopify API）使用 Deterministic Edges 強制導向 Human-in-the-loop (Waiting 狀態)。
* **狀態與記憶：** 使用 LangGraph Checkpointer 持久化 `GraphState`，保存對話紀錄與執行上下文。

### 3. 資料庫與持久化層 (Database & ORM)
* **資料庫選型：** Supabase (純粹作為 PostgreSQL 與 pgvector 使用)。
* **ORM 選型：** Drizzle ORM 或 Prisma (TypeScript 友善)，避免重度依賴 Supabase SDK 以防止廠商鎖定 (Vendor lock-in)。
* **核心 Data Model (Tasks Table)：**
    * 所有任務共用結構，具備 `parent_task_id` 實現裂變關聯。
    * 欄位包含：`status`, `execution_logs` (JSONB), `scheduled_at`, `tenant_id`。

### 4. 影像處理與 CDN 儲存 (Image Infrastructure)
* **服務選型：** Cloudflare Images。
* **整合方式：** 後端透過 S3-Compatible API 與 Cloudflare 溝通。
* **工作流：**
    1.  AI 產出大圖後上傳至 Cloudflare Images 獲取 `Image_ID`。
    2.  利用 Cloudflare 動態變體 (Variants/Dynamic params) 處理各種尺寸與格式 (WebP/AVIF 自動轉換)。
    3.  將包含 Cloudflare CDN 網址與多語系 Alt Text 的資料透過 Storefront/Admin API 寫入 Shopify。

### 5. 身份驗證與安全 (Auth & Security)
* **初期方案：** 利用 Supabase Auth 快速實作社群/Email 登入。
* **解耦策略：** 後端嚴格實作 `AuthService` 介面，使用標準 JWT 驗證，不將業務邏輯綁死於 Supabase 的 Row Level Security (RLS) 中。

---

## 參、Phase 1 (MVP) 實作重點提示

1.  **優先打通主幹線：** 完成從「輸入指令 -> Supervisor 派工 -> LangGraph 產出文案 -> 儲存至資料庫 -> 卡片進入 Waiting -> 用戶 Approve -> 呼叫 Shopify API」的最短路徑。
2.  **不強求花俏的前端：** 初期 UI 可以極簡，但「看板卡片狀態流轉」與「Log 即時跳動」的機制必須穩固。
3.  **自有場景壓測：** 利用現有的線上課程與電商環境，作為這套系統首批 AI 員工的實戰修羅場，驗證多語系產出品質與 API 穩定度。
