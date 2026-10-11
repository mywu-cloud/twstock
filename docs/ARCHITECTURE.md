# twstock 網站架構

台股大盤（上市加權指數／上櫃櫃買指數）K 線與籌碼資訊站。
純靜態網站 + GitHub Actions 定時爬蟲，部署於 Cloudflare Pages，零伺服器、零資料庫。

---

## 1. 系統總覽

```
┌──────────────────────────┐      每日 21:37 / 23:17（台北，週一～五）
│  GitHub Actions (cron)   │ ─────────────────────────────────────────┐
│  scripts/update.py       │                                          │
└────────────┬─────────────┘                                          │
             │ HTTP (JSON)                                            │
   ┌─────────┼──────────────────────────┬─────────────────────┐       │
   ▼         ▼                          ▼                     │       │
 TWSE 證交所  TPEx 櫃買中心        FinMind（僅初次建檔）        │       │
   └─────────┴──────────────┬───────────┘                     │       │
                            ▼                                 │       │
                 data/twse.json, data/tpex.json  ── git commit & push ─┘
                            │
                            ▼  push 觸發
                 Cloudflare Pages 自動部署（靜態檔）
                            │
                            ▼
      瀏覽器：index.html + assets/app.js 讀 JSON → 前端聚合 → K 線 + 資料表
```

設計重點：
- **資料預先計算、前端只做聚合**：日資料存成精簡陣列；週／月／半年／年 K 由瀏覽器即時聚合，不需多份檔案。
- **增量更新、可續跑**：每次只抓近月價格與缺漏籌碼，超過時間預算即存檔結束，下次接續。
- **來源分工**：官方 API 為主（最即時、最權威），FinMind 只用於一次性回補長期歷史。

---

## 2. 目錄結構

```
twstock/
├── index.html                    頁面骨架（表頭、TAB、圖表容器、資料表）
├── assets/
│   ├── style.css                 設計 tokens（深／淺色）、Goodinfo 風格表格、RWD
│   ├── app.js                    資料載入、週期聚合、圖表、表格、匯出、主題
│   └── lightweight-charts.js     TradingView Lightweight Charts 4.2.0（本地化）
├── data/
│   ├── twse.json                 上市日資料（排程產生）
│   ├── tpex.json                 上櫃日資料（排程產生）
│   └── meta.json                 最後更新時間、筆數
├── scripts/
│   ├── update.py                 爬蟲／資料更新程式
│   └── requirements.txt          requests
├── .github/workflows/
│   └── update-data.yml           排程與手動回補
├── docs/ARCHITECTURE.md          本文件
├── _headers                      Cloudflare 快取規則
└── README.md
```

---

## 3. 資料層

### 3.1 資料來源與端點

| 市場 | 資料 | 端點 | 頻率 | 單位 |
|---|---|---|---|---|
| 上市 | 指數 OHLC | `twse.com.tw/rwd/zh/TAIEX/MI_5MINS_HIST?date=YYYYMM01` | 月 | 點 |
| 上市 | 成交量值筆數 | `twse.com.tw/rwd/zh/afterTrading/FMTQIK?date=YYYYMM01` | 月 | 元／股／筆 |
| 上市 | 三大法人 | `twse.com.tw/rwd/zh/fund/BFI82U?type=day&dayDate=YYYYMMDD` | 日 | 元 |
| 上市 | 信用交易 | `twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=YYYYMMDD&selectType=MS` | 日 | 仟元／張 |
| 上櫃 | 指數 OHLC | `tpex.org.tw/www/zh-tw/indexInfo/inx?date=YYYY/MM/01` | 月 | 點 |
| 上櫃 | 成交量值筆數 | `tpex.org.tw/www/zh-tw/afterTrading/tradingIndex?date=YYYY/MM/01` | 月 | 張／仟元／筆 |
| 上櫃 | 三大法人 | `tpex.org.tw/www/zh-tw/insti/summary?type=Daily&date=YYYY/MM/DD` | 日 | 元 |
| 上櫃 | 融資融券 | `tpex.org.tw/www/zh-tw/margin/balance?date=YYYY/MM/DD`（summary 列） | 日 | 仟元／張 |
| 初次建檔 | 指數歷史 | FinMind `TaiwanStockPrice`（TAIEX / TPEx） | — | — |
| 初次建檔 | 上市法人 | FinMind `TaiwanStockTotalInstitutionalInvestors`（2004–） | — | 元 |
| 初次建檔 | 上市融資券 | FinMind `TaiwanStockTotalMarginPurchaseShortSale`（2001–） | — | 元／張 |

