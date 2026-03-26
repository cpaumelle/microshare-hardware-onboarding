package com.traplinked.trap.JERRY

import spray.json._
import scala.util.Try

/**
 * Traplinked JERRY Decoder — maps packed Traplinked API data to Microshare unpacked format.
 *
 * Input: JSON payload from meta.iot.payload containing:
 *   - device: { serial_number, name, type, status, battery_status, transfer_mode,
 *               operation_mode, last_heartbeat, location, trap_1, trap_2 }
 *   - report: { type, timestamp, user, description }
 *
 * Output tuple:
 *   _1: Telematics (sensor data) → written to io.microshare.trap.unpacked
 *   _2: Device health → written to io.microshare.device.health
 *
 * Naming convention: com.traplinked.trap.JERRY.Decoder
 * (matches io.tracknet.motion.TBMS100.Decoder, com.tactacam.camera.REVEAL6.Decoder)
 *
 * Device cluster config:
 *   meta.unpacker = "com.traplinked.trap.JERRY.Decoder"
 *   meta.type     = "com.traplinked.trap.JERRY.Decoder"
 */
object Decoder {

  // Report type → event name mapping
  val ReportNames: Map[Int, String] = Map(
    2  -> "trap_triggered",
    3  -> "rearmed",
    14 -> "infested",
    15 -> "light_infestation",
    16 -> "severe_infestation",
    17 -> "false_triggering",
    18 -> "activity_warning",
    19 -> "activity_critical",
    20 -> "catch_detected"
  )

  // Device type → name mapping
  val DeviceTypes: Map[Int, String] = Map(
    0 -> "JERRY",
    1 -> "JERRY_LORA",
    2 -> "TRAPME",
    3 -> "TOM",
    4 -> "TRAPSENSOR"
  )

  // Operation mode → name mapping
  val OpModes: Map[Int, String] = Map(
    0 -> "snaptrap",
    1 -> "movement",
    2 -> "insect"
  )

  /**
   * Decode the packed payload into (telematics, health) tuple.
   *
   * @param payloadJson JSON string from meta.iot.payload
   * @return (Option[JsObject], Option[JsObject]) — telematics and health
   */
  def execute2(payloadJson: String): (Option[JsObject], Option[JsObject]) = {
    Try {
      val payload = payloadJson.parseJson.asJsObject
      val device = payload.fields("device").asJsObject
      val report = payload.fields("report").asJsObject

      val telematics = buildTelematics(device, report)
      val health = buildHealth(device)

      (Some(telematics), Some(health))
    }.getOrElse((None, None))
  }

  private def buildTelematics(device: JsObject, report: JsObject): JsObject = {
    val reportType = report.fields("type").convertTo[Int]
    val reportName = ReportNames.getOrElse(reportType, s"type_$reportType")

    val deviceType = device.fields.get("type").map(_.convertTo[Int]).getOrElse(0)
    val opMode = device.fields.get("operation_mode").map(_.convertTo[Int]).getOrElse(0)
    val trap1 = device.fields.get("trap_1").map(_.convertTo[Boolean]).getOrElse(false)
    val trap2 = device.fields.get("trap_2").map(_.convertTo[Boolean]).getOrElse(false)

    JsObject(
      // Sensor fields — Microshare data dictionary
      "trap" -> JsArray(
        JsObject("value" -> JsBoolean(trap1), "context" -> JsString("Trap 1")),
        JsObject("value" -> JsBoolean(trap2), "context" -> JsString("Trap 2"))
      ),
      "trap_event" -> JsArray(
        JsObject("value" -> JsString(reportName))
      ),
      "trap_mode" -> JsArray(
        JsObject("value" -> JsString(OpModes.getOrElse(opMode, "unknown")))
      ),

      // Origin — full vendor data preserved
      "origin" -> JsObject(
        "traplinked" -> JsObject(
          "serial_number" -> device.fields.getOrElse("serial_number", JsNull),
          "name" -> device.fields.getOrElse("name", JsNull),
          "device_type" -> JsString(DeviceTypes.getOrElse(deviceType, s"type_$deviceType")),
          "report_type" -> JsNumber(reportType),
          "report_name" -> JsString(reportName),
          "report_user" -> report.fields.getOrElse("user", JsNull),
          "report_description" -> report.fields.getOrElse("description", JsNull),
          "status" -> device.fields.getOrElse("status", JsNull),
          "transfer_mode" -> device.fields.getOrElse("transfer_mode", JsNull),
          "operation_mode" -> device.fields.getOrElse("operation_mode", JsNull),
          "last_heartbeat" -> device.fields.getOrElse("last_heartbeat", JsNull),
          "location" -> device.fields.getOrElse("location", JsNull)
        )
      )
    )
  }

  private def buildHealth(device: JsObject): JsObject = {
    val serialNumber = device.fields.get("serial_number").map(_.convertTo[String]).getOrElse("")
    val batteryStatus = device.fields.get("battery_status").map(_.convertTo[Double]).getOrElse(0.0)
    val batteryPercent = Math.round(batteryStatus * 100).toInt
    // Derive voltage: 0.0 → 2.4V, 1.0 → 3.6V (typical LiSOCl2 range)
    val derivedVoltage = Math.round((batteryStatus * 1.2 + 2.4) * 10.0) / 10.0

    JsObject(
      "id" -> JsString(serialNumber),
      "charge" -> JsArray(JsObject("unit" -> JsString("%"), "value" -> JsNumber(batteryPercent))),
      "voltage" -> JsArray(JsObject("unit" -> JsString("V"), "value" -> JsNumber(derivedVoltage))),
      "temperature" -> JsArray(JsObject("unit" -> JsString("°C"), "value" -> JsNull))
    )
  }
}
