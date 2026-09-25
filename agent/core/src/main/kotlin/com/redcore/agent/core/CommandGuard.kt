package com.redcore.agent.core

import java.time.Instant

/** Remembers executed command ids so a replayed command is never run twice. */
interface ExecutedCommandLog {
    fun contains(id: String): Boolean
    fun add(id: String)
}

/** Bounded in-memory log; the app persists the same ids across restarts. */
class BoundedCommandLog(private val capacity: Int = 500, initial: Collection<String> = emptyList()) : ExecutedCommandLog {
    private val ids = LinkedHashSet<String>(initial.toList().takeLast(capacity))
    override fun contains(id: String) = id in ids
    override fun add(id: String) {
        ids.remove(id)
        ids.add(id)
        while (ids.size > capacity) ids.remove(ids.first())
    }
    fun snapshot(): List<String> = ids.toList()
}

sealed interface Verdict<out T> {
    data class Accepted<T>(val value: T) : Verdict<T>
    data class Rejected(val reason: String) : Verdict<Nothing>
}

/**
 * Every server message passes through here before the agent acts on it:
 * signature, device binding, expiry, replay and version monotonicity.
 */
class CommandGuard(
    private val deviceId: String,
    private val verifier: EnvelopeVerifier,
    private val executed: ExecutedCommandLog,
    private val clock: () -> Instant = Instant::now,
) {
    fun checkCommand(signed: Signed): Verdict<CommandEnvelope> {
        if (!verifier.verify(signed.envelope, signed.signature)) return Verdict.Rejected("bad_signature")
        val env = try {
            RedcoreJson.decodeFromString(CommandEnvelope.serializer(), signed.envelope)
        } catch (e: Exception) {
            return Verdict.Rejected("malformed")
        }
        if (env.kind != "command") return Verdict.Rejected("wrong_kind")
        if (env.deviceId != deviceId) return Verdict.Rejected("wrong_device")
        val expires = runCatching { Instant.parse(env.expiresAt) }.getOrNull() ?: return Verdict.Rejected("malformed")
        if (!clock().isBefore(expires)) return Verdict.Rejected("expired")
        if (executed.contains(env.id)) return Verdict.Rejected("replayed")
        return Verdict.Accepted(env)
    }

    /** Accepts a signed full state only if it is newer than what is already applied (anti-rollback). */
    fun checkState(signed: Signed, appliedVersion: Int): Verdict<StateEnvelope> {
        if (!verifier.verify(signed.envelope, signed.signature)) return Verdict.Rejected("bad_signature")
        val env = try {
            RedcoreJson.decodeFromString(StateEnvelope.serializer(), signed.envelope)
        } catch (e: Exception) {
            return Verdict.Rejected("malformed")
        }
        if (env.kind != "state") return Verdict.Rejected("wrong_kind")
        if (env.deviceId != deviceId) return Verdict.Rejected("wrong_device")
        if (env.version != env.state.version) return Verdict.Rejected("malformed")
        if (env.version <= appliedVersion) return Verdict.Rejected("stale")
        return Verdict.Accepted(env)
    }

    /** APPLY_STATE commands carry a full state; the same anti-rollback rule applies. */
    fun stateFromCommand(env: CommandEnvelope, appliedVersion: Int): Verdict<DesiredState> {
        val stateJson = env.payload["state"] ?: return Verdict.Rejected("malformed")
        val state = try {
            RedcoreJson.decodeFromJsonElement(DesiredState.serializer(), stateJson)
        } catch (e: Exception) {
            return Verdict.Rejected("malformed")
        }
        if (state.version <= appliedVersion) return Verdict.Rejected("stale")
        return Verdict.Accepted(state)
    }
}
