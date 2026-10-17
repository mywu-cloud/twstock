#!/usr/bin/env python3
"""
Quant-Lab 大盤資料更新程式
--------------------------------
來源：
  上市 (TWSE)：MI_5MINS_HIST(指數OHLC)、FMTQIK(成交量值)、BFI82U(三大法人)、MI_MARGN(信用交易)
  上櫃 (TPEx)：indexInfo/inx(指數OHLC)、afterTrading/tradingIndex(成交量值)、
               insti/summary(三大法人)、margin/balance(融資融券)
  初次建檔 (--bootstrap)：FinMind 一次取回長期歷史，加速回補

資料列格式 (data/<market>.json → rows)：
  [date(YYYYMMDD), open, high, low, close, amount(百萬元), volume(張), trades(筆),
   foreign(百萬元), trust(百萬元), dealer(百萬元), margin_balance(百萬元), short_balance(張)]

用法：
  python scripts/update.py                 # 每日更新（近月 + 補缺漏籌碼）
  python scripts/update.py --bootstrap     # 首次建檔：FinMind 長期歷史 + 官方近月
  python scripts/update.py --backfill 300  # 本次最多再往回補 300 個交易日的籌碼
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
TZ = dt.timezone(dt.timedelta(hours=8))

F = ["d", "o", "h", "l", "c", "amt", "vol", "trades", "fi", "it", "dl", "mb", "ss"]
IDX = {k: i for i, k in enumerate(F)}

MARKETS = {
    "twse": {"name": "加權指數", "label": "上市", "chip_since": "20040407", "margin_since": "20010103"},
    "tpex": {"name": "櫃買指數", "label": "上櫃", "chip_since": "20070423", "margin_since": "20070102"},
}

UA = {"User-Agent": "Mozilla/5.0 (QuantLab data bot; +https://stock-147.pages.dev)",
      "Accept": "application/json,text/plain,*/*"}
SESSION = requests.Session()
SESSION.headers.update(UA)

PAUSE = {"twse": 3.2, "tpex": 1.6, "finmind": 0.5}
_last_call: dict[str, float] = {}
DEADLINE = [float("inf")]


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


# ---------------------------------------------------------------- helpers
def num(s):
    """'1,234.5' / '-' / '' / 1.2 → float | None"""
    if s is None:
        return None
    if isinstance(s, (int, float)):
        return float(s)
    s = str(s).replace(",", "").replace("+", "").replace("X", "").strip()
    if s in ("", "-", "--", "---", "N/A"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def to_ymd(s: str) -> str | None:
    """'115/10/01' 或 '2026/10/01' 或 '2026-10-01' → '20261001'"""
    s = str(s).strip().replace("-", "/").replace("＊", "").replace("*", "")
    p = s.split("/")
    if len(p) != 3:
        return None
    try:
        y, m, d = int(p[0]), int(p[1]), int(p[2])
    except ValueError:
        return None
    if y < 1000:
        y += 1911
    return f"{y:04d}{m:02d}{d:02d}"


def get_json(src: str, url: str, params: dict, tries: int = 4):
    if time.time() > DEADLINE[0]:
        raise TimeoutError("time budget exhausted")
    for k in range(tries):
        wait = PAUSE[src] - (time.time() - _last_call.get(src, 0))
        if wait > 0:
            time.sleep(wait)
        _last_call[src] = time.time()
        try:
            r = SESSION.get(url, params=params, timeout=30)
            if r.status_code == 200:
                return r.json()
            log(f"  HTTP {r.status_code} {url} {params}")
        except (requests.RequestException, ValueError) as e:
            log(f"  ERR {e.__class__.__name__} {url} {params}")
        time.sleep(5 * (k + 1) + (20 if k >= 1 else 0))
    return None


def r2(x):
    return None if x is None else round(x, 2)


def mil(x, div=1e6):
    return None if x is None else round(x / div)


# ---------------------------------------------------------------- store
class Store:
    def __init__(self, market: str):
        self.market = market
        self.path = DATA / f"{market}.json"
        self.rows: dict[str, list] = {}
        self.nodata: set[str] = set()   # 已確認來源無籌碼資料的日期（避免重複請求）
        if self.path.exists():
            j = json.loads(self.path.read_text("utf-8"))
            for r in j.get("rows", []):
                r = list(r) + [None] * (len(F) - len(r))
                self.rows[r[0]] = r
            self.nodata = set(j.get("nodata", []))
        self.dirty = False

    def put(self, d: str, **kv):
        row = self.rows.get(d)
        if row is None:
            row = [d] + [None] * (len(F) - 1)
            self.rows[d] = row
        for k, v in kv.items():
            if v is None:
                continue
            i = IDX[k]
            if row[i] != v:
                row[i] = v
                self.dirty = True

    def has_price(self, d):
        r = self.rows.get(d)
        return r is not None and r[IDX["c"]] is not None

    def save(self):
        rows = [r for _, r in sorted(self.rows.items()) if r[IDX["c"]] is not None]
        meta = MARKETS[self.market]
        out = {
            "market": self.market,
            "name": meta["name"],
            "label": meta["label"],
            "units": {"amt": "百萬元", "vol": "張", "trades": "筆", "fi/it/dl": "百萬元",
                      "mb": "百萬元", "ss": "張"},
            "fields": F,
            "updated": dt.datetime.now(TZ).strftime("%Y-%m-%d %H:%M"),
            "rows": rows,
            "nodata": sorted(self.nodata)[-3000:],
        }
        DATA.mkdir(exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), "utf-8")
        tmp.replace(self.path)
        log(f"[{self.market}] saved {len(rows)} rows → {self.path.name}")


# ---------------------------------------------------------------- TWSE
TWSE = "https://www.twse.com.tw/rwd/zh"


def twse_price_month(st: Store, ym: str):
    j = get_json("twse", f"{TWSE}/TAIEX/MI_5MINS_HIST", {"date": ym + "01", "response": "json"})
    n = 0
    if j and j.get("stat") == "OK":
        for r in j.get("data", []):
            d = to_ymd(r[0])
            if d:
                st.put(d, o=r2(num(r[1])), h=r2(num(r[2])), l=r2(num(r[3])), c=r2(num(r[4])))
                n += 1
    j = get_json("twse", f"{TWSE}/afterTrading/FMTQIK", {"date": ym + "01", "response": "json"})
    if j and j.get("stat") == "OK":
        for r in j.get("data", []):
            d = to_ymd(r[0])
            if d and d in st.rows:
                sh, amt, tr = num(r[1]), num(r[2]), num(r[3])
                st.put(d, amt=mil(amt), vol=None if sh is None else round(sh / 1000),
                       trades=None if tr is None else int(tr))
    log(f"[twse] price {ym}: {n} days")


def twse_inst_day(st: Store, d: str) -> bool:
    j = get_json("twse", f"{TWSE}/fund/BFI82U", {"type": "day", "dayDate": d, "response": "json"})
    if not j or j.get("stat") != "OK" or not j.get("data"):
        return False
    fi = it = dl = None
    for r in j["data"]:
        name, net = r[0].strip(), num(r[3])
        if name.startswith("外資及陸資") or name == "外資":
            fi = (fi or 0) + (net or 0)
        elif name.startswith("投信"):
            it = net
        elif name.startswith("自營商") and "外資" not in name:
            dl = (dl or 0) + (net or 0)
    st.put(d, fi=mil(fi), it=mil(it), dl=mil(dl))
    return fi is not None


def twse_margin_day(st: Store, d: str) -> bool:
    j = get_json("twse", f"{TWSE}/marginTrading/MI_MARGN",
                 {"date": d, "selectType": "MS", "response": "json"})
    if not j or j.get("stat") != "OK":
        return False
    tables = j.get("tables") or []
    rows = tables[0].get("data", []) if tables else j.get("creditList", [])
    mb = ss = None
    for r in rows:
        name = str(r[0])
        if name.startswith("融資金額"):
            mb = num(r[5])
        elif name.startswith("融券"):
            ss = num(r[5])
    st.put(d, mb=None if mb is None else round(mb / 1000), ss=None if ss is None else int(ss))
    return mb is not None or ss is not None


# ---------------------------------------------------------------- TPEx
TPEX = "https://www.tpex.org.tw/www/zh-tw"


def _tpex_table(j):
    if not j or str(j.get("stat", "")).lower() != "ok":
        return None
    t = j.get("tables") or []
    return t[0] if t else None


def tpex_price_month(st: Store, ym: str):
    date = f"{ym[:4]}/{ym[4:]}/01"
    t = _tpex_table(get_json("tpex", f"{TPEX}/indexInfo/inx", {"date": date, "response": "json"}))
    n = 0
    if t:
        for r in t.get("data", []):
            d = to_ymd(r[0])
            if d:
                st.put(d, o=r2(num(r[1])), h=r2(num(r[2])), l=r2(num(r[3])), c=r2(num(r[4])))
                n += 1
    t = _tpex_table(get_json("tpex", f"{TPEX}/afterTrading/tradingIndex", {"date": date, "response": "json"}))
    if t:
        for r in t.get("data", []):
            d = to_ymd(r[0])
            if d and d in st.rows:
                vol, amt_k, tr = num(r[1]), num(r[2]), num(r[3])
                st.put(d, vol=None if vol is None else int(vol), amt=mil(amt_k, 1e3),
                       trades=None if tr is None else int(tr))
                if not st.has_price(d) and num(r[4]) is not None:   # 無 OHLC 時至少保留收盤
                    c = r2(num(r[4]))
                    st.put(d, o=c, h=c, l=c, c=c)
    log(f"[tpex] price {ym}: {n} days")


def tpex_inst_day(st: Store, d: str) -> bool:
    date = f"{d[:4]}/{d[4:6]}/{d[6:]}"
    t = _tpex_table(get_json("tpex", f"{TPEX}/insti/summary", {"type": "Daily", "date": date, "response": "json"}))
    if not t or not t.get("data"):
        return False
    vals = {str(r[0]).strip().replace(" ", ""): num(r[3]) for r in t["data"] if len(r) > 3}
    if not vals:   # 非交易日或欄位格式異動時略過
        return False
    fi = next((v for k, v in vals.items() if k.startswith("外資及陸資(不含")), None)
    if fi is None:
        fi = vals.get("外資及陸資合計", vals.get("外資及陸資"))
    it = vals.get("投信")
    dl = vals.get("自營商合計")
    if dl is None:
        parts = [v for k, v in vals.items() if k.startswith("自營商(") and v is not None]
        dl = sum(parts) if parts else None
    st.put(d, fi=mil(fi), it=mil(it), dl=mil(dl))
    return fi is not None


def tpex_margin_day(st: Store, d: str) -> bool:
    date = f"{d[:4]}/{d[4:6]}/{d[6:]}"
    t = _tpex_table(get_json("tpex", f"{TPEX}/margin/balance", {"date": date, "response": "json"}))
    if not t:
        return False
    fields = t.get("fields") or []
    try:
        i_mb, i_ss = fields.index("資餘額"), fields.index("券餘額")
    except ValueError:
        i_mb, i_ss = 6, 14
    mb = ss = None
    for r in t.get("summary") or []:
        name = str(r[1]) if len(r) > 1 else ""
        if name.startswith("融資金"):
            mb = num(r[i_mb])
        elif name.startswith("合計"):
            ss = num(r[i_ss])
    st.put(d, mb=None if mb is None else round(mb / 1000), ss=None if ss is None else int(ss))
    return mb is not None


# ---------------------------------------------------------------- FinMind (bootstrap)
FM = "https://api.finmindtrade.com/api/v4/data"


def fm(dataset, start, end, data_id=None):
    p = {"dataset": dataset, "start_date": start, "end_date": end}
    if data_id:
        p["data_id"] = data_id
    tok = os.environ.get("FINMIND_TOKEN")
    if tok:
        p["token"] = tok
    j = get_json("finmind", FM, p)
    return (j or {}).get("data") or []


def fm_chunks(start_year: int):
    y = start_year
    end = dt.date.today().year
    while y <= end:
        yield f"{y}-01-01", f"{min(y + 4, end)}-12-31"
        y += 5


def bootstrap(stores: dict[str, Store]):
    log("== bootstrap from FinMind ==")
    for mk, data_id in (("twse", "TAIEX"), ("tpex", "TPEx")):
        st = stores[mk]
        for s, e in fm_chunks(1999):
            for p in fm("TaiwanStockPrice", s, e, data_id):
                d = p["date"].replace("-", "")
                st.put(d, o=r2(p.get("open")), h=r2(p.get("max")), l=r2(p.get("min")), c=r2(p.get("close")),
                       amt=mil(p.get("Trading_money")),
                       vol=None if p.get("Trading_Volume") is None else round(p["Trading_Volume"] / 1000),
                       trades=p.get("Trading_turnover") or None)
        log(f"[{mk}] FinMind price rows: {len(st.rows)}")
    st = stores["twse"]
    for s, e in fm_chunks(2004):
        agg: dict[str, dict] = {}
        for r in fm("TaiwanStockTotalInstitutionalInvestors", s, e):
            agg.setdefault(r["date"], {})[r["name"]] = (r.get("buy") or 0) - (r.get("sell") or 0)
        for date, v in agg.items():
            d = date.replace("-", "")
            fi = v.get("Foreign_Investor")
            dl = None
            if "Dealer_self" in v or "Dealer_Hedging" in v or "Dealer" in v:
                dl = v.get("Dealer_self", 0) + v.get("Dealer_Hedging", 0) + v.get("Dealer", 0)
            st.put(d, fi=mil(fi), it=mil(v.get("Investment_Trust")), dl=mil(dl))
    for s, e in fm_chunks(2001):
        agg = {}
        for r in fm("TaiwanStockTotalMarginPurchaseShortSale", s, e):
            agg.setdefault(r["date"], {})[r["name"]] = r.get("TodayBalance")
        for date, v in agg.items():
            d = date.replace("-", "")
            mbv = v.get("MarginPurchaseMoney")
            st.put(d, mb=mil(mbv), ss=v.get("ShortSale"))
    log("[twse] FinMind chips merged")


# ---------------------------------------------------------------- main flow
PRICE = {"twse": twse_price_month, "tpex": tpex_price_month}
INST = {"twse": twse_inst_day, "tpex": tpex_inst_day}
MARGIN = {"twse": twse_margin_day, "tpex": tpex_margin_day}


def months_back(n: int):
    t = dt.datetime.now(TZ).date().replace(day=1)
    out = []
    for _ in range(n):
        out.append(t.strftime("%Y%m"))
        t = (t - dt.timedelta(days=1)).replace(day=1)
    return out


def fill_chips(st: Store, recent: int, backfill: int):
    mk = st.market
    since_i, since_m = MARKETS[mk]["chip_since"], MARKETS[mk]["margin_since"]
    days = sorted((d for d in st.rows if st.has_price(d)), reverse=True)
    today = dt.datetime.now(TZ).strftime("%Y%m%d")
    budget = backfill
    for k, d in enumerate(days):
        r = st.rows[d]
        need_i = r[IDX["fi"]] is None and d >= since_i and ("i" + d) not in st.nodata
        need_m = r[IDX["mb"]] is None and d >= since_m and ("m" + d) not in st.nodata
        if not (need_i or need_m):
            continue
        if k >= recent:
            if budget <= 0:
                break
            budget -= 1
        try:
            if need_i and not INST[mk](st, d) and d < today and k > 3:
                st.nodata.add("i" + d)
            if need_m and not MARGIN[mk](st, d) and d < today and k > 3:
                st.nodata.add("m" + d)
        except TimeoutError:
            log(f"[{mk}] time budget reached at {d}")
            return
        if k % 20 == 0:
            log(f"[{mk}] chips … {d}")
    log(f"[{mk}] chips done (backfill budget left {budget})")


def deep_price(st: Store, months: int):
    """官方月資料回補價格（FinMind 無資料時使用）。"""
    have = {d[:6] for d in st.rows}
    for ym in months_back(months):
        if ym not in have:
            try:
                PRICE[st.market](st, ym)
            except TimeoutError:
                return


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bootstrap", action="store_true", help="以 FinMind 建立長期歷史")
    ap.add_argument("--months", type=int, default=2, help="每次重抓的近月數 (官方)")
    ap.add_argument("--recent", type=int, default=15, help="近 N 個交易日籌碼一律補齊")
    ap.add_argument("--backfill", type=int, default=40, help="本次最多往回補幾個交易日的籌碼")
    ap.add_argument("--deep-months", type=int, default=0, help="官方月資料回補價格的月數")
    ap.add_argument("--max-minutes", type=float, default=45)
    ap.add_argument("--market", choices=["twse", "tpex", "all"], default="all")
    a = ap.parse_args()
    DEADLINE[0] = time.time() + a.max_minutes * 60

    mks = ["twse", "tpex"] if a.market == "all" else [a.market]
    stores = {m: Store(m) for m in ("twse", "tpex")}
    if a.bootstrap or any(not stores[m].rows for m in mks):
        bootstrap(stores)
    for m in mks:
        st = stores[m]
        try:
            for ym in reversed(months_back(a.months)):
                PRICE[m](st, ym)
            if a.deep_months:
                deep_price(st, a.deep_months)
        except TimeoutError:
            pass
        fill_chips(st, a.recent, a.backfill)
        st.save()
    meta = {"updated": dt.datetime.now(TZ).strftime("%Y-%m-%d %H:%M"),
            "markets": {m: {"last": max(stores[m].rows) if stores[m].rows else None,
                            "rows": len(stores[m].rows)} for m in ("twse", "tpex")}}
    (DATA / "meta.json").write_text(json.dumps(meta, ensure_ascii=False), "utf-8")
    log("done", meta)


if __name__ == "__main__":
    sys.exit(main())
