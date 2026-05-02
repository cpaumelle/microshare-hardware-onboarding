/*
 * Taqt feedback — event.meta producer (SmilioEventHandler-equivalent JS robot)
 *
 * Trigger recType: io.microshare.feedback.unpacked
 * Output recTypes:
 *   - io.microshare.feedback.unpacked.event.meta — backboard-enriched press event
 *     (consumed by the EverSmart Clean form's default `feedback_event` dataFormat,
 *     and by our KPI 9.1/9.2 view aggregations)
 *
 * Emits one event.meta record per detected press. Detection rules (mirroring
 * the platform's Scala SmilioEventHandler at
 * reference/microshare-source/stream-service-3/src/main/scala/.../SmilioEventHandler.scala):
 *
 *   1. data.swipe[0].value === true (boolean mode) OR a string (RFID mode)
 *      → emit one "Hall Effect" event.
 *
 *   2. data.pushes_since_reset[i].value > prior value for the same context_id
 *      → emit one event with current/history sums.
 *
 * Prior `pushes_since_reset` values are stored per-device in
 * `bindings.lastPushes[device_id][context_id]`. First-ever record for a device
 * has no prior values, so the first run only emits any swipe events (no
 * push-diff events). Subsequent records emit one event per slot whose
 * cumulative value increased.
 *
 * The backboard is read via httpGet to `/view/io.microshare.config.backboard/<id>`
 * (the backboard is a VIEW, not a share record — same as A large airport). The backboard
 * id is sourced from `record.data.meta.dc.facts.backboard` which our unpacker
 * stamps on every record. Cached for 24h in bindings.backboardCache.
 *
 * Note: we do NOT also write to io.microshare.event.alert.feedback here. That
 * is the alert-emitter robot's job (Microshare value_monitor v4.15), which
 * applies notification rules from io.microshare.config.robot. SmilioEventHandler
 * does write the alert directly, but our setup separates the two so the rules
 * engine can filter alerts (good/staff are silent, etc.).
 */

var lib = require('./libs/helpers');

// Trigger is io.microshare.taqt.unpacked. Output recType mirrors the source
// using SmilioEventHandler's convention (<source.recType>.event.meta), so
// the chain stays on the proven-listable io.microshare.taqt.* namespace.
// The form needs to be configured to read this recType (it defaults to
// io.microshare.feedback.unpacked.event.meta which is platform-blocked
// for user writes). Wire-up in app.facts.sources[].dataFormat or via a
// custom sources mapping.
var META_RECTYPE    = 'io.microshare.taqt.unpacked.event.meta';
// SmilioEventHandler.scala writes BOTH .event.meta AND
// io.microshare.event.alert.feedback per detected press (the latter is the
// bundler's input). We replicate both. If io.microshare.event.alert.feedback
// turns out to be platform-list-blocked too (like feedback.unpacked is), we
// fall back to a custom alert recType — TBD by replay verification.
var ALERT_RECTYPE   = 'io.microshare.event.alert.feedback';
var ALERT_NAME      = 'feedback';
var SOLUTION        = 'clean';
var SWIPE_CONTEXT   = 'Hall Effect';
var MS_API_HOST     = '__MS_API_HOST__';
var BACKBOARD_TTL_MS = 24 * 60 * 60 * 1000;

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
        for (var i = 0; i < keys.length; i++) conn.setRequestProperty(keys[i], headers[keys[i]]);
    }
    var status = conn.getResponseCode();
    var stream = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
    if (!stream) return { status: status, body: null };
    var reader = new BufferedReader(new InputStreamReader(stream));
    var response = '';
    var line;
    while ((line = reader.readLine()) !== null) response += line;
    reader.close();
    var body = null;
    try { body = JSON.parse(response); } catch (e) { body = response; }
    return { status: status, body: body };
}

function initBindings() {
    if (typeof bindings === 'undefined' || bindings === null) bindings = {};
    if (!bindings.lastPushes) bindings.lastPushes = {};
    if (!bindings.backboardCache) bindings.backboardCache = null;
    if (!bindings.backboardCacheTime) bindings.backboardCacheTime = 0;
    if (!bindings.backboardId) bindings.backboardId = '';
}

