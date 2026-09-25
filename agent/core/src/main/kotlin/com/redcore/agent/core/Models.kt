package com.redcore.agent.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

/** Mirrors backend `DesiredState` (backend/src/domain/desired-state.ts). Unknown fields are ignored. */
@Serializable
data class DesiredState(
    val version: Int,
    val phase: Int,
    val kiosk: KioskOverride,
    val wallpaper: WallpaperState? = null,
    val policy: PolicyRef? = null,
    val userRestrictions: List<String> = emptyList(),
    val notice: DeviceNotice? = null,
    val released: Boolean = false,
)

@Serializable
data class KioskOverride(
    val mode: String,
    val allowlist: List<String> = emptyList(),
    val message: String? = null,
    val supportContact: String? = null,
    val paymentUrl: String? = null,
    val amountDue: AmountDue? = null,
    val source: String = "none",
)

@Serializable
data class AmountDue(val amount: Double, val currency: String, val dueDate: String)

@Serializable
data class WallpaperState(
    val wallpaperId: String,
    val path: String,
    val sha256: String,
    val target: String,
    val lockChange: Boolean,
    val source: String = "admin",
)

@Serializable
data class DeviceNotice(
    val kind: String,
    val title: String,
    val body: String,
    val dueDate: String? = null,
    val amount: Double? = null,
    val currency: String? = null,
)

@Serializable
data class PolicyRef(val id: String, val version: Int, val spec: JsonObject)

@Serializable
data class StateEnvelope(
    val v: Int,
    val kind: String,
    val deviceId: String,
    val version: Int,
    val state: DesiredState,
    val issuedAt: String,
)

@Serializable
data class CommandEnvelope(
    val v: Int,
    val kind: String,
    val id: String,
    val deviceId: String,
    val type: String,
    val payload: JsonObject,
    val issuedAt: String,
    val expiresAt: String,
)

/** What the server sends: the exact signed bytes plus a base64 DER signature. */
@Serializable
data class Signed(val envelope: String, val signature: String)

@Serializable
data class TransparencyItem(val key: String, val title: String, val detail: String)

@Serializable
data class TransparencyReport(
    val managedBy: String,
    val organization: String,
    val organizationType: String,
    val headline: String,
    val items: List<TransparencyItem>,
)

val RedcoreJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = true
}
