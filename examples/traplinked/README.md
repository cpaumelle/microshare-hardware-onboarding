# Traplinked JERRY — Hardware Onboarding

Onboarding the [Traplinked](https://docs.traplinked.com/rest/) JERRY snap trap into the Microshare pest management platform.

## Two-Stage Approach

### Stage 1: Dev / Evaluation (Robot-only)

Everything runs in Composer — no Scala, no platform deployment. Deploy in minutes, test with real hardware immediately.

```
Traplinked API  ──poll──>  Poller Robot  ──write──>  traplinked.packed
                                │                    trap.unpacked
                                │                    device.health
                                │
                           Alert Generator Robot  ──>  event.alert.rodent
                                                          │
                                                   ES Pest Bundler  ──>  incident
```

**Two Robots:**
- **Poller Robot** (scheduled 60s) — polls Traplinked API, writes packed + unpacked + health
- **Alert Generator Robot** (triggered) — converts trap events into rodent alerts

See [`stage1-dev/`](stage1-dev/) for code, setup, and deployment instructions.

### Stage 2: Production (Scala pipeline)

The Poller Robot stays (it replaces the LoRaWAN network server). The Scala pipeline replaces the unpacking, health, and alert generation.

```
Traplinked API  ──poll──>  Poller Robot  ──write──>  traplinked.packed
                                                          │
                                                   Scala Decoder  ──>  trap.unpacked
                                                          │               device.health
                                                          │
                                                   Scala EventHandler  ──>  event.alert.rodent
                                                                               │
                                                                        ES Pest Bundler  ──>  incident
```

**Components:**
- **Poller Robot** (scheduled 60s) — writes packed only
- **TraplinkedDecoder.scala** — maps packed → unpacked + health
- **TraplinkedEventHandler.scala** — generates alerts from trap events

See [`stage2-prod/`](stage2-prod/) for Scala code, device cluster config, and migration guide.

## Device

The **JERRY** is a WiFi/LoRa snap trap with two independent traps per unit. Traplinked devices communicate through their own cloud platform — the LoRaWAN layer is fully abstracted behind their REST API.

Device types: JERRY, JERRY_LORA, TRAPME, TOM, TRAPSENSOR.

## Record Types

| recType | Written by | Purpose |
|---|---|---|
| `io.microshare.traplinked.packed` | Poller Robot | Raw Traplinked API data |
| `io.microshare.trap.unpacked` | Robot (Stage 1) or Decoder (Stage 2) | Standard unpacked record |
| `io.microshare.device.health` | Robot (Stage 1) or Decoder (Stage 2) | Battery, voltage, last seen |
| `io.microshare.event.alert.rodent` | Alert Robot (Stage 1) or EventHandler (Stage 2) | Rodent alerts |

## Event Types

| Traplinked event | Alert event | Action |
|---|---|---|
| `catch_detected` | `rodent_caught` | Site visit: retrieve + rearm |
| `trap_triggered` | `rodent_present` | Site visit: check + rearm |
| `false_triggering` | `trap_false_trigger` | Site visit: rearm |
| `infested` | `rodent_infestation` | Monitoring alert |
| `light_infestation` | `rodent_light_infestation` | Monitoring alert |
| `severe_infestation` | `rodent_severe_infestation` | Urgent response |
| `activity_warning` | `rodent_activity_warning` | Threshold warning |
| `activity_critical` | `rodent_activity_critical` | Threshold critical |
| `rearmed` | — | No alert (no action needed) |

## Unpacked Record Structure

See [unpacked-example.json](unpacked-example.json) for a full example.
