/*
 * DEV CP Traplinked | Alert Generator
 *
 * Triggered Robot that fires on io.microshare.trap.unpacked records
 * from Traplinked devices and writes io.microshare.event.alert.rodent
 * for catch/trigger events.
 *
 * This is the second stage of the Traplinked pipeline:
 *   1. DEV CP Traplinked | Poller Unpacker  — polls API, writes trap.unpacked
 *   2. DEV CP Traplinked | Alert Generator  — this file, writes event.alert.rodent
 *   3. ES Pest Bundler Rodent (platform)    — bundles alerts into incidents
 *
 * The Poller Unpacker is temporary (replaced by Scala unpacker eventually).
 * This Alert Generator is permanent — snap trap alert logic is device-specific.
 *
 * Trigger recType: io.microshare.trap.unpacked
 * Output recType:  io.microshare.event.alert.rodent
 *
 * Generates alerts for all actionable Traplinked events:
 *
 *   Trap events (site visit required):
 *     catch_detected     → rodent_caught            (confirmed catch)
 *     trap_triggered     → rodent_present            (trap fired, check needed)
 *     false_triggering   → trap_false_trigger         (rearm needed)
 *
 *   Infestation/activity monitoring:
 *     infested           → rodent_infestation         (general infestation)
 *     light_infestation  → rodent_light_infestation   (light activity)
 *     severe_infestation → rodent_severe_infestation  (urgent)
 *     activity_warning   → rodent_activity_warning    (threshold warning)
 *     activity_critical  → rodent_activity_critical   (threshold critical)
 *
 * Ignores: rearmed (no action needed).
 */

var lib = require('./libs/helpers');

// ── Configuration ──────────────────────────────────────────────────────────

var ALERT_RECTYPE = 'io.microshare.event.alert.rodent';
var LOG_URL = 'https://robot-logs.charliehub.net/log';

// Events that should generate an alert
// Traplinked gives us richer data than motion sensors — we map all actionable events
var ALERT_EVENTS = {
    // Trap events — all require site visit
    'catch_detected':       'rodent_caught',              // confirmed catch — retrieve + rearm
    'trap_triggered':       'rodent_present',             // trap fired, catch not confirmed — check + rearm
    'false_triggering':     'trap_false_trigger',         // no catch, but trap needs rearming

    // Infestation levels — monitoring/escalation alerts
    'infested':             'rodent_infestation',         // general infestation detected
    'light_infestation':    'rodent_light_infestation',   // light activity level
    'severe_infestation':   'rodent_severe_infestation',  // severe — urgent response
    'activity_warning':     'rodent_activity_warning',    // activity threshold warning
    'activity_critical':    'rodent_activity_critical'    // activity threshold critical — urgent

    // NOT alerting on: rearmed (no action needed), type_* (unknown types)
};

// ── Helpers ────────────────────────────────────────────────────────────────

function log(stage, data) {
    try {
        lib.post(LOG_URL, { 'Content-Type': 'application/json' },
            JSON.stringify({ robot: 'traplinked-alert', stage: stage, data: data, ts: new Date().toISOString() }));
    } catch (e) {}
    print(stage + ': ' + JSON.stringify(data));
}

// ── Build alert record ────────────────────────────────────────────────────
//
// Matches the format written by RodentEventHandler in the stream service
// so the ES Pest Bundler Rodent can process it identically.

function buildAlert(unpacked, recordId) {
    var meta = unpacked.meta || {};
    var iot = meta.iot || {};
    var dc = meta.dc || {};
    var trapEvent = (unpacked.trap_event || [{}])[0].value || 'unknown';
    var alertEvent = ALERT_EVENTS[trapEvent];

    // Build label from location tags and event type
    var device = meta.device || [];
    var lastTag = device[device.length - 1] || 'unknown';

    var trapState = unpacked.trap || [];
    var firedTraps = [];
    for (var i = 0; i < trapState.length; i++) {
        if (trapState[i].value) firedTraps.push(trapState[i].context || ('Trap ' + (i + 1)));
    }
    var trapSuffix = firedTraps.length > 0 ? ' (' + firedTraps.join(', ') + ')' : '';

    var LABELS = {
        'rodent_caught':              'Rodent Caught',
        'rodent_present':             'Trap Triggered',
        'trap_false_trigger':         'False Trigger',
        'rodent_infestation':         'Infestation Detected',
        'rodent_light_infestation':   'Light Infestation',
        'rodent_severe_infestation':  'Severe Infestation',
        'rodent_activity_warning':    'Activity Warning',
        'rodent_activity_critical':   'Activity Critical'
    };
    var label = (LABELS[alertEvent] || 'Alert') + trapSuffix + ': ' + lastTag;

    return {
        alert: 'rodent',
        event: alertEvent,
        solution: 'pest',
        label: label,
        tstamp: iot.time || new Date().toISOString(),

        current: { sum: 1 },
        history: { sum: 0 },
        change: 1,

        meta: {
            dc: {
                facts: dc.facts || { usecase: 'SC05' },
                id: dc.id || '',
                name: dc.name || '',
                network: dc.network || 'com.traplinked',
                recType: dc.recType || 'io.microshare.traplinked.packed',
                unpacker: dc.unpacker || 'robot.traplinked.poller',
                usecase: 'SC05'
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
                    trap: unpacked.trap || []
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
        return;  // silently skip non-alert events (rearmed, false_triggering, etc.)
    }

    // Skip if not from Traplinked (don't interfere with EZ Kat motion alerts)
    var dc = (data.meta || {}).dc || {};
    if (dc.network && dc.network !== 'com.traplinked') {
        return;  // not our device type
    }

    var alert = buildAlert(data, record.id || '');

    // Tags — same as the unpacked record (location tags)
    var tags = (data.meta || {}).device || [];
    tags = tags.slice();  // copy

    lib.writeShare(auth, ALERT_RECTYPE, alert, tags);

    log('alert', {
        device: (data.meta || {}).iot ? data.meta.iot.device_id : '?',
        event: trapEvent,
        alertEvent: ALERT_EVENTS[trapEvent],
        label: alert.label,
        time: alert.tstamp
    });
}
