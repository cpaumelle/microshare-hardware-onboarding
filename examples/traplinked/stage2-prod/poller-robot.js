/*
 * Traplinked — Stage 2 Poller Robot (Production)
 *
 * Polls the Traplinked REST API and writes raw data to io.microshare.traplinked.packed.
 * The Scala pipeline handles unpacking, device health, and alert generation.
 *
 * This Robot replaces the LoRaWAN network server for Traplinked devices.
 * It is permanent — even after the Scala decoder is deployed.
 *
 * Writes: io.microshare.traplinked.packed ONLY
 * Does NOT write: trap.unpacked, device.health, event.alert.rodent
 *
 * The packed record contains the full Traplinked API response as meta.iot.payload
 * (JSON string), matching the pattern used by the Tactacam poller.
 *
 * Scheduled: true (every 60s)
 * Traplinked API: https://docs.traplinked.com/rest/
 */

var lib = require('./libs/helpers');

// ── Configuration ──────────────────────────────────────────────────────────

var TL_API       = 'https://api.traplinked.com/api/v1.9';
var TL_TOKEN     = 'REPLACE_ME';
var TL_DEVICE_ID = '8VUD57F0';  // comma-separated for multiple

var PACKED_RECTYPE = 'io.microshare.traplinked.packed';
var LOG_URL        = 'https://robot-logs.charliehub.net/log';

// ── Helpers ────────────────────────────────────────────────────────────────

function log(stage, data) {
    try {
        lib.post(LOG_URL, { 'Content-Type': 'application/json' },
            JSON.stringify({ robot: 'traplinked-poller-v2', stage: stage, data: data, ts: new Date().toISOString() }));
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

// ── Main (scheduled) ──────────────────────────────────────────────────────

function main(text, auth) {
    if (typeof bindings === 'undefined' || bindings === null) bindings = {};
    if (!bindings.lastReportTimestamp) bindings.lastReportTimestamp = '';
    if (!bindings.seenReports) bindings.seenReports = [];
    if (!bindings.fcntUp) bindings.fcntUp = 0;

    // Build API query — high-water mark dedup
    var since = bindings.lastReportTimestamp;
    if (since) {
        var d = new Date(new Date(since + 'Z').getTime() + 1000);
        since = d.toISOString().replace('Z', '').split('.')[0];
    } else {
        var d = new Date(Date.now() - 300000);  // 5 minutes on first run
        since = d.toISOString().replace('Z', '').split('.')[0];
    }

    var url = TL_API + '/devices?ids=' + TL_DEVICE_ID +
        '&device_fields=serial_number,name,type,status,battery_status,transfer_mode,operation_mode,last_heartbeat,location,trap_1,trap_2,reports' +
        '&reports_since=' + since;

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

        // Write packed record — the Scala decoder will unpack this
        // The payload contains the full device+report data as a JSON string
        // matching the Tactacam pattern (meta.iot.payload)
        var packed = {
            meta: {
                iot: {
                    device_id: device.serial_number,
                    time: report.timestamp,
                    iso_time: report.timestamp,
                    type: 'com.traplinked.api',
                    ns_version: 'v1.0',
                    fcnt_up: ++bindings.fcntUp,
                    payload: JSON.stringify({
                        device: {
                            serial_number: device.serial_number,
                            name: device.name,
                            type: device.type,
                            status: device.status,
                            battery_status: device.battery_status,
                            transfer_mode: device.transfer_mode,
                            operation_mode: device.operation_mode,
                            last_heartbeat: device.last_heartbeat,
                            location: device.location,
                            trap_1: device.trap_1,
                            trap_2: device.trap_2
                        },
                        report: {
                            type: report.type,
                            timestamp: report.timestamp,
                            user: report.user || null,
                            description: report.description || null
                        }
                    })
                }
            }
        };

        var tags = [device.serial_number];
        lib.writeShare(auth, PACKED_RECTYPE, packed, tags);
        newCount++;
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
