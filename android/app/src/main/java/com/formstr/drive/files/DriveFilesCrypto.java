package com.formstr.drive.files;

import android.util.Base64;

import org.bouncycastle.asn1.sec.SECNamedCurves;
import org.bouncycastle.asn1.x9.X9ECParameters;
import org.bouncycastle.math.ec.ECPoint;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.Arrays;

import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

public final class DriveFilesCrypto {
    private static final byte PAYLOAD_VERSION = 2;
    /** v3 chunk format: salt is not stored — re-derived from the chunk index on decrypt. */
    private static final byte PAYLOAD_VERSION_V3 = 3;
    private static final int PAYLOAD_NONCE_LENGTH = 32;
    private static final int MESSAGE_KEY_LENGTH = 44;
    private static final byte[] NIP44_INFO = "nip44-v2".getBytes(StandardCharsets.UTF_8);
    private static final int SEGMENT_NONCE_LENGTH = 12;
    private static final int SEGMENT_TAG_LENGTH_BITS = 128;

    private DriveFilesCrypto() {
    }

    public static byte[] decryptEncryptedBlob(byte[] encryptedBlob, String privateKeyHex)
            throws GeneralSecurityException {
        byte[] conversationKey = deriveConversationKey(privateKeyHex);
        String ciphertext = new String(encryptedBlob, StandardCharsets.UTF_8);
        String plaintextBase64 = decryptPayload(ciphertext, conversationKey);

        try {
            return Base64.decode(plaintextBase64, Base64.DEFAULT);
        } catch (IllegalArgumentException error) {
            throw new GeneralSecurityException("Failed to decode decrypted file payload", error);
        }
    }

    /**
     * Decrypts one Blossom chunk blob. Two formats exist and they differ in more
     * than a version byte, so the branches must not share a code path:
     *
     *  - v2 (current, produced by src/crypto.ts's aesGcmEncryptRaw):
     *    {@code 0x02 || nonce(32) || ciphertext}. The stored nonce is the HKDF
     *    salt and there is NO additional authenticated data. This is the exact
     *    same blob layout NIP-44 v2 uses for event content — the chunk path just
     *    skips the base64 layer.
     *  - v3 (legacy, written by older builds): the salt was derived from the
     *    chunk index rather than stored, and the index was also fed in as GCM
     *    AAD. Kept so files uploaded before the format change stay readable.
     *
     * Applying the v3 AAD to a v2 blob fails the GCM tag check, which is why
     * this is version-gated rather than unconditional.
     */
    public static byte[] decryptChunkBlob(byte[] rawBlob, String privateKeyHex, int chunkIndex)
            throws GeneralSecurityException {
        byte[] conversationKey = deriveConversationKey(privateKeyHex);

        if (rawBlob.length < 2) {
            throw new GeneralSecurityException("Encrypted chunk payload is too short");
        }

        byte version = rawBlob[0];
        byte[] salt;
        byte[] ciphertext;
        byte[] additionalData = null;

        if (version == PAYLOAD_VERSION) {
            if (rawBlob.length <= PAYLOAD_NONCE_LENGTH + 1) {
                throw new GeneralSecurityException("Encrypted chunk payload is too short");
            }
            salt = Arrays.copyOfRange(rawBlob, 1, 1 + PAYLOAD_NONCE_LENGTH);
            ciphertext = Arrays.copyOfRange(rawBlob, 1 + PAYLOAD_NONCE_LENGTH, rawBlob.length);
        } else if (version == PAYLOAD_VERSION_V3) {
            additionalData = chunkIndexBytes(chunkIndex);
            salt = hmacSha256(conversationKey, additionalData);
            ciphertext = Arrays.copyOfRange(rawBlob, 1, rawBlob.length);
        } else {
            throw new GeneralSecurityException("Unsupported encrypted payload version");
        }

        byte[] expandedKeys = hkdfSha256(conversationKey, salt, NIP44_INFO, MESSAGE_KEY_LENGTH);
        byte[] aesKey = Arrays.copyOfRange(expandedKeys, 0, 32);
        byte[] aesNonce = Arrays.copyOfRange(expandedKeys, 32, 44);

        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(
                Cipher.DECRYPT_MODE,
                new SecretKeySpec(aesKey, "AES"),
                new GCMParameterSpec(128, aesNonce));

        if (additionalData != null) {
            cipher.updateAAD(additionalData);
        }

        return cipher.doFinal(ciphertext);
    }

    /**
     * NIP-FS single-blob segment decryption (mirrors crypto.ts's
     * decryptSegment exactly): AES-256-GCM directly under the file's
     * conversationKey (deriveConversationKey's output used AS the raw
     * 32-byte AES key — no HKDF expansion, unlike decryptChunkBlob above).
     * The nonce is computed, never stored: 11-byte big-endian segment index,
     * then a 1-byte last-segment flag (1 on the final segment, 0 otherwise).
     * Payload is {@code ciphertext || tag(16)} — no version byte.
     *
     * `segmentIndex`/`isLast` MUST match what the segment was encrypted
     * with. Getting either wrong recomputes the wrong nonce, which fails the
     * GCM tag check by design — see buildSegmentNonce for why: this is what
     * makes a reordered or truncated segment detectable rather than silently
     * decrypting to garbage or returning a short file.
     */
    public static byte[] decryptSegment(byte[] payload, String privateKeyHex, long segmentIndex, boolean isLast)
            throws GeneralSecurityException {
        byte[] conversationKey = deriveConversationKey(privateKeyHex);
        byte[] nonce = buildSegmentNonce(segmentIndex, isLast);

        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(
                Cipher.DECRYPT_MODE,
                new SecretKeySpec(conversationKey, "AES"),
                new GCMParameterSpec(SEGMENT_TAG_LENGTH_BITS, nonce));

        return cipher.doFinal(payload);
    }

