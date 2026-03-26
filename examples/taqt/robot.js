/*
 * Ubiqod (Taqt) Webhook → Microshare Unpacker Robot
 *
 * Receives Ubiqod webhook JSON (no hex decoding — already structured)
 * and maps it to Microshare's standard data dictionary format.
 *
 * Handles three event types:
 *   DATA       — button press / badge swipe (TaqtOne, QR, SafeQoD)
 *   KEEP_ALIVE — periodic heartbeat (TaqtOne only)
 *   ALERT      — satisfaction threshold alert (TaqtOne only)
 *
 * Trigger recType: io.microshare.feedback.packed
 * Output recType:  io.microshare.feedback.unpacked
 *
 * Device identity: tracker.slug (IMEI for TaqtOne, UUID for QR/SafeQoD)
 * Timestamp:       root timestamp field (ISO 8601)
 *
 * Based on:
 *   - Ubiqod webhook docs: help.taqt.com/portal/en/kb/articles/getting-events-and-data-from-ubiqod-using-the-webhook
 *   - Example payloads: storage.googleapis.com/skiply-prod-ubiqod/schemas/callbackexample_new.json
 *   - JSON schema: storage.googleapis.com/skiply-prod-ubiqod/schemas/ubiqodhook_new.json
 *
 * Note: As of March 30 2026, the TYPE field for secure QR code trackers
 * is changing from UBIQODKEY to SAFEQOD. This robot handles both.
 */

var lib = require('./libs/helpers');

var PACKED_RECTYPE = 'io.microshare.feedback.packed';
var OUTPUT_RECTYPE = 'io.microshare.feedback.unpacked';
var LOG_RECTYPE    = 'io.microshare.newhw.log';

var TWIN_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── Helpers ────────────────────────────────────────────────────────────────

function logResult(auth, stage, data) {
    var record = { stage: stage, timestamp: new Date().toISOString(), data: data };
    print('UBIQOD [' + stage + ']: ' + JSON.stringify(data));
    try {
        lib.writeShare(auth, LOG_RECTYPE, record, ['newhw', 'ubiqod', stage]);
    } catch (e) {
        print('Log write failed: ' + e);
    }
}

// ── Device twin lookup (from device cluster) ───────────────────────────────

function initBindings() {
    if (typeof bindings === 'undefined' || bindings === null) {
        bindings = {};
    }
    if (!bindings.twinLookup) bindings.twinLookup = {};
    if (!bindings.twinCacheTime) bindings.twinCacheTime = 0;
    if (!bindings.dcMeta) bindings.dcMeta = null;
}

function loadTwinLookup(auth) {
    var now = Date.now();

    if (bindings.twinCacheTime && (now - bindings.twinCacheTime) < TWIN_CACHE_TTL_MS) {
        var count = Object.keys(bindings.twinLookup).length;
        if (count > 0) {
            print('Using cached twin lookup (' + count + ' devices)');
            return;
        }
    }

    print('Loading device cluster twin data for ' + PACKED_RECTYPE);
    try {
        var result = lib.readShareByType(auth, PACKED_RECTYPE);
        if (!result || !result.objs || result.objs.length === 0) {
            print('No device cluster data found — will use Ubiqod site metadata');
            return;
        }

        var lookup = {};
        var dcMeta = null;

        for (var i = 0; i < result.objs.length; i++) {
            var cluster = result.objs[i];
            var clusterData = cluster.data || {};

            if (!dcMeta) {
                dcMeta = {
                    id: cluster.id || cluster._id || '',
                    name: cluster.name || '',
                    network: clusterData.network || 'com.taqt.ubiqod',
                    recType: PACKED_RECTYPE,
                    targetRecType: clusterData.targetRecType || OUTPUT_RECTYPE
                };
            }

            var devices = clusterData.devices || [];
            for (var j = 0; j < devices.length; j++) {
                var dev = devices[j];
                var devId = (dev.id || '').toUpperCase();
                if (devId) {
                    lookup[devId] = {
                        location: (dev.meta || {}).location || [],
                        guid: dev.guid || ''
                    };
                }
            }
        }

        bindings.twinLookup = lookup;
        bindings.twinCacheTime = now;
        bindings.dcMeta = dcMeta;
        logResult(auth, 'twins_loaded', { count: Object.keys(lookup).length });
    } catch (e) {
        print('Twin load error: ' + e);
    }
}

// ── Ubiqod JSON extraction (Network Server equivalent) ─────────────────────

