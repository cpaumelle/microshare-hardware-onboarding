package io.microshare.stream.actors.Handlers.agent.events

import org.apache.pekko.actor.{ActorSystem, Props}
import org.apache.pekko.stream.Materializer
import io.microshare.services.RemoteShareServices
import io.microshare.stream.actors.Writers.CloudEventWriter
import io.microshare.stream.models.DeviceDescriptor
import spray.json._
import scala.concurrent.ExecutionContext
import scala.util.Try

/**
 * Traplinked Event Handler — generates rodent alerts from Traplinked snap trap events.
 *
 * Unlike RodentEventHandler (which uses 4-reading motion pattern analysis for
 * passive PIR sensors), this handler processes definitive event types from the
 * Traplinked API: catch_detected, trap_triggered, false_triggering, etc.
 *
 * Routing: matched by decoder name "com.traplinked.trap.JERRY.Decoder" in
 * AgentHandlerSupervisor, NOT by use_case SC05.
 *
 * Trigger: io.microshare.trap.unpacked (from Scala decoder)
 * Output:  io.microshare.event.alert.rodent
 */

// Source data extracted from Traplinked unpacked records
class TraplinkedDeviceSourceData(
  override val device_id: String,
  override val fcnt_up: Int,
  val trapEvent: String,
  val trap1: Boolean,
  val trap2: Boolean,
  val trapMode: String
) extends DeviceSourceData(device_id, fcnt_up)

object TraplinkedEventHandler {
  def props(descriptor: DeviceDescriptor)(implicit
    execution: ExecutionContext,
    actorSystem: ActorSystem,
    materializer: Materializer,
    eventWriter: CloudEventWriter,
    shareService: RemoteShareServices
  ): Props = {
    Props(new TraplinkedEventHandler(descriptor))
  }

  val AlertRecType = "io.microshare.event.alert.rodent"

  // Traplinked event → alert event mapping
  // All events that require a site visit or monitoring action
  val AlertEvents: Map[String, String] = Map(
    "catch_detected"    -> "rodent_caught",
    "trap_triggered"    -> "rodent_present",
    "false_triggering"  -> "trap_false_trigger",
    "infested"          -> "rodent_infestation",
    "light_infestation" -> "rodent_light_infestation",
    "severe_infestation"-> "rodent_severe_infestation",
    "activity_warning"  -> "rodent_activity_warning",
    "activity_critical" -> "rodent_activity_critical"
  )

  val Labels: Map[String, String] = Map(
    "rodent_caught"              -> "Rodent Caught",
    "rodent_present"             -> "Trap Triggered",
    "trap_false_trigger"         -> "False Trigger",
    "rodent_infestation"         -> "Infestation Detected",
    "rodent_light_infestation"   -> "Light Infestation",
    "rodent_severe_infestation"  -> "Severe Infestation",
    "rodent_activity_warning"    -> "Activity Warning",
    "rodent_activity_critical"   -> "Activity Critical"
  )
}

class TraplinkedEventHandler(descriptor: DeviceDescriptor)(implicit
  execution: ExecutionContext,
  actorSystem: ActorSystem,
  materializer: Materializer,
  eventWriter: CloudEventWriter,
  shareService: RemoteShareServices
) extends BaseEventHandler[TraplinkedDeviceSourceData](descriptor) {

  // Traplinked gives definitive events — no history needed
  override protected def requiresHistory(source: Source[TraplinkedDeviceSourceData]): Boolean = false

  override protected def getSourceDataFromRecord(record: JsObject): TraplinkedDeviceSourceData = {
    val baseData = super.getSourceDataFromRecord(record).asInstanceOf[DeviceSourceData]
    val dataObj = getData(record)

    val trapEvent = dataObj.fields.get("trap_event")
      .flatMap(_.convertTo[JsArray].elements.headOption)
      .flatMap(_.asJsObject.fields.get("value"))
      .map(_.convertTo[String])
      .getOrElse("")

    val trapArray = dataObj.fields.get("trap")
      .map(_.convertTo[JsArray].elements)
      .getOrElse(Vector.empty)

    val trap1 = trapArray.headOption
      .flatMap(_.asJsObject.fields.get("value"))
      .map(_.convertTo[Boolean])
      .getOrElse(false)

    val trap2 = trapArray.lift(1)
      .flatMap(_.asJsObject.fields.get("value"))
      .map(_.convertTo[Boolean])
      .getOrElse(false)

    val trapMode = dataObj.fields.get("trap_mode")
      .flatMap(_.convertTo[JsArray].elements.headOption)
      .flatMap(_.asJsObject.fields.get("value"))
      .map(_.convertTo[String])
      .getOrElse("unknown")

    new TraplinkedDeviceSourceData(
      baseData.device_id,
      baseData.fcnt_up,
      trapEvent,
      trap1,
      trap2,
      trapMode
    )
  }

  override protected def sourceDataToJsObject(data: TraplinkedDeviceSourceData): JsValue = {
    JsObject(
      "device_id" -> JsString(data.device_id),
      "fcnt_up" -> JsNumber(data.fcnt_up),
      "trap_event" -> JsString(data.trapEvent),
      "trap_1" -> JsBoolean(data.trap1),
      "trap_2" -> JsBoolean(data.trap2)
    )
  }

  override protected def processMessage(
    newSource: Source[TraplinkedDeviceSourceData],
    historySources: List[Source[TraplinkedDeviceSourceData]],
    rootObj: JsObject
  ): Int = {
    try {
      val trapEvent = newSource.data.trapEvent
      val alertEvent = TraplinkedEventHandler.AlertEvents.get(trapEvent)

      alertEvent match {
        case None =>
          // Non-alertable event (rearmed, etc.) — skip
          addToProcessedMap(
            this.getClass.getSimpleName,
            "skipped",
            s"${newSource.data.device_id} / ${newSource.id}: non-alertable event '$trapEvent'"
          )
          0

        case Some(event) =>
          // Build label with trap info
          val firedTraps = List(
            if (newSource.data.trap1) Some("Trap 1") else None,
            if (newSource.data.trap2) Some("Trap 2") else None
          ).flatten
          val trapSuffix = if (firedTraps.nonEmpty) s" (${firedTraps.mkString(", ")})" else ""
          val label = TraplinkedEventHandler.Labels.getOrElse(event, "Alert") + trapSuffix

          // Build alert data
          val alertObj = buildAlertData(
            1,    // sum
            0,    // history
            event,
            Some(label),
            Some("rodent"),
            Some("pest")
          )

          // Write the alert
          writeRecord(
            TraplinkedEventHandler.AlertRecType,
            alertObj,
            List(newSource),
            rootObj
          )

          addToProcessedMap(
            this.getClass.getSimpleName,
            "success",
            s"${newSource.data.device_id} / ${newSource.id}: $event alert generated for '$trapEvent'"
          )
          1
      }
    } catch {
      case ex: Exception =>
        addToProcessedMap(
          this.getClass.getSimpleName,
          "error",
          s"${newSource.data.device_id} / ${newSource.id} Exception: ${ex.getMessage}"
        )
        0
    }
  }
}
