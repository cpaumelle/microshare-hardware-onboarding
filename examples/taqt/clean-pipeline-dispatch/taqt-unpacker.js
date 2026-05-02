/*
 * Ubiqod (Taqt) Webhook → Microshare Unpacker Robot
 *
 * Produces records that are byte-shape-identical to what Skiply's LoRaWAN
 * SmilioAction.Decoder produces (see Smilio sample at
 * reference/microshare-source/stream-service-3/src/test/resources/files/
 * smilioUnpackedV3KafkaMsg.json), so a Taqt-fed cluster is indistinguishable
 * from a Smilio-fed cluster to every downstream consumer:
 *
 *   - The platform's Scala SmilioEventHandler (selected by the cluster's
 *     use_case=SF01 + deviceUnpacker="eu.skiply.button.SmilioAction.Decoder")
 *     maintains pushes_since_reset history per device, diffs against the
 *     prior record, looks up the cluster's backboard, and emits both
 *     io.microshare.taqt.unpacked.event.meta records (consumed by the
 *     EverSmart form's default feedback_event dataFormat) and
 *     io.microshare.event.alert.feedback records (consumed by the alert
 *     pipeline). Nothing here writes those derived records — the platform
 *     does, identically to Smilio.
 *   - The EverSmart form's feedback_telematic transform also works directly
 *     against these records.
 *
 * Two Microshare-format choices are baked in to keep parity exact:
 *
 *   1. Each TaqtOne press emits a fixed 5-slot pushes_since_reset array
 *      whose context_ids are the canonical Smilio strings ("Button #1, Upper
 *      Left", … "Button #5, Middle"). The operator-facing label that says
 *      what each button *means* in this restroom (Low soap / Leak / etc.)
 *      lives in the io.microshare.config.backboard record, exactly like
 *      Smilio. See upstream/taqt/docs/BACKBOARD.md.
 *
 *   2. Cumulative counters per (device, button slot) are kept in
 *      bindings.deviceState and incremented on each press, so the value
 *      sequence looks like Smilio's monotonic counter even though Ubiqod
 *      sends one press at a time.
 *
 * Handles three Ubiqod eventTypes:
 *   DATA       — button press / badge swipe (TaqtOne, QR, SafeQoD)
 *   KEEP_ALIVE — periodic heartbeat (TaqtOne only)
 *   ALERT      — satisfaction threshold alert (TaqtOne only)
 *
 * Trigger recType: io.microshare.taqt.packed
 * Output recType:  io.microshare.taqt.unpacked
 *
 * Device identity: tracker.slug (IMEI for TaqtOne, UUID for QR/SafeQoD)
 * Timestamp:       root timestamp field (ISO 8601)
 *
 * Based on:
 *   - Ubiqod webhook docs: help.taqt.com/portal/en/kb/articles/getting-events-and-data-from-ubiqod-using-the-webhook
 *   - Skiply SmilioAction Decoder (LoRaWAN equivalent): SmilioAction/Decoder.scala
 *
 * Note: As of March 30 2026, the TYPE field for secure QR code trackers
 * is changing from UBIQODKEY to SAFEQOD. This robot handles both.
 */

var lib = require('./libs/helpers');

var PACKED_RECTYPE = 'io.microshare.taqt.packed';
var OUTPUT_RECTYPE = 'io.microshare.taqt.unpacked';
var LOG_RECTYPE    = 'io.microshare.newhw.log';

// Device clusters are Composer objects under /device/, NOT share records, so
// they cannot be read with lib.readShareByTags / readShareByView. Always use
// httpGet against /device/<recType>?details=true&discover=true. Pattern proven
// in public/examples/{taqt,traplinked,futura}/robot.js.
// app.microshare.io API host has NO /api/ prefix; pest.microshare.io does.
var MS_API_HOST = '__MS_API_HOST__';

var TWIN_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// httpGet — Java HttpURLConnection wrapper. Required because Microshare's
// GraalJS robot runtime has no fetch/axios/http stdlib, and lib.post is for
// POST only (lib has no GET helper). Returns {status, body}. Pattern duplicated
// across all hardware robots since the GraalJS context has no module system.
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

// Canonical Smilio button positions, indexed by Ubiqod data.reference. The
// TaqtOne hardware layout is fixed across units, so this is a constant table.
// What each button *means* in a given deployment is configured per cluster
// via the io.microshare.config.backboard record's smilioEvent → event/label
// mapping (see upstream/taqt/docs/BACKBOARD.md).
var BUTTON_REF_TO_CONTEXT_ID = {
    '1': 'Button #1, Upper Left',
    '2': 'Button #2, Upper Right',
    '3': 'Button #3, Lower Left',
    '4': 'Button #4, Lower Right',
    '5': 'Button #5, Middle'
};

