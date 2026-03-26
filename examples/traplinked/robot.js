/*
 * Traplinked JERRY — Scheduled Poller + Unpacker Robot
 *
 * Replaces the Scala NetworkServer + Decoder for Traplinked devices.
 * Polls the Traplinked REST API, matches devices against a device cluster
 * for twinning, maps to Microshare's standard data dictionary, and writes
 * unpacked records identical to what the Scala pipeline would produce.
 *
 * Scheduled: true (every 60s)
 * Twin recType:   io.microshare.traplinked.packed (device cluster for twinning)
 * Output recType: io.microshare.trap.unpacked     (same as LoRaWAN traps)
 *
 * The JERRY has two snap traps (trap_1, trap_2). Following the SmilioAction
 * pattern for multi-output devices, these are represented as:
 *
 *   trap: [
 *     {value: true,  context: "Trap 1"},
 *     {value: false, context: "Trap 2"}
 *   ]
 *
 * Report types mapped to trap_event:
 *   2  trap_triggered     → [{value: "trap_triggered"}]
 *   3  rearmed            → [{value: "rearmed"}]
 *   17 false_triggering   → [{value: "false_triggering"}]
 *   20 catch_detected     → [{value: "catch_detected"}]
 *   etc.
 *
 * SETUP:
 *   1. Create a device cluster in Composer on io.microshare.traplinked.packed
 *   2. Register each JERRY with serial_number as device ID and location tags
 *   3. Deploy this robot as scheduled (60s interval)
 *
 * Traplinked API: https://docs.traplinked.com/rest/
 */

var lib = require('./libs/helpers');

// ── Configuration ──────────────────────────────────────────────────────────

var TL_API       = 'https://api.traplinked.com/api/v1.9';
var TL_TOKEN     = 'REPLACE_ME';
var TL_DEVICE_ID = '8VUD57F0';  // comma-separated for multiple

var TWIN_RECTYPE   = 'io.microshare.traplinked.packed';
var OUTPUT_RECTYPE = 'io.microshare.trap.unpacked';
var LOG_URL        = 'https://robot-logs.charliehub.net/log';
var TWIN_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// ── Report type names ──────────────────────────────────────────────────────

var REPORT_NAMES = {
    2:  'trap_triggered',
    3:  'rearmed',
    14: 'infested',
    15: 'light_infestation',
    16: 'severe_infestation',
    17: 'false_triggering',
    18: 'activity_warning',
    19: 'activity_critical',
    20: 'catch_detected'
};

// ── Device type names ──────────────────────────────────────────────────────

var DEVICE_TYPES = {
    0: 'JERRY',
    1: 'JERRY_LORA',
    2: 'TRAPME',
    3: 'TOM',
    4: 'TRAPSENSOR'
};

// ── Operation mode names ───────────────────────────────────────────────────

var OP_MODES = { 0: 'snaptrap', 1: 'movement', 2: 'insect' };

// ── Helpers ────────────────────────────────────────────────────────────────

function log(stage, data) {
    try {
        lib.post(LOG_URL, { 'Content-Type': 'application/json' },
            JSON.stringify({ robot: 'traplinked-poller', stage: stage, data: data, ts: new Date().toISOString() }));
    } catch (e) {}
    print(stage + ': ' + JSON.stringify(data));
}

function httpGet(url, headers) {
    var URL = Java.type('java.net.URL');
    var BufferedReader = Java.type('java.io.BufferedReader');
    var InputStreamReader = Java.type('java.io.InputStreamReader');

    var conn = new URL(url).openConnection();
    conn.setRequestMethod('GET');
    conn.setConnectTimeout(15000);
    conn.setReadTimeout(15000);

    if (headers) {
        var keys = Object.keys(headers);
        for (var i = 0; i < keys.length; i++) {
            conn.setRequestProperty(keys[i], headers[keys[i]]);
        }
    }

    var status = conn.getResponseCode();
    var stream = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
    if (!stream) return { status: status, body: null };

    var reader = new BufferedReader(new InputStreamReader(stream));
    var response = '';
    var line;
    while ((line = reader.readLine()) !== null) {
        response += line;
    }
    reader.close();

    var body = null;
    try { body = JSON.parse(response); } catch (e) { body = response; }

    return { status: status, body: body };
}

