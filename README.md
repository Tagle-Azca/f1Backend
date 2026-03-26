# F1 Intelligence Platform — Backend

Express API serving historical race data (MongoDB), telemetry (Cassandra), and driver relationship graphs (Dgraph).

**Frontend repo:** https://github.com/Tagle-Azca/f1-platform

---

## Requirements

- Node.js 18+
- Docker + Docker Compose
- npm

---

## Getting started

### 1 · Clone both repos

```bash
git clone git@github.com:Tagle-Azca/f1Backend.git   f1dbBack
git clone git@github.com:Tagle-Azca/f1-platform.git f1-platform
```

### 2 · Install dependencies

```bash
cd f1dbBack
npm install
cp .env.example .env   # default values work out of the box
```

### 3 · Start the databases

```bash
npm run db:up
```

> Cassandra takes ~60 s to be ready on first boot. Check with `npm run db:logs`.

### 4 · Seed the databases

```bash
# Seed everything at once (recommended)
npm run seed

# Or individually:
npm run seed:mongo        # historical data
npm run seed:cassandra    # telemetry 2023+
npm run seed:dgraph       # relationship graph

# Full MongoDB history from 1950 (~12 h)
npm run seed:history
```

Optional extras:

```bash
npm run fetch:photos      # download driver photos
npm run fetch:circuits    # download circuit track SVGs
```

### 5 · Start the API

```bash
npm run dev     # development (nodemon, auto-reload)
npm start       # production
```

API available at **http://localhost:8741**.

> **Auto-seed (Cassandra):** the server reads the race calendar on startup and schedules a Cassandra seed automatically the day after each race at 10:00 UTC. MongoDB is seeded manually with `npm run seed:mongo` after each GP.
> To seed Cassandra for a past race manually: `npm run seed:cassandra`

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8741` | API port |
| `MONGO_URI` | `mongodb://localhost:27017/f1_platform` | MongoDB connection string |
| `CASSANDRA_HOST` | `127.0.0.1` | Cassandra host |
| `CASSANDRA_PORT` | `9042` | Cassandra port |
| `CASSANDRA_KEYSPACE` | `f1_telemetry` | Cassandra keyspace |
| `CASSANDRA_DC` | `datacenter1` | Cassandra datacenter |
| `ASTRA_BUNDLE_B64` | — | Base64 Astra secure-connect bundle (production) |
| `ASTRA_CLIENT_ID` | — | Astra client ID |
| `ASTRA_CLIENT_SECRET` | — | Astra client secret |
| `DGRAPH_URL` | `localhost:9080` | Dgraph gRPC address |
| `FRONTEND_URL` | `http://localhost:5173` | CORS allowed origin |

---

## API endpoints

### Dashboard
```
GET  /api/dashboard                              next race, last session, standings snapshot
GET  /api/dashboard/live                         live race classification (polls F1 SignalR)
```

### Races (MongoDB)
```
GET  /api/races?season=2025                      full calendar for a season
GET  /api/races/:season/:round                   race detail + schedule + results
```

### Drivers (MongoDB)
```
GET  /api/drivers                                driver list
GET  /api/drivers/:id                            driver profile
GET  /api/drivers/featured?season=2025           current season drivers with constructor info
```

### Stats (MongoDB aggregations)
```
GET  /api/stats/driver/:id                       career totals (wins, podiums, poles…)
GET  /api/stats/driver/:id/seasons               season-by-season breakdown
GET  /api/stats/driver/:id/circuits              results grouped by circuit
GET  /api/stats/driver/:id/network               teammate ego-network (nodes + edges)
GET  /api/stats/historical-performance?driverId=&year=   lap-by-lap season performance
GET  /api/stats/standings/:season                driver championship standings
GET  /api/stats/constructor-standings/:season    constructor championship standings
GET  /api/stats/season-drivers/:season           all drivers who scored points that season
GET  /api/stats/circuit/:id                      circuit win history
GET  /api/stats/constructor/:id                  constructor career stats
```

### Circuits (MongoDB)
```
GET  /api/circuits                               all circuits
GET  /api/circuits/:id                           single circuit + track coords
```

### Telemetry (Cassandra — OpenF1, 2023+)
```
GET  /api/telemetry/races                        races with available telemetry
GET  /api/telemetry/drivers/:raceId              drivers who participated in a race
GET  /api/telemetry/laps/:raceId/:driverId       lap times + sector splits
GET  /api/telemetry/pitstops/:raceId/:driverId   pit stop data
GET  /api/telemetry/pace/:raceId?drivers=        lap pace comparison for selected drivers
GET  /api/telemetry/strategy/:raceId             full tire strategy (stints per driver)
GET  /api/telemetry/positions/:raceId            position-per-lap for all drivers
GET  /api/telemetry/team-pace?teamName=&year=    team pace trend across a season
GET  /api/telemetry/safety-car/:raceId           safety car / VSC periods
GET  /api/telemetry/race-info/:raceId            session metadata
```

### Graph (Dgraph)
```
GET  /api/graph/drivers?season=2025              full driver-team graph for a season
GET  /api/graph/driver/:driverId                 single driver node
GET  /api/graph/driver/:driverId/ego             driver ego-graph (direct connections)
GET  /api/graph/driver/:driverId/connections     all driver connections
GET  /api/graph/constructor/:constructorId       constructor ego-graph
```

### Search (MongoDB)
```
GET  /api/search?q=alonso&limit=12              global search across drivers, races, circuits
```

### Auth
```
POST /api/auth/google                            Google OAuth sign-in
```

---

## Data sources

| Source | Used for |
|---|---|
| [Jolpica / Ergast](https://api.jolpi.ca) | Historical race results, calendar, drivers, constructors |
| [OpenF1](https://openf1.org) | Lap telemetry, pit stops, tire stints, positions (2023+) |
| [F1 SignalR](https://livetiming.formula1.com) | Live race classification during race weekends |

---

## License

MIT
