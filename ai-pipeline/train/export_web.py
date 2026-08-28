"""
แปลงโมเดลที่เทรนแล้วให้รันในเบราว์เซอร์ได้

อ่าน train/artifacts/xgboost/ + data/processed/panel.csv
แล้วเขียนไฟล์ลง data/ai/ ของเว็บ สามไฟล์:

    model.json      ต้นไม้ทั้งหมดในรูป array แบน ๆ + isotonic calibrator
    provinces.json  ฟีเจอร์คงที่รายจังหวัด + ค่าเฉลี่ยประวัติ (ไว้แทน rolling ของอนาคต)
    holidays.json   วันหยุดดิบ ให้ JS คำนวณ feature เทศกาลเองแบบเดียวกับฝั่ง Node

ข้อจำกัดที่ต้องรู้: โมเดลใช้ acc_roll7_prev / acc_roll28_prev / acc_same_dow_mean_prev
ซึ่งต้องรู้จำนวนอุบัติเหตุจริงของวันก่อนหน้า — ข้อมูลนั้นไม่มีให้แบบเรียลไทม์
สำหรับวันในอนาคตจึงแทนด้วยค่าเฉลี่ยรายจังหวัดจากปีล่าสุด (แยกตามเดือน/วันในสัปดาห์)
ทำให้ทำนายอนาคตได้ แต่ความแม่นจะต่ำกว่าตัวเลขในรายงานซึ่งวัดบนประวัติจริง

    python train/export_web.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import numpy as np
import pandas as pd
import xgboost as xgb

ROOT = Path(__file__).resolve().parent.parent
PANEL = ROOT / "data" / "processed" / "panel.csv"
PROVINCE_REF = ROOT / "data" / "reference" / "provinces.json"
MODEL_DIR = ROOT / "train" / "artifacts" / "xgboost"
# ai-pipeline อยู่ใต้ repo ของเว็บ โฟลเดอร์แม่จึงเป็น root ของเว็บอยู่แล้ว
OUT = ROOT.parent / "data" / "ai"

# ปฏิทินวันหยุดถูก cache ไว้ตอน build แล้ว อ่านซ้ำจากที่เดิม
ICS_CACHE_DIR = ROOT / "data" / "raw"

# เพดาน/พื้นของความน่าจะเป็นที่ยอมให้แสดง (ดูเหตุผลตรงที่เขียนลง model.json)
CLAMP_FLOOR = 0.01
CLAMP_CEIL = 0.99

# ฟีเจอร์ประวัติที่อนาคตไม่รู้ค่าจริง ต้องประมาณจากค่าเฉลี่ย
HISTORY_FEATURES = ["acc_roll7_prev", "acc_roll28_prev", "acc_same_dow_mean_prev"]

# ฟีเจอร์ที่คงที่ต่อจังหวัด (ค่าเดียวตลอดช่วงเวลา) — ส่งไปฝั่งเว็บทั้งก้อน
STATIC_FEATURES = [
    "highway_km", "vehicle_km", "avg_lanes", "road_km_per_area",
    "pct_curve_prev", "pct_slope_prev", "pct_junction_prev",
    "population", "area_km2", "log_population",
    "motorcycle_per_capita", "vehicle_density",
    "osm_motorway_ways", "osm_trunk_ways", "osm_primary_ways",
    "osm_secondary_ways", "osm_traffic_signals",
]


def flatten_tree(tree: dict) -> list:
    """
    แปลงต้นไม้หนึ่งต้นจากโครงสร้างภายในของ XGBoost เป็น array แบน

    แต่ละโหนดเก็บเป็น [feature, threshold, yes, no, missing]
    ใบไม้เก็บเป็น [-1, value, 0, 0, 0] — ใช้ -1 เป็นเครื่องหมายว่าเป็นใบ

    ⚠️ ห้ามใช้ booster.get_dump(dump_format="json") ตรงนี้
    ดัมป์นั้นให้ค่า split_condition ผิดในบางโหนด — เจอค่า -2147483648 (INT32_MIN)
    โผล่บนฟีเจอร์ที่มีแต่ค่าบวก ทำให้เดินต้นไม้ผิดทาง 30 จาก 171 ต้น
    โครงสร้างภายในที่ save_model() เขียนไว้เป็นค่าจริงที่โมเดลใช้ตอนทำนาย
    """
    left = tree["left_children"]
    right = tree["right_children"]
    conditions = tree["split_conditions"]
    indices = tree["split_indices"]
    default_left = tree["default_left"]

    nodes = []
    for i in range(len(left)):
        if left[i] == -1:
            # โหนดใบ: XGBoost เก็บค่าที่ใบไว้ในช่อง split_conditions ช่องเดียวกัน
            nodes.append([-1, float(conditions[i]), 0, 0, 0])
        else:
            # ค่าใน JSON ถูกตัดทศนิยมมาแล้ว ต้องดึงกลับเป็น float32 ตัวจริง
            # ไม่งั้นค่าที่อยู่ติดเส้นแบ่งจะเทียบได้คนละผลกับที่ XGBoost ทำ
            # (XGBoost เทียบด้วย float32 ทั้งข้อมูลและ threshold)
            nodes.append([
                int(indices[i]),
                float(np.float32(conditions[i])),
                int(left[i]),
                int(right[i]),
                int(left[i]) if default_left[i] else int(right[i]),
            ])
    return nodes


def dump_model(model_file: Path, features: list[str]) -> dict:
    booster = xgb.Booster()
    booster.load_model(str(model_file))

    internal = json.loads(booster.save_raw(raw_format="json").decode("utf-8"))
    model_trees = internal["learner"]["gradient_booster"]["model"]["trees"]
    trees = [flatten_tree(t) for t in model_trees]

    # split_indices อ้างอิงลำดับ feature ของโมเดลเอง ต้องตรงกับ features.json
    # ไม่งั้น JS จะหยิบค่าผิดคอลัมน์ไปเทียบ threshold
    names = booster.feature_names
    if names is not None:
        assert list(names) == features, "ลำดับ feature ในโมเดลไม่ตรงกับ features.json"

    config = json.loads(booster.save_config())
    # XGBoost รุ่นใหม่คืนค่านี้เป็นสตริงเวกเตอร์ เช่น '[4.2106387E-1]'
    # (รองรับ multi-target) ส่วนรุ่นเก่าคืนเป็นตัวเลขล้วน — รับทั้งสองแบบ
    raw_base = str(config["learner"]["learner_model_param"]["base_score"]).strip()
    base_score = float(raw_base.strip("[]").split(",")[0])

    # เทรนด้วย early stopping ต้นไม้หลังรอบที่ดีที่สุดจึงถูกทิ้ง
    # Booster.predict ตัดให้เองตาม best_iteration แต่ get_dump คืนมาทั้งหมด
    # ถ้าไม่ตัดตรงนี้ ฝั่งเว็บจะบวกต้นไม้เกินมาแล้วได้คนละคำตอบกับ Python
    best = booster.attr("best_iteration")
    if best is not None:
        trees = trees[: int(best) + 1]

    return {
        "trees": trees,
        "base_score": base_score,
        "n_trees": len(trees),
        "n_trees_saved": len(model_trees),
    }


def province_history(panel: pd.DataFrame) -> dict:
    """
    ค่าเฉลี่ยจำนวนอุบัติเหตุรายจังหวัด ใช้แทนฟีเจอร์ rolling ของวันในอนาคต

    ตัด 90 วันท้ายทิ้ง เพราะยังมี reporting lag ตัวเลขจะต่ำกว่าจริง
    แล้วใช้ 365 วันก่อนหน้านั้นเป็นฐาน — สดพอที่จะสะท้อนระดับปัจจุบัน
    และยาวพอที่จะครอบคลุมทุกเดือนกับทุกวันในสัปดาห์
    """
    panel = panel[panel["is_recent_90d"] == 0]
    end = panel["date"].max()
    recent = panel[panel["date"] > end - pd.Timedelta(days=365)]

    out = {}
    for geocode, group in recent.groupby("geocode"):
        by_month = group.groupby(group["date"].dt.month)["y_accident_count"].mean()
        by_dow = group.groupby("dow")["y_accident_count"].mean()
        out[geocode] = {
            "mean": round(float(group["y_accident_count"].mean()), 4),
            "by_month": {str(k): round(float(v), 4) for k, v in by_month.items()},
            "by_dow": {str(k): round(float(v), 4) for k, v in by_dow.items()},
        }
    return out, str(recent["date"].min().date()), str(end.date())


def main() -> None:
    if not (MODEL_DIR / "features.json").exists():
        raise SystemExit(f"ยังไม่มีโมเดลใน {MODEL_DIR} — รัน `python train/train.py` ก่อน")

    OUT.mkdir(parents=True, exist_ok=True)
    features = json.loads((MODEL_DIR / "features.json").read_text(encoding="utf-8"))
    metrics = json.loads((MODEL_DIR / "metrics.json").read_text(encoding="utf-8"))

    print(f"features: {len(features)}")

    binary = dump_model(MODEL_DIR / "model_binary.json", features)
    count = dump_model(MODEL_DIR / "model_count.json", features)
    print(f"trees: binary {binary['n_trees']} / count {count['n_trees']}")

    calib_x = np.load(MODEL_DIR / "calibrator_x.npy")
    calib_y = np.load(MODEL_DIR / "calibrator_y.npy")

    # isotonic ให้จุดมาเยอะและซ้ำค่ากันมาก บีบให้เหลือเฉพาะจุดที่ทำให้เส้นหักจริง
    keep = [0]
    for i in range(1, len(calib_x) - 1):
        if calib_y[i] != calib_y[i - 1] or calib_y[i] != calib_y[i + 1]:
            keep.append(i)
    keep.append(len(calib_x) - 1)

    model = {
        "generated_at": pd.Timestamp.utcnow().isoformat(),
        "algo": "xgboost",
        "features": features,
        "binary": binary,
        "count": count,
        "calibrator": {
            "x": [round(float(calib_x[i]), 6) for i in keep],
            "y": [round(float(calib_y[i]), 6) for i in keep],
        },
        # isotonic อิ่มตัวที่ 0 กับ 1 พอดีได้ ถ้าทุกวันในถังปลายสุดของชุด valid
        # ออกผลไปทางเดียวกันหมด (กรุงเทพฯ เข้าเงื่อนไขนี้จริง)
        # แต่ "100%" คือการอ้างความแน่นอนที่ข้อมูลจำนวนจำกัดให้ไม่ได้
        # และ "0%" แปลว่ารับประกันว่าปลอดภัย ซึ่งอันตรายกว่า จึงตัดปลายทั้งสองข้าง
        # เก็บไว้ที่นี่ที่เดียว ให้ทั้งฝั่งเว็บและตัวตรวจสอบอ่านค่าเดียวกัน
        "clamp": {"floor": CLAMP_FLOOR, "ceil": CLAMP_CEIL},
        "threshold": metrics.get("tuned_threshold", 0.5),
        # เก็บผลบนชุด test ไว้ให้หน้าเว็บอ้างอิงได้ว่าโมเดลนี้แม่นแค่ไหน
        "metrics": {
            "test_at_tuned": metrics["splits"]["test"]["model_at_tuned"],
            "test_at_half": metrics["splits"]["test"]["model_at_0.5"],
            "baseline": metrics["splits"]["test"]["baseline_province_dow"],
            "count_mae": metrics["count_model"]["test_mae"],
        },
        "history_features": HISTORY_FEATURES,
    }
    (OUT / "model.json").write_text(json.dumps(model, ensure_ascii=False), encoding="utf-8")
    size_kb = (OUT / "model.json").stat().st_size / 1024
    print(f"เขียน {OUT / 'model.json'} ({size_kb:.0f} KB)")

    # ---- ฟีเจอร์รายจังหวัด ----
    panel = pd.read_csv(PANEL, parse_dates=["date"], dtype={"geocode": str})
    ref = {p["geocode"]: p for p in json.loads(PROVINCE_REF.read_text(encoding="utf-8"))}

    history, hist_from, hist_to = province_history(panel)
    latest = panel.sort_values("date").groupby("geocode").tail(1).set_index("geocode")

    booster = xgb.Booster()
    booster.load_model(str(MODEL_DIR / "model_binary.json"))
    count_booster = xgb.Booster()
    count_booster.load_model(str(MODEL_DIR / "model_count.json"))

    # ต้องบอก iteration_range เอง — Booster.predict ใช้ต้นไม้ทั้งหมดที่เซฟไว้
    # ไม่ตัดตาม early stopping ให้ ต่างจาก sklearn wrapper ที่ตัดให้
    # ตัวเลขที่ต้องยึดคือแบบตัด เพราะ calibrator กับ threshold ถูกฟิตบนค่านั้น
    binary_range = (0, int(booster.attr("best_iteration")) + 1)
    count_range = (0, int(count_booster.attr("best_iteration")) + 1)

    # ---- ค่า "วันธรรมดา" ของแต่ละจังหวัด ----
    #
    # ความน่าจะเป็นดิบใช้ตัดสินข้ามจังหวัดไม่ได้ — กรุงเทพฯ ได้ 99% ทุกวัน
    # เพราะทางหลวงในเมืองแทบไม่มีวันไหนไม่เกิดเหตุ ส่วนจังหวัดเล็กอาจต่ำทั้งปี
    # ถ้าใช้เกณฑ์ตายตัว การ์ดจะขึ้น "เสี่ยงสูง" ทุกวันในกรุงเทพฯ จนผู้ใช้เลิกอ่าน
    #
    # จึงเก็บ median ของสิ่งที่ "โมเดลเองทำนาย" ตลอดปีล่าสุดของจังหวัดนั้น
    # แล้วให้ฝั่งเว็บเทียบวันนี้กับค่านี้ — เทียบของชนิดเดียวกัน ไม่ใช่เอา
    # ค่าทำนายไปเทียบกับค่าจริงซึ่งมี bias คนละแบบ
    year = panel[panel["date"] > panel["date"].max() - pd.Timedelta(days=365)]
    year_matrix = xgb.DMatrix(year[features])
    year_raw = booster.predict(year_matrix, iteration_range=binary_range)
    year_count = count_booster.predict(year_matrix, iteration_range=count_range)
    year_prob = np.clip(np.interp(year_raw, calib_x, calib_y), CLAMP_FLOOR, CLAMP_CEIL)

    typical = {}
    for geocode, group in year.assign(_p=year_prob, _c=year_count).groupby("geocode"):
        typical[geocode] = {
            "probability": round(float(group["_p"].median()), 4),
            "count": round(float(group["_c"].median()), 4),
        }

    provinces = []
    for geocode, row in latest.iterrows():
        info = ref.get(geocode, {})
        static = {}
        for feat in STATIC_FEATURES:
            if feat not in panel.columns:
                continue
            value = row[feat]
            static[feat] = None if pd.isna(value) else float(value)
        provinces.append({
            "geocode": geocode,
            "name": row["province"],
            "lat": info.get("lat"),
            "lon": info.get("lon"),
            "static": static,
            "history": history.get(geocode, {"mean": 0, "by_month": {}, "by_dow": {}}),
            "typical": typical.get(geocode),
        })

    provinces_doc = {
        "generated_at": pd.Timestamp.utcnow().isoformat(),
        "history_window": {"from": hist_from, "to": hist_to},
        "provinces": sorted(provinces, key=lambda p: p["geocode"]),
    }
    (OUT / "provinces.json").write_text(
        json.dumps(provinces_doc, ensure_ascii=False), encoding="utf-8"
    )
    print(f"เขียน {OUT / 'provinces.json'} ({len(provinces)} จังหวัด)")

    # ---- ชุดตรวจสอบ: ให้ฝั่ง JS ทำนายแล้วต้องได้ค่าเดียวกัน ----
    sample = panel.sort_values("date").tail(20000).sample(60, random_state=7)
    matrix = xgb.DMatrix(sample[features])
    raw = booster.predict(matrix, iteration_range=binary_range)
    expected = count_booster.predict(matrix, iteration_range=count_range)
    calibrated = np.clip(np.interp(raw, calib_x, calib_y), CLAMP_FLOOR, CLAMP_CEIL)

    cases = []
    for i, (_, row) in enumerate(sample.iterrows()):
        cases.append({
            "province": row["province"],
            "date": str(row["date"].date()),
            "x": [None if pd.isna(row[f]) else float(row[f]) for f in features],
            "raw": float(raw[i]),
            "calibrated": float(calibrated[i]),
            "count": float(expected[i]),
        })
    (ROOT / "train" / "artifacts" / "web_validation.json").write_text(
        json.dumps(cases, ensure_ascii=False), encoding="utf-8"
    )
    print(f"เขียนชุดตรวจสอบ {len(cases)} เคส")


if __name__ == "__main__":
    main()
