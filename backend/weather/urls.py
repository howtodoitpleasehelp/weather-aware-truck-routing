from django.urls import path
from .views import (
    get_weather,
    analyze_route_checkpoints,
    analyze_route_weather,
)

urlpatterns = [
    path("weather/", get_weather, name="get_weather"),
    path(
        "weather/checkpoints/",
        analyze_route_checkpoints,
        name="analyze_route_checkpoints",
    ),
    path(
        "weather/route-analysis/",
        analyze_route_weather,
        name="analyze_route_weather",
    ),
]