
import { useEffect, useMemo, useState } from "react";
import {
  MapContainer,
  Marker,
  Polyline,
  TileLayer,
  CircleMarker,
  Popup,
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
    html: `<div style="width:18px;height:18px;border-radius:50%;background:${color};border:3px solid white;box-shadow:0 1px 6px #333"></div>`,
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

function riskColor(level) {
  switch (level) {
    case "low":
      return "#16a34a";
    case "moderate":
      return "#eab308";
    case "high":
      return "#ea580c";
    case "severe":
      return "#dc2626";
    default:
      return "#64748b";
  }
}

function App() {
  const [origin, setOrigin] = useState(DEFAULT_ORIGIN);
  const [destination, setDestination] = useState(DEFAULT_DESTINATION);
  const [mapClickTarget, setMapClickTarget] = useState("origin");
  const [routes, setRoutes] = useState([]);
  const [selectedRouteId, setSelectedRouteId] = useState(null);
  const [departureTime, setDepartureTime] = useState(() => {
    const date = new Date(Date.now() + 60 * 60 * 1000);
    date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
    return date.toISOString().slice(0, 16);
  });
  const [loadWeight, setLoadWeight] = useState("20000");
  const [intervalMiles, setIntervalMiles] = useState("25");
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
      const weight = Number(loadWeight);
      if (!Number.isFinite(weight) || weight <= 0) {
        throw new Error("Load weight must be greater than zero pounds.");
      }

      if (!departureTime) {
        throw new Error("Choose a departure date and time.");
      }

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

      setOrigin({
        ...resolvedOrigin,
        manuallyPlaced: origin.manuallyPlaced,
      });
      setDestination({
        ...resolvedDestination,
        manuallyPlaced: destination.manuallyPlaced,
      });

      const routeResponse = await api.post("/routes/", {
        origin: {
          lat: resolvedOrigin.lat,
          lon: resolvedOrigin.lon,
        },
        destination: {
          lat: resolvedDestination.lat,
          lon: resolvedDestination.lon,
        },
      });

      const departureISO = new Date(departureTime).toISOString();
      const routeResults = await Promise.all(
        routeResponse.data.routes.map(async (route) => {
          try {
            const weatherResponse = await api.post(
              "/weather/route-analysis/",
              {
                geometry: route.geometry,
                distance_miles: route.distance_miles,
                duration_seconds: route.duration_seconds,
                departure_time: departureISO,
                interval_miles: Number(intervalMiles),
                load_weight_lbs: weight,
              },
            );

            return {
              ...route,
              weatherAnalysis: weatherResponse.data,
              weatherError: null,
            };
          } catch (weatherError) {
            return {
              ...route,
              weatherAnalysis: null,
              weatherError:
                weatherError.response?.data?.error ||
                "Weather analysis could not be retrieved.",
            };
          }
        }),
      );

      setRoutes(routeResults);
      setSelectedRouteId(routeResults[0]?.id ?? null);

      const successfulAnalyses = routeResults.filter(
        (route) => route.weatherAnalysis,
      ).length;

      setNotice(
        `${routeResults.length} route alternative(s) found. Weather analysis completed for ${successfulAnalyses} route(s).`,
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

  const selectedCheckpoints =
    selectedRoute?.weatherAnalysis?.checkpoints || [];

  return (
    <main className="app">
      <header className="app-header">
        <p className="eyebrow">WEATHER-AWARE LOGISTICS</p>
        <h1>Truck Route Planner</h1>
        <p>
          Compare U.S. truck routes using weather forecasts, travel time, and
          checkpoint risk.
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

            <label>
              <span className="field-title">Departure date and time</span>
              <input
                type="datetime-local"
                value={departureTime}
                onChange={(event) => setDepartureTime(event.target.value)}
                required
              />
              <span className="field-help">
                Weather forecasts are limited by provider availability.
              </span>
            </label>

            <label>
              <span className="field-title">Load weight (lb)</span>
              <input
                type="number"
                min="1"
                step="1"
                value={loadWeight}
                onChange={(event) => setLoadWeight(event.target.value)}
                required
              />
              <span className="field-help">
                Recorded for the trip; weight-based scoring is not yet enabled.
              </span>
            </label>

            <label>
              <span className="field-title">Weather checkpoint interval</span>
              <select
                value={intervalMiles}
                onChange={(event) => setIntervalMiles(event.target.value)}
              >
                <option value="10">Every 10 miles</option>
                <option value="25">Every 25 miles</option>
                <option value="50">Every 50 miles</option>
              </select>
              <span className="field-help">
                Shorter intervals create more checkpoints.
              </span>
            </label>
          </div>

          <button type="submit" disabled={loading}>
            {loading ? "Finding routes and analyzing weather..." : "Find Routes"}
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
              to reposition it. Select a route to view its weather checkpoints.
            </p>
          </div>
        </div>

        <div className="map-controls">
          <span>Place next map click:</span>
          <button
            type="button"
            className={
              mapClickTarget === "origin" ? "secondary active" : "secondary"
            }
            onClick={() => setMapClickTarget("origin")}
          >
            Origin
          </button>
          <button
            type="button"
            className={
              mapClickTarget === "destination"
                ? "secondary active"
                : "secondary"
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

            <MapClickHandler enabled onMapClick={handleMapClick} />

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

              const isSelected = route.id === selectedRoute?.id;

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

            {selectedCheckpoints.map((checkpoint, index) => {
              if (
                checkpoint.latitude == null ||
                checkpoint.longitude == null
              ) {
                return null;
              }

              const score = checkpoint.risk?.score;
              const color = riskColor(checkpoint.risk?.level);

              return (
                <CircleMarker
                  key={`${checkpoint.distance_miles}-${index}`}
                  center={[checkpoint.latitude, checkpoint.longitude]}
                  radius={score == null ? 6 : 7 + Math.min(score / 15, 5)}
                  pathOptions={{
                    color,
                    fillColor: color,
                    fillOpacity: 0.8,
                    weight: 2,
                  }}
                >
                  <Popup>
                    <strong>
                      Mile {Number(checkpoint.distance_miles).toFixed(1)}
                    </strong>
                    <br />
                    Risk: {score == null ? "Unavailable" : `${score}/100`}
                    <br />
                    Level: {checkpoint.risk?.level || "unavailable"}
                    <br />
                    Arrival: {checkpoint.arrival_time}
                    <br />
                    {checkpoint.weather
                      ? `Wind gusts: ${checkpoint.weather.wind_gusts_10m ?? "N/A"} km/h`
                      : "Weather forecast unavailable"}
                  </Popup>
                </CircleMarker>
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
          <span><i className="legend-dot" style={{ background: "#16a34a" }} /> Low risk</span>
          <span><i className="legend-dot" style={{ background: "#eab308" }} /> Moderate</span>
          <span><i className="legend-dot" style={{ background: "#ea580c" }} /> High</span>
          <span><i className="legend-dot" style={{ background: "#dc2626" }} /> Severe</span>
        </div>
      </section>

      {routes.length > 0 && (
        <section className="routes-section">
          <h2>Available routes</h2>
          <p className="muted">
            Select a route card or click a line on the map to compare weather
            risk and checkpoint conditions.
          </p>

          <div className="route-grid">
            {routes.map((route) => {
              const analysis = route.weatherAnalysis;
              const routeRisk = analysis?.route_risk;
              const isSelected = route.id === selectedRoute?.id;

              return (
                <button
                  type="button"
                  key={route.id}
                  className={isSelected ? "route-card selected" : "route-card"}
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

                  {routeRisk?.score != null ? (
                    <span
                      className="risk-summary"
                      style={{ color: riskColor(routeRisk.level) }}
                    >
                      Weather risk: {routeRisk.score}/100 · {routeRisk.level}
                    </span>
                  ) : (
                    <span className="risk-summary">
                      {route.weatherError || "Weather risk unavailable"}
                    </span>
                  )}

                  {analysis && (
                    <span className="weather-coverage">
                      Weather at {routeRisk.available_checkpoints}/
                      {routeRisk.total_checkpoints} checkpoints
                    </span>
                  )}

                  {isSelected && (
                    <span className="selected-label">Selected</span>
                  )}
                </button>
              );
            })}
          </div>

          {selectedRoute && (
            <div className="checkpoint-section">
              <h3>{selectedRoute.name}: weather checkpoints</h3>
              {!selectedRoute.weatherAnalysis ? (
                <p className="muted">
                  {selectedRoute.weatherError ||
                    "No weather analysis is available for this route."}
                </p>
              ) : (
                <>
                  <p className="muted">
                    Risk is a prototype weather heuristic, not an official
                    truck-safety rating. Forecast coverage can vary by
                    departure time and route length.
                  </p>

                  <div className="checkpoint-list">
                    {selectedCheckpoints.map((checkpoint, index) => (
                      <article
                        className="checkpoint-card"
                        key={`${checkpoint.distance_miles}-${index}`}
                      >
                        <div className="checkpoint-heading">
                          <strong>
                            Mile {Number(checkpoint.distance_miles).toFixed(1)}
                          </strong>
                          <span
                            className="risk-pill"
                            style={{
                              color: riskColor(checkpoint.risk?.level),
                              borderColor: riskColor(checkpoint.risk?.level),
                            }}
                          >
                            {checkpoint.risk?.score == null
                              ? "Unavailable"
                              : `${checkpoint.risk.score}/100 · ${checkpoint.risk.level}`}
                          </span>
                        </div>
                        <p>
                          <strong>Estimated arrival:</strong>{" "}
                          {new Date(checkpoint.arrival_time).toLocaleString()}
                        </p>
                        {checkpoint.weather ? (
                          <p>
                            <strong>Conditions:</strong>{" "}
                            {checkpoint.weather.temperature_2m ?? "N/A"}°C,
                            wind gusts{" "}
                            {checkpoint.weather.wind_gusts_10m ?? "N/A"} km/h,
                            visibility{" "}
                            {checkpoint.weather.visibility == null
                              ? "N/A"
                              : `${(checkpoint.weather.visibility / 1000).toFixed(1)} km`}
                          </p>
                        ) : (
                          <p className="muted">
                            Weather forecast unavailable for this arrival time.
                          </p>
                        )}
                        {checkpoint.risk?.factors?.length > 0 && (
                          <ul>
                            {checkpoint.risk.factors.map((factor, factorIndex) => (
                              <li key={`${factor.description}-${factorIndex}`}>
                                {factor.description} (+{factor.points})
                              </li>
                            ))}
                          </ul>
                        )}
                      </article>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </section>
      )}

      <footer className="app-footer">
        <p>
          Routing by Valhalla · Weather by Open-Meteo · Map data © OpenStreetMap contributors
        </p>
      </footer>
    </main>
  );
}

export default App;
