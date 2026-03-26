/*
 * Futura Emitter — Scheduled Poll Robot
 *
 * A scheduled Microshare Robot that polls the Futura Emitter Trap Management
 * API for new events and writes them as Microshare unpacked records.
 *
 * This does the job of both the NetworkServer (extract device ID, timestamp)
 * and the Decoder (map event fields to Microshare schema) — plus the polling
 * itself, with no external infrastructure needed.
 *
 * Scheduled: true (runs on a timer, e.g. every 60 seconds)
 * Output recType: io.microshare.trap.unpacked (configurable)
 *
 * Futura API docs:
 *   https://emitter-trap-management.emittercloud.m2mgate.de/q/swagger-ui/
 *
 * Event types: TRIGGERED, PROXIMITY, LOW_BATTERY, NO_KEEP_ALIVE, KEEP_ALIVE
 * Device types: TUBE_TRAP (Emitter Tubetrap), EMITTER_CAM (Emitter Cam)
 */

var lib = require('./libs/helpers');

// ── Configuration ──────────────────────────────────────────────────────────

// Futura Emitter API
var FUTURA_SERVER_URL = 'https://emitterapi.m2mgate.de/emitter-server';
var FUTURA_TMS_URL    = 'https://emitter-trap-management.emittercloud.m2mgate.de';
var FUTURA_USERNAME   = 'REPLACE_WITH_YOUR_USERNAME';
var FUTURA_PASSWORD   = 'REPLACE_WITH_YOUR_PASSWORD';

// Microshare output
var OUTPUT_RECTYPE = 'io.microshare.trap.unpacked';
var LOG_RECTYPE    = 'io.microshare.emitter.log';

// ── Helpers ────────────────────────────────────────────────────────────────

function logResult(auth, stage, data) {
    print('EMITTER [' + stage + ']: ' + JSON.stringify(data));
    try {
        lib.writeShare(auth, LOG_RECTYPE, {
            stage: stage,
            timestamp: new Date().toISOString(),
            data: data
        }, ['emitter', 'log', stage]);
    } catch (e) {
        print('Log write failed: ' + e);
    }
}

/**
 * HTTP GET using Java's HttpURLConnection.
 * Microshare Robots only have lib.post() — this fills the gap.
 */
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

// ── Bindings (persistent state across executions) ──────────────────────────

function initBindings() {
    if (typeof bindings === 'undefined' || bindings === null) bindings = {};
    if (!bindings.authToken) bindings.authToken = null;
    if (!bindings.lastPollTime) bindings.lastPollTime = 0;
    if (!bindings.seenEventIds) bindings.seenEventIds = [];
}

// ── Futura authentication ──────────────────────────────────────────────────

function futuraLogin(auth) {
    print('Authenticating with Futura Emitter Server');

    var result = lib.post(
        FUTURA_SERVER_URL + '/rest/webapp/login',
        { 'Content-Type': 'application/json' },
        JSON.stringify({ username: FUTURA_USERNAME, password: FUTURA_PASSWORD })
    );

    // The login response includes a token in the response body or headers
    var token = null;
    if (result && result.token) {
        token = result.token;
    } else if (result && result.data && result.data.token) {
        token = result.data.token;
    } else if (result && typeof result === 'string') {
        token = result;
    }

    if (token) {
        bindings.authToken = token;
        logResult(auth, 'login_ok', { token_length: token.length });
        return true;
    }

    logResult(auth, 'login_fail', { result: result });
    return false;
}

function futuraHeaders() {
    return {
        'X-Auth-Token': bindings.authToken,
        'Accept': 'application/json'
    };
}

// ── Poll for new events ────────────────────────────────────────────────────

