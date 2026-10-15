"""Read-only preflight for the exact registered experimental forecast bundle."""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Callable

from edgelab.experimental_forecast_job import (
    ExperimentalForecastJobError,
    resolve_latest_forecast_model,
)
from edgelab.experimental_registry import (
    ForecastOnlyArtifactError,
    validate_forecast_only_artifact,
)


def run_preflight(*, base_url: str, token: str, artifact_dir: str | Path,
                  resolver: Callable[..., dict[str, str]] = resolve_latest_forecast_model,
                  validator: Callable[..., Any] = validate_forecast_only_artifact) -> dict[str, Any]:
    """Check the registry descriptor and exact cached bundle without forecasting or writes."""
    result: dict[str, Any] = {"schema": "experimental-forecast-preflight-v1",
                              "status": "failed", "stage": "resolve", "errorCategory": None,
                              "modelReady": False, "artifactFileCount": 0}
    try:
        model = resolver(base_url, token)
    except ExperimentalForecastJobError as exc:
        result["errorCategory"] = exc.failure_category
        return result
    except Exception:
        result["errorCategory"] = "preflight_unavailable"
        return result

    result["stage"] = "artifact_validation"
    root = Path(artifact_dir)
    try:
        validator(model["modelId"], model["artifactSha256"], artifact_dir=root)
    except ForecastOnlyArtifactError as exc:
        result["errorCategory"] = exc.failure_category
        # Count only the three exact expected artifact slots; never emit names or paths.
        names = (f'{model["modelId"]}.pkl', f'{model["modelId"]}.json',
                 f'experimental-trifecta-{model["modelId"]}.manifest.json')
        result["artifactFileCount"] = sum((root / name).is_file() for name in names)
        return result
    except Exception:
        result["errorCategory"] = "preflight_unavailable"
        return result

    result.update({"status": "ready", "stage": "complete", "errorCategory": None,
                   "modelReady": True, "artifactFileCount": 3})
    return result


def main() -> int:
    result = run_preflight(
        base_url=os.environ.get("EDGELAB_API_URL", ""),
        token=os.environ.get("INGEST_TOKEN", ""),
        artifact_dir=os.environ.get("EXPERIMENTAL_ARTIFACT_DIR", "ml/artifacts"),
    )
    print(json.dumps(result, sort_keys=True), flush=True)
    return 0 if result["status"] == "ready" else 1


if __name__ == "__main__":
    raise SystemExit(main())
