package com.redcore.agent.core

import java.security.KeyPairGenerator
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.time.Instant
import java.util.Base64
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

class EnvelopeVerifierTest {
    // Produced by the backend's CommandSigner (Node.js crypto), so this proves wire compatibility.
    private val serverPub =
        "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEkLY4hnHmVbUNKzjQr80iIJJC6E/kX1kU6FF4rbiHs3ZVfE4SKKOPKAgg1StdpAMCMMXeyIKUfaoyINOWvsJkDg=="
    private val serverEnv =
        """{"v":1,"kind":"command","id":"c0ffee00-0000-4000-8000-000000000001","deviceId":"dev-1","type":"SHOW_MESSAGE","payload":{"text":"Hello from Redcore"},"issuedAt":"2026-01-01T00:00:00.000Z","expiresAt":"2099-01-01T00:00:00.000Z"}"""
    private val serverSig = "MEYCIQCeufdNF0EieXO/YUvC5HVrPKnyO7yymwYREjMSUefJEwIhAPS2vf5tAHR+gXX3gUaR1nNhNlXQJj4bonxlndzLCcgm"

    @Test
    fun `verifies a signature produced by the backend`() {
        assertTrue(EnvelopeVerifier(serverPub).verify(serverEnv, serverSig))
    }

    @Test
    fun `rejects tampered envelopes and garbage signatures`() {
        val v = EnvelopeVerifier(serverPub)
        assertFalse(v.verify(serverEnv.replace("dev-1", "dev-2"), serverSig))
        assertFalse(v.verify(serverEnv, "not-base64!!"))
        assertFalse(v.verify(serverEnv, Base64.getEncoder().encodeToString(ByteArray(70))))
    }

    @Test
    fun `guard accepts a valid command once and rejects replays, other devices and expiry`() {
        val log = BoundedCommandLog()
        val guard = CommandGuard("dev-1", EnvelopeVerifier(serverPub), log)
        val signed = Signed(serverEnv, serverSig)
        val ok = guard.checkCommand(signed)
        assertIs<Verdict.Accepted<CommandEnvelope>>(ok)
        assertEquals("SHOW_MESSAGE", ok.value.type)
        log.add(ok.value.id)
        assertEquals(Verdict.Rejected("replayed"), guard.checkCommand(signed))

        val other = CommandGuard("dev-2", EnvelopeVerifier(serverPub), BoundedCommandLog())
        assertEquals(Verdict.Rejected("wrong_device"), other.checkCommand(signed))

        val future = CommandGuard("dev-1", EnvelopeVerifier(serverPub), BoundedCommandLog()) { Instant.parse("2100-01-01T00:00:00Z") }
        assertEquals(Verdict.Rejected("expired"), future.checkCommand(signed))
        assertEquals(Verdict.Rejected("bad_signature"), guard.checkCommand(Signed(serverEnv.replace("Hello", "Howdy"), serverSig)))
    }

    @Test
    fun `state envelopes must be newer than the applied version`() {
        val kp = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        fun sign(s: String) = Base64.getEncoder().encodeToString(
            Signature.getInstance("SHA256withECDSA").run { initSign(kp.private); update(s.toByteArray()); sign() },
        )
        val pub = Base64.getEncoder().encodeToString(kp.public.encoded)
        val env = """{"v":1,"kind":"state","deviceId":"dev-1","version":3,"state":{"version":3,"phase":2,"kiosk":{"mode":"none","allowlist":[],"source":"none"},"wallpaper":null,"policy":null,"userRestrictions":["no_factory_reset"],"notice":null,"released":false,"futureField":1},"issuedAt":"2026-01-01T00:00:00Z"}"""
        val guard = CommandGuard("dev-1", EnvelopeVerifier(pub), BoundedCommandLog())
        val ok = guard.checkState(Signed(env, sign(env)), appliedVersion = 2)
        assertIs<Verdict.Accepted<StateEnvelope>>(ok)
        assertEquals(listOf("no_factory_reset"), ok.value.state.userRestrictions)
        assertEquals(Verdict.Rejected("stale"), guard.checkState(Signed(env, sign(env)), appliedVersion = 3))
    }

    @Test
    fun `bounded log evicts the oldest ids`() {
        val log = BoundedCommandLog(capacity = 2)
        listOf("a", "b", "c").forEach(log::add)
        assertFalse(log.contains("a"))
        assertEquals(listOf("b", "c"), log.snapshot())
    }
}
