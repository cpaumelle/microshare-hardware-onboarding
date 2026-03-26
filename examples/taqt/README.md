# Example: Ubiqod (Taqt) Feedback Device

A Microshare Robot that receives [Ubiqod](https://help.taqt.com/portal/en/kb/articles/getting-events-and-data-from-ubiqod-using-the-webhook) webhook JSON and writes standard feedback records — compatible with existing SmilioAction dashboards.

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
  "origin": { "ubiqod_webhook": { ... } }
}
```

## Setup

1. **Create a device cluster** in Composer on your packed recType. Register devices with their IMEI and location tags. The cluster doesn't need a NetworkServer or Decoder — the Robot handles that.

2. **Create a Robot** in Composer:
   - Trigger recType: your packed recType
   - Permissions: Share Read, Share Query, Share Write
   - Script: contents of `robot.js`
   - Update `PACKED_RECTYPE` and `OUTPUT_RECTYPE` at the top of the script

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
- Reads the device cluster via `lib.readShareByType()` for device.uuid → location mapping
- Caches in `bindings` with 24h TTL
- Falls back to Ubiqod site metadata if no twin match

## Adapting for Other Devices

1. Copy `robot.js`
2. Replace `extractUbiqod()` with your device's JSON field extraction
3. Replace `decodeDataEvent()` / `decodeAlertEvent()` with your sensor field mappings
4. Keep the output structure — `meta.iot`, `meta.device`, `meta.dc`, `device_health`, and sensor fields at top level
