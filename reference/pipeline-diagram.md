# Data Pipeline: Packed → Unpacked

How raw device data becomes a fully enriched Microshare record.

```mermaid
flowchart LR
    subgraph INBOUND ["Inbound (packed)"]
        RAW["Device sends JSON<br/>via webhook or REST API<br/><br/>★ <b>device.uuid:</b> 867280...<br/>timestamp: 2026-...<br/>event: triggered<br/>battery: 93%"]
    end

    subgraph ROBOT ["Robot (rapid dev iteration) or Scala pipeline (production)"]
        direction TB
        EXTRACT["<b>1. EXTRACT</b><br/>Find the ★ device.uuid<br/>in the vendor JSON<br/>(IMEI, serial number, DevEUI, etc.)"]
        MATCH["<b>2. MATCH</b><br/>Look up ★ device.uuid in cluster<br/>→ get location tags"]
        MAP["<b>3. MAP</b><br/>Translate vendor fields<br/>to Microshare schema"]
        EXTRACT --> MATCH --> MAP
    end

    subgraph OUTBOUND ["Outbound (unpacked)"]
        UNPACKED["<b>meta.iot.device_id:</b> ★ 867280...<br/><b>meta.iot.time:</b> 2026-...<br/><b>meta.device:</b> Building A / Floor 1 / Lobby<br/><b>meta.dc:</b> cluster name, network<br/><b>sensor fields:</b> vendor data mapped<br/><b>device_health:</b> battery, signal<br/><b>origin:</b> full raw JSON preserved"]
    end

    RAW --> EXTRACT
    MAP --> UNPACKED
    DC --> MATCH

    subgraph DC ["Device Cluster (Composer)"]
        TWINS["Register devices with<br/>★ device.uuid + location tags<br/><br/>867280060123456 → Building A / Floor 1 / Lobby<br/>867280060789012 → Building A / Floor 2 / Entrance<br/><br/><i>Robot reads via lib.readShareByType()</i>"]
    end

    style RAW text-align:left
    style UNPACKED text-align:left
    style TWINS text-align:left
    style DC fill:#e8f4f8,stroke:#2196F3
    style EXTRACT fill:#fff3e0,stroke:#FF9800
    style MATCH fill:#fff3e0,stroke:#FF9800
    style MAP fill:#fff3e0,stroke:#FF9800
```

## The Unique ID Is Everything

Every device vendor puts a unique identifier somewhere in their JSON — an IMEI, a serial number, a DevEUI. This is the **single field that connects everything**:

```mermaid
flowchart LR
    A["Inbound JSON\n★ device.uuid\ne.g. 867280060123456"] -->|must match| B["Device Cluster\ndevices[].id\n867280060123456"] -->|enriches with| C["Unpacked Record\nmeta.iot.device_id: 867280...\nmeta.device: Building A / Floor 1 / Lobby"]
    style A fill:#fff3e0,stroke:#FF9800
    style B fill:#e8f4f8,stroke:#2196F3
    style C fill:#e8f5e9,stroke:#4CAF50
```

Without a matching ID in the device cluster, the Robot can still write unpacked records — but they'll have no location context and won't appear correctly on dashboards.

## Where Different Vendors Put the device.uuid

Every vendor's JSON is different. The first job when onboarding a new device is finding where the device.uuid lives:

| Vendor | Field path in JSON | ID type | Example |
|---|---|---|---|
| Ubiqod (Taqt) | `tracker.slug` | IMEI | `867280060123456` |
| Futura Emitter | `emitterId` | IMEI or vendor ID | `1234567890ABCDE` |
| Actility (LoRaWAN) | `DevEUI_uplink.DevEUI` | EUI-64 | `58A0CB0000102AFC` |
| Your device | *check vendor docs* | *varies* | — |

The Robot's extraction function maps this vendor-specific field to Microshare's standard `meta.iot.device_id`. This is the **NetworkServer job** — and the first thing to get right.

## The device.uuid on the Physical Device

The device.uuid isn't just a data field — it's physically printed or encoded on every device, typically as a QR code or barcode. This is how devices get registered into device clusters during field installation.

<img src="images/deploy-m-screenshot.png" width="200" align="right" alt="Deploy-M app"/>

Microshare's [Deploy-M](https://play.google.com/store/apps/details?id=com.microshare.DeployM2) mobile app ([guide](https://docs.microshare.io/docs/2/installer/deploy-m/app-guide/)) scans the device.uuid from the physical label, reads the device ID and type, and registers it into the device cluster with location tags (building, floor, room) — completing the digital twin in seconds.

### QR Code Formats

<table>
<tr>
<td width="150" align="center">

<img src="images/qr-imei-example.png" width="120" alt="IMEI QR code"/><br/>
<b>Simple IMEI</b><br/>
<code>867280060123456</code>

</td>
<td width="150" align="center">

<img src="images/qr-lorawan-example.png" width="120" alt="LoRaWAN QR code"/><br/>
<b>LoRaWAN TR005</b><br/>
<code>LW:D0:DevEUI:...</code>

</td>
<td>

**Microshare QR** — devices sourced through Microshare ship with pre-printed labels that Deploy-M reads directly.

**LoRaWAN standard** — the [LoRa Alliance TR005](https://lora-alliance.org/wp-content/uploads/2020/11/TR005_LoRaWAN_Device_Identification_QR_Codes.pdf) spec encodes the DevEUI and join credentials in a standard format.

**Vendor-specific** — any proprietary QR format must be shared with Microshare to update Deploy-M's parser.

**Manual entry** — for devices without a supported QR code (e.g. cellular devices with a printed IMEI), the device.uuid can be typed into Deploy-M or registered via the Composer API.

</td>
</tr>
</table>