function loadBackboard(auth, backboardId) {
    if (!backboardId) return null;
    if (bindings.backboardId === backboardId
        && bindings.backboardCache
        && (Date.now() - bindings.backboardCacheTime) < BACKBOARD_TTL_MS) {
        return bindings.backboardCache;
    }
    var url = MS_API_HOST + '/view/io.microshare.config.backboard/' + backboardId;
    var resp = httpGet(url, {
        'Authorization': 'Bearer ' + auth,
        'Accept':        'application/json'
    });
    if (!resp || resp.status !== 200 || !resp.body || !resp.body.objs || !resp.body.objs[0]) {
        print('event-meta: backboard ' + backboardId + ' not loadable (status=' + (resp && resp.status) + ')');
        return null;
    }
    var view = resp.body.objs[0];
    var buttons = view.data && view.data.facts && view.data.facts.en && view.data.facts.en.buttons;
    if (!Array.isArray(buttons)) {
        print('event-meta: backboard ' + backboardId + ' missing data.facts.en.buttons');
        return null;
    }
    var map = {};
    for (var i = 0; i < buttons.length; i++) {
        if (buttons[i] && buttons[i].smilioEvent) map[buttons[i].smilioEvent] = buttons[i];
    }
    bindings.backboardId       = backboardId;
    bindings.backboardCache    = map;
    bindings.backboardCacheTime = Date.now();
    print('event-meta: backboard loaded (' + Object.keys(map).length + ' buttons)');
    return map;
}

function buildSourceRef(source) {
    var d = source.data || {};
    var iot = (d.meta && d.meta.iot) || {};
    return {
        id:      source.id || source._id || '',
        recType: source.recType || '',
        tstamp:  iot.iso_time || iot.time || '',
        data: {
            device_id: iot.device_id || '',
            fcnt_up:   iot.fcnt_up || 0
        }
    };
}

// Tags on emitted event.meta records — match A large airport's exact pattern so the
// EverSmart Clean form's positional location filters (loc1, loc2, ...)
// resolve correctly:
//
//   [<dataContext-tag-1>, <dataContext-tag-2>, ...<location array>]
//   e.g. ["customer","restroom","SiteA","T1","L0","WC01","WRR"]
//
// Microshare strips cluster.data.globalTags on POST so meta.global is empty;
// we hardcode the dataContext prefix here. Alert-emitter's metaTags filter
// must use the same lowercase prefix to match.
var DATA_CONTEXT_TAGS = ['customer', 'restroom'];

function buildTags(source) {
    var meta = (source.data && source.data.meta) || {};
    var tags = [];
    for (var c = 0; c < DATA_CONTEXT_TAGS.length; c++) tags.push(DATA_CONTEXT_TAGS[c]);
    var globals = meta.global || [];
    for (var i = 0; i < globals.length; i++) {
        if (tags.indexOf(globals[i]) === -1) tags.push(globals[i]);
    }
    var device = meta.device || [];
    for (var j = 0; j < device.length; j++) {
        if (tags.indexOf(device[j]) === -1) tags.push(device[j]);
    }
    return tags;
}

function emitEventMeta(auth, source, contextId, current, previous, badgeId, sources, backboard) {
    var match = backboard && backboard[contextId];
    if (!match) {
        print('event-meta: no backboard mapping for ' + contextId + ' — skipping');
        return 0;
    }

    var meta = (source.data && source.data.meta) || {};
    var sourceRefs = [];
    for (var i = 0; i < sources.length; i++) sourceRefs.push(buildSourceRef(sources[i]));

    var record = {
        button:  contextId,
        event:   match.event,
        label:   match.label,
        change:  current - previous,
        current: { sum: current },
        history: { sum: previous },
        meta:    meta,
        sources: sourceRefs
    };
    if (badgeId) record.badge_id = badgeId;

    var tags = buildTags(source);
    lib.writeShare(auth, META_RECTYPE, record, tags);

    // Companion alert.feedback record — the bundler subscribes to this recType.
    // Same shape as SmilioEventHandler.buildAlertData with alert/solution set.
    var alertRecord = {
        event:    match.event,
        label:    match.label,
        change:   current - previous,
        current:  { sum: current },
        history:  { sum: previous },
        alert:    ALERT_NAME,
        solution: SOLUTION,
        meta:     meta,
        sources:  sourceRefs
    };
    if (badgeId) alertRecord.badge_id = badgeId;
    lib.writeShare(auth, ALERT_RECTYPE, alertRecord, tags);

    print('event-meta: emitted event.meta + alert.feedback event=' + match.event + ' change=' + (current - previous));
    return 1;
}

