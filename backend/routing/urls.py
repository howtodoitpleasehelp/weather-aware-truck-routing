from django.urls import path
from .views import (
    health_check,
    get_routes,
    geocode_address,
    reverse_geocode,
)

urlpatterns = [
    path("health/", health_check, name="health_check"),
    path("routes/", get_routes, name="get_routes"),
    path("geocode/", geocode_address, name="geocode_address"),
    path("reverse-geocode/", reverse_geocode, name="reverse_geocode"),
]