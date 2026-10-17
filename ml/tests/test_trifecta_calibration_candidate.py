"""Synthetic-only candidate safety checks; no real performance evidence."""
import json
import os
import subprocess
import sys
from pathlib import Path

from edgelab.models import trifecta_calibration_candidate as candidate


def test_disabled_does_not_read_eligibility(monkeypatch):
    monkeypatch.setattr(candidate, "_eligible_experimental_training_groups",
                        lambda *args: (_ for _ in ()).throw(AssertionError("must not read")))
    assert candidate.evaluate_calibration_candidate([], {})["status"] == "disabled"


def test_insufficient_no_fit_and_whole_date_split(monkeypatch):
    groups = [[{"race_id": f"r-{day}-{race}", "race_date": f"2026-01-{day:02d}"}]
              for day in range(1, 11) for race in range(2)]
    monkeypatch.setattr(candidate, "_eligible_experimental_training_groups", lambda *args: (groups, {}, {}))
    monkeypatch.setattr(candidate, "_fit", lambda *args: (_ for _ in ()).throw(AssertionError("must not fit")))
    report = candidate.evaluate_calibration_candidate([], {}, enabled=True)
    assert report["status"] == "insufficient_data"
    parts = report["partitions"]
    assert max(parts["train"]["dates"]) < min(parts["calibration"]["dates"])
    assert max(parts["calibration"]["dates"]) < min(parts["test"]["dates"])
    assert [parts[k]["nRaces"] for k in ("train", "calibration", "test")] == [12, 4, 4]
    assert report["promotionEligible"] is False


def test_calibrates_ensemble_before_test_without_refitting(monkeypatch):
    groups = [[{"race_id": f"r-{day}-{race}", "race_date": f"2026-01-{day:02d}"}]
              for day in range(1, 11) for race in range(50)]
    monkeypatch.setattr(candidate, "_eligible_experimental_training_groups", lambda *args: (groups, {}, {}))
    fits, calls = [], []
    def fit(rows, columns):
        assert all(row["race_date"] <= "2026-01-06" for row in rows)
        fits.append(rows)
        return {}
    def ensemble(artifact, group):
        assert len(artifact["bootstrap_models"]) == 4
        calls.append((group[0]["race_date"], artifact["temperature"]))
        p = .1 if artifact["temperature"] == .7 else .05
        return {"actual": p, "other": 1 - p}, {}
    monkeypatch.setattr(candidate, "_fit", fit)
    monkeypatch.setattr(candidate, "ensemble_ordered_triples", ensemble)
    monkeypatch.setattr(candidate, "_actual_selection", lambda group: "actual")
    def metrics(groups, distributions):
        p = distributions[0]["actual"]
        return {"exactOrderLogLoss": 1-p, "multiclassBrier": 1-p, "topTicketEce": 1-p, "nRaces": len(groups)}
    monkeypatch.setattr(candidate, "_proper_ticket_metrics", metrics)
    report = candidate.evaluate_calibration_candidate([], {}, enabled=True)
    assert len(fits) == 5
    assert report["temperature"] == .7
    assert report["descriptiveTestGatePassed"] is True
    assert report["status"] == "evaluated_unqualified"
    assert report["promotionEligible"] is False
    assert report["artifactCreated"] is False
    first_test = next(i for i, (day, _) in enumerate(calls) if day >= "2026-01-09")
    assert all(day >= "2026-01-09" for day, _ in calls[first_test:])
    assert all("2026-01-07" <= day <= "2026-01-08" for day, _ in calls[:first_test])


def test_module_entrypoint_writes_candidate_only_insufficient_report(tmp_path):
    rows, store, report = [tmp_path / name for name in ("rows.json", "store.json", "report.json")]
    rows.write_text("[]")
    store.write_text("{}")
    command = [sys.executable, "-m", "edgelab.models.trifecta_calibration_candidate",
               "--rows", str(rows), "--store", str(store), "--report", str(report)]
    env = {**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1])}
    disabled = subprocess.run(command, capture_output=True, text=True, env=env)
    assert disabled.returncode != 0
    assert not report.exists()
    subprocess.run([*command, "--enable-experimental-candidate"], check=True, env=env)
    result = json.loads(report.read_text())
    assert result["status"] == "insufficient_data"
    assert result["candidateOnly"] is True
    assert result["promotionEligible"] is False
    assert result["artifactCreated"] is False


def test_temperature_ensemble_keeps_exact_120_normalized_probabilities():
    import math
    from edgelab.models.trifecta import _fit, ensemble_ordered_triples
    rows = [{"race_id": "synthetic", "number": lane, "finish_order": lane, "lane": lane}
            for lane in range(1, 7)]
    model = _fit(rows, ["lane"])
    for temperature in (.4, 1.0, 3.0):
        probabilities, spread = ensemble_ordered_triples(
            {"model": model, "bootstrap_models": [model] * 4, "temperature": temperature}, rows)
        assert len(probabilities) == 120
        assert math.isclose(sum(probabilities.values()), 1.0, abs_tol=1e-12)
        assert all(0 < p < 1 for p in probabilities.values())
        assert all(len(set(selection.split("-"))) == 3 for selection in probabilities)
        assert all(value >= 0 for value in spread.values())