// ── Device twin lookup ─────────────────────────────────────────────────────
//
// Reads the device cluster via httpGet to the /device/ API endpoint.
// lib.readShareByType does NOT work for device clusters (they're Composer
// objects, not share records). But the auth parameter passed to main() is
// a valid Bearer token for the Microshare API, so we can call /device/
// directly via Java HttpURLConnection — same as the Composer UI does.
//
// The API host must match the environment: dapi for dev, api for prod.

var API_HOST = 'https://dapi.microshare.io';  // change to https://api.microshare.io for prod

function loadTwinLookup(auth) {
    var now = Date.now();
    if (bindings.twinCacheTime && (now - bindings.twinCacheTime) < TWIN_CACHE_TTL_MS) {
        if (Object.keys(bindings.twinLookup).length > 0) return;
    }

    try {
        var url = API_HOST + '/device/' + TWIN_RECTYPE + '?details=true&discover=true';
        var result = httpGet(url, {
            'Authorization': 'Bearer ' + auth,
            'Accept': 'application/json'
        });
        if (result.status !== 200 || !result.body || !result.body.objs || result.body.objs.length === 0) return;
        result = result.body;

        var lookup = {};
        var dcMeta = null;
        for (var i = 0; i < result.objs.length; i++) {
            var cluster = result.objs[i];
            if (!dcMeta) {
                dcMeta = {
                    id: cluster.id || cluster._id || '',
                    name: cluster.name || '',
                    network: 'com.traplinked',
                    recType: TWIN_RECTYPE,
                    unpacker: 'robot.traplinked.poller'
                };
            }
            var devices = (cluster.data || {}).devices || [];
            for (var j = 0; j < devices.length; j++) {
                var dev = devices[j];
                var devId = (dev.id || '').toUpperCase();
                if (devId) {
                    lookup[devId] = { location: (dev.meta || {}).location || [] };
                }
            }
        }
        bindings.twinLookup = lookup;
        bindings.dcMeta = dcMeta;
        bindings.twinCacheTime = now;
        log('twins', { count: Object.keys(lookup).length });
    } catch (e) {
        print('Twin load error: ' + e);
    }
}

function getLocation(device) {
    var twin = bindings.twinLookup[(device.serial_number || '').toUpperCase()];
    if (twin && twin.location && twin.location.length > 0) return twin.location;

    // Fallback to Traplinked location
    var loc = [];
    if (device.location) {
        if (device.location.name) loc.push(device.location.name);
        if (device.location.address) loc.push(device.location.address);
    }
    if (device.name) loc.push(device.name);
    loc.push(device.serial_number);
    return loc;
}

// ── Build unpacked record ──────────────────────────────────────────────────

function buildUnpacked(device, report) {
    var reportName = REPORT_NAMES[report.type] || ('type_' + report.type);
    var location = getLocation(device);
    var dcMeta = bindings.dcMeta || {
        name: 'Robot-based unpacker (Traplinked)',
        network: 'com.traplinked',
        recType: TWIN_RECTYPE,
        unpacker: 'robot.traplinked.poller'
    };

    return {
        // ── meta (same structure as any Microshare unpacked record) ────
        meta: {
            iot: {
                device_id: device.serial_number,
                time: report.timestamp,
                iso_time: report.timestamp,
                type: 'poll',
                ns_version: 'v1.0'
            },
            device: location,
            dc: {
                id: dcMeta.id || '',
                name: dcMeta.name || '',
                network: dcMeta.network || 'com.traplinked',
                recType: TWIN_RECTYPE,
                unpacker: dcMeta.unpacker || 'robot.traplinked.poller',
                usecase: 'trap',
                facts: { usecase: 'trap' }
            },
            global: [],
            source: []
        },

        // ── sensor fields at top level (Microshare data dictionary) ────

        // Trap state — dual trap following SmilioAction [{value, context}] pattern
        trap: [
            { value: device.trap_1 || false, context: 'Trap 1' },
            { value: device.trap_2 || false, context: 'Trap 2' }
        ],

        // Event type
        trap_event: [
            { value: reportName }
        ],

        // Operation mode
        trap_mode: [
            { value: OP_MODES[device.operation_mode] || 'unknown' }
        ],

        // ── device health ──────────────────────────────────────────────
        device_health: {
            id: device.serial_number,
            charge: [{ unit: '%', value: Math.round((device.battery_status || 0) * 100) }],
            connection: [{ value: device.transfer_mode === 0 ? 'wifi' : 'lora' }],
            last_seen: [{ value: device.last_heartbeat || null }],
            status: [{ value: device.status }]
        },

        // ── origin (full vendor data preserved for debugging) ──────────
        origin: {
            traplinked: {
                serial_number: device.serial_number,
                name: device.name,
                device_type: DEVICE_TYPES[device.type] || ('type_' + device.type),
                report_type: report.type,
                report_name: reportName,
                report_user: report.user || null,
                report_description: report.description || null,
                status: device.status,
                transfer_mode: device.transfer_mode,
                operation_mode: device.operation_mode,
                last_heartbeat: device.last_heartbeat,
                location: device.location
            },
            deviceClusterId: dcMeta.id || ''
        }
    };
}

