# Taqt (Ubiqod) → Microshare: clean-pipeline dispatch with JS robots

A self-contained worked example: take a Taqt/Ubiqod feedback button's webhook,
unpack it into a Smilio-shaped record, and generate the downstream feedback
events — entirely with JavaScript robots, no platform Scala decoder. Runnable on
dev (`dapi.microshare.io`).

## The key lesson

Microshare's platform event handlers — `SmilioEventHandler`, the Scala decode
chain, the pest incident bundler — fire on **LoRaWAN / platform-fed records only**.
They do **not** fire on records that a robot or a pipe token writes. So when you
feed a pipeline yourself (webhook → pipe token → robot), the platform will not
generate the derived `*.event.meta` / `event.alert.feedback` records for you.

A robot-fed pipeline must therefore produce its own derived records. That's why
this folder pairs an unpacker robot with a JS replica of the event handler:

| File | What it does |
|---|---|
| `taqt-unpacker.js` | Triggers on `<vendor>.taqt.packed`, parses the Ubiqod webhook, twin-matches against the device cluster, and writes a Smilio-shaped record to `<vendor>.taqt.unpacked`. |
| `event-meta.js` | A JS replica of the platform's `SmilioEventHandler`. Triggers on `<vendor>.taqt.unpacked`, diffs each button's cumulative count against per-device history in `bindings`, looks up the cluster's backboard view, and emits `<recType>.event.meta` + `io.microshare.event.alert.feedback`. |

