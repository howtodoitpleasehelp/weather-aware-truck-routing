
import json
import requests

from django.conf import settings
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST


VALHALLA_BASE_URL = getattr(
    settings,
    "VALHALLA_BASE_URL",
    "https://valhalla1.openstreetmap.de",
)


def health_check(request):
    return JsonResponse({
        "status": "ok",
        "message": "Weather-Aware Truck Routing API is running",
    })


def valid_coordinate(point):
    if not isinstance(point, dict):
        return False

    try:
        lat = float(point["lat"])
        lon = float(point["lon"])
    except (KeyError, TypeError, ValueError):
        return False

    return -90 <= lat <= 90 and -180 <= lon <= 180


@csrf_exempt
@require_POST
def get_routes(request):
    try:
        data = json.loads(request.body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return JsonResponse(
            {"error": "Request body must contain valid JSON."},
            status=400,
        )

    if not isinstance(data, dict):
        return JsonResponse(
            {"error": "Request body must be a JSON object."},
            status=400,
        )

    origin = data.get("origin")
    destination = data.get("destination")

    if not valid_coordinate(origin) or not valid_coordinate(destination):
        return JsonResponse(
            {"error": "Origin and destination must contain valid lat and lon values."},
            status=400,
        )

    payload = {
        "locations": [
            {"lat": float(origin["lat"]), "lon": float(origin["lon"])},
            {"lat": float(destination["lat"]), "lon": float(destination["lon"])},
        ],
        "costing": "truck",
        "units": "miles",
        "format": "osrm",
        "shape_format": "geojson",
        "directions_type": "none",
        "alternates": 2,
    }

    try:
        response = requests.post(
            f"{VALHALLA_BASE_URL.rstrip('/')}/route",
            json=payload,
            timeout=25,
        )
        response.raise_for_status()
        result = response.json()

    except requests.Timeout:
        return JsonResponse(
            {"error": "The routing service timed out. Please try again."},
            status=504,
        )
    except requests.RequestException:
        return JsonResponse(
            {"error": "The routing service is currently unavailable."},
            status=502,
        )
    except ValueError:
        return JsonResponse(
            {"error": "The routing service returned invalid JSON."},
            status=502,
        )

    if result.get("code") != "Ok":
        return JsonResponse(
            {
                "error": result.get(
                    "message",
                    "No route could be found for these locations.",
                )
            },
            status=422,
        )

    routes = []

    for index, route in enumerate(result.get("routes", []), start=1):
        geometry = route.get("geometry")

        if not isinstance(geometry, dict):
            continue

        if geometry.get("type") != "LineString":
            continue

        coordinates = geometry.get("coordinates", [])

        if len(coordinates) < 2:
            continue

        distance_meters = route.get("distance")
        duration_seconds = route.get("duration")

        if distance_meters is None or duration_seconds is None:
            continue

        # Convert Valhalla's returned distance from meters to miles.
        distance_miles = float(distance_meters) / 1609.344

        routes.append({
            "id": index,
            "name": f"Route {index}",
            "distance_miles": round(distance_miles, 2),
            "duration_seconds": round(float(duration_seconds), 2),
            "duration_minutes": round(float(duration_seconds) / 60, 1),
            "geometry": geometry,
        })

    if not routes:
        return JsonResponse(
            {"error": "No usable routes were returned by the routing service."},
            status=502,
        )

    return JsonResponse({
        "status": "ok",
        "route_count": len(routes),
        "requested_route_count": 3,
        "routes": routes,
    })


@csrf_exempt
@require_POST
def geocode_address(request):
    """Convert a U.S. address into coordinates."""
    try:
        data = json.loads(request.body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return JsonResponse({"error": "Invalid JSON."}, status=400)

    address = data.get("address", "").strip() if isinstance(data, dict) else ""

    if not address:
        return JsonResponse({"error": "Please enter an address."}, status=400)

    try:
        response = requests.get(
            "https://nominatim.openstreetmap.org/search",
            params={
                "q": address,
                "format": "jsonv2",
                "limit": 1,
                "countrycodes": "us",
            },
            headers={"User-Agent": "WeatherAwareTruckRouting/0.1"},
            timeout=10,
        )
        response.raise_for_status()
        results = response.json()
    except (requests.RequestException, ValueError):
        return JsonResponse(
            {"error": "Address lookup is temporarily unavailable."},
            status=502,
        )

    if not results:
        return JsonResponse(
            {"error": "No matching U.S. address was found."},
            status=404,
        )

    result = results[0]

    return JsonResponse({
        "address": result["display_name"],
        "lat": float(result["lat"]),
        "lon": float(result["lon"]),
    })


@csrf_exempt
@require_POST
def reverse_geocode(request):
    """Convert map coordinates into a readable address."""
    try:
        data = json.loads(request.body)
        lat = float(data["lat"])
        lon = float(data["lon"])
    except (
        json.JSONDecodeError,
        UnicodeDecodeError,
        KeyError,
        TypeError,
        ValueError,
    ):
        return JsonResponse(
            {"error": "Valid latitude and longitude are required."},
            status=400,
        )

    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return JsonResponse({"error": "Coordinates are out of range."}, status=400)

    try:
        response = requests.get(
            "https://nominatim.openstreetmap.org/reverse",
            params={
                "lat": lat,
                "lon": lon,
                "format": "jsonv2",
            },
            headers={"User-Agent": "WeatherAwareTruckRouting/0.1"},
            timeout=10,
        )
        response.raise_for_status()
        result = response.json()
    except (requests.RequestException, ValueError):
        return JsonResponse(
            {"error": "Address lookup is temporarily unavailable."},
            status=502,
        )

    return JsonResponse({
        "address": result.get("display_name", f"{lat:.5f}, {lon:.5f}"),
        "lat": lat,
        "lon": lon,
    })
