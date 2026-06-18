/*
 * Futura Emitter — Scheduled Poll + Alert Robot
 *
 * Polls the Futura Emitter API every 60s for new EMITTER_CAM photo events
 * and writes them directly to io.microshare.event.alert.image in the
 * Tactacam-compatible alert structure consumed by the standard bundler.
 *
 * Only photo events (type=ARMED/TRIGGERED with eventImageDownloadUrl) are
 * processed. Maintenance events (KEEP_ALIVE, NO_KEEP_ALIVE, LOW_BATTERY)
 * are silently skipped.
 *
 * Scheduled: true (runs on a timer, e.g. every 60 seconds)
 * Twin recType: com.futura.emitter.packed (device cluster for location)
 *
 * Futura API docs:
 *   https://emitter-trap-management.emittercloud.m2mgate.de/q/swagger-ui/
 *
 * NOTE: Use /tms/events/api (not /tms/events). The portal endpoint filters
 * by ack status and silently drops EMITTER_CAM photo events (type=ARMED)
 * because they are auto-acknowledged on arrival.
 */

var lib = require('./libs/helpers');

// ── Configuration ──────────────────────────────────────────────────────────

var FUTURA_SERVER_URL = 'https://emitterapi.m2mgate.de/emitter-server';
var FUTURA_TMS_URL    = 'https://emitter-trap-management.emittercloud.m2mgate.de';
var FUTURA_USERNAME   = '{{FUTURA_USERNAME}}';
var FUTURA_PASSWORD   = '{{FUTURA_PASSWORD}}';

var TWIN_RECTYPE   = 'com.futura.emitter.packed';
var OUTPUT_RECTYPE = 'io.microshare.event.alert.image';
var LOG_RECTYPE    = 'io.microshare.futura.log';

var MS_API_HOST = 'https://pest.microshare.io';

var TWIN_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// ── Bindings (persistent state across executions) ──────────────────────────

