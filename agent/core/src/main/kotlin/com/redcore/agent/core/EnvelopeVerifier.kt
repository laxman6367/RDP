package com.redcore.agent.core

import java.security.KeyFactory
import java.security.PublicKey
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.Base64

/**
 * Verifies server-signed envelopes (spec §10 "Signed commands; agent verifies
 * command origin"). The backend signs the exact UTF-8 envelope bytes with
 * ECDSA P-256 / SHA-256 and sends a DER signature, which is what Java's
 * `SHA256withECDSA` produces and expects on every Android version.
 */
class EnvelopeVerifier(publicKeySpkiBase64: String) {
    private val key: PublicKey = KeyFactory.getInstance("EC")
        .generatePublic(X509EncodedKeySpec(Base64.getDecoder().decode(publicKeySpkiBase64.trim())))

    fun verify(envelope: String, signatureBase64: String): Boolean = try {
        Signature.getInstance("SHA256withECDSA").run {
            initVerify(key)
            update(envelope.toByteArray(Charsets.UTF_8))
            verify(Base64.getDecoder().decode(signatureBase64))
        }
    } catch (e: Exception) {
        // Malformed signature or base64 is a failed verification, never a crash.
        false
    }
}