    /**
     * Mirrors crypto.ts's buildSegmentNonce exactly. Uses {@code long} (not
     * {@code int}) for the index: a large file at the default 64 KiB
     * chunkSize can exceed Integer.MAX_VALUE segments well before the
     * 11-byte encoding limit this throws on.
     */
    private static byte[] buildSegmentNonce(long segmentIndex, boolean isLast) throws GeneralSecurityException {
        if (segmentIndex < 0) {
            throw new GeneralSecurityException("Segment index must be non-negative, got " + segmentIndex);
        }
        byte[] nonce = new byte[SEGMENT_NONCE_LENGTH];
        long remaining = segmentIndex;
        for (int i = 10; i >= 0; i--) {
            nonce[i] = (byte) (remaining & 0xFF);
            remaining >>>= 8;
        }
        if (remaining != 0) {
            throw new GeneralSecurityException("Segment index too large to encode in 11 bytes: " + segmentIndex);
        }
        nonce[11] = (byte) (isLast ? 1 : 0);
        return nonce;
    }

    /** Big-endian 4-byte chunk index — the v3 salt seed and AAD. */
    private static byte[] chunkIndexBytes(int chunkIndex) {
        return new byte[] {
                (byte) ((chunkIndex >> 24) & 0xFF),
                (byte) ((chunkIndex >> 16) & 0xFF),
                (byte) ((chunkIndex >> 8) & 0xFF),
                (byte) (chunkIndex & 0xFF),
        };
    }

    private static byte[] deriveConversationKey(String privateKeyHex) throws GeneralSecurityException {
        byte[] privateKeyBytes = hexToBytes(privateKeyHex);
        BigInteger privateKey = new BigInteger(1, privateKeyBytes);
        X9ECParameters parameters = SECNamedCurves.getByName("secp256k1");

        ECPoint publicPoint = parameters.getG().multiply(privateKey).normalize();
        ECPoint sharedPoint = publicPoint.multiply(privateKey).normalize();
        byte[] sharedX = toFixedLength(sharedPoint.getAffineXCoord().getEncoded(), 32);

        return hmacSha256(NIP44_INFO, sharedX);
    }

    private static String decryptPayload(String payload, byte[] conversationKey)
            throws GeneralSecurityException {
        byte[] decodedPayload;
        try {
            decodedPayload = Base64.decode(payload, Base64.DEFAULT);
        } catch (IllegalArgumentException error) {
            throw new GeneralSecurityException("Invalid encrypted payload", error);
        }

        if (decodedPayload.length <= PAYLOAD_NONCE_LENGTH + 1) {
            throw new GeneralSecurityException("Encrypted payload is too short");
        }

        if (decodedPayload[0] != PAYLOAD_VERSION) {
            throw new GeneralSecurityException("Unsupported encrypted payload version");
        }

        byte[] nonce = Arrays.copyOfRange(decodedPayload, 1, 1 + PAYLOAD_NONCE_LENGTH);
        byte[] ciphertext = Arrays.copyOfRange(decodedPayload, 1 + PAYLOAD_NONCE_LENGTH, decodedPayload.length);

        byte[] expandedKeys = hkdfSha256(conversationKey, nonce, NIP44_INFO, MESSAGE_KEY_LENGTH);
        byte[] aesKey = Arrays.copyOfRange(expandedKeys, 0, 32);
        byte[] aesNonce = Arrays.copyOfRange(expandedKeys, 32, 44);

        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(
                Cipher.DECRYPT_MODE,
                new SecretKeySpec(aesKey, "AES"),
                new GCMParameterSpec(128, aesNonce));

        byte[] plaintext = cipher.doFinal(ciphertext);
        return new String(plaintext, StandardCharsets.UTF_8);
    }

    private static byte[] hkdfSha256(byte[] ikm, byte[] salt, byte[] info, int length)
            throws GeneralSecurityException {
        byte[] pseudorandomKey = hmacSha256(salt, ikm);
        byte[] output = new byte[length];
        byte[] previousBlock = new byte[0];
        int offset = 0;
        int blockIndex = 1;

        while (offset < length) {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(pseudorandomKey, "HmacSHA256"));
            mac.update(previousBlock);
            mac.update(info);
            mac.update((byte) blockIndex);

            previousBlock = mac.doFinal();
            int copyLength = Math.min(previousBlock.length, length - offset);
            System.arraycopy(previousBlock, 0, output, offset, copyLength);
            offset += copyLength;
            blockIndex += 1;
        }

        return output;
    }

    private static byte[] hmacSha256(byte[] key, byte[] data) throws GeneralSecurityException {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key, "HmacSHA256"));
        return mac.doFinal(data);
    }

    private static String bytesToHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            sb.append(String.format("%02x", b));
        }
        return sb.toString();
    }

    private static byte[] hexToBytes(String hex) {
        String normalizedHex = hex == null ? "" : hex.trim();
        if (normalizedHex.length() % 2 != 0) {
            throw new IllegalArgumentException("Private key hex must have even length");
        }

        byte[] bytes = new byte[normalizedHex.length() / 2];
        for (int index = 0; index < normalizedHex.length(); index += 2) {
            bytes[index / 2] = (byte) Integer.parseInt(
                    normalizedHex.substring(index, index + 2),
                    16);
        }
        return bytes;
    }

    private static byte[] toFixedLength(byte[] bytes, int length) {
        if (bytes.length == length) {
            return bytes;
        }

        if (bytes.length > length) {
            return Arrays.copyOfRange(bytes, bytes.length - length, bytes.length);
        }

        byte[] padded = new byte[length];
        System.arraycopy(bytes, 0, padded, length - bytes.length, bytes.length);
        return padded;
    }
}
