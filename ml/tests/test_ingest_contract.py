import json
import re
from pathlib import Path

from edgelab.predict import predict_rows
from edgelab.venues import venue_rows

ROOT = Path(__file__).resolve().parents[2]

def test_boat_venue_master_matches_official_codes_and_race_venue_ids():
    rows = venue_rows()
    assert len(rows) == 24
    assert rows[0] == {"id": "01", "sport": "boat", "name": "桐生"}
    assert rows[-1] == {"id": "24", "sport": "boat", "name": "大村"}
    parser = (ROOT / "ml/edgelab/parsers/boatrace_b.py").read_text()
    assert '"venue_id": current_venue' in parser

def test_predict_and_model_rows_satisfy_api_ingest_required_fields():
    source = (ROOT / "apps/api/src/index.ts").read_text()
    prediction_required = re.search(r"predictions:\{table:'predictions',required:\[(.*?)\]", source).group(1)
    model_required = re.search(r"models:\{table:'models',required:\[(.*?)\]", source).group(1)
    prediction_required = re.findall(r"'([^']+)'", prediction_required)
    model_required = re.findall(r"'([^']+)'", model_required)
    pred = predict_rows([{"race_id":"boat-20990101-01-01","number":1,"available_at":"2098-12-31T00:00:00+00:00"}],
                        {"metadata":{"id":"boat-win-v1","status":"untrained"}},
                        predicted_at="2099-01-01T00:00:00+00:00")[0]
    model = {"id":"boat-win-v1","sport":"boat","bet_type":"win","version":"v1",
             "algorithm":"lightgbm","status":"untrained"}
    assert all(key in pred for key in prediction_required)
    assert all(key in model for key in model_required)
    assert json.loads(json.dumps(pred, sort_keys=True)) == {
        "id":"boat-20990101-01-01:boat-win-v1:1:2099-01-01T00:00:00+00:00",
        "race_id":"boat-20990101-01-01","number":1,"model_id":"boat-win-v1",
        "probability":None,"prob_std":None,"predicted_at":"2099-01-01T00:00:00+00:00","data_origin":"real"}