// ── Main (scheduled) ──────────────────────────────────────────────────────

function main(text, auth) {
    if (typeof bindings === 'undefined' || bindings === null) bindings = {};
    if (!bindings.lastReportTimestamp) bindings.lastReportTimestamp = '';
    if (!bindings.seenReports) bindings.seenReports = [];
    if (!bindings.twinLookup) bindings.twinLookup = {};
    if (!bindings.twinCacheTime) bindings.twinCacheTime = 0;
    if (!bindings.dcMeta) bindings.dcMeta = null;

    // Load device twins
    loadTwinLookup(auth);

    // Build API query
    var since = bindings.lastReportTimestamp;
    if (!since) {
        var d = new Date(Date.now() - 86400000);
        since = d.toISOString().replace('Z', '').split('.')[0];
    }
    var url = TL_API + '/devices?ids=' + TL_DEVICE_ID +
        '&device_fields=serial_number,name,type,status,battery_status,transfer_mode,operation_mode,last_heartbeat,location,trap_1,trap_2,reports' +
        '&reports_since=' + since;

    // GET from Traplinked
    var result = httpGet(url, {
        'Authorization': 'Bearer ' + TL_TOKEN,
        'Accept': 'application/json'
    });

    if (result.status !== 200 || !result.body) {
        log('error', { message: 'API failed', status: result.status });
        return bindings;
    }

    var devices = result.body.devices || [];
    if (devices.length === 0) return bindings;

    var device = devices[0];
    var reports = device.reports || [];
    var newCount = 0;

    for (var i = 0; i < reports.length; i++) {
        var report = reports[i];
        var reportKey = report.timestamp + '_' + report.type;

        if (bindings.seenReports.indexOf(reportKey) !== -1) continue;
        bindings.seenReports.push(reportKey);
        while (bindings.seenReports.length > 200) bindings.seenReports.shift();

        // Build unpacked record
        var unpacked = buildUnpacked(device, report);

        // Tags
        var tags = unpacked.meta.device.slice();
        tags.push(device.serial_number);

        // Write to io.microshare.trap.unpacked
        lib.writeShare(auth, OUTPUT_RECTYPE, unpacked, tags);
        newCount++;

        log('unpacked', {
            device: device.serial_number,
            event: unpacked.trap_event[0].value,
            trap: unpacked.trap,
            timestamp: report.timestamp,
            location: unpacked.meta.device,
            battery: unpacked.device_health.charge[0].value
        });
    }

    // Track last poll timestamp
    if (reports.length > 0) {
        var newest = reports[0].timestamp;
        for (var j = 1; j < reports.length; j++) {
            if (reports[j].timestamp > newest) newest = reports[j].timestamp;
        }
        bindings.lastReportTimestamp = newest;
    }

    if (newCount > 0) {
        log('poll', { device: TL_DEVICE_ID, new_events: newCount });
    }

    return bindings;
}