function extractUbiqod(raw) {
    var tracker = raw.tracker || {};
    var site = raw.site || {};

    // Device ID: tracker.slug is the canonical unique ID
    // (IMEI for TaqtOne, UUID for QR/SafeQoD)
    var deviceId = tracker.slug || tracker.id || '';

    // Timestamp
    var time = raw.timestamp || new Date().toISOString();

    // Event type
    var eventType = raw.eventType || 'UNKNOWN';

    // Battery
    var battery = tracker.batteryLevel;

    // Site location (lat,lng as comma-separated string)
    var lat = null;
    var lng = null;
    if (site.location && typeof site.location === 'string' && site.location.indexOf(',') !== -1) {
        var parts = site.location.split(',');
        lat = parseFloat(parts[0]) || null;
        lng = parseFloat(parts[1]) || null;
    }

    return {
        device_id: deviceId,
        time: time,
        eventType: eventType,
        battery: battery,
        lat: lat,
        lng: lng,
        tracker: tracker,
        site: site,
        account: raw.account || {},
        data: raw.data || null,
        alert: raw.alert || null,
        validity: raw.ubiqodValidity || {}
    };
}

// ── Decode DATA events (matching SmilioAction unpacked structure) ───────────
//
// SmilioAction produces:
//   swipe: [{value: true/false}]
//   pushes_since_reset: [{value: N, context: "Button #1, Upper Left"}, ...]
//   device_health.voltage: [{value: V, unit: "V", context: "idle"}, ...]
//
// Ubiqod sends one press at a time (not cumulative), so we emit:
//   swipe: [{value: true}] if badge was swiped
//   pushes_since_reset: [{value: pressCount, context: "Button #N, <label>"}]
//
// The field names (pushes_since_reset, swipe) match the SmilioAction decoder
// so downstream dashboards and robots see the same schema.

function decodeDataEvent(data) {
    if (!data) return { sensor: {}, device_health: {} };

    var sensor = {};

    var buttonRef = data.reference || '';
    var buttonLabel = data.label || '';
    var pressCount = data.pressCount || 1;

    // pushes_since_reset — matches SmilioAction FieldType.PUSHES_SINCE_RESET
    // SmilioAction uses context like "Button #1, Upper Left"
    // We use "Button #<ref>, <label>" to keep the same pattern
    sensor.pushes_since_reset = [{
        value: pressCount,
        context: 'Button #' + buttonRef + (buttonLabel ? ', ' + buttonLabel : '')
    }];

    // swipe — matches SmilioAction FieldType.SWIPE
    // SmilioAction sets swipe based on cmd byte == 3
    // Ubiqod sets it when a badge/code was scanned
    if (data.code) {
        sensor.swipe = [{ value: true }];
        // Additional badge metadata (not in SmilioAction but useful)
        sensor.badge = [{
            value: data.code.reference || '',
            context: data.code.label || '',
            externalReferences: data.code.externalReferences || {}
        }];
    } else {
        sensor.swipe = [{ value: false }];
    }

    // Photo URL if present (not in SmilioAction — Ubiqod-specific extension)
    if (data.photo) {
        sensor.photo = [{ url: data.photo }];
    }

    return { sensor: sensor };
}

// ── Decode ALERT events ────────────────────────────────────────────────────

function decodeAlertEvent(alert) {
    if (!alert) return { sensor: {} };

    return {
        sensor: {
            alert: [{
                type: alert.type || '',
                subtype: alert.subtype || '',
                count: alert.count || 0,
                config: alert.config || {}
            }]
        }
    };
}

// ── Build location tags ────────────────────────────────────────────────────

function buildLocationTags(extracted, twin) {
    // Prefer device cluster twin location if available
    if (twin && twin.location && twin.location.length > 0) {
        return twin.location;
    }

    // Fallback: build from Ubiqod site metadata
    var tags = [];
    var site = extracted.site;
    var account = extracted.account;

    if (account.name) tags.push(account.name);
    if (site.label) tags.push(site.label);

    // Add tracker label if different from site
    var trackerLabel = extracted.tracker.label || '';
    if (trackerLabel && tags.indexOf(trackerLabel) === -1) {
        tags.push(trackerLabel);
    }

    return tags;
}

// ── Main ───────────────────────────────────────────────────────────────────