### 3.2 儲存格式（`data/<market>.json`）

```json
{
  "market": "twse", "name": "加權指數", "label": "上市",
  "updated": "2026-10-08 21:40",
  "fields": ["d","o","h","l","c","amt","vol","trades","fi","it","dl","mb","ss"],
  "rows": [["20261008",49783.06,49783.06,49189.77,49313.44,924509,10437289,5075757,-75852,3009,-18731,646406,211949]],
  "nodata": ["i20070101", "m20070101"]
}
```

| 欄 | 意義 | 單位 |
|---|---|---|
| d | 交易日 | YYYYMMDD |
| o h l c | 開高低收 | 點 |
| amt | 成交金額 | 百萬元 |
| vol | 成交量 | 張 |
| trades | 成交筆數 | 筆 |
| fi / it / dl | 外資／投信／自營 買賣超 | 百萬元 |
| mb | 融資餘額 | 百萬元 |
| ss | 融券餘額 | 張 |

- 金額一律存「百萬元」整數，檔案精簡且無浮點誤差；前端 ÷100 顯示為億元。
- `nodata`：來源確認無資料的日期（`i`=法人、`m`=融資券），避免重複請求。
- 增減欄（融資增減、融券增減、漲跌）不存檔，前端由相鄰資料計算。

### 3.3 欄位定義（與 Goodinfo 對齊）

- **外資** = 外資及陸資（不含外資自營商）
- **自營** = 自營商（自行買賣）+ 自營商（避險）
- **合計** = 外資 + 投信 + 自營（等於交易所公告「三大法人合計」）
- **成交均張** = 成交張數 ÷ 成交筆數
- **振幅** = (最高 − 最低) ÷ 前收 × 100%

### 3.4 更新程式 `scripts/update.py`

流程：
1. 讀入既有 JSON（無檔案或 `--bootstrap` → 先以 FinMind 匯入長期歷史）。
2. 重抓近 `--months` 個月（預設 2）的官方價量資料，覆寫最新值。
3. `fill_chips`：由新到舊掃描交易日，近 `--recent` 天必補；更舊的缺漏在 `--backfill` 額度內回補。
4. 超過 `--max-minutes` 即停止並存檔（下次自動續補）。
5. 輸出 `twse.json`、`tpex.json`、`meta.json`。

可靠性：
- 每來源獨立節流（TWSE 3.2 秒、TPEx 1.6 秒），避免被封鎖。
- 失敗重試 4 次、指數退避。
- 原子寫入（先寫 `.tmp` 再 rename）。

### 3.5 排程 `.github/workflows/update-data.yml`

| 觸發 | 台北時間 | 動作 |
|---|---|---|
| cron | 週一～五 21:37 | 當日資料（融資券約 21:00 公布） |
| cron | 週一～五 23:17 | 補抓 |
| cron | 週六 09:23 | 大量回補歷史籌碼（backfill 1500、上限 300 分鐘） |
| 手動 | — | 可勾選 bootstrap、自訂 backfill |

有變更才 commit（`git diff --cached --quiet` 判斷），push 後 Cloudflare Pages 自動部署。

---

## 4. 前端

### 4.1 版面