function processRecord(auth, source) {
    var data = source.data || {};
    var meta = data.meta || {};
    var iot  = meta.iot || {};
    var deviceId = iot.device_id || '';
    if (!deviceId) {
        print('event-meta: no device_id, skipping');
        return;
    }

    var backboardId = (meta.dc && meta.dc.facts && meta.dc.facts.backboard) || bindings.backboardId || '';
    var backboard   = loadBackboard(auth, backboardId);
    if (!backboard) {
        print('event-meta: no backboard available for ' + backboardId);
        return;
    }

    var emitted = 0;

    // 1. Swipe (Hall Effect / NFC tap)
    var swipes = data.swipe || [];
    if (Array.isArray(swipes) && swipes.length > 0) {
        var first = swipes[0] || {};
        var v     = first.value;
        if (typeof v === 'string' && v) {
            emitted += emitEventMeta(auth, source, SWIPE_CONTEXT, 1, 0, v, [source], backboard);
        } else if (v === true) {
            var badge = first.badge_id || (typeof first.context_id === 'string' && first.context_id !== 'Last RFID' ? first.context_id : null);
            emitted += emitEventMeta(auth, source, SWIPE_CONTEXT, 1, 0, badge, [source], backboard);
        }
    }

    // 2. pushes_since_reset diff against last-seen state
    var current = data.pushes_since_reset || [];
    if (Array.isArray(current) && current.length > 0) {
        var prevState = bindings.lastPushes[deviceId] || {};
        var hasPrior  = Object.keys(prevState).filter(function(k) { return k.charAt(0) !== '_'; }).length > 0;
        var sources   = hasPrior
            ? [{ id: prevState._lastId || '', recType: source.recType, data: { meta: { iot: { device_id: deviceId, fcnt_up: prevState._fcntUp || 0 } } } }, source]
            : [source];

        for (var i = 0; i < current.length; i++) {
            var entry = current[i];
            var cid   = entry && entry.context_id;
            if (!cid) continue;
            var cval  = (typeof entry.value === 'number') ? entry.value : 0;
            var pval  = (typeof prevState[cid] === 'number') ? prevState[cid] : 0;
            if (cval > pval && hasPrior) {
                emitted += emitEventMeta(auth, source, cid, cval, pval, null, sources, backboard);
            }
        }

        // Update last-seen state
        var newState = {};
        for (var j = 0; j < current.length; j++) {
            if (current[j] && current[j].context_id) {
                newState[current[j].context_id] = (typeof current[j].value === 'number') ? current[j].value : 0;
            }
        }
        newState._fcntUp = iot.fcnt_up || 0;
        newState._lastId = source.id || source._id || '';
        bindings.lastPushes[deviceId] = newState;
    }

    print('event-meta: device=' + deviceId + ' emitted=' + emitted);
}

function main(text, auth) {
    initBindings();
    try {
        var rec = lib.parseMsg(text);
        if (!rec || !rec.objs || !rec.objs[0]) {
            print('event-meta: empty trigger');
            return bindings;
        }
        processRecord(auth, rec.objs[0]);
    } catch (e) {
        print('event-meta: error ' + (e && e.message));
        // Errors only — heartbeat/state diagnostics removed for production volume.
        try {
            lib.writeShare(auth, 'io.microshare.newhw.log', {
                stage:     'event-meta-error',
                timestamp: new Date().toISOString(),
                data:      { error: '' + (e && e.message), stack: (e && e.stack) || '' }
            }, ['event-meta', 'error']);
        } catch (e2) {}
    }
    return bindings;
}
