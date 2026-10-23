import json
import math
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from django.http import JsonResponse
from django.views.decorators.http import require_GET, require_POST

from datetime import datetime, timezone
from django.views.decorators.csrf import csrf_exempt
from .checkpoints import generate_checkpoints
from .route_weather import fetch_checkpoint_weather
from .risk import score_checkpoint_weather, summarize_route_risk


OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"


@require_GET
def get_weather(request):
    """Return current weather and a 48-hour hourly forecast for coordinates."""

    latitude = request.GET.get("latitude")
    longitude = request.GET.get("longitude")

    if latitude is None or longitude is None:
        return JsonResponse(
            {
                "error": "Both latitude and longitude are required."
            },
            status=400,
        )

    try:
        latitude = float(latitude)
        longitude = float(longitude)
    except (TypeError, ValueError):
        return JsonResponse(
            {"error": "Latitude and longitude must be valid numbers."},
            status=400,
        )

    if not -90 <= latitude <= 90:
        return JsonResponse(
            {"error": "Latitude must be between -90 and 90."},
            status=400,
        )

    if not -180 <= longitude <= 180:
        return JsonResponse(
            {"error": "Longitude must be between -180 and 180."},
            status=400,
        )

    params = {
        "latitude": latitude,
        "longitude": longitude,
        "current": (
            "temperature_2m,"
            "relative_humidity_2m,"
            "apparent_temperature,"
            "precipitation,"
            "rain,"
            "showers,"
            "snowfall,"
            "weather_code,"
            "wind_speed_10m,"
            "wind_gusts_10m"
        ),
        "hourly": (
            "temperature_2m,"
            "precipitation_probability,"
            "precipitation,"
            "rain,"
            "snowfall,"
            "weather_code,"
            "wind_speed_10m,"
            "wind_gusts_10m,"
            "visibility"
        ),
        "forecast_hours": 48,
        "timezone": "UTC",
    }

    url = f"{OPEN_METEO_URL}?{urlencode(params)}"
    api_request = Request(
        url,
        headers={"User-Agent": "WeatherAwareTruckRouting/1.0"},
    )

    try:
        with urlopen(api_request, timeout=15) as response:
            data = json.loads(response.read().decode("utf-8"))

    except HTTPError as exc:
        return JsonResponse(
            {"error": "The weather provider returned an HTTP error."},
            status=502,
        )
    except (URLError, TimeoutError):
        return JsonResponse(
            {"error": "Unable to connect to the weather provider."},
            status=502,
        )
    except (json.JSONDecodeError, UnicodeDecodeError):
        return JsonResponse(
            {"error": "The weather provider returned invalid data."},
            status=502,
        )

    current = data.get("current", {})
    hourly = data.get("hourly", {})
    times = hourly.get("time", [])

    hourly_fields = [
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

    forecast = []

    for index, timestamp in enumerate(times):
        checkpoint_weather = {"time": timestamp}

        for field in hourly_fields:
            values = hourly.get(field, [])
            checkpoint_weather[field] = (
                values[index] if index < len(values) else None
            )

        forecast.append(checkpoint_weather)

    return JsonResponse(
        {
            "location": {
                "latitude": data.get("latitude"),
                "longitude": data.get("longitude"),
                "timezone": data.get("timezone"),
            },
            "units": {
                "temperature": "°C",
                "wind_speed": "km/h",
                "precipitation": "mm",
                "visibility": "m",
            },
            "current": current,
            "hourly": forecast,
            "source": "Open-Meteo",
        }
    )


@csrf_exempt
@require_POST
def analyze_route_weather(request):
    """Generate checkpoints and attach forecast weather to each one."""

    try:
        data = json.loads(request.body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return JsonResponse({"error": "Invalid JSON."}, status=400)

    if not isinstance(data, dict):
        return JsonResponse(
            {"error": "Request body must be a JSON object."},
            status=400,
        )

    try:
        geometry = data["geometry"]
        distance_miles = float(data["distance_miles"])
        duration_seconds = float(data["duration_seconds"])
        interval_miles = int(data.get("interval_miles", 25))

        departure_value = data["departure_time"]
        if not isinstance(departure_value, str):
            raise ValueError("Departure time must be a string.")

        departure = datetime.fromisoformat(
            departure_value.replace("Z", "+00:00")
        )

        if departure.tzinfo is None:
            raise ValueError("Departure time must include a timezone.")

        departure = departure.astimezone(timezone.utc)

        if (
            not math.isfinite(distance_miles)
            or not math.isfinite(duration_seconds)
            or distance_miles <= 0
            or duration_seconds <= 0
        ):
            raise ValueError(
                "Distance and duration must be positive finite numbers."
            )

        checkpoints = generate_checkpoints(
            geometry,
            distance_miles,
            interval_miles,
        )

        for checkpoint in checkpoints:
            fraction = checkpoint["distance_miles"] / distance_miles
            arrival_timestamp = (
                departure.timestamp() + fraction * duration_seconds
            )
            checkpoint["arrival_time"] = (
                datetime.fromtimestamp(
                    arrival_timestamp,
                    tz=timezone.utc,
                )
                .isoformat()
                .replace("+00:00", "Z")
            )

    except (KeyError, TypeError, ValueError, OverflowError) as exc:
        return JsonResponse(
            {"error": str(exc) or "Invalid route parameters."},
            status=400,
        )

    try:
        checkpoints_with_weather = fetch_checkpoint_weather(checkpoints)

        for checkpoint in checkpoints_with_weather:
            checkpoint["risk"] = score_checkpoint_weather(
                checkpoint.get("weather")
                if checkpoint.get("weather_status") == "available"
                else None
            )

        route_risk = summarize_route_risk(checkpoints_with_weather)

    except RuntimeError as exc:
        return JsonResponse(
            {"error": str(exc)},
            status=502,
        )

    return JsonResponse({
        "status": "ok",
        "distance_miles": distance_miles,
        "duration_seconds": duration_seconds,
        "interval_miles": interval_miles,
        "checkpoint_count": len(checkpoints_with_weather),
        "checkpoints": checkpoints_with_weather,
        "route_risk": route_risk,
        "weather_source": "Open-Meteo",
    })

@csrf_exempt
@require_POST
def analyze_route_checkpoints(request):
    """Generate route checkpoints and estimated arrival times."""

    try:
        data = json.loads(request.body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return JsonResponse({"error": "Invalid JSON."}, status=400)

    if not isinstance(data, dict):
        return JsonResponse(
            {"error": "Request body must be a JSON object."},
            status=400,
        )

    try:
        geometry = data["geometry"]
        distance_miles = float(data["distance_miles"])
        duration_seconds = float(data["duration_seconds"])
        interval_miles = int(data.get("interval_miles", 25))

        departure_value = data["departure_time"]
        if not isinstance(departure_value, str):
            raise ValueError("Departure time must be a string.")

        departure = datetime.fromisoformat(
            departure_value.replace("Z", "+00:00")
        )

        if departure.tzinfo is None:
            raise ValueError("Departure time must include a timezone.")

        departure = departure.astimezone(timezone.utc)

        if (
            not math.isfinite(distance_miles)
            or not math.isfinite(duration_seconds)
            or distance_miles <= 0
            or duration_seconds <= 0
        ):
            raise ValueError(
                "Distance and duration must be positive finite numbers."
            )

        checkpoints = generate_checkpoints(
            geometry,
            distance_miles,
            interval_miles,
        )

    except (KeyError, TypeError, ValueError, OverflowError) as exc:
        return JsonResponse(
            {"error": str(exc) or "Invalid route parameters."},
            status=400,
        )

    for checkpoint in checkpoints:
        fraction = checkpoint["distance_miles"] / distance_miles
        arrival_timestamp = (
            departure.timestamp() + fraction * duration_seconds
        )

        checkpoint["arrival_time"] = (
            datetime.fromtimestamp(
                arrival_timestamp,
                tz=timezone.utc,
            )
            .isoformat()
            .replace("+00:00", "Z")
        )

    return JsonResponse({
        "status": "ok",
        "distance_miles": distance_miles,
        "duration_seconds": duration_seconds,
        "interval_miles": interval_miles,
        "checkpoint_count": len(checkpoints),
        "checkpoints": checkpoints,
    })

@csrf_exempt
@require_POST
def analyze_route_checkpoints(request):
    """Generate route checkpoints and estimated arrival times."""

    try:
        data = json.loads(request.body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return JsonResponse({"error": "Invalid JSON."}, status=400)

    if not isinstance(data, dict):
        return JsonResponse(
            {"error": "Request body must be a JSON object."},
            status=400,
        )

    try:
        geometry = data["geometry"]
        distance_miles = float(data["distance_miles"])
        duration_seconds = float(data["duration_seconds"])
        interval_miles = int(data.get("interval_miles", 25))

        departure_value = data["departure_time"]
        if not isinstance(departure_value, str):
            raise ValueError("Departure time must be a string.")

        departure = datetime.fromisoformat(
            departure_value.replace("Z", "+00:00")
        )

        if departure.tzinfo is None:
            raise ValueError("Departure time must include a timezone.")

        departure = departure.astimezone(timezone.utc)

        if (
            not math.isfinite(distance_miles)
            or not math.isfinite(duration_seconds)
            or distance_miles <= 0
            or duration_seconds <= 0
        ):
            raise ValueError(
                "Distance and duration must be positive finite numbers."
            )

        checkpoints = generate_checkpoints(
            geometry,
            distance_miles,
            interval_miles,
        )

    except (KeyError, TypeError, ValueError, OverflowError) as exc:
        return JsonResponse(
            {"error": str(exc) or "Invalid route parameters."},
            status=400,
        )

    for checkpoint in checkpoints:
        fraction = checkpoint["distance_miles"] / distance_miles
        arrival_timestamp = (
            departure.timestamp() + fraction * duration_seconds
        )

        checkpoint["arrival_time"] = (
            datetime.fromtimestamp(
                arrival_timestamp,
                tz=timezone.utc,
            )
            .isoformat()
            .replace("+00:00", "Z")
        )

    return JsonResponse({
        "status": "ok",
        "distance_miles": distance_miles,
        "duration_seconds": duration_seconds,
        "interval_miles": interval_miles,
        "checkpoint_count": len(checkpoints),
        "checkpoints": checkpoints,
    })