```
┌─────────────────────────────────────────────────────┐
│ Quant-Lab        [上市 加權指數][上櫃 櫃買指數]   ☀/☾ │  sticky 頂欄
├─────────────────────────────────────────────────────┤
│ 上市・加權指數 2026/10/08                            │
│ 49,313.44 ▼492.93 -0.99%   開 高 低 成交 法人 融資增減 │  行情摘要
├─────────────────────────────────────────────────────┤
│ [日K 週K 月K 半年K 年K]        [成交金額 三大法人 融資] │
│ 圖例：開高低收、漲跌、MA5/20/60                        │
│ ┌ 主圖：K 線 + 均線 ─────────────────────────────┐  │
│ └───────────────────────────────────────────────┘  │
│ ┌ 副圖：成交金額／法人買賣超／融資餘額（時間軸同步）┐ │
│ └───────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────┤
│ 期間 [起]~[迄] [3月 1年 3年 全部] [查詢]   [匯出CSV] │
│ [價量][法人][信用][全部]  ← 平板／手機才顯示          │
│ 交易日期│開 高 低 收 漲跌 %│振幅│成交│均張│法人4欄│融資2欄│融券2欄 │
└─────────────────────────────────────────────────────┘
```

### 4.2 模組（`assets/app.js`）

| 區塊 | 函式 | 職責 |
|---|---|---|
| 資料 | `loadMarket` | fetch JSON、記憶體快取 |
| 聚合 | `periodKey`、`aggregate` | 依 D/W/M/H/Y 分組；OHLC、加總、期末餘額、衍生欄 |
| 圖表 | `initCharts`、`drawMain`、`drawSub` | 主副圖建立、時間軸／十字線同步、均線 |
| 圖例 | `updateLegend` | 十字線所在 K 棒的數值 |
| 表格 | `renderTable`、`rowHTML` | 期間篩選、分頁（每次 250 筆）、紅綠著色 |
| 互動 | `focusRow`、表格點擊 | 點 K 棒捲到表格列；點表格列移動圖表 |
| 匯出 | `exportCSV` | UTF-8 BOM CSV（Excel 可直接開） |
| 狀態 | `restore`、`bind` | URL hash（`#twse-D`）、localStorage 偏好 |

週期聚合規則：

| 欄位 | 規則 |
|---|---|
| 開／收 | 期間第一筆開盤／最後一筆收盤 |
| 高／低 | 期間最大／最小 |
| 成交金額、量、筆數、法人 | 加總 |
| 融資、融券餘額 | 期末值 |
| 漲跌、振幅、增減 | 與前一期比較 |

週以 ISO 週（週一為首）分組；半年以 1–6 月 / 7–12 月分組。

### 4.3 響應式

| 斷點 | 版面 |
|---|---|
| > 1100px 桌機 | 摘要橫排、主圖 470px、表格全欄 |
| 641–1100px 平板 | 摘要 3 欄、主圖 400px、欄位群組切換 |
| ≤ 640px 手機 | 隱藏品牌字、TAB 精簡、主圖 300px、按鈕滿版、日期欄固定 |

### 4.4 主題

- `:root[data-theme="dark|light"]` 定義全部色彩 tokens。
- `<head>` 內聯腳本先讀 localStorage／系統偏好，避免閃爍。
- 切換時同步更新圖表色（`applyChartTheme`）。
- 台股慣例：**紅 = 上漲／買超／增加，綠 = 下跌／賣超／減少**。

---

## 5. 部署

| 項目 | 設定 |
|---|---|
| 平台 | Cloudflare Pages（連結本 repo） |
| Build command | （留空） |
| Output directory | `/` |
| 快取 | `_headers`：`/data/*` 5 分鐘、`/assets/*` 1 小時 |
| GitHub 權限 | Settings → Actions → Workflow permissions = Read and write |
| 選用 Secret | `FINMIND_TOKEN`（提高 FinMind 額度） |

---

## 6. 擴充方向

- 個股頁：同一套 `aggregate` + 圖表，資料改為 `data/stock/<id>.json`。
- 期貨／選擇權頁：台指期未平倉、外資期貨淨部位、P/C ratio（TAIFEX 開放資料）。
- 技術指標副圖：KD、MACD、RSI 前端計算。
- 資料量成長後可依年份分檔（`twse-2026.json`）並延遲載入。

---

本網站資訊僅供參考，不構成任何投資建議。