function pollEvents(auth) {
    var now = Date.now();
    var since = bindings.lastPollTime || (now - 300000); // default: last 5 minutes

    var url = FUTURA_TMS_URL + '/tms/events?acked=false&startDate=' + since;

    print('Polling: ' + url);
    var result = httpGet(url, futuraHeaders());

    if (result.status === 401) {
        // Token expired — re-login and retry
        print('401 — re-authenticating');
        if (!futuraLogin(auth)) return [];
        result = httpGet(url, futuraHeaders());
    }

    if (result.status !== 200 || !result.body) {
        logResult(auth, 'poll_error', { status: result.status, body: result.body });
        return [];
    }

    // Update last poll time
    bindings.lastPollTime = now;

    var events = result.body.events || result.body || [];
    if (!Array.isArray(events)) events = [];

    return events;
}

// ── Map Futura event to Microshare unpacked record ─────────────────────────

function mapEvent(event) {
    var emitterId = event.emitterId || '';
    var timestamp = event.msgTimestamp || new Date().toISOString();
    var eventType = event.type || event.eventType || 'UNKNOWN';
    var severity = event.severity || 'INFO';
    var trapType = event.emitterType || event.trapType || '';
    var pestType = event.emitterPestType || event.pestType || '';

    // Build Microshare-standard unpacked record
    return {
        meta: {
            iot: {
                device_id: emitterId,
                time: timestamp,
                iso_time: timestamp,
                type: eventType.toLowerCase(),
                ns_version: 'v1.0'
            },
            device: [
                event.customerName || '',
                event.emitterName || emitterId
            ],
            dc: {
                name: 'Robot-based unpacker (Futura Emitter)',
                network: 'com.futura.emitter',
                unpacker: 'robot.futura.emitter'
            },
            global: [],
            source: [],
            futura: {
                event_id: event.id || null,
                emitter_type: trapType,
                pest_type: pestType,
                severity: severity,
                station_id: event.stationId || '',
                customer_id: event.customerId || null,
                exterminator_id: event.exterminatorId || null,
                acked: event.acked || false
            }
        },
        // Sensor fields at top level (Microshare convention)
        trap_event: [{
            value: eventType,
            context: severity
        }],
        device_health: {
            id: emitterId
        },
        origin: {
            futura_event: event
        }
    };
}

// ── Deduplication ──────────────────────────────────────────────────────────

function isAlreadySeen(eventId) {
    return bindings.seenEventIds.indexOf(eventId) !== -1;
}

function markSeen(eventId) {
    bindings.seenEventIds.push(eventId);
    // Cap at 500 entries (FIFO)
    while (bindings.seenEventIds.length > 500) {
        bindings.seenEventIds.shift();
    }
}

// ── Main (scheduled) ──────────────────────────────────────────────────────

function main(text, auth) {
    print('=== EMITTER POLL START ===');
    initBindings();

    try {
        // Ensure authenticated
        if (!bindings.authToken) {
            if (!futuraLogin(auth)) {
                print('Cannot authenticate — skipping poll');
                return bindings;
            }
        }

        // Poll for new events
        var events = pollEvents(auth);
        var newCount = 0;

        for (var i = 0; i < events.length; i++) {
            var event = events[i];
            var eventId = event.id;

            // Deduplicate
            if (eventId && isAlreadySeen(eventId)) continue;

            // Map to Microshare schema
            var unpacked = mapEvent(event);

            // Tags
            var tags = [];
            if (unpacked.meta.device[0]) tags.push(unpacked.meta.device[0]);
            if (unpacked.meta.device[1]) tags.push(unpacked.meta.device[1]);
            tags.push(unpacked.meta.iot.device_id);
            tags.push(event.type || 'UNKNOWN');

            // Write to Microshare
            lib.writeShare(auth, OUTPUT_RECTYPE, unpacked, tags);

            if (eventId) markSeen(eventId);
            newCount++;
        }

        if (newCount > 0) {
            logResult(auth, 'poll_ok', {
                total_events: events.length,
                new_events: newCount,
                since: new Date(bindings.lastPollTime).toISOString()
            });
        }

    } catch (error) {
        logResult(auth, 'error', { message: '' + error, stack: error.stack || '' });
    }

    print('=== EMITTER POLL END ===');
    return bindings;
}
