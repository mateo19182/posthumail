const enc = new TextEncoder();
const dec = new TextDecoder();

export const b64u = (bytes: Uint8Array): string => {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export const unb64u = (s: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export const randomKey = (): string => b64u(crypto.getRandomValues(new Uint8Array(32)));

const hmacKey = (secret: string) =>
  crypto.subtle.importKey("raw", unb64u(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);

// Stateless signed token: 22 chars of HMAC(purpose:subject) followed by the subject.
// Short and URL/Telegram-deep-link safe as long as subjects use [A-Za-z0-9._-].
export type Purpose = "checkin" | "trustee" | "link" | "file";

const MAC_LEN = 22;

const mac = async (secret: string, p: Purpose, subject: string) =>
  b64u(new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(`${p}:${subject}`)))).slice(
    0,
    MAC_LEN,
  );

export const sign = async (secret: string, p: Purpose, subject: string): Promise<string> =>
  `${await mac(secret, p, subject)}${subject}`;

export const verify = async (secret: string, p: Purpose, token: string): Promise<string | null> => {
  if (token.length <= MAC_LEN) return null;
  const subject = token.slice(MAC_LEN);
  const expected = await mac(secret, p, subject);
  return timingSafeEqual(enc.encode(expected), enc.encode(token.slice(0, MAC_LEN))) ? subject : null;
};

const timingSafeEqual = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
};

const aesKey = (secret: string) =>
  crypto.subtle.importKey("raw", unb64u(secret), "AES-GCM", false, ["encrypt", "decrypt"]);

export interface Sealed {
  iv: string;
  ct: string;
}

export const seal = async (secret: string, plaintext: string): Promise<Sealed> => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secret), enc.encode(plaintext));
  return { iv: b64u(iv), ct: b64u(new Uint8Array(ct)) };
};

export const open = async (secret: string, { iv, ct }: Sealed): Promise<string> =>
  dec.decode(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64u(iv) }, await aesKey(secret), unb64u(ct)),
  );

export const sha256 = async (data: Uint8Array<ArrayBuffer> | string): Promise<string> =>
  b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", typeof data === "string" ? enc.encode(data) : data)));
