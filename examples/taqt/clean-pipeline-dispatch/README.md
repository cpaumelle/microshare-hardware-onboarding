# Taqt → Microshare Clean pipeline — feedback events not generated

> **The ask (open to anyone at Microshare who has time to look):**
> I've been trying to feed the Clean pipeline with a Taqt robot which
> should replicate the Network Server and unpacker. Taqt have a very
> good webhook platform and the `.packed` arrives fine. I can get the
> `.unpacked` fine but the events just don't seem to get created. Can
> you check this out and give my Claude Code instructions to make it
> work?

This folder is a self-contained reproduction, runnable on dev
(`dapi.microshare.io`).

---

## 1. Where we are stuck and our assumptions

We have a Microshare-platform-conformant Taqt feedback cluster on
dapi. Its `data.facts.usecase = "SF01"` and `data.meta.unpacker =
"eu.skiply.button.SmilioAction.Decoder"`. It is `isActive: true`. We
deposit records on its `targetRecType` (e.g.
`io.microshare.<vendor>.taqt.unpacked`) that are byte-shape-identical
to what the Scala `eu.skiply.button.SmilioAction.Decoder` produces
(5-slot `pushes_since_reset[]`, `swipe[]`, `meta.iot/dc/device/global`).

**The platform's `SmilioEventHandler` does not fire on these records.**
We see no `*.unpacked.event.meta` and no `event.alert.feedback`
records produced by the platform on this account. We do see them
produced by our own JS replicas (the workaround in this folder), but
not by the Scala chain.

We have read the relevant Scala source (`stream-service-3`) and
confirmed every documented condition for SmilioEventHandler
instantiation is satisfied by our cluster. We have also confirmed that
`CommonCRUDService.postByType` publishes a Kafka event on every share
and device write — including pipe-token writes — which should be the
trigger feed for `UpdateConfigReader` (devices) and
`DeviceStreamReader` (shares).

We can't observe `stream-service-3` logs from outside, so we can't tell
whether on dev:
- the agent supervisor is running at all,
- it has loaded our cluster into `agentChannels`,
- it received a `Reload` for our cluster's create event,
- it received any `share-events` Kafka messages for our writes,
- the cluster passed the `getRoboConfig` query but failed the
  `DeviceDescriptor.fromRecord` parser,
- or there is an environment-level filter (e.g.
  `robots.whitelistORblacklist.tags`, `replay.agents.ids`,
  `debug.disable_outbound`) excluding our org.

That's the scope of the question we'd appreciate help with: **on dev,
what is preventing SmilioEventHandler from being instantiated for our
cluster, or from firing on records arriving at its targetRecType?**

We have **not** assumed any specific remediation. The rest of this
document is the facts.

---

## 2. What's in this folder

| File | What it is |
|---|---|
| `taqt-unpacker.js` | User robot. Triggers on `<vendor>.taqt.packed`, parses the Ubiqod webhook, twin-matches against the device cluster, writes a Smilio-pixel-identical record to `<vendor>.taqt.unpacked`. |
| `event-meta.js` | User-side replica of `SmilioEventHandler` in JS. Triggers on `<vendor>.taqt.unpacked`, diffs `pushes_since_reset[i].value` against per-device history in `bindings.lastPushes`, looks up the cluster's backboard view, emits `<source.recType>.event.meta` and `io.microshare.event.alert.feedback`. We only had to write this because the platform's Scala chain doesn't fire — see §4. |

