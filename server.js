const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// Hilfsfunktion für Zeitformatierung im 24h Format
function formatTime(dateString) {
    if (!dateString) return null;
    
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return dateString; // Fallback bei ungültigem Datum
    
    return date.toLocaleTimeString('de-DE', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: 'Europe/Berlin'
    });
}

// Hilfsfunktion für komplettes Datum/Zeit Format
function formatDateTime(dateString) {
    if (!dateString) return null;
    
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return dateString;
    
    return date.toLocaleString('de-DE', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: 'Europe/Berlin'
    });
}

// Middleware
app.use(cors());
app.use(express.json());

// VVO API Basis-URL
const VVO_BASE_URL = 'https://webapi.vvo-online.de';

// Hilfsfunktion für VVO API Aufrufe
async function callVvoApi(endpoint, params = {}) {
    try {
        const url = new URL(`${VVO_BASE_URL}${endpoint}`);
        Object.keys(params).forEach(key => {
            if (params[key] !== undefined && params[key] !== null) {
                url.searchParams.append(key, params[key]);
            }
        });

        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`VVO API Error: ${response.status}`);
        }
        
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('VVO API Call failed:', error);
        throw error;
    }
}

// Root Endpoint - API Info
app.get('/', (req, res) => {
    res.json({
        name: 'VVO API Bridge für Home Assistant',
        version: '1.0.0',
        endpoints: {
            '/stations': 'Haltestellen suchen',
            '/departures/:stationId': 'Abfahrten einer Haltestelle',
            '/trip': 'Verbindungen suchen',
            '/lines': 'Linien einer Haltestelle',
            '/stops/:lineId': 'Haltestellen einer Linie'
        },
        vvo_data: {
            stations: 'Haltestellendaten (Name, ID, Koordinaten)',
            departures: 'Abfahrtszeiten mit Linie, Richtung, Verspätung',
            trips: 'Verbindungsvorschläge zwischen zwei Punkten',
            lines: 'Verfügbare Linien mit Typ (Bus, Bahn, etc.)',
            real_time: 'Echtzeitdaten für Verspätungen'
        }
    });
});

// 1. Haltestellen suchen
app.get('/stations', async (req, res) => {
    try {
        const { query, limit = 10 } = req.query;
        
        if (!query) {
            return res.status(400).json({ error: 'Query parameter ist erforderlich' });
        }

        const data = await callVvoApi('/tr/pointfinder', {
            query: query,
            limit: limit,
            assignedstops: true,
            type_sf: true
        });

        const stations = data.Points?.map(point => ({
            id: point.id,
            name: point.name,
            city: point.city,
            coords: {
                lat: point.coords?.[1] / 1000000,
                lng: point.coords?.[0] / 1000000
            },
            type: point.type
        })) || [];

        res.json({
            query: query,
            count: stations.length,
            stations: stations
        });

    } catch (error) {
        res.status(500).json({ 
            error: 'Fehler beim Abrufen der Haltestellen',
            message: error.message 
        });
    }
});

// 2. Abfahrten einer Haltestelle
app.get('/departures/:stationId', async (req, res) => {
    try {
        const { stationId } = req.params;
        const { limit = 20, time_offset = 0 } = req.query;

        const data = await callVvoApi('/dm', {
            stopid: stationId,
            limit: limit,
            time: new Date(Date.now() + time_offset * 60000).toISOString(),
            isarrival: false
        });

        const departures = data.Departures?.map(dep => ({
            line: dep.LineName,
            direction: dep.Direction,
            platform: dep.Platform?.Name,
            scheduled_time: formatTime(dep.ScheduledTime),
            scheduled_time_full: formatDateTime(dep.ScheduledTime),
            real_time: formatTime(dep.RealTime),
            real_time_full: formatDateTime(dep.RealTime),
            delay: dep.Delay || 0,
            state: dep.State,
            route_changes: dep.RouteChanges || [],
            low_floor: dep.Diva?.number ? true : false
        })) || [];

        res.json({
            station_id: stationId,
            station_name: data.Name,
            timestamp: formatDateTime(new Date().toISOString()),
            count: departures.length,
            departures: departures
        });

    } catch (error) {
        res.status(500).json({ 
            error: 'Fehler beim Abrufen der Abfahrten',
            message: error.message 
        });
    }
});

