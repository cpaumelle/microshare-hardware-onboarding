# Example: Polling an External REST API (Futura Emitter)

A single scheduled Microshare Robot that polls the [Futura Emitter Trap Management API](https://emitter-trap-management.emittercloud.m2mgate.de/q/swagger-ui/) for new trap events and writes them as standard Microshare unpacked records.

No external poller, no Lambda, no cron job — the Robot handles authentication, polling, twin lookup, field mapping, deduplication, and writing to the data lake.

## Architecture

```
Scheduled Robot (runs every N seconds)
  → lib.post() to Futura login endpoint → X-Auth-Token
  → httpGet() to /device/{TWIN_RECTYPE} → DC twin lookup (24h cached)
  → httpGet() to GET /tms/events/api (new events since last poll)
  → For each new event:
      → Look up twin by emitterId → location tags
      → Maps Futura fields to Microshare schema
      → lib.writeShare() → unpacked recType
```

The `httpGet()` helper uses `Java.type('java.net.URL')` for GET requests (Microshare's `lib.post()` only supports POST). This works in the GraalJS runtime.

## Futura Emitter API

**Trap Management API:** `https://emitter-trap-management.emittercloud.m2mgate.de`
**Server API (auth):** `https://emitterapi.m2mgate.de/emitter-server`
**Swagger:** [emitter-trap-management.emittercloud.m2mgate.de/q/swagger-ui/](https://emitter-trap-management.emittercloud.m2mgate.de/q/swagger-ui/)

### Event Types

| Type | Severity | Description |
|---|---|---|
| `TRIGGERED` | ALARM | Trap has been triggered (catch) |
| `PROXIMITY` | INFO | Motion detected near trap |
| `LOW_BATTERY` | WARN | Battery level low |
| `NO_KEEP_ALIVE` | WARN | Device stopped reporting |

### Device Types

| Type | Description |
|---|---|
| `TUBE_TRAP` | Emitter Tubetrap (snap trap with catch/motion modes) |
| `EMITTER_CAM` | Emitter Cam (camera trap) |

## Files

| File | Purpose |
|---|---|
| `robot.js` | The scheduled Robot — polls, maps, writes |
| `event-example.json` | Example Futura event payload |

## Setup

1. **Create a device cluster** in Composer on `com.futura.emitter.packed`. Register each emitter by its `emitterId` with location tags.

2. **Create a Robot** in Microshare Composer:
   - Set `isScheduled: true` with your desired interval
   - Permissions: Share Read, Share Query, Share Write
   - Script: contents of `robot.js`
   - Credentials are injected from `.env` via `{{FUTURA_USERNAME}}` / `{{FUTURA_PASSWORD}}` placeholders — deploy with `src/deploy-atom.py`
   - `MS_API_HOST` is `https://pest.microshare.io` — change for other environments

> **Robot auth:** the robot's `data.auth` must be a `grant_type=robot` token (scope `SHARE:READ,QUERY,WRITE`; add `SHARE:EXECUTE,POLICY` for a bundler) that returns HTTP 200 on `/api/share`. An `ALL:ALL`/session token authenticates but 401s there, so the robot dispatches and writes nothing ("silent dispatch death"). Re-kick a stalled robot by toggling `isActive`; never PUT a new auth.

3. **No webhook configuration needed** — the Robot polls the Futura API directly.

## How the Robot Works

**Authentication** — `futuraLogin()`:
- POSTs to Futura Server API `/rest/webapp/login`
- Caches `X-Auth-Token` in `bindings` across executions
- Re-authenticates on 401

**DC twin lookup** — `loadTwinLookup()`:
- Reads `com.futura.emitter.packed` device cluster via `httpGet` to `/api/device/{recType}`
- Builds `emitterId → {location}` lookup table
- Caches 24h in `bindings.twinLookup`

**Polling** — `pollEvents()`:
- GETs `/tms/events/api?startDate=<last_poll>` via Java HttpURLConnection
- Uses the `/tms/events/api` endpoint, **not** the portal `/tms/events?acked=false`: the portal endpoint filters by ack status and silently drops EMITTER_CAM photo events (auto-acknowledged on arrival)
- Tracks `lastPollTime` in `bindings` to only fetch new events
- Deduplicates by event ID (capped at 500 IDs in `bindings`)

**Field mapping** — `buildAlert(event, twin)`:
- Uses twin location when available; falls back to `[emitterName]`
- `emitterId` → `meta.iot.device_id`
- `msgTimestamp` → `meta.iot.time` / `meta.iot.iso_time` / top-level `time`
- `eventImageDownloadUrl` → `current.image`
- `emitterPestType` → `current.pest`
- Futura-specific fields go in `origin.futura` (`event_id`, `emitter_type`, `pest_type`, `classification`) — not `meta.*`

## Credentials

Credentials use `{{FUTURA_USERNAME}}` / `{{FUTURA_PASSWORD}}` placeholders that are substituted at deploy time from `.env`. Never hardcode credentials in the script.

## Adapting for Other REST APIs

1. Replace `futuraLogin()` with your API's auth flow
2. Replace `pollEvents()` with your API's list/query endpoint
3. Replace `buildAlert()` with your field mappings
4. The `httpGet()` helper, `loadTwinLookup()`, bindings-based state, and dedup logic are reusable as-is
