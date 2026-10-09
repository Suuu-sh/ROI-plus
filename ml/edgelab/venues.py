"""Official Japanese boat-racing venue master."""
VENUE_NAMES = (
    "桐生", "戸田", "江戸川", "平和島", "多摩川", "浜名湖", "蒲郡", "常滑",
    "津", "三国", "びわこ", "住之江", "尼崎", "鳴門", "丸亀", "児島",
    "宮島", "徳山", "下関", "若松", "芦屋", "福岡", "唐津", "大村",
)

def venue_rows():
    return [{"id": f"{i:02d}", "sport": "boat", "name": name}
            for i, name in enumerate(VENUE_NAMES, 1)]