The unpacked output shape mirrors the Smilio decoder in the public
[`microshare/lib-unpackers`](https://github.com/microshare/lib-unpackers)
(`SmilioAction.scala`), so downstream consumers that already expect Smilio
feedback records work unchanged.

---

## Deploy

A device cluster shaped like this:

```jsonc
{
  "name": "Taqt feedback cluster",
  "recType": "io.microshare.<vendor>.taqt.packed",
  "tags":    ["<your-tag>"],
  "data": {
    "isActive":       true,
    "targetRecType":  "io.microshare.<vendor>.taqt.unpacked",
    "network":        { "network": "com.taqt.ubiqod", "region": "EU868", "version": "v1.1" },
    "meta": {
      "type":     "eu.skiply.button.SmilioAction.Decoder",
      "unpacker": "eu.skiply.button.SmilioAction.Decoder",
      "location": "<csv,of,context,tags>"
    },
    "facts": {
      "usecase":   "SF01",
      "backboard": "<backboard-view-id>"
    },
    "devices":   [
      {
        "id":   "<device-slug>",                 // e.g. the Ubiqod tracker.slug (IMEI)
        "guid": "<lowercase-no-dashes>",
        "meta": { "location": ["L1","L2","L3","L4","L5"] },
        "state": {}
      }
    ],
    "readAuth":  "<32-byte-hex>",
    "writeAuth": "<same 32-byte hex>"
  }
}
```

Plus the two robots in this folder. Because they write derived and bundled
records, both need the full **5 scopes**:
`[SHARE:READ, SHARE:QUERY, SHARE:WRITE, SHARE:EXECUTE, SHARE:POLICY]`.
`__MS_API_HOST__` is patched to your API host at deploy time
(`https://dapi.microshare.io` on dev; on prod use `https://pest.microshare.io/api`
for pest-vanity tenants — `api.microshare.io` returns only a subset of records for them).

> **Robot auth:** the robot's `data.auth` must be a `grant_type=robot` token (scope `SHARE:READ,QUERY,WRITE`; add `SHARE:EXECUTE,POLICY` for a bundler) that returns HTTP 200 on `/api/share`. An `ALL:ALL`/session token authenticates but 401s there, so the robot dispatches and writes nothing ("silent dispatch death"). Re-kick a stalled robot by toggling `isActive`; never PUT a new auth.

---

## 1. Webhook → packed

The Ubiqod portal POSTs each event to a pipe-token URL on the packed recType:

```
POST https://dapi.microshare.io/share/io.microshare.<vendor>.taqt.packed/token/<PIPE_TOKEN>
Content-Type: application/json
```

The body is the raw Ubiqod webhook JSON. Example from a TaqtOne button:

```json
{
  "account": { "name": "Example Organisation" },
  "alert": null,
  "data": {
    "code": null,
    "interfaceType": "TAQTONE",
    "label": "Please clean",
    "photo": null,
    "pressCount": 2,
    "rate": 5,
    "reference": "5"
  },
  "eventType": "DATA",
  "location": "48.637004,-2.052779",
  "site": {
    "id":       "00000000-0000-0000-0000-000000000000",
    "label":    "Demo site",
    "location": "48.637004,-2.052779",
    "contacts": [
      { "type": "CUSTOMER", "fullName": "", "email": "", "phone": "" },
      { "type": "MANAGER",  "fullName": "", "email": "", "phone": "" }
    ],
    "externalReferences": {}
  },
  "timestamp": "2026-05-01T15:59:49.802Z",
  "tracker": {
    "id":    "00000000-0000-0000-0000-000000000000",
    "slug":  "860000000000001",
    "label": "Service Requests",
    "type":  "IOT",
    "model": "TAQTONE",
    "batteryLevel": 85,
    "externalReferences": {}
  },
  "ubiqodValidity": {
    "badgeSwiped":    false,
    "codeFromCookie": false,
    "codeValid":      false,
    "onSite":         true,
    "scanToken":      false,
    "withPhoto":      false
  }
}
```

The fields that matter for the unpacker:
- `tracker.slug` — the device id, twin-matched against `cluster.data.devices[].id`
- `data.reference` — which button (1–5)
- `data.pressCount` — cumulative count, drives the Smilio `pushes_since_reset` deltas
- `ubiqodValidity.badgeSwiped` — drives `swipe[].value` (Hall Effect)
- `data.code.reference` (when present) — RFID/badge id

Three event types are possible: `DATA` (button press / badge), `KEEP_ALIVE`
(heartbeat), and `ALERT` (satisfaction threshold). The unpacker handles all three.

---

## 2. Unpacker → unpacked (Smilio-shaped)

`taqt-unpacker.js` runs on the cluster's source recType (`<vendor>.taqt.packed`)
and emits records on the cluster's `targetRecType` (`<vendor>.taqt.unpacked`)
with full twin-lookup-populated location:

```json
{
  "pushes_since_reset": [
    { "context_id": "Button #1, Upper Left",  "value": 0  },
    { "context_id": "Button #2, Upper Right", "value": 0  },
    { "context_id": "Button #3, Lower Left",  "value": 18 },
    { "context_id": "Button #4, Lower Right", "value": 8  },
    { "context_id": "Button #5, Middle",      "value": 28 }
  ],
  "swipe": [{ "value": false }],
  "meta": {
    "dc": {
      "facts":    { "backboard": "<backboard-view-id>", "usecase": "SF01" },
      "id":       "<cluster-id>",
      "name":     "<cluster-name>",
      "network":  "com.taqt.ubiqod",
      "recType":  "io.microshare.<vendor>.taqt.packed",
      "unpacker": "eu.skiply.button.SmilioAction.Decoder",
      "usecase":  "SF01"
    },
    "device": ["L1", "L2", "L3", "L4", "L5"],
    "global": ["<dataContext1>", "<dataContext2>"],
    "iot":    { "device_id": "860000000000001", "fcnt_up": 23,
                "iso_time": "2026-05-01T16:00:29Z", "type": "uplink" },
    "source": []
  },
  "device_health": {
    "id": "860000000000001",
    "charge": [{ "unit": "%", "value": 85 }]
  },
  "badge": [{ "context": "<rfid>", "value": "<rfid>", "externalReferences": {} }],
  "origin": { "deviceClusterId": "<cluster-id>", "ubiqod": { /* original webhook fields */ } }
}
```

---

## 3. event-meta replica → feedback events

Because the platform handlers do not fire on robot/pipe writes (see the key
lesson above), `event-meta.js` does the diff-and-emit itself:

- it compares each button's `pushes_since_reset[i].value` to the previous value
  held in `bindings.lastPushes` (per device),
- on a positive delta it writes a `<recType>.event.meta` record, and
- an `io.microshare.event.alert.feedback` record, pulling the alert's display
  fields from the cluster's backboard view.

With both robots deployed, a few Ubiqod payloads run end-to-end:
`.packed` → `.unpacked` → `.event.meta` + `event.alert.feedback`.

---

## 4. Tokens and identity

- **Pipe token** (write-only, permanent — for the webhook deposit to `.packed`):
  `POST <auth>/oauth2/token?username=…&password=…&client_id=…&grant_type=pipe&scope=SHARE:WRITE`
- **Robot token** (for each robot's `data.auth` — read/query/write):
  `POST <auth>/oauth2/token?…&grant_type=robot&scope=SHARE:READ,SHARE:QUERY,SHARE:WRITE`
  (add `SHARE:EXECUTE,SHARE:POLICY` for a bundler). It **must** return HTTP 200 on
  `/api/share` — an `ALL:ALL`/session token authenticates but 401s there, so the
  robot dispatches and writes nothing ("silent dispatch death").
- Both must be minted under the **same identity**. The OAuth endpoint binds tokens
  to whichever identity is active in the UI session, and there's no API parameter
  to pin it. Mismatched identities produce "record exists by id but doesn't list"
  symptoms — a separate gotcha worth knowing.
