// Encryption for stored mailbox passwords. AES-256-GCM with a key derived
// from APP_SECRET, so a database copy alone never yields a usable password.

const enc = new TextEncoder();
const dec = new TextDecoder();

async function keyFor(): Promise<CryptoKey> {
  const secret = process.env.APP_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error(
      "APP_SECRET is not set (needs at least 16 characters). Add it in the deployment's environment variables."
    );
  }
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(`rate-beacon:${secret}`));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

const b64 = {
  to: (b: Uint8Array) => btoa(String.fromCharCode(...b)),
  from: (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
};

export async function encryptSecret(plain: string): Promise<string> {
  const key = await keyFor();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const buf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plain));
  return `${b64.to(iv)}.${b64.to(new Uint8Array(buf))}`;
}

export async function decryptSecret(stored: string): Promise<string> {
  const [ivPart, dataPart] = stored.split(".");
  if (!ivPart || !dataPart) throw new Error("Stored credential is malformed");
  const key = await keyFor();
  const buf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64.from(ivPart) },
    key,
    b64.from(dataPart)
  );
  return dec.decode(buf);
}
