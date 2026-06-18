# Example: Ubiqod (Taqt) Feedback Device

A Microshare Robot that receives [Ubiqod](https://help.taqt.com/portal/en/kb/articles/getting-events-and-data-from-ubiqod-using-the-webhook) webhook JSON and writes standard feedback records — readable by existing SmilioAction dashboards. Note: platform handlers (SmilioEventHandler, the Scala decode chain, the pest incident bundler) fire on LoRaWAN/platform-fed records ONLY — NOT on records this robot or a pipe token writes; a robot-fed pipeline must produce its own derived records.

## What the Device Sends

Ubiqod TaqtOne devices send structured JSON via webhook. Three event types:

- **DATA** — button press or badge swipe
- **KEEP_ALIVE** — periodic heartbeat
- **ALERT** — satisfaction threshold triggered

See `payload-data.json`, `payload-keepalive.json`, and `payload-alert.json`.

### Key Fields

| Field | Path | Example |
|---|---|---|
| device.uuid | `tracker.slug` | `867280060123456` (IMEI) |
| Timestamp | `timestamp` | `2025-11-26T11:33:42.000Z` |
| Battery | `tracker.batteryLevel` | `93` |
| Button pressed | `data.reference` | `3` |
| Button label | `data.label` | `Arrival` |
| Badge scanned | `data.code.reference` | `04EDEB7A3B7480` |
| Event type | `eventType` | `DATA` / `KEEP_ALIVE` / `ALERT` |

## What the Robot Produces

```json
{
  "pushes_since_reset": [{"value": 1, "context": "Button #3, Arrival"}],
  "swipe": [{"value": true}],
  "badge": [{"value": "04EDEB7A3B7480", "context": "My User Badge"}],
  "device_health": {
    "id": "867280060123456",
    "charge": [{"unit": "%", "value": 93}]
  },
  "meta": {
    "iot": {
      "device_id": "867280060123456",
      "time": "2025-11-26T11:33:42.000Z",
      "type": "data"
    },
    "device": ["Example Organisation", "My site", "My TaqtOne"],
    "dc": { "name": "...", "network": "com.taqt.ubiqod", "unpacker": "robot.ubiqod.taqt" },
    "global": [],
    "source": []
  },
  "origin": {
    "ubiqod": { "tracker_id": "...", "tracker_model": "...", ... },
    "ubiqod_webhook": { ... }
  }
}
```

## Setup

1. **Create a device cluster** in Composer on `io.microshare.feedback.packed`. Register devices with their IMEI (tracker.slug) and location tags. The cluster doesn't need a NetworkServer or Decoder — the Robot handles that. Note that the platform handlers (SmilioEventHandler, the Scala decode chain, the pest incident bundler) only fire on LoRaWAN/platform-fed records, NOT on the records this robot writes — a robot-fed pipeline must produce its own derived records.

2. **Create a Robot** in Composer:
   - Trigger recType: `io.microshare.feedback.packed`
   - Permissions: Share Read, Share Query, Share Write
   - Script: contents of `robot.js`
   - `MS_API_HOST` is `https://api.microshare.io` for generic accounts. **Prod host caveat:** pest-vanity tenants MUST use `https://pest.microshare.io/api` — `api.microshare.io` authenticates but returns only a SUBSET of records for them.

> **Robot auth:** the robot's `data.auth` must be a `grant_type=robot` token (scope `SHARE:READ,QUERY,WRITE`; add `SHARE:EXECUTE,POLICY` for a bundler) that returns HTTP 200 on `/api/share`. An `ALL:ALL`/session token authenticates but 401s there, so the robot dispatches and writes nothing ("silent dispatch death"). Re-kick a stalled robot by toggling `isActive`; never PUT a new auth.

3. **Configure the Ubiqod webhook** to POST to Microshare targeting your packed recType.

## How the Robot Works

**NetworkServer equivalent** — `extractUbiqod()`:
- Extracts `tracker.slug` as device.uuid, `timestamp` as event time
- Parses `site.location` for lat/lng
- Extracts battery, model, site metadata

**Decoder equivalent** — `decodeDataEvent()`:
- Maps `data.reference` + `data.label` → `pushes_since_reset`
- Maps `data.code` → `swipe` + `badge`
- Maps `tracker.batteryLevel` → `device_health.charge`

**Device twin lookup** — `loadTwinLookup()`:
- Reads the device cluster via `httpGet` to `/api/device/{recType}` on `MS_API_HOST`
- **Important**: device clusters are Composer objects (under `/device/`), not share records — use `httpGet`. Also note that `lib.readShareByType` does not exist as a `lib` function — calling it crashes the JS context silently. For share-record reads use `lib.readShareByTags(auth, recType, [], {})` instead.
- Caches in `bindings` with 24h TTL
- Falls back to Ubiqod site metadata if no twin match

**Vendor metadata location** — Ubiqod-specific fields go in `origin.ubiqod`, not `meta.*`. The `meta` section follows the standard Microshare data dictionary only.

## Logging

The robot writes a log record to `io.microshare.ubiqod.log` at each stage. Query in Composer to debug.

## Adapting for Other Devices

1. Copy `robot.js`
2. Replace `extractUbiqod()` with your device's JSON field extraction
3. Replace `decodeDataEvent()` / `decodeAlertEvent()` with your sensor field mappings
4. Keep the output structure — `meta.iot`, `meta.device`, `meta.dc`, `device_health`, and sensor fields at top level