The unpacker's output shape is reverse-engineered from
[`microshare/lib-unpackers`](https://github.com/microshare/lib-unpackers)
(`SmilioAction.scala`) plus the staged Smilio sample at
`stream-service-3/src/test/resources/files/smilioUnpackedV3KafkaMsg.json`
in the internal repo.

---

## 3. What we deploy

A device cluster shaped like this (verified against the
`DeviceDescriptor` parser's expected fields):

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

Plus the two robots in this folder, both with scopes
`[SHARE:READ, SHARE:QUERY, SHARE:WRITE, SHARE:EXECUTE, SHARE:POLICY]`.
`__MS_API_HOST__` patched to `https://dapi.microshare.io` (or
`https://api.microshare.io` on prod) at deploy time.

---

## 4. What we send and what we observe

### 4a. Real Ubiqod webhook → packed

Webhook URL (Ubiqod portal posts here):

```
POST https://dapi.microshare.io/share/io.microshare.<vendor>.taqt.packed/token/<PIPE_TOKEN>
Content-Type: application/json
```

Real Taqt traffic lands as records on
`io.microshare.<vendor>.taqt.packed`, body = the raw Ubiqod webhook
JSON verbatim. Example body we captured from a real TaqtOne button:

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
    "id":       "9e5119a8-0179-401e-a77b-c6547df30416",
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
    "id":    "f7445aa1-1ae1-4774-8901-78775f6ce800",
    "slug":  "868719079797649",
    "label": "Service Requests 7649",
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
- `tracker.slug` — the device id we twin-match against
  `cluster.data.devices[].id`
- `data.reference` — which button (1-5)
- `data.pressCount` — cumulative count, drives the Smilio
  `pushes_since_reset` deltas
- `ubiqodValidity.badgeSwiped` — drives `swipe[].value` (Hall Effect)
- `data.code.reference` (when present) — RFID/badge id

Three event types possible: `DATA` (button press / badge), `KEEP_ALIVE`
(heartbeat), `ALERT` (satisfaction threshold). The unpacker handles all
three.

### 4b. Our unpacker robot → unpacked (Smilio-pixel-identical)

`taqt-unpacker.js` runs on the cluster's source recType
(`<vendor>.taqt.packed`) and emits records on the cluster's
`targetRecType` (`<vendor>.taqt.unpacked`) with full
twin-lookup-populated location:

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
    "iot":    { "device_id": "868719079797649", "fcnt_up": 23,
                "iso_time": "2026-05-01T16:00:29Z", "type": "uplink" },
    "source": []
  },
  "device_health": {
    "id": "868719079797649",
    "charge": [{ "unit": "%", "value": 85 }]
  },
  "badge": [{ "context": "<rfid>", "value": "<rfid>", "externalReferences": {} }],
  "origin": { "deviceClusterId": "<cluster-id>", "ubiqod": { /* original webhook fields */ } }
}
```

Both `lib.writeShare` (from inside our user robot) and a direct
pipe-token POST to `/share/<vendor>.taqt.unpacked/token/<pipe>` land
records on this recType. Our `event-meta.js` fires on these records
and produces the chained `*.unpacked.event.meta` and
`io.microshare.event.alert.feedback` records, so the records
themselves are well-formed and dispatch-eligible at least to user
robots.

### 4c. SmilioEventHandler — silent

For any of the writes in 4b, we do **not** observe the platform
producing:
- `*.unpacked.event.meta` (the
  `<source.recType>${SmilioEventHandler.MetaEventSuffix}` write)
- `io.microshare.event.alert.feedback` from the Scala chain
  (we see them only from our own alert-emitter robot)

`totalCount` on the relevant `*.event.meta` recType cluster-wide does
not change after our writes. Same for the Scala-chain output of
`io.microshare.event.alert.feedback`.

### 4d. Probe — depositing directly on `feedback.unpacked`

To rule out the recType-suffix being the discriminator, we also
deposited a Smilio-pixel-identical payload on
`io.microshare.feedback.unpacked` directly via pipe token.

| step | result |
|---|---|
| POST `/share/io.microshare.feedback.unpacked/token/<pipe>` | 200, id returned |
| GET by id | currentCount=1, owner=our org |
| LIST `feedback.unpacked` recently | currentCount > 0 — our record is in the list |
| New `feedback.unpacked.event.meta` records | totalCount delta = 0 |
| New `event.alert.feedback` (Scala-produced) | 0 |

So even on the recType the Scala chain natively writes to, a
user-pipe-token deposit does not trigger SmilioEventHandler.

---

## 5. What we read in the Scala source

Quoting from the internal `microshare/stream-service-3` repo and
`microshare-service` repo — full source is internal, only the
relevant snippets quoted here.

### 5a. `SmilioEventHandler` is selected per-cluster, not per-recType

`actors/Supervisors/AgentHandlerSupervisor.scala`:

```scala
val SMILIO_EVENT_USE_CASE = "SF01"

