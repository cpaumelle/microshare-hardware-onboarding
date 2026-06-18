# Unpacked Record Structure

What a Microshare device cluster produces. Your Robot should write records matching this schema.

## Record Envelope

```json
{
  "recType": "io.microshare.<domain>.unpacked",
  "tags": ["Building", "Floor", "Room", "Sensor"],
  "data": { ... }
}
```

## `data.meta.iot` — Transport Metadata

```json
{
  "device_id": "867280060123456",
  "time": "2026-03-24T10:15:30.000Z",
  "iso_time": "2026-03-24T10:15:30.000Z",
  "type": "uplink",
  "ns_version": "v1.0"
}
```

The `device_id` field holds the device.uuid — the unique identifier from the vendor (IMEI, serial number, DevEUI, etc.).

## `data.meta.device` — Location Tags

```json
["Building", "Floor", "Room", "Sensor"]
```

From the device cluster's twin entry. Your Robot should look this up via `lib.readShareByType()`.

## `data.meta.dc` — Device Cluster Metadata

```json
{
  "name": "My device cluster",
  "network": "com.vendor.platform",
  "unpacker": "robot.vendor.device"
}
```

Identifies which cluster and unpacker processed this record.

## `data.meta.global` / `data.meta.source`

Both empty arrays `[]`.

## `data.device_health`

```json
{
  "id": "867280060123456",
  "charge": [{"unit": "%", "value": 93}]
}
```

All values use the `[{unit, value}]` array pattern.

## `data.<sensor_fields>` — Sensor Data

Sensor fields sit at the top level of `data`. Each uses `[{value}]` or `[{unit, value}]`:

| Domain | Fields |
|---|---|
| Feedback | `pushes_since_reset`, `swipe` |
| Trap | `trap_event` |
| Environment | `temperature`, `humidity`, `co2`, `voc` |
| Motion | `presence`, `motions_since_reset` |
| Open/close | `open`, `events_since_reset` |

## `data.origin`

Preserve the full raw payload for debugging:

```json
{
  "ubiqod_webhook": { ... }
}
```
