# twstock｜台股大盤 K 線與籌碼

上市加權指數、上櫃櫃買指數的 K 線圖與每日籌碼資料表（參考 Goodinfo 版面），每個交易日晚間自動更新。

- **上市／上櫃 TAB** 切換
- **K 線**：日K、週K、月K、半年K、年K；MA5／20／60；副圖切換成交金額／三大法人／融資餘額
- **資料表**：開高低收、漲跌、漲跌%、振幅、成交(億)、成交均張、外資／投信／自營／合計、融資餘額／增減、融券餘額／增減
- 期間查詢（3月／1年／3年／全部／自訂）、CSV 匯出
- 桌機／平板／手機自動切換版面；深色／淺色主題
- 台股配色：紅漲綠跌

架構說明見 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 技術

| 層 | 技術 |
|---|---|
| 前端 | 原生 HTML / CSS / JavaScript、TradingView Lightweight Charts 4.2.0 |
| 資料 | 靜態 JSON（`data/twse.json`、`data/tpex.json`） |
| 爬蟲 | Python 3.12 + requests（`scripts/update.py`） |
| 排程 | GitHub Actions cron |
| 部署 | Cloudflare Pages |

## 資料來源

臺灣證券交易所、證券櫃檯買賣中心開放資料；初次建立歷史資料時使用 FinMind。

## 部署

1. Cloudflare Pages → 建立專案 → 連結 `mywu-cloud/twstock`
   - Build command：留空
   - Build output directory：`/`
2. GitHub → Settings → Actions → General → Workflow permissions → **Read and write permissions**
3. （選用）Settings → Secrets and variables → Actions → 新增 `FINMIND_TOKEN`
4. Actions → **每日更新大盤資料** → Run workflow → 勾選 **bootstrap**，backfill 填 `400`
5. 之後自動執行：週一～五 21:37、23:17；週六 09:23 加大回補上櫃歷史籌碼

## 本地開發

```bash
pip install -r scripts/requirements.txt
python scripts/update.py --bootstrap     # 首次建檔
python scripts/update.py                 # 日常更新
python -m http.server 8000               # http://localhost:8000
```

常用參數：

| 參數 | 預設 | 說明 |
|---|---|---|
| `--bootstrap` | — | 以 FinMind 匯入長期歷史 |
| `--months` | 2 | 重抓近幾個月的官方價量 |
| `--recent` | 15 | 近幾個交易日的籌碼一律補齊 |
| `--backfill` | 40 | 本次最多往回補幾個交易日的籌碼 |
| `--max-minutes` | 45 | 時間預算，超過即存檔結束 |
| `--market` | all | `twse` / `tpex` / `all` |

## 免責聲明

本網站資訊僅供參考，不構成任何投資建議；投資有風險，請自行判斷並承擔風險。
