
import json
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"

HOURLY_FIELDS = [
    "temperature_2m",
    "precipitation_probability",
    "precipitation",
    "rain",
    "snowfall",
    "weather_code",
    "wind_speed_10m",
    "wind_gusts_10m",
    "visibility",
]


def fetch_checkpoint_weather(checkpoints):
    """
    Fetch forecast data for checkpoint coordinates and match each
    checkpoint to its estimated arrival hour.
    """
    if not checkpoints:
        return []

    # Open-Meteo accepts comma-separated coordinates for multiple locations.
    params = {
        "latitude": ",".join(
            str(point["latitude"]) for point in checkpoints
        ),
        "longitude": ",".join(
            str(point["longitude"]) for point in checkpoints
        ),
        "hourly": ",".join(HOURLY_FIELDS),
        "forecast_hours": 48,
        "timezone": "UTC",
    }

    url = f"{OPEN_METEO_URL}?{urlencode(params)}"
    request = Request(
        url,
        headers={"User-Agent": "WeatherAwareTruckRouting/1.0"},
    )

    try:
        with urlopen(request, timeout=20) as response:
            data = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        raise RuntimeError(
            f"Weather provider returned HTTP {exc.code}."
        ) from exc
    except (URLError, TimeoutError) as exc:
        raise RuntimeError(
            "Unable to connect to the weather provider."
        ) from exc
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise RuntimeError(
            "Weather provider returned invalid JSON."
        ) from exc

    # A single location may be returned as an object, while multiple
    # locations are generally returned as a list of objects.
    locations = data if isinstance(data, list) else [data]

    if len(locations) != len(checkpoints):
        raise RuntimeError(
            "Weather provider returned an unexpected number of locations."
        )

    results = []

    for checkpoint, location_data in zip(checkpoints, locations):
        hourly = location_data.get("hourly", {})
        times = hourly.get("time", [])

        if not times:
            results.append({
                **checkpoint,
                "weather": None,
                "weather_status": "unavailable",
            })
            continue

        arrival = datetime.fromisoformat(
            checkpoint["arrival_time"].replace("Z", "+00:00")
        ).astimezone(timezone.utc)

        forecast_times = [
            datetime.fromisoformat(timestamp).replace(tzinfo=timezone.utc)
            for timestamp in times
        ]

        # Match the closest hourly forecast only if it is within 30 minutes.
        closest_index = min(
            range(len(forecast_times)),
            key=lambda i: abs((forecast_times[i] - arrival).total_seconds()),
        )

        difference_minutes = abs(
            (forecast_times[closest_index] - arrival).total_seconds()
        ) / 60

        if difference_minutes > 30:
            results.append({
                **checkpoint,
                "weather": None,
                "weather_status": "outside_forecast_window",
            })
            continue

        weather = {
            field: (
                hourly[field][closest_index]
                if closest_index < len(hourly.get(field, []))
                else None
            )
            for field in HOURLY_FIELDS
        }
        weather["forecast_time"] = times[closest_index]

        results.append({
            **checkpoint,
            "weather": weather,
            "weather_status": "available",
        })

    return results
