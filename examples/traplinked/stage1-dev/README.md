# Traplinked — Stage 1 (Dev / Evaluation)

100% Robot-based pipeline. Deploy directly from Composer, no Scala needed.

## Setup

1. **Create a device cluster** in Composer on `io.microshare.traplinked.packed`
   - Set `meta.location` to `"Your Identity Name,trap"` (comma-separated global tags)
   - Set `facts.usecase` to `SC05`
   - Set `network` to `com.traplinked.api`
   - Register each device with its serial number as the device ID
   - Set location tags: `["Customer", "Site", "Trap Name", "SerialNumber"]`
   - Avoid commas in location tags

2. **Deploy the Poller Robot** (`poller-robot.js`)
   - Trigger recType: `io.microshare.traplinked.packed`
   - Scheduled: Yes, every 60 seconds
   - Replace `TL_TOKEN` with your Traplinked API key
   - Replace `TL_DEVICE_ID` with your device serial number(s)
   - Set `API_HOST` to match your Microshare environment

3. **Deploy the Alert Generator Robot** (`alert-generator-robot.js`)
   - Trigger recType: `io.microshare.trap.unpacked`
   - Scheduled: No (triggered)

4. **Register your cluster** in the Metrics app (`facts.sources[]`)

## What each Robot does

### Poller Robot (scheduled)

Polls the Traplinked REST API every 60 seconds and writes:
- `io.microshare.traplinked.packed` — raw API response (for future Scala migration)
- `io.microshare.trap.unpacked` — standard unpacked record with sensor fields
- `io.microshare.device.health` — battery, voltage, last seen (throttled to every 10 minutes)

### Alert Generator Robot (triggered)

Fires on every `io.microshare.trap.unpacked` write and generates `io.microshare.event.alert.rodent` for actionable events (catch, trigger, false trigger, infestation levels).

Skips non-actionable events (rearmed).

## Migrating to Stage 2

When the Scala decoder is deployed, switch to the Stage 2 poller (writes packed only) and disable the alert generator Robot. See [`../stage2-prod/`](../stage2-prod/).
