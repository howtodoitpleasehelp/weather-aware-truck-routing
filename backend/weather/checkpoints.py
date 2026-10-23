import math


EARTH_RADIUS_MILES = 3958.7613


def haversine_miles(point_a, point_b):
    """Calculate distance between [lon, lat] points in miles."""
    lon1, lat1 = map(math.radians, point_a)
    lon2, lat2 = map(math.radians, point_b)

    dlat = lat2 - lat1
    dlon = lon2 - lon1

    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    )

    return 2 * EARTH_RADIUS_MILES * math.asin(
        math.sqrt(min(1.0, a))
    )


def interpolate_point(start, end, fraction):
    """Interpolate between two [lon, lat] coordinates."""
    return [
        start[0] + (end[0] - start[0]) * fraction,
        start[1] + (end[1] - start[1]) * fraction,
    ]


def generate_checkpoints(geometry, route_distance_miles, interval_miles):
    """
    Generate checkpoint coordinates along a GeoJSON LineString.

    Checkpoints are placed at the origin, each requested interval,
    and the destination. Distances are scaled to the route distance
    supplied by the routing service.
    """
    if interval_miles not in (10, 25, 50):
        raise ValueError("Interval must be 10, 25, or 50 miles.")

    if route_distance_miles <= 0:
        raise ValueError("Route distance must be positive.")

    if not isinstance(geometry, dict):
        raise ValueError("Invalid route geometry.")

    if geometry.get("type") != "LineString":
        raise ValueError("Route geometry must be a LineString.")

    coordinates = geometry.get("coordinates", [])

    if len(coordinates) < 2:
        raise ValueError("At least two route coordinates are required.")

    for point in coordinates:
        if not isinstance(point, (list, tuple)) or len(point) < 2:
            raise ValueError("Invalid route coordinate.")

        lon, lat = point[:2]

        if not (
            isinstance(lon, (int, float))
            and isinstance(lat, (int, float))
            and math.isfinite(lon)
            and math.isfinite(lat)
            and -180 <= lon <= 180
            and -90 <= lat <= 90
        ):
            raise ValueError("Route coordinates are out of range.")

    cumulative = [0.0]

    for index in range(1, len(coordinates)):
        segment_distance = haversine_miles(
            coordinates[index - 1][:2],
            coordinates[index][:2],
        )
        cumulative.append(cumulative[-1] + segment_distance)

    geometry_distance = cumulative[-1]

    if geometry_distance <= 0:
        raise ValueError("Route geometry has no measurable distance.")

    # Scale geometry distances to match Valhalla's reported distance.
    scale = route_distance_miles / geometry_distance
    total_distance = route_distance_miles

    distances = [0.0]
    current = interval_miles

    while current < total_distance:
        distances.append(float(current))
        current += interval_miles

    if total_distance > 0:
        distances.append(total_distance)

    checkpoints = []
    segment_index = 1

    for distance in distances:
        geometry_target = distance / scale

        while (
            segment_index < len(cumulative) - 1
            and cumulative[segment_index] < geometry_target
        ):
            segment_index += 1

        segment_start_distance = cumulative[segment_index - 1]
        segment_end_distance = cumulative[segment_index]

        segment_length = segment_end_distance - segment_start_distance

        fraction = (
            (geometry_target - segment_start_distance) / segment_length
            if segment_length > 0
            else 0.0
        )

        coordinate = interpolate_point(
            coordinates[segment_index - 1],
            coordinates[segment_index],
            fraction,
        )

        checkpoints.append({
            "distance_miles": round(distance, 2),
            "longitude": coordinate[0],
            "latitude": coordinate[1],
        })

    return checkpoints
