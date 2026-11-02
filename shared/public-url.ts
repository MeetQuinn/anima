import { z } from "zod";

// This validates the URL's syntax, not DNS or whether a tunnel is reachable.
export const PublicHttpsUrl = z
  .string()
  .trim()
  .url()
  .max(2048)
  .refine((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    const octets = host.split(".").map(Number);
    const privateV4 =
      octets.length === 4 &&
      octets.every(Number.isInteger) &&
      (octets[0] === 0 ||
        octets[0] === 10 ||
        octets[0] === 127 ||
        octets[0]! >= 224 ||
        (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
        (octets[0] === 192 && octets[1] === 168) ||
        (octets[0] === 169 && octets[1] === 254) ||
        (octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127));
    // Public DNS names are supported; literal IPv6 addresses need a public hostname.
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      host.includes(".") &&
      !host.includes(":") &&
      !privateV4 &&
      !["localhost", "local", "internal", "test", "invalid"].some(
        (suffix) => host === suffix || host.endsWith(`.${suffix}`),
      )
    );
  }, "Use a public HTTPS URL without credentials, query parameters or a fragment.");

export const PublicUrl = PublicHttpsUrl.pipe(
  z
    .string()
    .refine(
      (value) => new URL(value).pathname === "/",
      "Enter only the HTTPS origin, without a path.",
    ),
).transform((value) => new URL(value).origin);
export const PublicUrlRequest = z.object({ publicUrl: PublicUrl }).strict();
export interface PublicUrlSettings {
  publicUrl?: string;
}
