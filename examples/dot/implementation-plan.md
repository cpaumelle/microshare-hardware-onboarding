# DOT-style integration — implementation plan

A worked plan for taking a DOT-style pest detection partner from "we
just signed a deal" to "real detection events flowing into customer
incidents" via Microshare. Follows the **Tactacam pattern**: single
robot, direct to the pest event tier, no `unpacked` intermediate.

This is a transparent partner-facing companion to
[`README.md`](README.md) — partners can read it to understand what's
being built, on what timeline, and where the seams are.

---

## Pipeline shape

Matches the canonical pest pattern: **detection (packed) → twinning
(device cluster) → event → incident**.

```
Vendor system ──[POST]──►  com.<vendor>.<usecase>.packed   (raw vendor JSON)
                                  │
                                  │  ── single detection robot
                                  │  - twins device ID via cluster
                                  │  - maps vendor event → standard pest event
                                  ▼
                       io.microshare.event.alert.rodent          (pest event tier)
                                  │  payload: { alert: "<pest_type>",
                                  │             event: "<event_name>",
                                  │             label: "<human-readable>", ... }
                                  │
                                  ▼  pest incident bundler (existing platform robot)
                                  │
                       io.microshare.event.alert.incident        (customer-visible)
```

The `event.alert.rodent` recType is the de-facto **pest event tier**
consumed by the bundler — the `alert` field in the payload
distinguishes pest types (rodent, bedbug, image, etc.). This is the
same pattern the [Tactacam example](../taqt/) implicitly uses.

---

## RecType + cluster naming

| Asset | Pattern | Example (DOT bedbug) |
|---|---|---|
| Vendor packed records | `com.<vendor>.<usecase>.packed` | `com.digitalodourtechnologies.bedbug.packed` |
| Pest event (shared) | `io.microshare.event.alert.rodent` | (same) |
| Incident (shared) | `io.microshare.event.alert.incident` | (same) |
| Cluster name | `Pest 2.2.0 Demo \| <Vendor> <Usecase>` | `Pest 2.2.0 Demo \| DOT Bedbug` |
| Cluster `data.network` | vendor namespace | `com.digitalodourtechnologies` |
| Cluster `data.facts.usecase` | new code per detection class | `SC11` for bedbug; existing `SC05` rodent, `SC08` Tactacam camera |
| Cluster `data.targetRecType` | direct to pest event tier | `io.microshare.event.alert.rodent` |

---

## Phases

### Phase 0 — provisioning (before the first vendor call)

1. Mint a permanent pipe token (`grant_type=pipe`, scope `SHARE:WRITE`)
   for the chosen recType. Persist it for the webhook URL. A pipe token
   only deposits, so it needs write-only scope — not `ALL:ALL`.
2. Compose the webhook URL and share it with the vendor (in
   [`README.md`](README.md)).
3. Smoke-test the URL with a synthetic POST → verify `200` and
   confirm the record appears in `share/<recType>`.
4. Create an empty device cluster on the target environment:
   - `recType`: vendor-namespaced (e.g. `com.<vendor>.<usecase>.packed`)
   - `data.network.network`: vendor namespace (e.g. `com.<vendor>`)
   - `data.facts.usecase`: new code for this detection class
   - `data.targetRecType`: `io.microshare.event.alert.rodent`
   - `data.devices`: `[]` (populated once the vendor sends inventory)

### Phase 1 — receive payload sample

1. Vendor POSTs one real event to the webhook URL (during a call,
   ideally).
2. Inspect the arriving record in `share/<recType>`.
3. Document the actual payload shape in `reference/api-reference.md`.
4. Identify field positions for: device id (deveui or other),
   timestamp, event vocabulary, severity/confidence (if any), battery,
   location metadata.

### Phase 2 — populate the cluster

Once the vendor sends the device inventory:

1. PUT the cluster with `data.devices[]` populated. Each entry:
   ```json
   {
     "id":   "<device-id>",
     "guid": "<device-id>",
     "meta": {
       "location": ["customer", "site", "area", "<device-id>"],
       "desc":     "<optional>"
     }
   }
   ```
2. Verify `/device/<recType>/<cluster_id>?details=true` returns each
   device.

### Phase 3 — single detection robot

> **Robot auth:** the robot's `data.auth` must be a `grant_type=robot` token (scope `SHARE:READ,QUERY,WRITE`; add `SHARE:EXECUTE,POLICY` for a bundler) that returns HTTP 200 on `/api/share`. An `ALL:ALL`/session token authenticates but 401s there, so the robot dispatches and writes nothing ("silent dispatch death"). Re-kick a stalled robot by toggling `isActive`; never PUT a new auth.
>
> Mint a dedicated `grant_type=robot` token for this robot — do **not** reuse the Phase 0 pipe token, which 401s on `/api/share`.

Create one robot in `robots/event.js`:

