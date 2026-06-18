# Example: DOT Pest Trap — Inbound Webhook

A partner-facing brief for connecting a DOT-style pest trap platform to
Microshare via webhook. DOT (or any equivalent rodent / pest device
vendor) POSTs trap event JSON to a Microshare URL; downstream Robots
enrich, alert, and bundle into customer-visible incidents.

This is a "talk-to-the-vendor" document — code/robot examples will be
added once a real DOT payload sample is captured. Until then, see
[`examples/taqt/`](../taqt/) for the same webhook pattern with worked
robot code.

---

## TL;DR for the vendor

POST your trap event JSON to a URL Microshare provides. No additional
auth. Microshare's Robots enrich it with location and customer
metadata, then route it into the standard pest pipeline (incident
creation in the pest management app).

---

## Webhook URL pattern

```
https://pest.microshare.io/api/share/io.microshare.<vendor>.packed/token/<PIPE_TOKEN>
```

| Part | Meaning |
|---|---|
| `pest.microshare.io` | The Microshare environment (PestServer 2.2 demo) |
| `io.microshare.<vendor>.packed` | recType for the vendor's raw events (e.g. `com.<vendor>.<usecase>.packed`) |
| `<PIPE_TOKEN>` | A write-only credential, minted once per vendor |

The token is bound to this URL — it can only write to the named
recType, cannot read records, and cannot be reused for other recTypes.

---

## HTTP details

| | |
|---|---|
| Method | `POST` |
| Content-Type | `application/json` |
| Authentication | None — the token is in the URL path |
| Expected response | `200 OK`, body is JSON with the created record id and timestamp |
| `401` | Token invalid or expired |
| `400` | Body malformed |
| `5xx` | Microshare-side error — please retry with exponential backoff |

Path-tag augmentation is supported if useful on the vendor's side:

```
.../token/<TOKEN>/<tag1>/<tag2>/...
```

Any path segments after the token are attached as tags on the record.

---

## What the vendor sends

POST whatever JSON shape the vendor's platform already uses. The
request body becomes the record's `data` field verbatim — no specific
schema required. The Microshare unpacker Robot is adapted per vendor
after seeing a few real events.

To shorten the iteration loop, here's where common fields end up
mapped in our pipeline. If the vendor's payload includes them under
any names, integration is faster:

| Concept | Where it goes |
|---|---|
| Device unique ID | `meta.iot.device_id` (used for cluster twin lookup) |
| Event timestamp | `meta.iot.iso_time` |
| Event type / state | `trap_event[].value` (e.g. `trap_triggered`, `catch_detected`) |
| Trap state per slot (dual-trap units) | `trap[].value` + `trap[].context` |
| Battery level | `device_health.charge[].value` |
| Latitude / longitude | `meta.iot.lat` / `meta.iot.lng` |
| Connection status / mode | `device_health.connection[].value` |

If the vendor already delivers webhooks to other partners with a
stable shape, sending that same shape is fine — the unpacker adapts to
the input rather than requiring the vendor to reformat.

---

## Quick smoke test

Once the URL is provisioned, the vendor can verify connectivity with a
single curl:

```bash
curl -X POST 'https://pest.microshare.io/api/share/com.<vendor>.<usecase>.packed/token/<TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{
    "device_id": "VENDOR-TEST-1",
    "event_type": "trap_triggered",
    "timestamp": "2026-05-06T09:00:00Z",
    "battery": 95
  }'
```

Expected: `200 OK` with a JSON body containing the new record's `id`
and `tstamp`. Microshare can confirm receipt in real-time.

---

## What Microshare needs from the vendor

1. **One sample of a real webhook payload** (any event type, real or
   anonymised values). This defines the shape the unpacker maps from.
2. **List of event types** the vendor will send (e.g.
   `trap_triggered`, `catch_detected`, `rearmed`, `battery_low`,
   `offline`/`online`). Maps to the standard rodent alert vocabulary.
3. **Device inventory**:
   - Serial numbers / device IDs to expect
   - Customer / site / area / position labels per device (so
     incidents carry meaningful locations)
   - Hardware type (snap-trap, motion sensor, dual-trap, camera, etc.)
4. **Retry policy** on the vendor side: when the endpoint returns
   `5xx`, what does the vendor's system do? (Capacity-planning input.)

---

## What Microshare provides

1. The pipe-token URL (one per vendor, persistent)
2. A device cluster registered with the vendor's device IDs and
   location metadata — Microshare maintains this; the vendor only
   sends events keyed by device ID
3. A single detection Robot that maps the vendor's shape directly into
   the standard pest event tier (`io.microshare.event.alert.rodent`
   with the appropriate `alert` discriminator)
4. Connection to the existing pest pipeline:
   - `event.alert.rodent` → `event.alert.incident` (pest incident bundler, shared)
5. End-to-end verification: a real device event reaching an incident
   in the pest management app

Typical turnaround once a payload sample is captured: 1–2 days.

---

## Architecture (Microshare side)

```
Vendor system ──[POST]──►  com.<vendor>.<usecase>.packed   ◄── what the vendor sends (raw)
                                  │
                                  ▼  [event-triggered Robot — single detection robot]
                                  │  - twins device ID via cluster
                                  │  - maps vendor event → standard pest event vocabulary
                                  │
                           io.microshare.event.alert.rodent  ◄── pest event tier
                                  │     payload includes `alert: "<pest_type>"` discriminator
                                  │     (e.g. "rodent", "bedbug", "image")
                                  │
                                  ▼  [event-triggered Robot — pest incident bundler, existing]
                                  │
                           io.microshare.event.alert.incident ◄── customer-visible
```

> **Note:** the platform bundler / event handlers fire on LoRaWAN/platform-fed records, and may NOT create incidents from a robot-fed pipeline. If incidents don't appear, ship a direct-write JS bundler (write the incident record yourself with `data.current.workflow.process.status='open'`), or widen the platform bundler's filter to admit your recType.
>
> The detection robot's `data.auth` must be a `grant_type=robot` token (scope `SHARE:READ,QUERY,WRITE`) returning HTTP 200 on `/api/share` — see the [implementation plan](implementation-plan.md) Phase 3.

Each `─►` is one Robot. Each stage's records are persisted, so any
misbehavior can be debugged without re-querying the vendor. This is the
**Tactacam pattern** — single robot, no `unpacked` intermediate, direct
to the pest event tier. The `event.alert.rodent` recType is, in
practice, the de-facto "pest event" tier consumed by the bundler — the
`alert` field in the payload distinguishes pest types (rodent, bedbug,
image, etc.).

For integrations with state-machine semantics (e.g., trap_triggered →
catch_detected → rearmed across multiple events) see the
[Traplinked example](../traplinked/), which uses a two-stage poller +
alert-generator pattern with an `unpacked` intermediate.

---

## Related references

| | |
|---|---|
| [`reference/webhook-ingest.md`](../../reference/webhook-ingest.md) | Connecting a device platform to Microshare via pipe token |
| [`reference/pipeline-diagram.md`](../../reference/pipeline-diagram.md) | Visual: how packed data becomes enriched unpacked records |
| [`reference/composer-api.md`](../../reference/composer-api.md) | Composer API — auth, data lake, Robots (incl. robot-auth), device clusters |
| [`reference/unpacked-record-structure.md`](../../reference/unpacked-record-structure.md) | Target schema for unpacked records |
| [`examples/taqt/`](../taqt/) | Canonical webhook pattern with worked Robot code |
| [`examples/traplinked/`](../traplinked/) | Pest trap pattern (poll-based, but same downstream pipeline) |
