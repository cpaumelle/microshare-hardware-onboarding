# Microshare Composer API

Manage Robots, Views, and the Data Lake programmatically on `dapp.microshare.io`.

## Authentication

All API calls require a Bearer token. On **prod** these are 64-character hex strings
(~48 hours). On **dev**, `dauth` now also issues **JWT-format pipe tokens** that are
permanent, write-only, and have no expiry — so do not assume a fixed length or TTL
(see [`validate.py`](../tools/validate.py) if you need to test a token).

> **Robot tokens are different — see [Robots](#robots).** A robot's `data.auth` must be
> minted with `grant_type=robot`, not the user `password` grant shown below.

### Option 1: PLAY_SESSION (from login)

```python
import requests, json, base64

resp = requests.post("https://dapp.microshare.io/login",
    data={"csrfToken": "api-client", "username": USER, "password": PASS},
    headers={"Content-Type": "application/x-www-form-urlencoded"},
    allow_redirects=False)

cookie = resp.cookies.get("PLAY_SESSION")
parts = cookie.split(".")
payload = json.loads(base64.urlsafe_b64decode(parts[1] + "=" * (4 - len(parts[1]) % 4)))
token = payload["data"]["access_token"]
```

### Option 2: OAuth2 (password grant)

```bash
curl -X POST "https://dauth.microshare.io/oauth2/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=password&username=YOU&password=PASS&client_id=YOUR_APP_KEY&scope=ALL:ALL"
```

Your `client_id` is the API key from **Manage -> Keys** in the Composer UI.

---

## Data Lake (Share API)

### Write

```bash
curl -X POST "https://dapi.microshare.io/share/io.myapp.events" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"temperature": 22.5, "humidity": 45}'
```

### Read

```bash
# All records of a recType
curl -s "https://dapi.microshare.io/share/io.myapp.events?details=true" \
  -H "Authorization: Bearer $TOKEN"

# By tag — best for looking up a specific device
curl -s "https://dapi.microshare.io/share/io.myapp.events/tags/myDeviceId?details=true" \
  -H "Authorization: Bearer $TOKEN"

# Single record by ID
curl -s "https://dapi.microshare.io/share/io.myapp.events/{recordId}?details=true" \
  -H "Authorization: Bearer $TOKEN"
```

`details=true` is required — without it, `data` comes back empty.

### Pagination

Use `page=N&perPage=N` (default perPage: 999). Sort with `sort=-tstamp` (prefix `-` for descending).

### Response

```json
{
  "meta": { "totalCount": 42, "currentCount": 10, "currentPage": 1, "perPage": 999 },
  "objs": [
    {
      "id": "69c25219...",
      "recType": "io.myapp.events",
      "tags": ["building", "floor1"],
      "data": { ... }
    }
  ]
}
```

---

## Webhook Ingest (Pipe Token)

For external device platforms to POST data without sharing credentials:

```
POST https://dingest.microshare.io/share/{recType}/token/{pipeToken}
Content-Type: application/json
```

Generate pipe tokens via the Composer UI (**Manage -> Keys -> Tokens**) or via the OAuth2 API with `SHARE:WRITE` scope:

```bash
curl -X POST "https://dauth.microshare.io/oauth2/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=password&username=YOU&password=PASS&client_id=YOUR_API_KEY&scope=SHARE:WRITE"
```

See [`webhook-ingest.md`](webhook-ingest.md) for the full setup guide.

---

## Robots

### Robot auth token — get this right or the robot silently writes nothing

This is the #1 cause of a robot that "runs" but produces no data. A robot's `data.auth`
token must be minted with **`grant_type=robot`** and the scopes the robot actually needs:

```bash
curl -X POST "https://dauth.microshare.io/oauth2/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=robot&username=YOU&password=PASS&client_id=YOUR_APP_KEY&scope=SHARE:READ,SHARE:QUERY,SHARE:WRITE"
```

- **Validate it:** the token must return **HTTP 200 on `GET /api/share`**. A `password`-grant
  or `ALL:ALL` token authenticates fine but **401s on `/api/share`** — so the robot fires on
  dispatch but every `writeShare` / `/device` / `/view` call fails and nothing is written.
  This failure is silent (no error surfaces); we call it **silent dispatch death**. Never use
  `ALL:ALL` for a robot's auth.
- **Scopes by robot type:** forwarders / unpackers need **3** — `SHARE:READ,QUERY,WRITE`.
  **Bundlers need 5** — add `SHARE:EXECUTE,SHARE:POLICY`. Missing a scope is also a silent failure.
- **Never change a live robot's auth by PUT.** To re-kick a stalled robot, toggle `isActive`
  off then on. The `grant_type=robot` token is long-lived, so routine "refreshing" isn't needed.

### List / Get

```bash
curl -s "https://dapi.microshare.io/robo/*" -H "Authorization: Bearer $TOKEN"
curl -s "https://dapi.microshare.io/robo/{recType}/{robotId}" -H "Authorization: Bearer $TOKEN"
```

### Create

```bash
curl -X POST "https://dapi.microshare.io/robo/{recType}" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My Robot",
    "desc": "",
    "recType": "io.myapp.events",
    "tags": [],
    "data": {
      "script": "var lib = require(\"./libs/helpers\");\nfunction main(text, auth) { ... }",
      "scopes": ["SHARE:READ", "SHARE:QUERY", "SHARE:WRITE"],
      "isActive": true,
      "isScheduled": false,
      "schedule": {"delay": 0, "interval": 60000},
      "auth": "GRANT_TYPE_ROBOT_TOKEN",
      "owners": []
    }
  }'
```

### Update (deploy a script)

```bash
SCRIPT=$(cat robot.js)
curl -s "https://dapi.microshare.io/robo/{recType}/{robotId}" \
  -H "Authorization: Bearer $TOKEN" \
  | jq --arg s "$SCRIPT" --arg t "$TOKEN" \
    '.objs[0] | .data.script=$s | .data.auth=$t | .data.isActive=true' \
  | curl -X PUT "https://dapi.microshare.io/robo/{recType}/{robotId}" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d @-
```

### Robot Fields

| Field | Description |
|---|---|
| `script` | JavaScript source (escaped string) |
| `scopes` | `["SHARE:READ","SHARE:QUERY","SHARE:WRITE"]` (forwarder/unpacker); add `"SHARE:EXECUTE","SHARE:POLICY"` for a bundler |
| `isActive` | Enable/disable. Toggle off→on to re-kick a stalled robot (do **not** PUT a new `auth`). |
| `isScheduled` | Timer mode (true) vs trigger-on-data mode (false) |
| `schedule` | `{"delay": 0, "interval": 60000}` — milliseconds |
| `auth` | A `grant_type=robot` token (see [Robot auth](#robot-auth-token--get-this-right-or-the-robot-silently-writes-nothing)). Must 200 on `/api/share`. |

---

## Device Clusters

### List Clusters

```bash
curl -s "https://dapi.microshare.io/device/{packedRecType}?details=true&discover=true" \
  -H "Authorization: Bearer $TOKEN"
```

### Reading Clusters from a Robot

Use `httpGet` with the `auth` parameter passed to `main(text, auth)`:

```javascript
var url = API_HOST + '/device/' + TWIN_RECTYPE + '?details=true&discover=true';
var result = httpGet(url, {'Authorization': 'Bearer ' + auth});
var devices = result.body.objs[0].data.devices || [];
```

See the [Traplinked example](../examples/traplinked/robot.js) for a complete implementation.

### Robot helper gotchas (these fail silently)

- **`lib.readShareByType` does not exist** — calling it crashes the robot silently (it
  dispatches but writes nothing). Use `lib.readShareByTags(auth, recType, [], {})` instead.
- **`lib.post` / `lib.get` have no `.body`.** On a 2xx they spread the parsed JSON straight
  onto the return value — read `resp.objs` / `resp.accessToken`, not `resp.body.objs`. On a
  non-2xx, `resp.err` is set and the message is in `resp.msg`. (A *local* `httpGet` wrapper
  you define yourself may return `{status, body}` — that's different from `lib.get`.)
- **Platform event handlers / bundlers do NOT fire on robot or pipe-token writes.** The Scala
  decode chain, `SmilioEventHandler`, and the pest incident bundler only run on LoRaWAN/platform-fed
  records. If your pipeline is robot-fed, replicate the diff-and-emit / bundling logic in a JS
  robot and direct-write the derived records (see
  [`clean-pipeline-dispatch/event-meta.js`](../examples/taqt/clean-pipeline-dispatch/event-meta.js)).
- **Pipe/ingest writes do not trigger device-cluster decode.** You cannot validate a cluster by
  injecting packed records — decode runs only on the real network-server ingestion path.

---

## Views

### List / Get

```bash
curl -s "https://dapi.microshare.io/view/*" -H "Authorization: Bearer $TOKEN"
curl -s "https://dapi.microshare.io/view/{recType}/{viewId}" -H "Authorization: Bearer $TOKEN"
```

### Create a View

```bash
curl -X POST "https://dapi.microshare.io/view/io.microshare.trap.packed" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Latest Packed Records",
    "desc": "Recent trap.packed data",
    "recType": "io.microshare.trap.packed",
    "data": {
      "query": "[{\"$match\": {\"tstamp\": {\"$gt\": EPOCH_MILLIS}}}, {\"$limit\": 10}]",
      "fieldMapping": "[]"
    }
  }'
```

### Execute a View (read data through it)

Views bypass the policy engine — use them when direct share queries return `totalCount > 0` but `objs` is empty.

```bash
curl -s "https://dapi.microshare.io/share/{viewRecType}?id={viewId}&details=true" \
  -H "Authorization: Bearer $TOKEN"
```

The View returns raw MongoDB documents. Record data is at `objs[].data.data`, owner at `objs[].data.owner`.

### Important: View query performance

- Always include `$limit` — Views without it will timeout on large collections
- Filter by `tstamp` (epoch millis) to restrict the scan window
- `$sort` on large collections can timeout — prefer `$match` + `$limit` over `$sort` + `$limit`

### Pipe token URL: use `dapi`, not `dingest`

For dev, use `dapi.microshare.io` in the pipe token URL. Records written via `dingest.microshare.io` land in a separate store that is not readable through the standard Share API or Views.

---

## Workflow API (Incident Lifecycle)

Incidents created by the bundler have a workflow process. To transition an incident through its lifecycle (accept → do → done), use the workflow API.

### Host

The workflow engine is on a **separate host** from the Share API:

| Environment | Workflow Host |
|---|---|
| Dev (dapp) | `https://dwf.microshare.io` |
| Prod (pest) | `https://pest.microshare.io/wf` (same host, `/wf` prefix) |
| Prod (app) | `https://wf.microshare.io` |

On dev, do **not** use `dapp.microshare.io/wf/` — it returns 404 for POST requests.

### Transition an incident

```bash
curl -X POST "https://dwf.microshare.io/processes/{processId}/message/addUser?Authorization=$TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "addUser_by": "user@example.com",
    "addUser_action": "claimee",
    "addUser_user": "user@example.com",
    "addUser_time": "2026-03-27T12:00:00.000Z",
    "addUser_userTask": "accept"
  }'
```

Steps in order: `accept` → `do` → `done`. Send one request per step.

The `processId` is found in the incident record at `data.meta.workflow.process.id`.

> **Note (mobile / newer clients):** the React Native app drives the lifecycle through the
> workflow **claim / complete** endpoints (e.g. `/complete` for the action transition) rather
> than the `addUser` accept→do→done sequence above. If you're matching the current app
> behaviour, prefer claim/complete; the `addUser` form remains valid for the platform engine.

---

## API Hosts Summary

| Service | Dev | Prod (pest) |
|---|---|---|
| App / Login | `dapp.microshare.io` | `pest.microshare.io` |
| Share API | `dapi.microshare.io` | `pest.microshare.io/api` |
| Auth (OAuth2) | `dauth.microshare.io` | `pest.microshare.io` |
| Workflow | `dwf.microshare.io` | `pest.microshare.io/wf` |
| Images | `dimages.microshare.io` | `images.microshare.io` |
| Ingest (pipe) | `dapi.microshare.io` | `pest.microshare.io/api` |

> **Prod host warning (pest-vanity tenants):** always use `pest.microshare.io/api`.
> `api.microshare.io` authenticates but silently returns a **subset** of records for these
> tenants — a data-loss footgun. `api.microshare.io` / `app.microshare.io` are correct only
> for generic (non-pest) Microshare accounts.
