// Composer permissions: Share Read, Share Query, Share Write, Share Execute, Share Policy
/*
 * Futura Emitter | Alert Generator
 *
 * Triggered Robot that fires on io.microshare.trap.unpacked records
 * from Futura Emitter devices. Routes to two different alert recTypes
 * depending on whether the event has an image (EmitterCam) or not (TubeTrap):
 *
 *   EmitterCam (PROXIMITY, image present):
 *     → io.microshare.event.alert.image   event: rodent_photo   usecase: SC08
 *       Matches Tactacam convention: current.image = pre-signed URL
 *
 *   TubeTrap (TRIGGERED, no image):
 *     → io.microshare.event.alert.rodent  event: rodent_present  usecase: trap
 *       Matches Traplinked/EZ Kat convention
 *
 * This is the second stage of the Futura Emitter pipeline:
 *   1. Futura Emitter — Scheduled Poll Robot  — polls API, writes trap.unpacked
 *   2. Futura Emitter | Alert Generator        — this file
 *   3. Pest incident bundler (platform)       — bundles alerts into incidents
 *
 * Note: the platform bundler / event handlers fire on LoRaWAN/platform-fed records,
 * and may NOT create incidents from a robot-fed pipeline. If incidents don't appear,
 * ship a direct-write JS bundler (write the incident record yourself with
 * data.current.workflow.process.status='open'), or widen the platform bundler's
 * filter to admit your recType.
 *
 * Trigger recType: io.microshare.trap.unpacked
 * Identifies Futura records by dc.network === 'com.futura.emitter'.
 */

var lib = require('./libs/helpers');

// ── Configuration ──────────────────────────────────────────────────────────

var RODENT_RECTYPE = 'io.microshare.event.alert.rodent';
var IMAGE_RECTYPE  = 'io.microshare.event.alert.image';
var LOG_URL = 'https://your-log-collector.example.com/log';

// Futura event types → Microshare alert event mapping
// Routing to rodent vs image alert is decided by trap_image presence, not event type
var ALERT_EVENTS = {
    'TRIGGERED': 'rodent_present',  // TubeTrap physically triggered — check + service
    'PROXIMITY': 'rodent_photo'     // EmitterCam detection — image attached
};

// ── Helpers ────────────────────────────────────────────────────────────────

function log(stage, data) {
    try {
        lib.post(LOG_URL, { 'Content-Type': 'application/json' },
            JSON.stringify({ robot: 'futura-alert', stage: stage, data: data, ts: new Date().toISOString() }));
    } catch (e) {}
    print(stage + ': ' + JSON.stringify(data));
}

// ── Build alert record ─────────────────────────────────────────────────────

function buildAlert(unpacked, recordId) {
    var meta = unpacked.meta || {};
    var iot = meta.iot || {};
    var dc = meta.dc || {};
    var trapEvent = (unpacked.trap_event || [{}])[0].value || 'unknown';
    var alertEvent = ALERT_EVENTS[trapEvent];

    // Image URL present → EmitterCam event (SC08); absent → TubeTrap event
    var imageUrl = (unpacked.trap_image && unpacked.trap_image.length > 0)
        ? unpacked.trap_image[0].value
        : null;
    var isCameraEvent = !!imageUrl;

    var alertRecType = isCameraEvent ? IMAGE_RECTYPE : RODENT_RECTYPE;
    var usecase      = isCameraEvent ? 'SC08' : (dc.usecase || 'trap');

    // Build label from location and event type
    var device = meta.device || [];
    var lastTag = device[device.length - 1] || 'unknown';

    var LABELS = {
        'rodent_present': 'Rodent Detected',
        'rodent_photo':   'Rodent Photo'
    };
    var label = (LABELS[alertEvent] || 'Alert') + ': ' + lastTag;

    // current section — image events carry the photo URL (matches Tactacam convention)
    var current = isCameraEvent
        ? { image: imageUrl, type: 'image', sum: 1 }
        : { sum: 1 };

    return {
        alertRecType: alertRecType,   // consumed by main(), not written to the record
        alert: 'rodent',
        event: alertEvent,
        solution: 'pest',
        label: label,
        tstamp: iot.time || new Date().toISOString(),

        current: current,
        history: { sum: 0 },
        change: 1,

        meta: {
            dc: {
                facts: { usecase: usecase },
                id: dc.id || '',
                name: dc.name || '',
                network: dc.network || 'com.futura.emitter',
                recType: dc.recType || 'com.futura.emitter.packed',
                unpacker: dc.unpacker || 'robot.futura.emitter',
                usecase: usecase
            },
            device: device,
            global: meta.global || [],
            iot: {
                device_id: iot.device_id || '',
                time: iot.time || '',
                iso_time: iot.iso_time || iot.time || '',
                type: iot.type || 'poll',
                ns_version: iot.ns_version || 'v1.0'
            },
            source: meta.source || []
        },

        sources: [
            {
                data: {
                    device_id: iot.device_id || '',
                    trap_event: trapEvent,
                    trap_image: unpacked.trap_image || []
                },
                id: recordId || '',
                recType: 'io.microshare.trap.unpacked',
                tstamp: iot.time || new Date().toISOString()
            }
        ]
    };
}

// ── Main (triggered on trap.unpacked) ─────────────────────────────────────

function main(text, auth) {
    var record = lib.parseMsg(text);

    // lib.parseMsg returns {objs: [...]} — data is in objs[0]
    if (record && record.objs && record.objs.length > 0) {
        record = record.objs[0];
    }
    if (!record || !record.data) {
        return;
    }

    var data = record.data;
    var trapEvent = (data.trap_event || [{}])[0].value || '';

    // Only generate alerts for actionable events
    if (!ALERT_EVENTS[trapEvent]) {
        return;  // silently skip KEEP_ALIVE, NO_KEEP_ALIVE, LOW_BATTERY, etc.
    }

    // Skip if not from Futura (don't interfere with Traplinked or EZ Kat records)
    var dc = (data.meta || {}).dc || {};
    if (dc.network && dc.network !== 'com.futura.emitter') {
        return;  // not our device type
    }

    var alert = buildAlert(data, record.id || '');

    // Pull out the routing recType (not part of the written record)
    var alertRecType = alert.alertRecType;
    delete alert.alertRecType;

    // Tags — same as the unpacked record (location tags)
    var tags = (data.meta || {}).device || [];
    tags = tags.slice();  // copy

    lib.writeShare(auth, alertRecType, alert, tags);

    log('alert', {
        device: (data.meta || {}).iot ? data.meta.iot.device_id : '?',
        event: trapEvent,
        alertEvent: ALERT_EVENTS[trapEvent],
        alertRecType: alertRecType,
        label: alert.label,
        time: alert.tstamp
    });
}
