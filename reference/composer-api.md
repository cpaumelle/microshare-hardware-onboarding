# Microshare Composer API

Manage Robots, Views, and the Data Lake programmatically on `dapp.microshare.io`.

## Authentication

All API calls require a Bearer token (64-character hex string, valid 48 hours).

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
      "auth": "YOUR_TOKEN_HERE",
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
| `scopes` | `["SHARE:READ", "SHARE:QUERY", "SHARE:WRITE"]` |
| `isActive` | Enable/disable |
| `isScheduled` | Timer mode (true) vs trigger-on-data mode (false) |
| `schedule` | `{"delay": 0, "interval": 60000}` — milliseconds |
| `auth` | A valid token. Refresh it when the Robot stops executing. |

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

---

## Views

```bash
curl -s "https://dapi.microshare.io/view/*" -H "Authorization: Bearer $TOKEN"
curl -s "https://dapi.microshare.io/view/{recType}/{viewId}" -H "Authorization: Bearer $TOKEN"
```