function initBindings() {
    if (typeof bindings === 'undefined' || bindings === null) bindings = {};
    if (!bindings.authToken)    bindings.authToken    = null;
    if (!bindings.lastPollTime) bindings.lastPollTime = 0;
    if (!bindings.seenEventIds) bindings.seenEventIds = [];
    if (!bindings.twinLookup)   bindings.twinLookup   = {};
    if (!bindings.twinCacheTime)bindings.twinCacheTime = 0;
    if (!bindings.dcMeta)       bindings.dcMeta        = null;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function logResult(auth, stage, data) {
    print('EMITTER [' + stage + ']: ' + JSON.stringify(data));
    try {
        lib.writeShare(auth, LOG_RECTYPE, {
            stage: stage,
            timestamp: new Date().toISOString(),
            data: data
        }, ['futura', 'log', stage]);
    } catch (e) {
        print('Log write failed: ' + e);
    }
}

// NOTE: httpGet/httpPost use Java HttpURLConnection because Microshare Robots
// run in an isolated GraalJS context — lib.post() wraps ALL responses in
// {err, msg} and discards the raw body. Futura login returns a raw JWT string
// which lib.post() cannot capture.
function httpPost(url, headers, body) {
    var URL = Java.type('java.net.URL');
    var BufferedReader = Java.type('java.io.BufferedReader');
    var InputStreamReader = Java.type('java.io.InputStreamReader');
    var OutputStreamWriter = Java.type('java.io.OutputStreamWriter');

    var conn = new URL(url).openConnection();
    conn.setRequestMethod('POST');
    conn.setDoOutput(true);
    conn.setConnectTimeout(15000);
    conn.setReadTimeout(15000);

    if (headers) {
        var keys = Object.keys(headers);
        for (var i = 0; i < keys.length; i++) {
            conn.setRequestProperty(keys[i], headers[keys[i]]);
        }
    }

    if (body) {
        var writer = new OutputStreamWriter(conn.getOutputStream(), 'UTF-8');
        writer.write(body);
        writer.flush();
        writer.close();
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

    var parsed = null;
    try { parsed = JSON.parse(response); } catch (e) { parsed = response; }
    return { status: status, body: parsed };
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

function loadTwinLookup(auth) {
    var now = Date.now();
    if (bindings.twinCacheTime && (now - bindings.twinCacheTime) < TWIN_CACHE_TTL_MS) {
        if (Object.keys(bindings.twinLookup).length > 0) return;
    }

    try {
        var url = MS_API_HOST + '/api/device/' + TWIN_RECTYPE + '?details=true&discover=true';
        var result = httpGet(url, {
            'Authorization': 'Bearer ' + auth,
            'Accept': 'application/json'
        });
        if (result.status !== 200 || !result.body || !result.body.objs || result.body.objs.length === 0) return;

        var lookup = {};
        var dcMeta = null;
        for (var i = 0; i < result.body.objs.length; i++) {
            var cluster = result.body.objs[i];
            if (!dcMeta) {
                dcMeta = {
                    id: cluster.id || cluster._id || '',
                    name: cluster.name || '',
                    network: 'com.futura.emitter',
                    recType: TWIN_RECTYPE
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
        bindings.twinLookup   = lookup;
        bindings.dcMeta       = dcMeta;
        bindings.twinCacheTime = now;
        logResult(auth, 'twins', { count: Object.keys(lookup).length });
    } catch (e) {
        print('Twin load error: ' + e);
    }
}

// ── Futura authentication ──────────────────────────────────────────────────

function futuraLogin(auth) {
    print('Authenticating with Futura');
    var result = httpPost(
        FUTURA_SERVER_URL + '/rest/webapp/login',
        { 'Content-Type': 'application/json' },
        JSON.stringify({ email: FUTURA_USERNAME, password: FUTURA_PASSWORD })
    );

    var token = null;
    if (result && result.status === 200 && result.body) {
        token = (typeof result.body === 'string') ? result.body : (result.body.token || null);
    }

    if (token) {
        bindings.authToken = token;
        logResult(auth, 'login_ok', { token_length: token.length });
        return true;
    }

    logResult(auth, 'login_fail', { status: result ? result.status : null, body: result ? result.body : null });
    return false;
}

function futuraHeaders() {
    return { 'X-Auth-Token': bindings.authToken, 'Accept': 'application/json' };
}

// ── Poll for new events ────────────────────────────────────────────────────

function pollEvents(auth) {
    var now  = Date.now();
    var since = bindings.lastPollTime || (now - 3600000); // 1h lookback on first poll

    var url = FUTURA_TMS_URL + '/tms/events/api?startDate=' + since + '&pageIndex=0&pageSize=100';
    print('Polling: ' + url);

    var result = httpGet(url, futuraHeaders());

    if (result.status === 401) {
        print('401 — re-authenticating');
        if (!futuraLogin(auth)) return [];
        result = httpGet(url, futuraHeaders());
    }

    if (result.status !== 200 || !result.body) {
        logResult(auth, 'poll_error', { status: result.status, body: result.body });
        return [];
    }

    bindings.lastPollTime = now;

    var events = result.body.events || result.body || [];
    if (!Array.isArray(events)) events = [];
    return events;
}

// ── Build alert record ─────────────────────────────────────────────────────
//
// Produces a Tactacam-compatible event.alert.image record so the standard
// bundler can create incidents without any extra robot.

function buildAlert(event, twin) {
    var emitterId   = event.emitterId   || '';
    var emitterName = event.emitterName || emitterId;
    var timestamp   = event.msgTimestamp
                      ? (event.msgTimestamp.indexOf('Z') < 0 ? event.msgTimestamp + 'Z' : event.msgTimestamp)
                      : new Date().toISOString();
    var imageUrl    = event.eventImageDownloadUrl || '';
    var pestType    = (event.emitterPestType || '').toLowerCase(); // "cockroach", "rat", ...

    var deviceLocation = (twin && twin.location && twin.location.length > 0)
        ? twin.location
        : [emitterName];

    var locationLabel = deviceLocation.length > 0 ? deviceLocation[deviceLocation.length - 1] : emitterName;

    var dcMeta = bindings.dcMeta || {
        id: '', name: 'Futura Emitter', network: 'com.futura.emitter', recType: TWIN_RECTYPE
    };

    return {
        alert:    'rodent',
        event:    'rodent_photo',
        solution: 'pest',
        label:    'Rodent Photo: ' + emitterName + ' - ' + locationLabel,
        time:     timestamp,
        current: {
            image: imageUrl,
            sum:   1,
            type:  'image',
            pest:  pestType
        },
        meta: {
            device: deviceLocation,
            global: [],
            iot: {
                device_id:   emitterId,
                time:        timestamp,
                iso_time:    timestamp,
                type:        'futura.emitter.' + (event.type || 'armed').toLowerCase(),
                ns_version:  'v1.0'
            },
            dc: {
                id:       dcMeta.id   || '',
                name:     dcMeta.name || '',
                network:  'com.futura.emitter',
                recType:  TWIN_RECTYPE,
                usecase:  'SC08',
                facts:    { usecase: 'SC08' }
            },
            usecase: 'SC08',
            source:  []
        },
        origin: {
            futura: {
                event_id:       event.id || null,
                emitter_type:   event.emitterType || '',
                pest_type:      event.emitterPestType || '',
                classification: event.eventImageAiClassification || {}
            },
            deviceClusterId: dcMeta.id || ''
        }
    };
}

// ── Deduplication ──────────────────────────────────────────────────────────

function isAlreadySeen(eventId) {
    return bindings.seenEventIds.indexOf('' + eventId) !== -1;
}

function markSeen(eventId) {
    bindings.seenEventIds.push('' + eventId);
    while (bindings.seenEventIds.length > 500) {
        bindings.seenEventIds.shift();
    }
}

// ── Main (scheduled) ──────────────────────────────────────────────────────

// Robot auth: `auth` MUST be a grant_type=robot token (scope SHARE:READ,QUERY,WRITE;
// add SHARE:EXECUTE,POLICY for a bundler) that returns 200 on /api/share. An ALL:ALL or
// session token 401s on /api/share, so this robot fires but every writeShare/device/view
// call fails silently ("silent dispatch death"). Re-kick via isActive; never PUT a new auth.
function main(text, auth) {
    print('=== FUTURA POLL START ===');
    initBindings();

    try {
        loadTwinLookup(auth);

        if (!bindings.authToken) {
            if (!futuraLogin(auth)) {
                print('Cannot authenticate — skipping poll');
                return bindings;
            }
        }

        var events   = pollEvents(auth);
        var newCount = 0;
        var skipped  = 0;

        for (var i = 0; i < events.length; i++) {
            var event = events[i];

            // Only process photo events — skip maintenance (KEEP_ALIVE, LOW_BATTERY, etc.)
            if (!event.eventImageDownloadUrl) {
                skipped++;
                continue;
            }

            var eventId = event.id;
            if (eventId && isAlreadySeen(eventId)) continue;

            var twin    = bindings.twinLookup[(event.emitterId || '').toUpperCase()] || null;
            var alert   = buildAlert(event, twin);

            var tags = alert.meta.device.slice();
            tags.push(event.emitterId || '');
            if (event.emitterPestType) tags.push(event.emitterPestType.toLowerCase());
            tags.push('futura');

            lib.writeShare(auth, OUTPUT_RECTYPE, alert, tags);

            if (eventId) markSeen(eventId);
            newCount++;
        }

        if (newCount > 0 || skipped > 0) {
            logResult(auth, 'poll_ok', {
                total: events.length,
                new_alerts: newCount,
                skipped_maintenance: skipped,
                since: new Date(bindings.lastPollTime).toISOString()
            });
        }

    } catch (error) {
        logResult(auth, 'error', { message: '' + error, stack: error.stack || '' });
    }

    print('=== FUTURA POLL END ===');
    return bindings;
}
