# Traplinked JERRY — Scheduled Poller Robot

A Microshare Robot that polls the [Traplinked REST API](https://docs.traplinked.com/rest/) for trap events and writes standard `io.microshare.trap.unpacked` records.

## Device

The **JERRY** is a WiFi/LoRa snap trap with two independent traps per unit. Traplinked devices communicate through their own platform — the LoRaWAN layer is fully abstracted behind their REST API. There is no raw payload or RF metadata available.

Device types supported: JERRY, JERRY_LORA, TRAPME, TOM, TRAPSENSOR.

## How it works

```
Traplinked Cloud API  ──poll──>  Robot  ──write──>  io.microshare.trap.unpacked
                                   │
                         Device cluster (twin)
                      io.microshare.traplinked.packed
```

1. **Poll**: Robot calls `GET /api/v1.9/devices` with `reports_since` to fetch new events
2. **Twin**: Robot reads the device cluster via `httpGet` to `/device/` API for location tags
3. **Map**: Builds standard unpacked record with sensor fields, device health, and origin
4. **Write**: `lib.writeShare(auth, recType, data, tags)` to `io.microshare.trap.unpacked`
5. **Dedup**: High-water mark on report timestamp (+1 second) to avoid re-processing events across poll cycles. See the [dedup guide](../../README.md#deduplication-poll-based-robots) for details.

## Unpacked record structure

See [unpacked-example.json](unpacked-example.json) for a full example.

| Section | Content |
|---|---|
| `meta.iot` | Device ID, timestamp, `type: "poll"` (no RF data — REST-polled) |
| `meta.device` | Location tags from device cluster twin |
| `meta.dc` | Cluster metadata: `network: "com.traplinked"` |
| `trap` | Dual trap state: `[{value, context: "Trap 1"}, {value, context: "Trap 2"}]` |
| `trap_event` | Report type: `trap_triggered`, `rearmed`, `catch_detected`, etc. |
| `trap_mode` | Operation mode: `snaptrap`, `movement`, or `insect` |
| `device_health` | Battery %, connection type (wifi/lora), last heartbeat, device status |
| `origin` | Full Traplinked API response preserved for debugging |

## Report types

| Code | Name | Description |
|---|---|---|
| 2 | `trap_triggered` | Trap mechanism fired |
| 3 | `rearmed` | Trap reset by user |
| 14 | `infested` | Infestation detected |
| 15 | `light_infestation` | Light infestation level |
| 16 | `severe_infestation` | Severe infestation level |
| 17 | `false_triggering` | False trigger (no catch) |
| 18 | `activity_warning` | Activity warning threshold |
| 19 | `activity_critical` | Activity critical threshold |
| 20 | `catch_detected` | Confirmed catch |

## Setup

1. Create a device cluster in Composer on `io.microshare.traplinked.packed`
2. Register each device with its serial number as the device ID
3. Set location tags on each device in the cluster
4. Replace `TL_TOKEN` and `TL_DEVICE_ID` in the robot config
5. Deploy as a scheduled robot (60s interval)

## Traplinked API

- **Base**: `https://api.traplinked.com/api/v1.9`
- **Auth**: Bearer token (API key from Traplinked dashboard)
- **Docs**: https://docs.traplinked.com/rest/
- **Device fields**: serial_number, name, type, status, battery_status, transfer_mode, operation_mode, last_heartbeat, location, trap_1, trap_2, reports