// agent table populated from application.conf:robots.agents.use_case
val (useCases, agentRecTypes, …) = config.getConfigList("robots.agents.use_case") …

def startAgentRobot(actorMap, descriptor: DeviceDescriptor) = {
  if (!descriptor.isActive) throw new RobotNotActive
  val use_case  = descriptor.use_case.getOrElse("")
  val actorName = getActorName(descriptor.cluster_name)         // <id>.AGENT

  (use_case,
   useCases.contains(use_case),
   agentRecTypes.contains(descriptor.deviceUnpacker.getOrElse("")),
   descriptor.deviceUnpacker) match {
    case (SMILIO_EVENT_USE_CASE, true, true, _) =>
      context.actorOf(SmilioEventHandler.props(descriptor), actorName)
    …
  }
}
```

`application.conf`:

```hocon
robots.agents.use_case = [
  { value = "SF01", decoder = "eu.skiply.button.SmilioAction.Decoder",
    agent  = "io.microshare.stream.actors.Handlers.agent.events.SmilioEventHandler" },
  { value = "SF01", decoder = "eu.skiply.button.SmilioRfid.Decoder",
    agent  = "io.microshare.stream.actors.Handlers.agent.events.SmilioEventHandler" }
]
```

Our cluster's descriptor satisfies all four match elements:

| condition | required | our cluster |
|---|---|---|
| `use_case` | `"SF01"` | `data.facts.usecase = "SF01"` ✓ |
| `useCases.contains(use_case)` | true | platform default config has SF01 ✓ |
| `agentRecTypes.contains(deviceUnpacker)` | true | `data.meta.unpacker = "eu.skiply.button.SmilioAction.Decoder"` ✓ |
| `descriptor.isActive` | true | `data.isActive = true` ✓ |

### 5b. `agentChannels` load + Reload pathway for newly-created clusters

`AgentHandlerSupervisor.preStart()` populates `agentChannels` once at
startup via `shareservices.getRoboConfig("*", limitWhiteOrBlackListedTags,
"device", Some(Seq("data.meta.unpacker")), Some(Seq(decoder)))` for each
configured agent decoder.

After startup, new clusters arrive via Kafka:

```scala
// actors/Readers/UpdateConfigReader.scala
case (Some(src), Some(evt), _) if src == "devices" => {
  …
  context.parent ! AgentHandlerSupervisor.Reload(id, evt, Some(desc), usecase)
}
```

`AgentHandlerSupervisor.Reload` for an unknown agent
(`agentActors.get(actorName) = None`) sends `Toggle` to itself, which
calls `startAgentRobot` and instantiates the handler.

### 5c. `share-events` is the trigger feed for live records

`actors/Readers/DeviceStreamReader.scala`:

```scala
override def handlePublish(pubNames, pubItem, offset) = {
  (Try(getMessageSource(pubItem)).toOption, Try(getEventType(pubItem)).toOption) match {
    case (Some(src), Some(evt)) if obj_typePattern.findFirstIn(src).isDefined && evt == "create" =>
      pubNames.map { pubName =>
        context.actorSelection(s"../$pubName") ! RobotHandler.Message(self.path.toString, pubItem)
      }
  }
}
```

with config:

```hocon
agents_unpacked {
  topic = "share-events"
  obj_type.pattern = "obj.*"
}
```

So the agent supervisor expects a Kafka publish on `share-events` for
each share create event with `obj_type ~ "obj.*"`.

### 5d. CRUD writes do publish to Kafka (every share / device write)

`microshare-service/services/CommonCRUDService.scala`:

```scala
def postByType(recType: String, doc: JsObject) = {
  (persistenceEndpoints map { endpoint =>
    endpoint match {
      case "mongo" => mongoStoreDao.save(doc)
      case "kafka" =>
        val msg = KafkaMessage.msgFormatter(typeName, mongoStoreDao.nameString,
                                            "create", recType, key, doc)
        kafkaProducers map { kafkaProducer =>
          kafkaProducer.send(msg, key, recType, resourceType, "create")
        }
        Vector(doc)
    }
  })
}
```

Same code path for any HTTP write to `/share/<recType>` or
`/device/<recType>`, regardless of grant_type (pipe / password) — there
is no early-return that skips Kafka for pipe-token writes that we
could find.

---

## 6. What we cannot observe from outside

- Whether dev's `stream-service-3` instance is currently running and
  has consumed the Kafka events corresponding to our cluster create
  and our subsequent `*.unpacked` writes.
- Whether the supervisor's `getRoboConfig` query at preStart returns
  our cluster on dev (it should — but `limitWhiteOrBlackListedTags` is
  read from dev's `robots.whitelistORblacklist.tags` and could be
  filtering us out).
- Whether `replay.agents.ids` is set on dev to a fixed list excluding
  our cluster.
- Whether `debug.disable_outbound` is true on dev (which would gate
  `eventWriter` and `shareService.post` from inside the handler).
- Whether the supervisor logged anything for `<our-cluster-id>.AGENT`
  at supervisor start, on `Reload`, or on incoming
  `RobotHandler.Message`.

Any of these would explain the silence we observe, but we can't
distinguish between them.

---

## 7. Reproduction

1. **Webhook URL** (Ubiqod portal can target this; any Microshare
   engineer can also `curl`):
   ```
   POST https://dapi.microshare.io/share/io.microshare.<vendor>.taqt.packed/token/<PIPE_TOKEN>
   Content-Type: application/json
   ```
   Body: a flat JSON document — see the Ubiqod webhook example in §4a.

2. **Cluster** must have the shape shown in §3.

3. **Robots:** deploy `taqt-unpacker.js` on the cluster's source
   recType, deploy `event-meta.js` on the cluster's `targetRecType`.
   Both need scopes `[SHARE:READ, SHARE:QUERY, SHARE:WRITE,
   SHARE:EXECUTE, SHARE:POLICY]`. Patch `__MS_API_HOST__` to
   `https://dapi.microshare.io` (or `https://api.microshare.io` on
   prod) at deploy time.

