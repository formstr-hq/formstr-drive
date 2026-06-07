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
    private static final int PAYLOAD_NONCE_LENGTH = 32;
    private static final int MESSAGE_KEY_LENGTH = 44;
    private static final byte[] NIP44_INFO = "nip44-v2".getBytes(StandardCharsets.UTF_8);

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
