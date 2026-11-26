/* CREW end-to-end encryption.
 *
 * Chat, shared notes and files are encrypted in each browser, so the CREW
 * host (the computer running server.py) only ever stores and passes along
 * scrambled data. Uses the browser's built-in Web Crypto (AES-GCM, PBKDF2).
 *
 * How the keys work:
 *  - The group password goes through PBKDF2 (SHA-256, 600,000 rounds, salted
 *    with the group code), giving 64 bytes. The first 32 are sent to the
 *    server to prove you know the password; the last 32 become a "wrapping
 *    key" that the server never sees. The password itself never leaves
 *    the browser.
 *  - The group's real key is 32 random bytes made by the first person in
 *    the group. The server keeps it only locked with the wrapping key, so
 *    anyone who knows the password can unlock it, and the server can't.
 *  - Changing the password locks the same group key with the new password,
 *    so people already in the group keep reading everything.
 *
 * Other scripts use the global `crewE2E` (encryptText, decryptText,
 * encryptBytes, decryptBytes, isSealed).
 */
const crewE2E = (() => {
  "use strict";
  const PREFIX = "e2e1:";
  const ROUNDS = 600000;
  const enc = new TextEncoder(), dec = new TextDecoder();
  const subtle = globalThis.crypto && crypto.subtle;

  const b64 = bytes => {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");

  let groupKey = null;      // CryptoKey for the group's data
  let groupRaw = null;      // its bytes, kept only to re-lock it for a new password
  let wrapKey = null;       // from the password; unlocks groupKey
  let ready, setReady;
  // A new "ready" promise only once the old one has been used, so anything
  // already waiting for the key still gets it.
  const reset = () => { if (groupKey || !ready) ready = new Promise(r => setReady = r); groupKey = groupRaw = null; };
  reset();

  function need() {
    if (!subtle) throw new Error("Encryption needs a secure connection. Open CREW's https:// address " +
                                 "(or http://localhost on the host computer).");
  }
  const aesKey = (raw, uses) => subtle.importKey("raw", raw, "AES-GCM", false, uses);

  async function seal(key, bytes, label) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(label) }, key, bytes));
    const out = new Uint8Array(12 + ct.length);
    out.set(iv); out.set(ct, 12);
    return out;
  }
  async function unseal(key, data, label) {
    return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: data.subarray(0, 12), additionalData: enc.encode(label) },
                                               key, data.subarray(12)));
  }

  // Same rules as the server's clean_room(), so everyone salts with the same text.
  const cleanRoom = r => String(r || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32);

  /** Password -> {auth (hex, for the server), material (to remember in this tab)}. */
  async function derive(password, room) {
    need();
    const base = await subtle.importKey("raw", enc.encode(String(password).normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
    const bits = new Uint8Array(await subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: enc.encode("crew-e2e-v1|" + cleanRoom(room)), iterations: ROUNDS }, base, 512));
    return fromMaterial(b64(bits));
  }
  /** What derive() made, from the copy this tab remembered (for reconnecting). */
  async function fromMaterial(material) {
    need();
    const bits = unb64(material);
    if (bits.length !== 64) throw new Error("Please join again with the group password.");
    return { auth: hex(bits.subarray(0, 32)), material, wrap: await aesKey(bits.subarray(32), ["encrypt", "decrypt"]) };
  }

  async function useGroupKey(raw) {
    groupRaw = raw;
    groupKey = await aesKey(raw, ["encrypt", "decrypt"]);
    setReady();
  }

  /** After joining: unlock the group key the server gave us, or make one. */
  async function start(k, wrapped, created) {
    reset();
    wrapKey = k.wrap;
    if (wrapped) { await unlock(wrapped); return null; }
    if (created) {                          // first in the group: make its key
      await useGroupKey(crypto.getRandomValues(new Uint8Array(32)));
      return lock(wrapKey);
    }
    return null;                            // the creator hasn't sent it yet; see unlock()
  }
  async function unlock(wrapped) {
    if (groupKey || !wrapKey) return;
    try { await useGroupKey(await unseal(wrapKey, unb64(wrapped), "group-key")); }
    catch { throw new Error("Couldn't unlock this group's encryption key."); }
  }
  /** The group key, locked with some password's wrapping key. */
  async function lock(wrap) { return b64(await seal(wrap, groupRaw, "group-key")); }

  async function waitReady(ms = 20000) {
    let t;
    const ok = await Promise.race([ready.then(() => true), new Promise(r => t = setTimeout(() => r(false), ms))]);
    clearTimeout(t);
    if (!ok) throw new Error("This group's encryption key hasn't arrived.");
  }

  const isSealed = s => typeof s === "string" && s.startsWith(PREFIX);
  async function encryptText(text, label) {
    await waitReady();
    return PREFIX + b64(await seal(groupKey, enc.encode(text), label));
  }
  /** Plain (old) text passes through; sealed text is decrypted or throws. */
  async function decryptText(s, label) {
    if (!isSealed(s)) return s;
    await waitReady();
    return dec.decode(await unseal(groupKey, unb64(s.slice(PREFIX.length)), label));
  }
  async function encryptBytes(buf, label) { await waitReady(); return seal(groupKey, new Uint8Array(buf), label); }
  async function decryptBytes(buf, label) { await waitReady(); return unseal(groupKey, new Uint8Array(buf), label); }

  return { derive, fromMaterial, start, unlock, lock, encryptText, decryptText, encryptBytes, decryptBytes,
           isSealed, clear: () => { reset(); wrapKey = null; }, get on() { return !!groupKey; },
           OVERHEAD: 28 };
})();