4. **Send traffic.** A few Ubiqod payloads will produce records on
   `.packed`. Both robots fire and the chain runs through to
   `.unpacked.event.meta` and `event.alert.feedback`.

5. **What we want to see but don't:** the
   `<source.recType>.event.meta` record produced by
   `SmilioEventHandler` itself (not by our `event-meta.js`). With our
   user-deployed `event-meta.js` disabled, `totalCount` on the
   relevant `*.event.meta` recType does not change after our writes.

---

## 8. Tokens and identity

- Pipe token (WRITE-only, permanent, scope=SHARE:WRITE):
  `POST <auth>/oauth2/token?username=…&password=…&client_id=…&grant_type=pipe&scope=ALL:ALL`
- Password / standard token (READ + WRITE, ~48h):
  `POST <auth>/oauth2/token?…&grant_type=password&scope=ALL:ALL`
- Both must be minted under the same identity — the OAuth endpoint
  binds tokens to whichever identity is currently active in the
  user's UI session and there is no API parameter to pin it.
  Mismatched identities produce "record exists by id but doesn't
  list" symptoms that look like the Scala-dispatch issue but aren't
  (separate gotcha worth knowing).

---

## 9. What an answer would look like

Either:
- "Look at log line X on dev's stream-service-3 — your cluster is
  being filtered out at step Y because Z. Fix it by changing field W."
  (with concrete Claude-Code-actionable instructions)
- "The Kafka publish path for /device on dev is broken — open a ticket
  with the platform team."
- "SmilioEventHandler has implicit org/tenant gating beyond what the
  source shows; here's the actual rule and how to satisfy it."

Anything that converts the silence into a known, observable cause is
useful — even a "yes the supervisor is dead on dev, try prod" would
let us move forward.
