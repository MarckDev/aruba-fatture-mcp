import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  chiaveMancante,
  erroreDecifratura,
  erroreFirma,
  verificaFirmaConBlob,
} from "../../dist/credenziali/windows-native.js";
import {
  ChiaveHelloMancanteError,
  SbloccoAnnullatoError,
  VaultIllegibileError,
} from "../../dist/credenziali/tipi.js";

test("NTE_NO_KEY, NTE_NOT_FOUND e NTE_BAD_KEYSET indicano una chiave mancante", () => {
  for (const hr of [0x8009000d, 0x80090011, 0x80090016]) assert.equal(chiaveMancante(hr), true, hr.toString(16));
  // I codici arrivano come int32 con segno.
  assert.equal(chiaveMancante(0x80090016 | 0), true);
  assert.equal(chiaveMancante(0x80090027), false);
  assert.equal(chiaveMancante(0), false);
});

test("esiti della decifratura: successo, annullamento, chiave mancante, altro", () => {
  assert.equal(erroreDecifratura(0), null);
  assert.ok(erroreDecifratura(0x80090036 | 0) instanceof SbloccoAnnullatoError);
  assert.ok(erroreDecifratura(0x8010006e | 0) instanceof SbloccoAnnullatoError);
  assert.ok(erroreDecifratura(0x80090016 | 0) instanceof ChiaveHelloMancanteError);
  const altro = erroreDecifratura(0x80090005 | 0);
  assert.ok(altro instanceof VaultIllegibileError);
  assert.match(altro.message, /--reset-windows-hello/);
  assert.match(altro.message, /0x80090005/);
});

/**
 * Il Passport KSP non supporta NCryptVerifySignature (0x80090029): la firma si
 * verifica in Node con la chiave pubblica esportata come BCRYPT_RSAPUBLIC_BLOB.
 */
function blobPubblico(chiavePubblica) {
  const jwk = chiavePubblica.export({ format: "jwk" });
  const e = Buffer.from(jwk.e, "base64url");
  const n = Buffer.from(jwk.n, "base64url");
  const intestazione = Buffer.alloc(24);
  intestazione.write("RSA1", 0, "ascii");
  intestazione.writeUInt32LE(n.length * 8, 4);
  intestazione.writeUInt32LE(e.length, 8);
  intestazione.writeUInt32LE(n.length, 12);
  return Buffer.concat([intestazione, e, n]);
}

test("verifica una firma RSA SHA-256 PKCS#1 dal blob pubblico di Windows", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const dati = Buffer.from('[2,"a","b","c","d"]');
  const firma = sign("sha256", dati, privateKey);
  const blob = blobPubblico(publicKey);
  assert.equal(verificaFirmaConBlob(blob, dati, firma), true);
  assert.equal(verificaFirmaConBlob(blob, Buffer.from('[2,"a","b","c","e"]'), firma), false);
  assert.equal(verificaFirmaConBlob(blob, dati, Buffer.alloc(256, 1)), false);
});

test("un blob che non è una chiave pubblica RSA viene rifiutato", () => {
  assert.throws(() => verificaFirmaConBlob(Buffer.alloc(24), Buffer.from("x"), Buffer.alloc(256)), /chiave pubblica/);
});

test("esiti della firma: successo, annullamento, chiave mancante, altro", () => {
  assert.equal(erroreFirma(0), null);
  assert.ok(erroreFirma(0x80090036 | 0) instanceof SbloccoAnnullatoError);
  assert.ok(erroreFirma(0x80090016 | 0) instanceof ChiaveHelloMancanteError);
  assert.match(erroreFirma(0x80090005 | 0).message, /firma.*0x80090005/);
});