- **Trigger recType**: `com.<vendor>.<usecase>.packed`
- **Twin lookup**: cluster on the same recType. Device clusters are
  `/device` Composer objects; read them with an authenticated
  `httpGet()` (Java `HttpURLConnection`) — `lib.get` works too, but
  `httpGet()` is recommended. Note `lib.readShareByType` does **not**
  exist and crashes the robot silently; use `lib.readShareByTags`.
- **Map** vendor detection vocabulary → standard pest event vocabulary
  (e.g. `bedbug_detected` → `event: "bedbug_detected"`,
  `alert: "bedbug"`).
- **Write to** `io.microshare.event.alert.rodent` with the appropriate
  `alert` discriminator.
- **Tags**: `[...meta.device, "<usecase>", <device-id>]`
- **Per-event log** to `io.microshare.<vendor>.log`

### Phase 4 — verify the existing bundler picks it up

> **Note:** the platform bundler / event handlers fire on LoRaWAN/platform-fed records, and may NOT create incidents from a robot-fed pipeline. If incidents don't appear, ship a direct-write JS bundler (write the incident record yourself with `data.current.workflow.process.status='open'`), or widen the platform bundler's filter to admit your recType.

The shared **pest incident bundler** fires on `event.alert.rodent`. It
should bundle vendor-specific events the same way it bundles existing
rodent events — group them into incidents.

Verify:
1. Total count on `event.alert.rodent` increments after a vendor trigger
2. Total count on `event.alert.incident` increments
3. Incident is visible in the pest management portal with the correct
   `alert` (pest type) and `event` (specific event) values

If the bundler filters by `alert: "rodent"` strictly, it'll need its
filter widened, or a parallel bundler stood up for the new pest type.

### Phase 4.5 — share rule check (usually a no-op)

Microshare's policy engine filters reads by share rules. Most demo
accounts already have catch-all rules that cover any new vendor
recType for Read by same-org users. **Adding a new vendor integration
typically does NOT require a new share rule** — the existing
catch-alls (`recType='*'` with `resourceType='objs'/'devices'/'configs'`)
handle visibility automatically.

To verify on the target environment:

1. Have a non-root demo user (or installer-style account) log in to
   Composer.
2. In the device-cluster list, click "Shared with me".
3. Confirm the new cluster appears.

If it does → no rule needed.
If it doesn't → add a `callingOrg='='` per-recType rule with
`resourceType='objs'`. Template in
`reference/composer-api/SHARE_RULES_PEST_2.2.md` (or your environment's
equivalent).

A per-recType rule is also needed if same-org users need to **write**
directly to the new packed recType (e.g. for replay scripts or
manual testing). The catch-alls grant Read but not Write on packed.

### Phase 5 — end-to-end test

1. Vendor triggers a real device on real hardware.
2. Watch in order:
   - `<vendor>.packed` totalCount +1
   - `event.alert.rodent` totalCount +1 (with the right `alert`)
   - `event.alert.incident` totalCount +1 (or attached to existing)
3. Confirm in the pest management portal that the incident is visible.

Latency target: under 2 seconds end-to-end.

---

## File layout (this folder)

```
public/examples/dot/
├── README.md                          # partner-facing brief
├── implementation-plan.md             # this file
├── robots/
│   └── event.js                       # single detection robot (added in Phase 3)
└── reference/
    └── api-reference.md               # captured payload shape (added in Phase 1)
```

---

## Comparison with other patterns in this repo

| Aspect | This pattern (Tactacam-style) | Traplinked-style |
|---|---|---|
| Stages | 1 robot | 2 robots (poller + alert-generator) |
| Intermediate `unpacked` recType | no | yes |
| Audit trail of raw events | yes (in `<vendor>.packed`) | yes (in `<vendor>.packed` once decomposed; was implicit before) |
| State (bindings) | minimal — twin cache only | high — `lastReportTimestamp`, `seenReports`, twin cache |
| Best for | webhook-driven, single-event detections | poll-driven, state-machine event sequences |

Use this pattern (Tactacam-style) when:
- The vendor pushes via webhook (no polling needed)
- Each event is a one-off detection (no state machine across events)
- Immediate alert is acceptable (no aggregation needed before alerting)

Use the Traplinked-style decomposition when the vendor pushes multiple
related events that need aggregation, or when the upstream is a poll
loop with dedup state.

---

## Open questions (per integration)

- Detection vocabulary: what event types will the vendor send?
- Hardware identifier: deveui, serial number, IMEI, MAC?
- Severity / confidence: boolean detection or graded?
- Latency expectations on the vendor side?
- Photos / images attached to detections? May need a parallel
  `event.alert.image` flow like Tactacam.

---

## Out of scope

- Customer-side onboarding (creating the pest app views, scopes,
  bundling rules) — handled by the demo team once data is flowing.
- Whether to introduce a true `event.alert.<pest_type>` recType per
  pest class — for now we ride on `event.alert.rodent` as the
  de-facto pest event tier (matches Tactacam).
