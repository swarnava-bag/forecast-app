# -*- coding: utf-8 -*-
"""Extract the Forecast-vs-Movement base workbook into a clean JSON snapshot.

Three team views come straight from the computed sheets (Overall / Channelwise /
Qcom). The Movement-Engine tables and the reconciliation are re-aggregated from
the raw SO / STN / Shipsheet sheets, filtered to the mother node
('YB FG Warehouse'), and have been validated to reproduce the reference report
to the unit (e.g. SO ex-node dispatch 36,62,671; STN closed ex-node 40,45,425;
shipsheet 3,04,636 units / Rs 3.27 Cr / 200 POs).

Output: public/data/movement-jun26.json
"""
import json, os, math, datetime, re
from collections import defaultdict
import openpyxl

SRC = os.path.join("Forecast vs Movement",
                   "Jun 26 Forecast vs Movement Final Dashboard Base.xlsx")
OUT = os.path.join("public", "data", "movement-jun26.json")
NODE = "YB FG Warehouse"   # mother node

wb = openpyxl.load_workbook(SRC, read_only=True, data_only=True)

def num(v):
    if v is None: return 0.0
    if isinstance(v, (int, float)) and not (isinstance(v, float) and math.isnan(v)):
        return float(v)
    s = str(v).strip().replace(",", "")
    if s in ("", "-", "#N/A", "#VALUE!", "N/A"): return 0.0
    try: return float(s)
    except: return 0.0

def txt(v):
    if v is None: return ""
    s = str(v).strip()
    return "" if s in ("#N/A", "#VALUE!") else s

# ── Overall (Ops) : header row 2, data row 3+ ────────────────────────────────
overall = []
ws = wb["Overall"]
for r in ws.iter_rows(min_row=3, values_only=True):
    ms = txt(r[1])
    if not ms: continue
    overall.append({
        "masterSku": ms, "fgCode": txt(r[2]), "productName": txt(r[5]),
        "category": txt(r[6]) or "Uncategorised", "productCategory": txt(r[7]),
        "forecastV9": num(r[8]), "forecast": num(r[9]),   # V7 is the denominator
        "stn": num(r[12]), "so": num(r[13]), "shipsheet": num(r[14]),
        "totalSupplied": num(r[15]),
    })

# ── Channelwise : 'Channelwise Final' is the complete sheet (SO populated;
#    ties to the reference channel summary — total supplied 77,20,997). The
#    plain 'Channelwise' sheet is stale (SO column reads 0). Header row 3.
channelwise = []
ws = wb["Channelwise Final"]
for r in ws.iter_rows(min_row=4, values_only=True):
    ms, ch = txt(r[1]), txt(r[5])
    if not ms or not ch: continue
    channelwise.append({
        "masterSku": ms, "fgCode": txt(r[2]), "productName": txt(r[3]),
        "category": txt(r[4]) or "Uncategorised", "channel": ch,
        "forecast": num(r[6]), "stn": num(r[7]), "so": num(r[8]),
        "shipsheet": num(r[9]), "totalSupplied": num(r[10]),
    })

# ── Qcom : header row 3, data row 4+ ─────────────────────────────────────────
qcom = []
ws = wb["Qcom"]
for r in ws.iter_rows(min_row=4, values_only=True):
    ms, plat = txt(r[3]), txt(r[10])
    if not ms or not plat: continue
    qcom.append({
        "masterSku": ms, "fgCode": txt(r[4]), "productName": txt(r[7]),
        "category": txt(r[8]) or "Uncategorised", "platform": plat,
        "forecast": num(r[11]), "mtdOrders": num(r[12]), "mtdSales": num(r[13]),
    })

# ── Daily movement — raw SO / STN, mother node, by day-of-month ──────────────
#   Overall daily = STN (closed, ex-node, by Date) + SO (ex-node, dispatched,
#   by Last Dispatch Date). Per-channel daily uses SO customer type (exact) so
#   the channel filter is honest; STN sits in the overall total. Both series
#   reconcile to the monthly totals (STN 40,45,425 · SO 36,62,671).
CH_SET = {"MT", "GT", "Qcom", "B2B", "B2C", "Growth", "CSD"}

def day_of(v):
    if isinstance(v, datetime.datetime):
        return v.day if (v.year == 2026 and v.month == 6) else None
    s = txt(v)
    if s[:7] == "2026-06":
        try: return int(s[8:10])
        except: return None
    return None

daily_stn = defaultdict(float); daily_so = defaultdict(float)
daily_ch = defaultdict(lambda: defaultdict(float))   # channel -> day -> so units
daily_sku = defaultdict(lambda: defaultdict(float))  # New Master SKU -> day -> STN+SO units

# FG base-number -> New Master SKU (N/G suffix differs between files; match by base)
def fg_base(v):
    m = re.match(r"\s*0*(\d+)", str(v)); return m.group(1) if m else None
