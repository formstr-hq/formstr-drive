import type { PublicSharePayload, ShareRole } from "../types/metadata";

export interface ShareTokenPayload {
  shareId: string;
  secret: string;
}

export interface CreateShareOptions {
  role: ShareRole;
  canReshare: boolean;
  expiresAt?: number;
  password?: string;
}

export interface CreateShareResult {
  shareId: string;
  secret: string;
  passwordSalt?: string;
  passwordVerifier?: string;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  const bin = String.fromCharCode(...bytes);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out.buffer;
}

function randomBase64Url(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return bytesToBase64Url(bytes);
}

export function createShareToken(): ShareTokenPayload {
  return {
    shareId: randomBase64Url(16),
    secret: randomBase64Url(24),
  };
}

export function buildShareLink(origin: string, payload: ShareTokenPayload): string {
  const cleanOrigin = origin.replace(/\/$/, "");
  return `${cleanOrigin}/share/${payload.shareId}#k=${payload.secret}`;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const arr = Array.from(new Uint8Array(digest));
  return arr.map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function secretToAesKey(secret: string): Promise<CryptoKey> {
  const hashBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", hashBytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function createPasswordVerifier(password: string): Promise<{ salt: string; verifier: string }> {
  const salt = randomBase64Url(16);
  const verifier = await sha256Hex(`${salt}:${password}`);
  return { salt, verifier };
}

export async function verifyPassword(password: string, salt: string, verifier: string): Promise<boolean> {
  const candidate = await sha256Hex(`${salt}:${password}`);
  return candidate === verifier;
}

export async function encryptSharePayload(
  payload: PublicSharePayload,
  secret: string
): Promise<{ ciphertext: string; iv: string }> {
  const key = await secretToAesKey(secret);
  const ivBytes = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(ivBytes) },
    key,
    toArrayBuffer(plaintext)
  );

  return {
    ciphertext: bytesToBase64Url(new Uint8Array(encrypted)),
    iv: bytesToBase64Url(ivBytes),
  };
}

export async function decryptSharePayload(
  ciphertext: string,
  iv: string,
  secret: string
): Promise<PublicSharePayload> {
  const key = await secretToAesKey(secret);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(base64UrlToBytes(iv)) },
    key,
    toArrayBuffer(base64UrlToBytes(ciphertext))
  );

  const json = new TextDecoder().decode(decrypted);
  return JSON.parse(json) as PublicSharePayload;
}
