package com.formstr.drive.files;

import android.util.Base64;

import org.bouncycastle.asn1.sec.SECNamedCurves;
import org.bouncycastle.asn1.x9.X9ECParameters;
import org.bouncycastle.crypto.engines.ChaCha7539Engine;
import org.bouncycastle.crypto.params.KeyParameter;
import org.bouncycastle.crypto.params.ParametersWithIV;
import org.bouncycastle.math.ec.ECPoint;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.Arrays;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

public final class DriveFilesCrypto {
    private static final byte PAYLOAD_VERSION = 2;
    private static final int PAYLOAD_NONCE_LENGTH = 32;
    private static final int MESSAGE_KEY_TOTAL = 76; // 32 enc_key + 12 enc_nonce + 32 auth_key
    private static final byte[] NIP44_INFO = "nip44-v2".getBytes(StandardCharsets.UTF_8);

    private DriveFilesCrypto() {}

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

    private static byte[] deriveConversationKey(String privateKeyHex) throws GeneralSecurityException {
        byte[] privateKeyBytes = hexToBytes(privateKeyHex);
        BigInteger privateKey = new BigInteger(1, privateKeyBytes);
        X9ECParameters parameters = SECNamedCurves.getByName("secp256k1");

        ECPoint publicPoint = parameters.getG().multiply(privateKey).normalize();
        ECPoint sharedPoint = publicPoint.multiply(privateKey).normalize();
        byte[] sharedX = toFixedLength(sharedPoint.getAffineXCoord().getEncoded(), 32);

        // NIP-44: hkdf_extract(sha256, sharedX, salt="nip44-v2") = HMAC-SHA256(key="nip44-v2", data=sharedX)
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

        // Minimum: version(1) + nonce(32) + 1 byte ciphertext + mac(32)
        if (decodedPayload.length < 1 + PAYLOAD_NONCE_LENGTH + 1 + 32) {
            throw new GeneralSecurityException("Encrypted payload is too short");
        }

        if (decodedPayload[0] != PAYLOAD_VERSION) {
            throw new GeneralSecurityException("Unsupported encrypted payload version");
        }

        byte[] nonce = Arrays.copyOfRange(decodedPayload, 1, 1 + PAYLOAD_NONCE_LENGTH);
        byte[] ciphertext = Arrays.copyOfRange(decodedPayload, 1 + PAYLOAD_NONCE_LENGTH, decodedPayload.length - 32);
        byte[] mac = Arrays.copyOfRange(decodedPayload, decodedPayload.length - 32, decodedPayload.length);

        // NIP-44 getMessageKeys: hkdf_expand(prk=conversationKey, info=nonce, length=76)
        byte[] expandedKeys = hkdfExpand(conversationKey, nonce, MESSAGE_KEY_TOTAL);
        byte[] encKey = Arrays.copyOfRange(expandedKeys, 0, 32);
        byte[] encNonce = Arrays.copyOfRange(expandedKeys, 32, 44);
        byte[] authKey = Arrays.copyOfRange(expandedKeys, 44, 76);

        // Verify MAC: HMAC-SHA256(key=authKey, data=concat(nonce, ciphertext))
        Mac hmacMac = Mac.getInstance("HmacSHA256");
        hmacMac.init(new SecretKeySpec(authKey, "HmacSHA256"));
        hmacMac.update(nonce);
        byte[] expectedMac = hmacMac.doFinal(ciphertext);
        if (!constantTimeEquals(expectedMac, mac)) {
            throw new GeneralSecurityException("MAC verification failed");
        }

        // Decrypt with ChaCha20 (IETF variant, 12-byte nonce)
        ChaCha7539Engine engine = new ChaCha7539Engine();
        engine.init(false, new ParametersWithIV(new KeyParameter(encKey), encNonce));
        byte[] plaintext = new byte[ciphertext.length];
        engine.processBytes(ciphertext, 0, ciphertext.length, plaintext, 0);

        return new String(plaintext, StandardCharsets.UTF_8);
    }

    // HKDF-Expand only (RFC 5869 section 2.3), no extract step
    private static byte[] hkdfExpand(byte[] prk, byte[] info, int length)
            throws GeneralSecurityException {
        byte[] output = new byte[length];
        byte[] previousBlock = new byte[0];
        int offset = 0;
        int blockIndex = 1;

        while (offset < length) {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(prk, "HmacSHA256"));
            mac.update(previousBlock);
            mac.update(info);
            mac.update((byte) blockIndex);
            previousBlock = mac.doFinal();
            int copyLength = Math.min(previousBlock.length, length - offset);
            System.arraycopy(previousBlock, 0, output, offset, copyLength);
            offset += copyLength;
            blockIndex++;
        }
        return output;
    }

    private static byte[] hmacSha256(byte[] key, byte[] data) throws GeneralSecurityException {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key, "HmacSHA256"));
        return mac.doFinal(data);
    }

    private static boolean constantTimeEquals(byte[] a, byte[] b) {
        if (a.length != b.length) return false;
        int diff = 0;
        for (int i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
        return diff == 0;
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
                    16
            );
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
