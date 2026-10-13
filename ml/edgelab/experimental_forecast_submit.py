"""Submit isolated, one-race experimental forecasts without logging credentials."""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any, Callable


def submit_forecasts(envelope: dict[str, Any], *, base_url: str, token: str,
                     opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any]:
    """POST each race separately and report partial acceptance accurately.

    The API request cap is one race per invocation. No retries are performed,
    so an uncertain response cannot accidentally duplicate later decisions.
    """
    races = envelope.get("races") if isinstance(envelope, dict) else None
    if (not isinstance(races, list) or not 1 <= len(races) <= 4
            or not base_url or not token):
        return {"status": "invalid_request", "storedRaceCount": 0,
                "eligibleRaceCount": len(races) if isinstance(races, list) else 0,
                "reason": "forecast_envelope_or_credentials_invalid"}
    base = base_url.rstrip("/")
    metadata = {key: value for key, value in envelope.items() if key != "races"}
    stored: list[str] = []
    for race in races:
        if (not isinstance(race, dict) or not isinstance(race.get("raceId"), str)
                or not isinstance(race.get("predictions"), list)
                or len(race["predictions"]) != 120):
            return {"status": "partially_stored" if stored else "submission_failed",
                    "storedRaceCount": len(stored), "eligibleRaceCount": len(races),
                    "failedRaceCount": len(races) - len(stored),
                    "reason": "forecast_race_payload_invalid"}
        body = json.dumps({**metadata, "races": [race]}, ensure_ascii=False,
                          allow_nan=False).encode("utf-8")
        request = urllib.request.Request(base + "/api/ingest/experimental-trifecta/forecast",
            data=body, method="POST", headers={"Authorization": "Bearer " + token,
            "Content-Type": "application/json", "Accept": "application/json"})
        try:
            with opener(request, timeout=30) as response:
                result = json.loads(response.read(16384).decode("utf-8"))
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, ValueError, OSError):
            return {"status": "partially_stored" if stored else "submission_failed",
                    "storedRaceCount": len(stored), "eligibleRaceCount": len(races),
                    "failedRaceCount": len(races) - len(stored),
                    "reason": "api_unavailable_or_rejected"}
        accepted = result.get("stored") if isinstance(result, dict) else None
        if (not isinstance(accepted, list) or len(accepted) != 1
                or not isinstance(accepted[0], dict)
                or accepted[0].get("raceId") != race["raceId"]
                or accepted[0].get("modelId") != envelope.get("modelId")
                or accepted[0].get("predictionCount") != 120):
            return {"status": "partially_stored" if stored else "submission_failed",
                    "storedRaceCount": len(stored), "eligibleRaceCount": len(races),
                    "failedRaceCount": len(races) - len(stored),
                    "reason": "invalid_api_response"}
        stored.append(race["raceId"])
    return {"status": "forecast_stored", "storedRaceCount": len(stored),
            "eligibleRaceCount": len(races), "raceIds": stored,
            "decision": "worker T-60 timing gate"}
