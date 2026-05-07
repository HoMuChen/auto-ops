---
key: geo
name: GEO (Generative Engine Optimization)
version: 1
---
GEO 的核心問題：LLM 用 RAG（檢索增強生成）把你的文章切成 chunk 再組合回答。
每個 chunk 必須能「被獨立擷取後直接回答問題」。

## BLUF 結構（Bottom Line Up Front）

每個段落、每個 H2 section 都用這個順序：
1. **直接回答**（1–2 句）— 開場就給答案，不要 warm-up
2. **為什麼重要**（2–3 句）— context，讓 chunk 有意義
3. **展開細節**（數字、例子、步驟）
4. **相關延伸**（下一個問題或行動）

問自己：「把這段單獨貼給 ChatGPT，它能用這段回答問題嗎？」
答案是 yes 才算合格。

## 文章結構設計

- **Heading 用問句**：符合使用者 query 格式，提高 AI Overview 觸發率
  - ✓ 「亞麻衣料洗幾次會起球？」
  - ✗ 「洗滌注意事項」
- **最佳 chunk 長度**：約 200 字（RAG 擷取甜蜜點）
- **總長度**：AI 引用 plateau 約 540 字，超過不會增加被引用機率；
  由主題/intent 決定長度，不是硬湊字數
- **格式偏好**：列點清單 > 連續段落、表格 > 文字比較、數字 > 形容詞

## Schema Markup（必須實作）

| Schema type | 使用場景 |
|-------------|---------|
| `Article` | 所有文章 |
| `HowTo` | 步驟型、教學型 |
| `FAQPage` | 含常見問答的頁面 |
| `Speakable` | 想被語音/AI 朗讀的段落 |

## Entity Proximity 戰術

LLM 透過 embedding 判斷你的品牌屬於哪個語義空間。
把你的品牌放在有商業價值的 entity 旁邊：
- 與同類高權威品牌語意共提（同一段、同一清單）
- 用 Google Natural Language API 找相關 entity；比關鍵字研究更有效
- 避免只堆關鍵字 — entity 鄰近度比 keyword density 更影響 LLM 引用

## Freshness 訊號

- Google Gemini 對 freshness 特別敏感（最強平台差異）
- 所有 AI 平台都給更新過的內容 +13.1% 偏好
- 策略：每季審視高流量頁面，更新數據/案例，重新發布

## 主動引用觸發（不只被動等）

- 原創研究與數據：**Quotes +27.2%、Statistics +25.2%** 的 RAG 被引用率
- 加入第一人稱直接引述（老闆親身經驗轉成可引用的語句）
- 清楚標示資料來源 — Claude 等 Constitutional AI 系統對歸因特別嚴格
