# Traplinked — Stage 2 (Production)

Production-ready Scala pipeline code for the Microshare platform team to review, QA, and deploy.

## What changes from Stage 1

| Component | Stage 1 (Robot) | Stage 2 (Scala) |
|---|---|---|
| Poller | Writes packed + unpacked + health | Writes **packed only** |
| Decoder | `buildUnpacked()` in Robot JS | `TraplinkedDecoder.scala` |
| Health | Robot writes `device.health` | Stream service writes from decoder output |
| Alert | Alert Generator Robot | `TraplinkedEventHandler.scala` |
| Bundler | No change | No change |

## Files

| File | Purpose |
|---|---|
| `poller-robot.js` | v2 Poller — writes packed only (permanent Robot) |
| `TraplinkedDecoder.scala` | Decoder: packed → unpacked + health |
| `TraplinkedEventHandler.scala` | Event handler: generates `event.alert.rodent` |
| `device-cluster-config.json` | Device cluster configuration template |

## Decoder

**Name:** `com.traplinked.trap.JERRY.Decoder`

Follows the naming convention: `{vendor}.{category}.{model}.Decoder`

The decoder reads `meta.iot.payload` (JSON string from the poller Robot) containing the full Traplinked device + report data and produces:

- **Telematics** → `trap`, `trap_event`, `trap_mode` (sensor fields at top level)
- **Health** → `charge`, `voltage` (derived from battery_status), `temperature`

Unlike LoRaWAN decoders that parse hex payloads, this decoder maps JSON → JSON.

## Event Handler

**Name:** `TraplinkedEventHandler`

Routing: matched by decoder name in `AgentHandlerSupervisor`, not by use_case SC05.

```scala
// Add to AgentHandlerSupervisor.scala — BEFORE the RODENT_MONITORING_USE_CASE case
val TRAPLINKED_DECODER = "com.traplinked.trap.JERRY.Decoder"

case (_, _, _, Some(TRAPLINKED_DECODER)) =>
  context.actorOf(TraplinkedEventHandler.props(descriptor), actorName)
```

Does NOT extend `RodentEventHandler`. Traplinked gives definitive event types (catch_detected, trap_triggered) — no 4-reading motion pattern analysis needed.

## Device Cluster

The device cluster must have:

```
meta.unpacker = "com.traplinked.trap.JERRY.Decoder"
meta.type     = "com.traplinked.trap.JERRY.Decoder"
meta.location = "Customer Name,trap"    ← comma-separated global tags
facts.usecase = "SC05"
network       = "com.traplinked.api"
```

See `device-cluster-config.json` for the full template.

## Migration from Stage 1

1. Verify Stage 1 poller is writing packed records (it does since Stage 1 writes both)
2. Deploy `TraplinkedDecoder.scala` to the decoder library
3. Deploy `TraplinkedEventHandler.scala` to stream-service
4. Add `TRAPLINKED_DECODER` routing to `AgentHandlerSupervisor.scala`
5. Update device cluster `meta.unpacker` and `meta.type` to `com.traplinked.trap.JERRY.Decoder`
6. Run parallel: keep Stage 1 robots active, enable Scala pipeline, compare outputs
7. Once validated: switch to v2 poller (packed only), disable alert generator Robot
8. Verify end-to-end: packed → unpacked → alert → bundler → incident → dashboard
