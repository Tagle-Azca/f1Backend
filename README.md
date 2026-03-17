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
| `DGRAPH_URL` | `localhost:9080` | Dgraph gRPC address |
| `FRONTEND_URL` | `http://localhost:5173` | CORS allowed origin |

---

## API endpoints

```
GET /api/dashboard                          next race, last session, top standings
GET /api/drivers                            driver list
GET /api/drivers/:id                        driver profile
GET /api/races?season=2024                  races for a season
GET /api/races/:season/:round               race detail
GET /api/circuits                           all circuits
GET /api/circuits/:id                       single circuit
GET /api/standings?season=2024              driver championship
GET /api/stats/circuit/:id                  circuit history
GET /api/telemetry/races                    races with available telemetry
GET /api/telemetry/laps/:raceId/:driverId   lap times
GET /api/telemetry/pitstops/:raceId/:driverId pit stops
GET /api/telemetry/strategy/:raceId         full tire strategy
GET /api/graph/drivers?season=2024          driver-team graph (Dgraph)
GET /api/graph/driver/:driverId             single driver connections
GET /api/search?q=alonso                    global search
```

---

## License

MIT
