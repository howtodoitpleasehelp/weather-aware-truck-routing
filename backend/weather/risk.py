
def score_checkpoint_weather(weather):
    """
    Estimate weather risk on a 0-100 scale.
    This is a prototype heuristic, not an official safety rating.
    """

    if not isinstance(weather, dict):
        return {
            "score": None,
            "level": "unavailable",
            "factors": [],
        }

    score = 0
    factors = []

    def add_risk(points, message):
        nonlocal score
        score += points
        if points:
            factors.append({
                "points": points,
                "description": message,
            })

    # Precipitation probability: 0-25 points
    probability = weather.get("precipitation_probability")
    if probability is not None:
        if probability >= 80:
            add_risk(25, "Very high precipitation probability")
        elif probability >= 60:
            add_risk(20, "High precipitation probability")
        elif probability >= 40:
            add_risk(14, "Moderate precipitation probability")
        elif probability >= 20:
            add_risk(7, "Some chance of precipitation")

    # Wind gusts in km/h: 0-25 points
    gusts = weather.get("wind_gusts_10m")
    if gusts is not None:
        if gusts >= 80:
            add_risk(25, "Very strong wind gusts")
        elif gusts >= 60:
            add_risk(20, "Strong wind gusts")
        elif gusts >= 40:
            add_risk(12, "Elevated wind gusts")
        elif gusts >= 25:
            add_risk(5, "Moderate wind gusts")

    # Visibility in meters: 0-25 points
    visibility = weather.get("visibility")
    if visibility is not None:
        if visibility < 500:
            add_risk(25, "Extremely poor visibility")
        elif visibility < 1000:
            add_risk(20, "Very poor visibility")
        elif visibility < 2000:
            add_risk(14, "Poor visibility")
        elif visibility < 5000:
            add_risk(7, "Reduced visibility")

    # Weather code: 0-25 points
    code = weather.get("weather_code")

    if code in (95, 96, 99):
        add_risk(25, "Thunderstorm conditions forecast")
    elif code in (71, 73, 75, 77, 85, 86):
        add_risk(20, "Snow or snow showers forecast")
    elif code in (45, 48):
        add_risk(18, "Fog conditions forecast")
    elif code in (65, 82):
        add_risk(18, "Heavy rain or showers forecast")
    elif code in (63, 81):
        add_risk(12, "Moderate rain or showers forecast")
    elif code in (51, 53, 55, 61, 80):
        add_risk(6, "Drizzle, rain, or showers forecast")

    # Maximum possible score is 100.
    score = min(score, 100)

    if score >= 75:
        level = "severe"
    elif score >= 50:
        level = "high"
    elif score >= 25:
        level = "moderate"
    else:
        level = "low"

    return {
        "score": score,
        "level": level,
        "factors": factors,
    }


def summarize_route_risk(checkpoints):
    """Combine available checkpoint scores into a route-level score."""

    scores = [
        point["risk"]["score"]
        for point in checkpoints
        if point.get("risk", {}).get("score") is not None
    ]

    if not scores:
        return {
            "score": None,
            "level": "unavailable",
            "available_checkpoints": 0,
            "total_checkpoints": len(checkpoints),
        }

    average_score = sum(scores) / len(scores)
    worst_score = max(scores)

    # Give the worst checkpoint extra weight so localized hazards matter.
    route_score = round(0.7 * average_score + 0.3 * worst_score)

    if route_score >= 75:
        level = "severe"
    elif route_score >= 50:
        level = "high"
    elif route_score >= 25:
        level = "moderate"
    else:
        level = "low"

    return {
        "score": route_score,
        "level": level,
        "average_checkpoint_score": round(average_score, 1),
        "worst_checkpoint_score": worst_score,
        "available_checkpoints": len(scores),
        "total_checkpoints": len(checkpoints),
    }