// Stable index order in the pushes_since_reset array — must match the order
// SmilioAction.Decoder emits (see SmilioAction/Decoder.scala lines 19-23).
var SLOT_ORDER = ['1', '2', '3', '4', '5'];

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
    if (!bindings.globalTags) bindings.globalTags = [];
    // Per-device cumulative push counters keyed by device_id, so we can mimic
    // Smilio's monotonic pushes_since_reset[].value. Each entry is
    //   { counts: { '1': N, '2': N, ... } }
    if (!bindings.deviceState) bindings.deviceState = {};
    // Synthetic monotonically-increasing counter for meta.iot.fcnt_up. Each
    // emitted record gets a unique value so any same-fcnt dedup downstream
    // (form transform, SmilioEventHandler history loader) does not collapse
    // distinct records.
    if (typeof bindings.globalFcnt !== 'number') bindings.globalFcnt = 0;
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
        // Device clusters are Composer objects under /device/<recType>, NOT
        // share records. Use httpGet, never lib.readShareByTags / readShareByType.
        // (lib.readShareByType doesn't exist — silently crashes; readShareByTags
        // queries the share collection which contains no DCs.)
        // Pattern from public/examples/taqt/robot.js, proven April 2026.
        var url = MS_API_HOST + '/device/' + PACKED_RECTYPE + '?details=true&discover=true';
        var result = httpGet(url, {
            'Authorization': 'Bearer ' + auth,
            'Accept':        'application/json'
        });

        if (!result || result.status !== 200 || !result.body || !result.body.objs || result.body.objs.length === 0) {
            print('No device cluster data found at ' + url + ' (status=' + (result && result.status) + ') — will use Ubiqod site metadata');
            return;
        }

        var lookup = {};
        var dcMeta = null;
        var globalTags = [];

        for (var i = 0; i < result.body.objs.length; i++) {
            var cluster = result.body.objs[i];
            var clusterData = cluster.data || {};

            if (!dcMeta) {
                // Mirror Smilio's meta.dc shape exactly. The deviceUnpacker
                // string is what AgentHandlerSupervisor.startAgentRobot()
                // matches against to pick SmilioEventHandler — an operator
                // setting the cluster's unpacker to the SmilioAction decoder
                // class is what enables the .event/.event.meta/.alert.feedback
                // pipeline for our records.
                dcMeta = {
                    id: cluster.id || cluster._id || '',
                    name: cluster.name || '',
                    network: clusterData.network || 'com.taqt.ubiqod',
                    recType: PACKED_RECTYPE,
                    unpacker: clusterData.unpacker || 'eu.skiply.button.SmilioAction.Decoder',
                    usecase: clusterData.usecase || clusterData.use_case || 'SF01',
                    facts: clusterData.facts || {}
                };
            }

            // meta.global tags — Smilio populates these from cluster-level
            // metaTags (see real Smilio sample: ["Microshare","demo","solutions","restroom"]).
            // Cluster fields we'll accept (in priority order):
            //   1. clusterData.globalTags (array)
            //   2. clusterData.meta.global (array)
            //   3. clusterData.meta.location ("a,b,c" CSV — A large airport's pattern; the
            //      Microshare platform pipeline also reads this. We parse here so
            //      records produced by this user-side robot match the structure
            //      LoRaWAN-pipeline records have, and the EverSmart Clean form's
            //      default view can filter on data.meta.global $all dataContext.)
            var thisGlobals = clusterData.globalTags
                || (clusterData.meta && clusterData.meta.global)
                || [];
            if ((!thisGlobals || thisGlobals.length === 0)
                && clusterData.meta && typeof clusterData.meta.location === 'string'
                && clusterData.meta.location.indexOf(',') !== -1) {
                thisGlobals = clusterData.meta.location.split(',').map(function(s) { return s.trim(); }).filter(function(s) { return s; });
            }
            for (var g = 0; g < thisGlobals.length; g++) {
                if (globalTags.indexOf(thisGlobals[g]) === -1) globalTags.push(thisGlobals[g]);
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
        bindings.globalTags = globalTags;
        logResult(auth, 'twins_loaded', {
            count: Object.keys(lookup).length,
            globals: globalTags.length,
            backboard: dcMeta && dcMeta.facts && dcMeta.facts.backboard ? dcMeta.facts.backboard : null
        });
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
// SmilioAction emits cumulative counters: pushes_since_reset[i].value is the
// total presses for that button since reset, in a fixed 5-slot array on every
// uplink. The slot index and context_id strings are positional (Upper Left,
// Upper Right, Lower Left, Lower Right, Middle) and must match exactly what
// the platform's SmilioEventHandler / EverSmart form / backboard config join
// against.
//
// Ubiqod sends one press at a time (not cumulative). We maintain per-device
// cumulative counters in bindings.deviceState and emit the full 5-slot array
// on every press, with the just-pressed slot incremented by data.pressCount
// and the rest carrying their last cumulative value. Unused slots stay at 0
// — Smilio also reports zeros for unpressed buttons, so this matches.

function getOrInitDeviceState(deviceId) {
    if (!bindings.deviceState[deviceId]) {
        bindings.deviceState[deviceId] = {
            counts: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 }
        };
    }
    return bindings.deviceState[deviceId];
}

function buildPushesArray(state) {
    var out = [];
    for (var i = 0; i < SLOT_ORDER.length; i++) {
        var ref = SLOT_ORDER[i];
        out.push({
            value: state.counts[ref] || 0,
            context_id: BUTTON_REF_TO_CONTEXT_ID[ref]
        });
    }
    return out;
}

function decodeDataEvent(data, deviceId) {
    if (!data) return { records: [{ sensor: {}, deltaTimeMs: 0 }] };

    var buttonRef = String(data.reference || '');
    var pressCount = data.pressCount || 1;
    var photoUrl = data.photo || null;

    // TaqtOne hardware: 5 buttons (pins 1-5) + 1 NFC badge reader (pin 6).
    // Pin 6 is the staff check-in path — equivalent to Smilio's "Hall
    // Effect" on a swipe. The form's feedback_telematic transform already
    // emits event:"Hall Effect" when swipe[0].value is true, so we just
    // funnel pin 6 into the swipe path and the rest of the pipeline is
    // unchanged from the Smilio case.
    //
    // Important: only pin 6 should set swipe=true. Earlier versions also
    // set swiped=true whenever data.code was present, but Ubiqod includes
    // data.code on every event (carrying the press label / reference / QR
    // metadata) — using it as the swipe predicate falsely fires swipe on
    // every button press, which then triggers svcs-adapt to "close
    // incidents" on regular complaints. Badge metadata is preserved
    // separately via sensor.badge below regardless of pin.
    var nfcCheckin = (buttonRef === '6');
    var swiped = nfcCheckin;

    var state = getOrInitDeviceState(deviceId);

    if (BUTTON_REF_TO_CONTEXT_ID[buttonRef] !== undefined) {
        state.counts[buttonRef] += pressCount;
    } else if (buttonRef && !nfcCheckin) {
        // Anything other than refs 1-5 (button) or 6 (NFC) is a Ubiqod
        // misconfiguration we shouldn't try to interpret.
        print('UBIQOD: ignoring out-of-range button ref "' + buttonRef + '" for device ' + deviceId);
    }

    var sensor = {
        pushes_since_reset: buildPushesArray(state),
        swipe: [{ value: swiped }]
    };

    // Preserve badge metadata when present (data.code on a button press,
    // independent of whether ref=6 fired the swipe).
    if (data.code) {
        sensor.badge = [{
            value: data.code.reference || '',
            context: data.code.label || '',
            externalReferences: data.code.externalReferences || {}
        }];
    }

    if (photoUrl) {
        sensor.photo = [{ url: photoUrl }];
    }

    return { records: [{ sensor: sensor, deltaTimeMs: 0 }] };
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
        // For DATA events the decoder may return multiple records (baseline +
        // press) so we always work with an array.
        var sensorRecords;

        if (extracted.eventType === 'DATA') {
            sensorRecords = decodeDataEvent(extracted.data, extracted.device_id).records;
        } else if (extracted.eventType === 'ALERT') {
            sensorRecords = [{ sensor: decodeAlertEvent(extracted.alert).sensor, deltaTimeMs: 0 }];
        } else if (extracted.eventType === 'KEEP_ALIVE') {
            // Keepalive — no sensor data, just device health
            sensorRecords = [{ sensor: {}, deltaTimeMs: 0 }];
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
        var deviceHealth = { id: extracted.device_id };
        if (extracted.battery !== null && extracted.battery !== undefined) {
            deviceHealth.charge = [{ unit: '%', value: extracted.battery }];
        }

        // Step 5: Build location tags
        var locationTags = buildLocationTags(extracted, twin);

        // Step 6: Build unpacked record(s) matching real Smilio cluster output.
        // Field-for-field cross-checked against
        //   reference/microshare-source/stream-service-3/src/test/resources/files/smilioUnpackedV3KafkaMsg.json
        var dcMeta = bindings.dcMeta || {
            id: '',
            name: '',
            network: 'com.taqt.ubiqod',
            recType: PACKED_RECTYPE,
            // Defaults to the Smilio decoder string so AgentHandlerSupervisor
            // routes our records to SmilioEventHandler if the cluster itself
            // hasn't been configured with an explicit unpacker yet.
            unpacker: 'eu.skiply.button.SmilioAction.Decoder',
            usecase: 'SF01',
            facts: {}
        };

        var baseTimeMs = Date.parse(extracted.time);
        if (isNaN(baseTimeMs)) baseTimeMs = Date.now();

        var writeCount = 0;
        for (var ri = 0; ri < sensorRecords.length; ri++) {
            var rec = sensorRecords[ri];
            bindings.globalFcnt += 1;
            var recTimeIso = new Date(baseTimeMs + (rec.deltaTimeMs || 0)).toISOString();

            // meta.iot — fields and values match the Smilio sample exactly.
            // No iso_time/lat/lng (those aren't in the standard iot dictionary).
            // No payload-derived LoRa fields — TaqtOne is cellular, not LoRa.
            var iot = {
                device_id: extracted.device_id,
                fcnt_dwn: 0,
                fcnt_up: bindings.globalFcnt,
                ns_version: 'v3.0',
                time: recTimeIso,
                type: 'uplink'
            };

            var unpacked = {
                meta: {
                    iot: iot,
                    device: locationTags,
                    dc: {
                        id: dcMeta.id || '',
                        name: dcMeta.name || '',
                        network: dcMeta.network || 'com.taqt.ubiqod',
                        recType: PACKED_RECTYPE,
                        unpacker: dcMeta.unpacker || 'eu.skiply.button.SmilioAction.Decoder',
                        usecase: dcMeta.usecase || 'SF01',
                        facts: dcMeta.facts || {}
                    },
                    global: bindings.globalTags || [],
                    source: []
                },
                origin: {
                    // Per CLAUDE.md, vendor data lives under origin.<vendor>.
                    ubiqod: {
                        tracker_id: extracted.tracker.id || '',
                        tracker_model: extracted.tracker.model || '',
                        tracker_type: extracted.tracker.type || '',
                        tracker_label: extracted.tracker.label || '',
                        site_id: extracted.site.id || '',
                        site_label: extracted.site.label || '',
                        site_location: extracted.site.location || '',
                        account_name: extracted.account.name || '',
                        eventType: extracted.eventType,
                        validity: extracted.validity,
                        externalReferences: {
                            tracker: extracted.tracker.externalReferences || {},
                            site: extracted.site.externalReferences || {}
                        }
                    },
                    ubiqod_webhook: raw,
                    deviceClusterId: dcMeta.id || ''
                },
                device_health: deviceHealth
            };

            if (rec.sensor) {
                var keys = Object.keys(rec.sensor);
                for (var k = 0; k < keys.length; k++) {
                    unpacked[keys[k]] = rec.sensor[keys[k]];
                }
            }

            // Share-write tags: globals + locations only, matching Smilio's
            // tag convention. We do NOT add device_id or eventType — those
            // would diverge from Smilio and break tag-based queries that work
            // across both sources.
            var tags = (bindings.globalTags || []).slice();
            for (var li = 0; li < locationTags.length; li++) {
                if (tags.indexOf(locationTags[li]) === -1) tags.push(locationTags[li]);
            }

            lib.writeShare(auth, OUTPUT_RECTYPE, unpacked, tags);
            writeCount += 1;
        }

        logResult(auth, 'unpacked', {
            device_id: extracted.device_id,
            eventType: extracted.eventType,
            model: extracted.tracker.model || '',
            twin_match: !!twin,
            location: locationTags,
            battery: extracted.battery,
            button: extracted.data ? extracted.data.reference : null,
            badge: extracted.data && extracted.data.code ? extracted.data.code.reference : null,
            records_written: writeCount,
            fcnt_up: bindings.globalFcnt
        });

    } catch (error) {
        logResult(auth, 'error', { message: '' + error, stack: error.stack || '' });
    }

    print('=== UBIQOD ROBOT END ===');
    return bindings;
}
