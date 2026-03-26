# Example: Polling an External REST API (Futura Emitter)

A single scheduled Microshare Robot that polls the [Futura Emitter Trap Management API](https://emitter-trap-management.emittercloud.m2mgate.de/q/swagger-ui/) for new trap events and writes them as standard Microshare unpacked records.

No external poller, no Lambda, no cron job — the Robot handles authentication, polling, field mapping, deduplication, and writing to the data lake.

## Architecture

```
Scheduled Robot (runs every N seconds)
  → lib.post() to Futura login endpoint → X-Auth-Token
  → httpGet() to GET /tms/events (new events since last poll)
  → For each new event:
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

1. **Create a Robot** in Microshare Composer:
   - Set `isScheduled: true` with your desired interval
   - Permissions: Share Read, Share Query, Share Write
   - Script: contents of `robot.js`
   - Update the credentials and recType constants at the top

2. **No webhook configuration needed** — the Robot polls the Futura API directly.

## How the Robot Works

**Authentication** — `futuraLogin()`:
- POSTs to Futura Server API `/rest/webapp/login`
- Caches `X-Auth-Token` in `bindings` across executions
- Re-authenticates on 401

**Polling** — `pollEvents()`:
- GETs `/tms/events?acked=false&startDate=<last_poll>` via Java HttpURLConnection
- Tracks `lastPollTime` in `bindings` to only fetch new events
- Deduplicates by event ID (capped at 500 IDs in `bindings`)

**Field mapping** — `mapEvent()`:
- `emitterId` → `meta.iot.device_id`
- `msgTimestamp` → `meta.iot.time`
- `type` / `severity` → `trap_event[{value, context}]`
- `emitterType`, `pestType`, `stationId` → `meta.futura.*`
- Full original event preserved in `origin.futura_event`

## Adapting for Other REST APIs

1. Replace `futuraLogin()` with your API's auth flow
2. Replace `pollEvents()` with your API's list/query endpoint
3. Replace `mapEvent()` with your field mappings
4. The `httpGet()` helper, bindings-based state, and dedup logic are reusable as-is