// 3. Verbindungen suchen
app.get('/trip', async (req, res) => {
    try {
        const { from, to, time, is_arrival = false, max_changes = 9 } = req.query;
        
        if (!from || !to) {
            return res.status(400).json({ 
                error: 'Parameter "from" und "to" sind erforderlich' 
            });
        }

        const tripTime = time ? new Date(time) : new Date();
        
        const data = await callVvoApi('/tr/trips', {
            from: from,
            to: to,
            time: tripTime.toISOString(),
            isarrival: is_arrival,
            maxchanges: max_changes,
            shorttermchanges: true,
            walkingspeed: 'normal'
        });

        const trips = data.Routes?.map(route => ({
            duration: route.Duration,
            changes: route.Changes,
            departure: {
                time: formatTime(route.PartialRoutes?.[0]?.RegularStops?.[0]?.DepartureTime),
                time_full: formatDateTime(route.PartialRoutes?.[0]?.RegularStops?.[0]?.DepartureTime),
                station: route.PartialRoutes?.[0]?.RegularStops?.[0]?.Name
            },
            arrival: {
                time: formatTime(route.PartialRoutes?.[route.PartialRoutes.length - 1]?.RegularStops?.slice(-1)[0]?.ArrivalTime),
                time_full: formatDateTime(route.PartialRoutes?.[route.PartialRoutes.length - 1]?.RegularStops?.slice(-1)[0]?.ArrivalTime),
                station: route.PartialRoutes?.[route.PartialRoutes.length - 1]?.RegularStops?.slice(-1)[0]?.Name
            },
            parts: route.PartialRoutes?.map(part => ({
                line: part.Mot?.Name,
                direction: part.Direction,
                departure_time: formatTime(part.RegularStops?.[0]?.DepartureTime),
                departure_time_full: formatDateTime(part.RegularStops?.[0]?.DepartureTime),
                arrival_time: formatTime(part.RegularStops?.slice(-1)[0]?.ArrivalTime),
                arrival_time_full: formatDateTime(part.RegularStops?.slice(-1)[0]?.ArrivalTime),
                duration: part.Duration
            })) || []
        })) || [];

        res.json({
            from: from,
            to: to,
            timestamp: formatDateTime(new Date().toISOString()),
            count: trips.length,
            trips: trips
        });

    } catch (error) {
        res.status(500).json({ 
            error: 'Fehler beim Abrufen der Verbindungen',
            message: error.message 
        });
    }
});

// 4. Linien einer Haltestelle
app.get('/lines/:stationId', async (req, res) => {
    try {
        const { stationId } = req.params;

        const data = await callVvoApi('/stt/lines', {
            stopid: stationId
        });

        const lines = data.Lines?.map(line => ({
            id: line.Id,
            name: line.Name,
            type: line.Mot?.Type,
            type_name: line.Mot?.Name,
            directions: line.Directions || []
        })) || [];

        res.json({
            station_id: stationId,
            count: lines.length,
            lines: lines
        });

    } catch (error) {
        res.status(500).json({ 
            error: 'Fehler beim Abrufen der Linien',
            message: error.message 
        });
    }
});

// 5. Haltestellen einer Linie
app.get('/stops/:lineId', async (req, res) => {
    try {
        const { lineId } = req.params;

        const data = await callVvoApi('/stt/stops', {
            lineid: lineId
        });

        const stops = data.Stops?.map(stop => ({
            id: stop.Id,
            name: stop.Name,
            city: stop.City,
            coords: {
                lat: stop.Coord?.[1] / 1000000,
                lng: stop.Coord?.[0] / 1000000
            }
        })) || [];

        res.json({
            line_id: lineId,
            count: stops.length,
            stops: stops
        });

    } catch (error) {
        res.status(500).json({ 
            error: 'Fehler beim Abrufen der Haltestellen',
            message: error.message 
        });
    }
});

// Health Check für Render
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'OK', 
        timestamp: formatDateTime(new Date().toISOString())
    });
});

// Error Handler
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({
        error: 'Interner Serverfehler',
        message: error.message
    });
});

// 404 Handler
app.use((req, res) => {
    res.status(404).json({
        error: 'Endpoint nicht gefunden',
        available_endpoints: [
            'GET /',
            'GET /stations?query=<suchbegriff>',
            'GET /departures/:stationId',
            'GET /trip?from=<start>&to=<ziel>',
            'GET /lines/:stationId',
            'GET /stops/:lineId'
        ]
    });
});

app.listen(PORT, () => {
    console.log(`🚌 VVO API Bridge läuft auf Port ${PORT}`);
    console.log(`📍 Bereit für Home Assistant Integration`);
});
