# Example: Polling an External REST API (Futura Emitter)

A single scheduled Microshare Robot that polls the [Futura Emitter Trap Management API](https://emitter-trap-management.emittercloud.m2mgate.de/q/swagger-ui/) for new trap events and writes them as standard Microshare unpacked records.

No external poller, no Lambda, no cron job — the Robot handles authentication, polling, deduplication, field mapping, and writing to the data lake.

## When to Use This Pattern

Use a polling Robot when the device platform exposes a **REST API** but does **not** offer webhooks (or webhooks are inconvenient to receive). The Robot becomes the integration: it pulls on a schedule, normalises the payload, and writes to your packed/unpacked recTypes.

For platforms that *do* offer webhooks, see [`examples/taqt/`](../taqt/) and [`examples/traplinked/`](../traplinked/) instead.

## Architecture

The Robot fits the standard Microshare **EXTRACT → MATCH → MAP** pipeline (see [`reference/pipeline-diagram.md`](../../reference/pipeline-diagram.md)) — it just runs the steps inside one scheduled Robot instead of split across NetworkServer + Decoder.

```mermaid
flowchart LR
    API["Futura API<br/>(REST, token auth)"]
    DC[("Device Cluster<br/>com.futura.emitter.packed")]
    ROBOT["Scheduled Robot (every 60s)<br/><b>EXTRACT</b> emitterId →<br/><b>MATCH</b> against cluster →<br/><b>MAP</b> to unpacked schema"]
    LAKE["Microshare Data Lake<br/><i>trap.unpacked</i>"]

    ROBOT -- "1. POST /login → X-Auth-Token" --> API
    ROBOT -- "2. GET /tms/events?startDate=…" --> API
    ROBOT -- "3. lookup emitterId → location tags" --> DC
    ROBOT -- "4. lib.writeShare per new event" --> LAKE

    BIND[("Robot bindings<br/>persistent state")] -.- ROBOT

    style DC fill:#e8f4f8,stroke:#2196F3
    style ROBOT fill:#fff3e0,stroke:#FF9800
```

The Robot keeps three things in `bindings` (Composer's per-Robot persistent state) so each execution picks up where the last one left off:

- `authToken` — Futura `X-Auth-Token`, refreshed on 401
- `lastPollTime` — the `startDate` filter for the next poll
- `seenEventIds` — sliding window of recently-processed event IDs for dedup

> **Note:** the [`robot.js`](robot.js) in this example focuses on the polling + auth + dedup loop and writes location tags from what the Futura API itself returns (`customerName`, `emitterName`). For production you also need the **MATCH** step against a Microshare device cluster — see [Adding Device Cluster Lookup](#adding-device-cluster-lookup) below.

## Futura Emitter API

| | |
|---|---|
| Trap Management API | `https://emitter-trap-management.emittercloud.m2mgate.de` |
| Server API (auth) | `https://emitterapi.m2mgate.de/emitter-server` |
| Swagger | [emitter-trap-management.emittercloud.m2mgate.de/q/swagger-ui/](https://emitter-trap-management.emittercloud.m2mgate.de/q/swagger-ui/) |

### Event Types

| Type | Severity | Description |
|---|---|---|
| `TRIGGERED` | ALARM | Trap has been triggered (catch) |
| `PROXIMITY` | INFO | Motion detected near trap |
| `LOW_BATTERY` | WARN | Battery level low |
| `NO_KEEP_ALIVE` | WARN | Device stopped reporting |
| `KEEP_ALIVE` | INFO | Periodic heartbeat |

### Device Types

| Type | Description |
|---|---|
| `TUBE_TRAP` | Emitter Tubetrap (snap trap with catch/motion modes) |
| `EMITTER_CAM` | Emitter Cam (camera trap, image attached) |

See [`event-example.json`](event-example.json) for a full Futura event payload.

## Files

| File | Purpose |
|---|---|
| [`robot.js`](robot.js) | The scheduled Robot — polls, maps, writes |
| [`event-example.json`](event-example.json) | Example Futura event payload |

## Setup

1. **Create a Robot** in Microshare Composer:
   - Set `isScheduled: true` with your desired interval (Futura's events are typically minute-scale)
   - Permissions: Share Read, Share Query, Share Write
   - Script: contents of [`robot.js`](robot.js)
   - Set the Futura credentials and the output recType at the top of the file

2. **No webhook configuration needed** — the Robot polls the Futura API directly, so nothing has to be configured on the Futura side beyond a user account with API access.

3. **Save and enable the Robot.** It will start polling on its schedule and writing unpacked records to the data lake.

## How the Robot Works

**Authentication** — `futuraLogin()`
POSTs to the Futura Server API `/rest/webapp/login` and caches the returned `X-Auth-Token` in `bindings`. Re-authenticates automatically on a 401 response.

**Polling** — `pollEvents()`
GETs `/tms/events?startDate=<lastPollTime>` via `httpGet()`. Tracks `lastPollTime` in `bindings` so each run only fetches events newer than the previous run. Deduplicates by event ID against a sliding window of the most recent 500 IDs.

**Field mapping** — `mapEvent()`
- `emitterId` → `meta.iot.device_id`
- `msgTimestamp` → `meta.iot.time`
- `type` / `severity` → `trap_event[{value, context}]`
- `emitterType`, `emitterPestType`, `stationId` → `origin.futura.*`
- The full original event is preserved in `origin.futura_event` for traceability

The output matches the schema documented in [`reference/unpacked-record-structure.md`](../../reference/unpacked-record-structure.md), so downstream Robots, Views, and the Scala pipeline can consume it without special-casing.

**HTTP GET helper** — `httpGet()`
Microshare's built-in `lib.post()` only supports POST. The Robot uses `Java.type('java.net.URL')` for GETs against the Futura API. This is a small, reusable helper that works in any GraalJS-based Robot — see [`reference/composer-api.md`](../../reference/composer-api.md) for more on the Robot runtime.

## Adding Device Cluster Lookup

Cluster lookup is the **MATCH** step of the standard pipeline — it turns a vendor-supplied device ID into Microshare's full location hierarchy (Customer / Site / Building / Floor / Room / TrapID), and is what makes records appear correctly on dashboards and feed the right downstream consumers. See [`reference/pipeline-diagram.md`](../../reference/pipeline-diagram.md) for the canonical model.

This example skips the MATCH step to keep the polling/auth/dedup pattern legible. To make the Robot production-ready:

1. **Register your emitters in a device cluster** in Composer on a packed recType such as `com.futura.emitter.packed`. Each entry maps an `emitterId` to its location tags. The Microshare [Deploy-M](https://play.google.com/store/apps/details?id=com.microshare.DeployM2) mobile app does this in seconds by scanning the device's QR code or label.

2. **Read the cluster from the Robot:**

   ```javascript
   var TWIN_RECTYPE = 'com.futura.emitter.packed';
   var cluster = httpGet('/api/device/' + TWIN_RECTYPE + '?details=true&discover=true', {
       'Authorization': 'Bearer ' + auth
   });
   // Build emitterId → location lookup, cache in bindings for the Robot's lifetime
   ```

3. **Look up each event's `emitterId`** before mapping, and put the resulting tags in `meta.device` and on the share's record-level tags. Falling back to API-supplied values is fine for unregistered devices.

Without the MATCH step, records still write — but they carry only what the vendor API returned, won't sit in the right slot in your customer/site hierarchy, and can't be filtered by location in dashboards.

## Adapting for Other REST APIs

This Robot is a template for **any** poll-based device platform:

1. Replace `futuraLogin()` with your API's auth flow (Basic, Bearer, OAuth — anything HTTP-based works).
2. Replace `pollEvents()` with your API's list/query endpoint and your filter (last-modified timestamp, cursor, sequence number).
3. Replace `mapEvent()` with your field mappings — produce the schema in [`reference/unpacked-record-structure.md`](../../reference/unpacked-record-structure.md).
4. The `httpGet()` helper, `bindings`-based state (auth token + cursor + dedup window), and the dedup logic are reusable as-is.

## See Also

- [`reference/composer-api.md`](../../reference/composer-api.md) — Robot runtime, auth, common helpers
- [`reference/unpacked-record-structure.md`](../../reference/unpacked-record-structure.md) — schema your Robot should produce
- [`reference/pipeline-diagram.md`](../../reference/pipeline-diagram.md) — how packed and unpacked records flow through Microshare
- [`examples/traplinked/`](../traplinked/) — same pattern, with a two-stage dev → prod progression
- [`examples/taqt/`](../taqt/) — webhook variant (the platform pushes to Microshare, no polling)