function main(text, auth) {
    print('=== UBIQOD ROBOT START ===');
    initBindings();

    try {
        var rec = lib.parseMsg(text);
        if (!rec || !rec.objs || rec.objs.length === 0) {
            logResult(auth, 'error', { message: 'Failed to parse trigger record' });
            return bindings;
        }

        var obj = rec.objs[0];
        var raw = obj.data || {};

        // Step 1: Extract Ubiqod fields (NS equivalent)
        var extracted = extractUbiqod(raw);

        if (!extracted.device_id) {
            logResult(auth, 'error', { message: 'No device ID in payload' });
            return bindings;
        }

        print('Device: ' + extracted.device_id + ' type: ' + extracted.eventType +
              ' model: ' + (extracted.tracker.model || 'unknown'));

        // Step 2: Load device twins from device cluster
        loadTwinLookup(auth);
        var twin = bindings.twinLookup[extracted.device_id.toUpperCase()] || null;

        // Step 3: Decode based on event type
        var decoded = { sensor: {}, device_health: {} };

        if (extracted.eventType === 'DATA') {
            decoded = decodeDataEvent(extracted.data);
        } else if (extracted.eventType === 'ALERT') {
            decoded = decodeAlertEvent(extracted.alert);
        } else if (extracted.eventType === 'KEEP_ALIVE') {
            // Keepalive — no sensor data, just device health
            decoded = { sensor: {}, device_health: {} };
        } else {
            logResult(auth, 'skip', {
                device_id: extracted.device_id,
                eventType: extracted.eventType,
                message: 'Unknown event type'
            });
            return bindings;
        }

        // Step 4: Build device health (matching SmilioAction / TBHV100 patterns)
        // SmilioAction: device_health.voltage [{value, unit, context}]
        // TBHV100:      device_health.charge [{value, unit}], device_health.voltage [{value, unit}]
        // Ubiqod only provides batteryLevel (%) — no raw voltage
        var deviceHealth = decoded.device_health || {};
        deviceHealth.id = extracted.device_id;
        if (extracted.battery !== null && extracted.battery !== undefined) {
            deviceHealth.charge = [{ unit: '%', value: extracted.battery }];
        }

        // Step 5: Build location tags
        var locationTags = buildLocationTags(extracted, twin);

        // Step 6: Build unpacked record matching real device cluster output
        // Structure verified against live io.microshare.openclose.unpacked records
        var dcMeta = bindings.dcMeta || {
            id: '',
            name: 'Robot-based unpacker (Ubiqod)',
            network: 'com.taqt.ubiqod',
            recType: PACKED_RECTYPE,
            unpacker: 'robot.ubiqod.taqt',
            usecase: 'feedback'
        };

        var unpacked = {
            meta: {
                iot: {
                    device_id: extracted.device_id,
                    time: extracted.time,
                    iso_time: extracted.time,
                    type: extracted.eventType.toLowerCase(),
                    ns_version: 'v1.0',
                    lat: extracted.lat,
                    lng: extracted.lng
                },
                device: locationTags,
                dc: {
                    id: dcMeta.id || '',
                    name: dcMeta.name || '',
                    network: dcMeta.network || 'com.taqt.ubiqod',
                    recType: PACKED_RECTYPE,
                    unpacker: dcMeta.unpacker || 'robot.ubiqod.taqt',
                    usecase: dcMeta.usecase || 'feedback',
                    facts: dcMeta.facts || { usecase: 'feedback' }
                },
                global: [],
                source: [],
                // Ubiqod-specific metadata (not in standard DC output, but useful)
                ubiqod: {
                    tracker_id: extracted.tracker.id || '',
                    tracker_model: extracted.tracker.model || '',
                    tracker_type: extracted.tracker.type || '',
                    tracker_label: extracted.tracker.label || '',
                    site_id: extracted.site.id || '',
                    site_label: extracted.site.label || '',
                    account_name: extracted.account.name || '',
                    eventType: extracted.eventType,
                    validity: extracted.validity,
                    externalReferences: {
                        tracker: extracted.tracker.externalReferences || {},
                        site: extracted.site.externalReferences || {}
                    }
                }
            },
            device_health: deviceHealth,
            origin: {
                ubiqod_webhook: raw,
                deviceClusterId: dcMeta.id || ''
            }
        };

        // Merge sensor fields at top level (Microshare convention)
        if (decoded.sensor) {
            var keys = Object.keys(decoded.sensor);
            for (var k = 0; k < keys.length; k++) {
                unpacked[keys[k]] = decoded.sensor[keys[k]];
            }
        }

        // Tags for the unpacked record
        var tags = locationTags.slice();
        if (tags.indexOf(extracted.device_id) === -1) tags.push(extracted.device_id);
        tags.push(extracted.eventType);

        // Write unpacked record
        lib.writeShare(auth, OUTPUT_RECTYPE, unpacked, tags);

        logResult(auth, 'unpacked', {
            device_id: extracted.device_id,
            eventType: extracted.eventType,
            model: extracted.tracker.model || '',
            twin_match: !!twin,
            location: locationTags,
            battery: extracted.battery,
            button: extracted.data ? extracted.data.reference : null,
            badge: extracted.data && extracted.data.code ? extracted.data.code.reference : null
        });

    } catch (error) {
        logResult(auth, 'error', { message: '' + error, stack: error.stack || '' });
    }

    print('=== UBIQOD ROBOT END ===');
    return bindings;
}
