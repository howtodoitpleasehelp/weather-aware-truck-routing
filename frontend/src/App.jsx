
import { useEffect, useMemo, useState } from "react";
import {
  MapContainer,
  Marker,
  Polyline,
  TileLayer,
  useMap,
  useMapEvents,
} from "react-leaflet";
import L from "leaflet";
import api from "./services/api";
import "leaflet/dist/leaflet.css";
import "./App.css";

const DEFAULT_ORIGIN = {
  address: "Chicago, Illinois",
  lat: 41.8781,
  lon: -87.6298,
  manuallyPlaced: false,
};

const DEFAULT_DESTINATION = {
  address: "Indianapolis, Indiana",
  lat: 39.7684,
  lon: -86.1584,
  manuallyPlaced: false,
};

const markerIcon = (color) =>
  L.divIcon({
    className: "custom-marker-wrapper",
    html: `<div style="
      width: 18px; height: 18px; border-radius: 50%;
      background: ${color}; border: 3px solid white;
      box-shadow: 0 1px 6px #333;
    "></div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });

const originIcon = markerIcon("#16865c");
const destinationIcon = markerIcon("#d94841");

function MapClickHandler({ onMapClick, enabled }) {
  useMapEvents({
    click(event) {
      if (enabled) {
        onMapClick({
          lat: event.latlng.lat,
          lon: event.latlng.lng,
        });
      }
    },
  });

  return null;
}

function MapBounds({ routes, origin, destination }) {
  const map = useMap();

  useEffect(() => {
    const points = [];

    if (origin) points.push([origin.lat, origin.lon]);
    if (destination) points.push([destination.lat, destination.lon]);

    routes.forEach((route) => {
      (route.geometry?.coordinates || []).forEach(([lon, lat]) => {
        points.push([lat, lon]);
      });
    });

    if (points.length > 1) {
      map.fitBounds(points, { padding: [35, 35], maxZoom: 12 });
    } else if (points.length === 1) {
      map.setView(points[0], 10);
    }
  }, [map, routes, origin, destination]);

  return null;
}

function App() {
  const [origin, setOrigin] = useState(DEFAULT_ORIGIN);
  const [destination, setDestination] = useState(DEFAULT_DESTINATION);
  const [mapClickTarget, setMapClickTarget] = useState("origin");
  const [routes, setRoutes] = useState([]);
  const [selectedRouteId, setSelectedRouteId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const selectedRoute = useMemo(
    () => routes.find((route) => route.id === selectedRouteId) || routes[0],
    [routes, selectedRouteId],
  );

  function updateAddress(setter, address) {
    setter((previous) => ({
      ...previous,
      address,
      manuallyPlaced: false,
    }));
  }

  function placeMarker(target, coordinates) {
    const setter = target === "origin" ? setOrigin : setDestination;

    setter({
      ...coordinates,
      address: `${coordinates.lat.toFixed(5)}, ${coordinates.lon.toFixed(5)}`,
      manuallyPlaced: true,
    });

    setRoutes([]);
    setSelectedRouteId(null);
    setNotice(
      `${target === "origin" ? "Origin" : "Destination"} moved. Find routes to update your trip.`,
    );
    setError("");
  }

  async function findRoutes(event) {
    event.preventDefault();
    setLoading(true);
    setError("");
    setNotice("");
    setRoutes([]);
    setSelectedRouteId(null);

    try {
      async function resolveLocation(location, label) {
        if (location.manuallyPlaced) {
          return {
            address: location.address,
            lat: Number(location.lat),
            lon: Number(location.lon),
          };
        }

        const address = location.address.trim();
        if (!address) {
          throw new Error(`Enter an address for the ${label}.`);
        }

        const response = await api.post("/geocode/", { address });
        return {
          address: response.data.address,
          lat: response.data.lat,
          lon: response.data.lon,
        };
      }

      const [resolvedOrigin, resolvedDestination] = await Promise.all([
        resolveLocation(origin, "origin"),
        resolveLocation(destination, "destination"),
      ]);

      setOrigin({ ...resolvedOrigin, manuallyPlaced: origin.manuallyPlaced });
      setDestination({
        ...resolvedDestination,
        manuallyPlaced: destination.manuallyPlaced,
      });

      const response = await api.post("/routes/", {
        origin: {
          lat: resolvedOrigin.lat,
          lon: resolvedOrigin.lon,
        },
        destination: {
          lat: resolvedDestination.lat,
          lon: resolvedDestination.lon,
        },
      });

      setRoutes(response.data.routes);
      setSelectedRouteId(response.data.routes[0]?.id ?? null);
      setNotice(
        `${response.data.routes.length} route alternative(s) found. Select a route below to highlight it.`,
      );
    } catch (err) {
      setError(
        err.response?.data?.error ||
          err.message ||
          "Could not retrieve routes. Check that the Django backend is running.",
      );
    } finally {
      setLoading(false);
    }
  }

  function handleMapClick(coordinates) {
    placeMarker(mapClickTarget, coordinates);
  }

  function handleMarkerDrag(target, event) {
    const { lat, lng } = event.target.getLatLng();
    placeMarker(target, { lat, lon: lng });
  }

  return (
    <main className="app">
      <header className="app-header">
        <p className="eyebrow">WEATHER-AWARE LOGISTICS</p>
        <h1>Truck Route Planner</h1>
        <p>
          Plan a U.S. truck trip, compare route alternatives, and prepare for
          weather-aware routing.
        </p>
      </header>

      <section className="panel">
        <h2>Plan your trip</h2>

        <form onSubmit={findRoutes}>
          <div className="location-grid">
            <label>
              <span className="field-title">Origin</span>
              <input
                value={origin.address}
                onChange={(event) =>
                  updateAddress(setOrigin, event.target.value)
                }
                placeholder="e.g. Chicago, Illinois"
                required
              />
              <span className="field-help">Starting location in the U.S.</span>
            </label>

            <label>
              <span className="field-title">Destination</span>
              <input
                value={destination.address}
                onChange={(event) =>
                  updateAddress(setDestination, event.target.value)
                }
                placeholder="e.g. Indianapolis, Indiana"
                required
              />
              <span className="field-help">Where the truck is going</span>
            </label>
          </div>

          <button type="submit" disabled={loading}>
            {loading ? "Finding routes..." : "Find Routes"}
          </button>
        </form>

        {error && <p className="message error-message">{error}</p>}
        {notice && <p className="message notice-message">{notice}</p>}
      </section>

      <section className="map-panel">
        <div className="map-heading">
          <div>
            <h2>Route map</h2>
            <p className="muted">
              Drag either marker, or choose a marker below and click the map
              to reposition it.
            </p>
          </div>
        </div>

        <div className="map-controls">
          <span>Place next map click:</span>
          <button
            type="button"
            className={mapClickTarget === "origin" ? "secondary active" : "secondary"}
            onClick={() => setMapClickTarget("origin")}
          >
            Origin
          </button>
          <button
            type="button"
            className={
              mapClickTarget === "destination" ? "secondary active" : "secondary"
            }
            onClick={() => setMapClickTarget("destination")}
          >
            Destination
          </button>
        </div>

        <div className="map-container">
          <MapContainer
            center={[39.8, -89.5]}
            zoom={5}
            scrollWheelZoom
            className="leaflet-map"
          >
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />

            <MapClickHandler
              enabled
              onMapClick={handleMapClick}
            />

            <Marker
              position={[origin.lat, origin.lon]}
              icon={originIcon}
              draggable
              eventHandlers={{
                dragend: (event) => handleMarkerDrag("origin", event),
              }}
            />

            <Marker
              position={[destination.lat, destination.lon]}
              icon={destinationIcon}
              draggable
              eventHandlers={{
                dragend: (event) => handleMarkerDrag("destination", event),
              }}
            />

            {routes.map((route) => {
              const positions = (route.geometry?.coordinates || []).map(
                ([lon, lat]) => [lat, lon],
              );

              if (positions.length < 2) return null;

              const isSelected = route.id === (selectedRouteId ?? routes[0]?.id);

              return (
                <Polyline
                  key={route.id}
                  positions={positions}
                  pathOptions={{
                    color: isSelected ? "#2563eb" : "#8795a8",
                    weight: isSelected ? 6 : 4,
                    opacity: isSelected ? 0.95 : 0.65,
                  }}
                  eventHandlers={{
                    click: () => setSelectedRouteId(route.id),
                  }}
                />
              );
            })}

            <MapBounds
              routes={routes}
              origin={origin}
              destination={destination}
            />
          </MapContainer>
        </div>

        <div className="map-legend">
          <span><i className="legend-dot origin-dot" /> Origin</span>
          <span><i className="legend-dot destination-dot" /> Destination</span>
          <span><i className="legend-line selected-line" /> Selected route</span>
          <span><i className="legend-line alternative-line" /> Alternatives</span>
        </div>
      </section>

      {routes.length > 0 && (
        <section className="routes-section">
          <h2>Available routes</h2>
          <p className="muted">
            Select a route card or click a line on the map to highlight it.
          </p>

          <div className="route-grid">
            {routes.map((route) => (
              <button
                type="button"
                key={route.id}
                className={
                  route.id === (selectedRoute?.id ?? selectedRouteId)
                    ? "route-card selected"
                    : "route-card"
                }
                onClick={() => setSelectedRouteId(route.id)}
              >
                <span className="route-label">{route.name}</span>
                <strong>{Number(route.distance_miles).toFixed(1)} mi</strong>
                <span>
                  {(Number(route.duration_minutes) / 60).toFixed(1)} hours
                  estimated
                </span>
                <span className="muted">
                  {Math.round(Number(route.duration_minutes))} minutes
                </span>
                {route.id === (selectedRoute?.id ?? selectedRouteId) && (
                  <span className="selected-label">Selected</span>
                )}
              </button>
            ))}
          </div>
        </section>
      )}

      <footer className="app-footer">
        <p>
          Routing by Valhalla · Map data © OpenStreetMap contributors
        </p>
      </footer>
    </main>
  );
}

export default App;
