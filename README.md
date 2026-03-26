# Microshare Hardware Onboarding

Rapid prototyping of new device integrations on the Microshare IoT platform — using Robots to validate the data pipeline before Scala NetworkServer and Decoder classes are written.

## Why

Onboarding a new hardware type into Microshare requires Scala code (a NetworkServer to extract device identity from vendor JSON, and a Decoder to map fields to Microshare's data dictionary). The dev/QA/deploy cycle takes time.

A Microshare Robot can do both jobs in JavaScript, letting you:

- **Validate** — confirm the webhook payload maps correctly to unpacked records
- **Test** — run with real devices immediately, no Scala build needed
- **Iterate** — edit the script in Composer, re-test in seconds
- **Specify** — the working Robot becomes the spec for the Scala classes

Once the Scala is deployed by the Microshare platform team, the Robot is retired.

## Examples

### [`examples/taqt/`](examples/taqt/) — Inbound webhook

[Ubiqod](https://help.taqt.com/portal/en/kb/articles/getting-events-and-data-from-ubiqod-using-the-webhook) TaqtOne feedback device. The device platform sends JSON via webhook to a Microshare packed recType; a Robot triggers and unpacks it.

### [`examples/traplinked/`](examples/traplinked/) — Outbound poll (REST API)

[Traplinked](https://docs.traplinked.com/rest/) JERRY snap trap. A scheduled Robot polls the Traplinked REST API for trap events, reads the device cluster for twinning, and writes standard unpacked records.

### [`examples/futura/`](examples/futura/) — Outbound poll (REST API)

[Futura Emitter](https://emitter-trap-management.emittercloud.m2mgate.de/q/swagger-ui/) trap management. A scheduled Robot polls the Futura REST API for new trap events and writes them to Microshare.

## Connecting a Device Platform to Microshare

To receive webhook data from a device platform, generate a **pipe token** in Microshare and give the vendor this URL:

```
https://dapi.microshare.io/share/{your-packed-recType}/token/{your-pipe-token}
```

No authentication headers needed — the token in the URL is the credential. The device platform POSTs JSON to this URL, and your Robot triggers automatically.

See [`reference/webhook-ingest.md`](reference/webhook-ingest.md) for the full setup guide.

## How It Works

Raw JSON from a device goes through three steps to become a Microshare unpacked record:

1. **Extract** — find the device ID (IMEI, DevEUI, serial number) in the inbound JSON
2. **Match** — look up that ID in the device cluster to get location tags
3. **Map** — translate vendor-specific fields to Microshare's standard schema

The device ID is the single field that connects everything. It must appear in both the inbound JSON and the device cluster. See [`reference/pipeline-diagram.md`](reference/pipeline-diagram.md) for the full visual walkthrough.

## Deduplication (Poll-Based Robots)

When your Robot polls a vendor REST API on a schedule, the same event can be returned by the API more than once across poll cycles. Without dedup, each duplicate creates a separate unpacked record and cascades through the pipeline.

### If the API provides a unique event ID

Use it as the dedup key. Store seen IDs in `bindings` and skip events you've already processed:

```javascript
if (bindings.seenIds.indexOf(event.uuid) !== -1) continue;  // already processed
bindings.seenIds.push(event.uuid);
```

### If the API only provides timestamp + type

Many REST APIs return events with a timestamp and event type but no unique ID. In this case, use a **high-water mark** approach: after each poll, save the newest event timestamp, and on the next poll, request only events after that timestamp plus one second.

```javascript
// On each poll, ask for events strictly after the last one we saw
var since = bindings.lastTimestamp;
if (since) {
    var d = new Date(new Date(since + 'Z').getTime() + 1000);  // +1 second
    since = d.toISOString().replace('Z', '').split('.')[0];
}

// ... fetch and process events ...

// Save the newest timestamp for next poll
if (reports.length > 0) {
    var newest = reports[0].timestamp;
    for (var j = 1; j < reports.length; j++) {
        if (reports[j].timestamp > newest) newest = reports[j].timestamp;
    }
    bindings.lastTimestamp = newest;
}

return bindings;  // persist for next poll cycle
```

### Important: `bindings` resets on redeploy

Robot `bindings` persist between poll cycles but reset when the Robot script is updated via PUT. On the first run after a redeploy, your Robot has no history. Use a short lookback window (e.g. 5 minutes) rather than a long one (24 hours) to limit how many events get re-processed:

```javascript
if (!bindings.lastTimestamp) {
    var d = new Date(Date.now() - 300000);  // 5 minutes, not 24 hours
    since = d.toISOString().replace('Z', '').split('.')[0];
}
```

### Best practice: switch to webhooks

If the vendor supports webhooks, prefer them over polling. Webhooks push each event exactly once to a Microshare pipe token URL, eliminating the dedup problem entirely. See the [Taqt example](examples/taqt/) for the webhook pattern.

## Device Health

The Microshare dashboard shows battery level, connectivity, and last-seen time for each device. This data comes from `io.microshare.device.health` records — a separate recType from the unpacked sensor data.

For LoRaWAN devices, the Scala pipeline writes health records automatically from the decoded payload (voltage, temperature, RSSI). For REST-polled devices, your Robot needs to write these explicitly.

### Writing device health from your Robot

On each poll cycle, write a `io.microshare.device.health` record alongside your unpacked records:

```javascript
var healthRecord = {
    id: device.serial_number,
    charge: [{ unit: '%', value: batteryPercent }],
    voltage: [{ unit: 'V', value: null }],       // null if not available from vendor API
    temperature: [{ unit: '°C', value: null }],   // null if not available
    meta: unpacked.meta,                           // same meta as the unpacked record
    origin: { deviceClusterId: clusterId }
};
lib.writeShare(auth, 'io.microshare.device.health', healthRecord, tags);
```

### What to map from the vendor API

| Health field | What to map | Source |
|---|---|---|
| `charge` | Battery level as % | Most APIs provide this directly or as a 0.0-1.0 ratio |
| `voltage` | Raw voltage if available | LoRaWAN decoders provide this; REST APIs usually don't — use `null` |
| `temperature` | Device temperature if available | Use `null` if the API doesn't expose it |
| `last_seen` | When the device last communicated | Map from `lastHeartbeat`, `lastActive`, `lastSeen`, or similar |
| `connection` | Connection type or signal quality | WiFi/LoRa/cellular — whatever the API provides |
| `status` | Device operational status | Map from the vendor's status code |

### Tracking missed messages (offline detection)

LoRaWAN devices report RSSI/SNR for signal quality, but REST-polled devices don't have that. Instead, use the **last seen timestamp** to detect offline devices:

- Every vendor API has some form of "last heartbeat" or "last active" timestamp
- Write it to `last_seen` in the health record on every poll
- The dashboard can flag devices where `now - last_seen` exceeds the expected reporting interval
- For the Traplinked JERRY (WiFi), the expected heartbeat is every few hours. If `last_heartbeat` is more than 24 hours old, the device is likely offline

### Key points

- Write health records **once per poll cycle**, not per event — health is a device snapshot, not an event
- Include `null` for fields the vendor API doesn't provide — the dashboard handles missing data gracefully
- The `meta` structure must match the unpacked record (same `dc.id`, `device` tags, `global` tags) for the dashboard to associate health with the right device
- Health records need `meta.global` to include your use case tag (e.g. `"trap"`) for the dashboard's `dataContext` filter
- Don't try to fabricate LoRaWAN metrics (RSSI, SNR, spreading factor) for non-LoRaWAN devices — provide what the vendor API actually gives you

## Device Cluster Twinning

A key part of producing correct unpacked records is **twinning** — attaching location metadata to each device.

In Microshare, a **device cluster** holds a list of devices with their IDs and location tags. When the platform processes a record, it looks up the device and adds the location as `meta.device`. Your Robot needs to do the same.

1. **Create a device cluster** in Composer on your packed recType
2. **Register devices** with their IDs and location tags (building / floor / room / sensor)
3. **The Robot reads the cluster** at runtime, builds a device ID → location lookup, and attaches `meta.device` to each unpacked record

The validation script checks this for you:

```bash
python tools/validate.py --rectype io.microshare.feedback.packed
```

See [`reference/composer-api.md`](reference/composer-api.md#device-clusters) for the API and code examples.

---

## Composer API & Tools

Deploy and manage Robots, read and write data, and interact with device clusters — all from the command line.

**[`reference/composer-api.md`](reference/composer-api.md)** — API reference: authentication, data lake, Robots, device clusters.

**[`tools/ms_auth.py`](tools/ms_auth.py)** — Authentication helper that obtains a token for API access.

**[`tools/validate.py`](tools/validate.py)** — Setup validation: checks credentials, API access, data lake, and Robot deployment.

```bash
pip install requests

export MICROSHARE_USER=you@example.com
export MICROSHARE_PASS=yourpassword
TOKEN=$(python tools/ms_auth.py)

# List your Robots
curl -s "https://dapi.microshare.io/robo/*" \
  -H "Authorization: Bearer $TOKEN" | jq ".objs[].name"

# Read the latest records
curl -s "https://dapi.microshare.io/share/io.myapp.events?details=true" \
  -H "Authorization: Bearer $TOKEN" | jq ".objs[].data"
```

## Reference

| File | Description |
|---|---|
| [`reference/webhook-ingest.md`](reference/webhook-ingest.md) | Connecting a device platform to Microshare via pipe token |
| [`reference/pipeline-diagram.md`](reference/pipeline-diagram.md) | Visual: how packed data becomes enriched unpacked records |
| [`reference/composer-api.md`](reference/composer-api.md) | Microshare Composer API — auth, data lake, Robots, device clusters |
| [`reference/unpacked-record-structure.md`](reference/unpacked-record-structure.md) | Target schema for unpacked records |

## Adapting for Other Devices

1. Copy `examples/taqt/robot.js` (webhook) or `examples/traplinked/robot.js` (poll)
2. Replace the extraction function with your device's JSON structure
3. Replace the decode function with your sensor field mappings
4. Keep the output structure (`meta.iot`, `meta.device`, `meta.dc`, `device_health`, sensor fields at top level)