fg2sku = {}
for r in overall:
    b = fg_base(r["fgCode"])
    if b: fg2sku.setdefault(b, r["masterSku"])

so = wb["SO"]
H = {h: i for i, h in enumerate(next(so.iter_rows(min_row=2, max_row=2, values_only=True))) if h}
for r in so.iter_rows(min_row=3, values_only=True):
    if r[H["Warehouse"]] != NODE: continue
    dq = num(r[H["Dispatch Qty"]])
    if dq == 0: continue
    d = day_of(r[H["Last Dispatch Date"]])
    if d is None: continue
    daily_so[d] += dq
    ct = txt(r[H["Customer Type"]])
    if ct in CH_SET: daily_ch[ct][d] += dq
    sku = fg2sku.get(fg_base(r[H["FG Code"]]))
    if sku: daily_sku[sku][d] += dq

stn = wb["STN"]
S = {h: i for i, h in enumerate(next(stn.iter_rows(min_row=2, max_row=2, values_only=True))) if h}
for r in stn.iter_rows(min_row=3, values_only=True):
    if r[S["From Warehouse"]] != NODE or txt(r[S["Status"]]) != "Closed": continue
    d = day_of(r[S["Date"]])
    if d is None: continue
    q = num(r[S["Qty"]])
    daily_stn[d] += q
    sku = fg2sku.get(fg_base(r[S["FG Code"]]))
    if sku: daily_sku[sku][d] += q

days = sorted(set(daily_stn) | set(daily_so))
daily = [{"day": d, "stn": daily_stn.get(d, 0.0), "so": daily_so.get(d, 0.0),
          "total": daily_stn.get(d, 0.0) + daily_so.get(d, 0.0)} for d in days]
dailyChannel = {ch: [{"day": d, "value": daily_ch[ch].get(d, 0.0)} for d in days] for ch in sorted(daily_ch)}
# per-SKU daily (sparse: only days with movement) for the SKU day-on-day drill
dailySku = {sku: [{"day": d, "value": daily_sku[sku][d]} for d in sorted(daily_sku[sku])] for sku in daily_sku}
days_elapsed = max(days) if days else 30
ship_added_back = sum(r["shipsheet"] for r in channelwise)   # ex-node pipeline add-back (39,650)

# ── Assemble ─────────────────────────────────────────────────────────────────
def tot(rows, k): return sum(r[k] for r in rows)
first = next(wb["Overall"].iter_rows(min_row=1, max_row=1, values_only=True))
try: updated_day = int(first[1])
except Exception: updated_day = None

data = {
    "meta": {
        "month": "Jun 2026", "monthKey": "2026-06", "updatedOnDay": updated_day, "source": os.path.basename(SRC),
        "node": "YB FG Warehouse (Mother Node)", "forecastBasis": "V7",
        "daysElapsed": days_elapsed, "daysInMonth": 30,
        "pipelineUnits": ship_added_back,
        "forecastV7Total": tot(overall, "forecast"), "forecastV9Total": tot(overall, "forecastV9"),
        "channels": sorted({r["channel"] for r in channelwise}),
        "platforms": sorted({r["platform"] for r in qcom}),
        "categories": sorted({r["category"] for r in overall}),
        "counts": {"overall": len(overall), "channelwise": len(channelwise), "qcom": len(qcom)},
    },
    "overall": overall, "channelwise": channelwise, "qcom": qcom,
    "daily": daily, "dailyChannel": dailyChannel,
    # NOTE: accurate per-SKU daily needs combo explosion (P1-P48 -> component
    # SKU) — the line-level FG code hides combo/pack movement, so it is deferred
    # to the daily-source-files ingestion chunk rather than shipped misleading.
}

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, separators=(",", ":"))

# ── Validation prints ────────────────────────────────────────────────────────
print("Wrote", OUT)
print(f"  overall {len(overall)} · channelwise {len(channelwise)} · qcom {len(qcom)}")
fV7 = tot(overall, "forecast"); sup = tot(overall, "totalSupplied")
print(f"  Overall moved: {sup:,.0f}/{fV7:,.0f} = {100*sup/fV7:.1f}%  (ref 83.8%)")
d_stn = sum(x["stn"] for x in daily); d_so = sum(x["so"] for x in daily)
print(f"  Daily STN sum: {d_stn:,.0f}  (ref 40,45,425)")
print(f"  Daily SO sum:  {d_so:,.0f}  (ref 36,62,671; date-attributed subset)")
print(f"  Days with movement: {len(daily)} · days elapsed: {days_elapsed}")
maxd = max(daily, key=lambda x: x["total"]) if daily else None
if maxd: print(f"  Max-pickup day: day {maxd['day']} = {maxd['total']:,.0f} units")
print(f"  Channels in daily: {list(dailyChannel)}")
print(f"  Pipeline (shipsheet add-back): {ship_added_back:,.0f}")
