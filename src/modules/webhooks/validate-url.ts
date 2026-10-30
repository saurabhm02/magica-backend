import dns from "node:dns/promises";
import net from "node:net";
import { AppError } from "@/lib/errors";

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return true;
  }
  const a = parts[0]!;
  const b = parts[1]!;
  // 0.0.0.0/8 (current network)
  if (a === 0) return true;
  // 10.0.0.0/8 (private)
  if (a === 10) return true;
  // 127.0.0.0/8 (loopback)
  if (a === 127) return true;
  // 169.254.0.0/16 (link-local)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 (private: 172.16.x.x - 172.31.x.x)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 (private)
  if (a === 192 && b === 168) return true;
  // 224.0.0.0/4 (multicast) & 240.0.0.0/4 (reserved/broadcast)
  if (a >= 224) return true;
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  // Loopback and unspecified
  if (normalized === "::1" || normalized === "::") return true;
  // IPv4-mapped IPv6 (::ffff:x.x.x.x)
  if (normalized.startsWith("::ffff:")) {
    const v4 = normalized.slice(7);
    if (net.isIPv4(v4)) return isPrivateIpv4(v4);
  }
  // Unique local addresses fc00::/7 (fc.. or fd..)
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  // Link-local addresses fe80::/10 (fe80.. to febf..)
  if (
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  ) {
    return true;
  }
  return false;
}

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateIpv4(ip);
  if (net.isIPv6(ip)) return isPrivateIpv6(ip);
  return false;
}

/**
 * Checks that a webhook URL is safe to call from our servers (SSRF guard).
 *
 * Input:
 * - urlString: the URL the user gave
 *
 * Output:
 * - the normalized URL; throws VALIDATION_FAILED if it is not allowed
 *
 * Rules it enforces:
 * - Must be a valid https URL.
 * - No localhost, .localhost, .local or .internal hosts.
 * - No private, loopback, link-local or multicast IPs, given directly or reached through DNS.
 * - A hostname that doesn't resolve is rejected (fail closed).
 */
export async function validateWebhookUrl(urlString: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new AppError("VALIDATION_FAILED", "Invalid webhook URL", false);
  }

  if (url.protocol !== "https:") {
    throw new AppError("VALIDATION_FAILED", "Webhook URL must use HTTPS", false);
  }

  const hostname = url.hostname.toLowerCase();
  if (!hostname) {
    throw new AppError("VALIDATION_FAILED", "Webhook URL must have a valid hostname", false);
  }

  // Reject localhost and local/internal suffixes
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new AppError("VALIDATION_FAILED", "Webhook URL cannot target localhost or internal domains", false);
  }

  // Handle IPv6 bracket format e.g. [::1]
  const cleanHost = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;

  if (net.isIP(cleanHost)) {
    if (isPrivateIp(cleanHost)) {
      throw new AppError("VALIDATION_FAILED", "Webhook URL cannot target private or localhost IP addresses", false);
    }
    return url.toString();
  }

  // Check resolved DNS IP addresses (fail-closed)
  try {
    const addresses = await dns.lookup(cleanHost, { all: true });
    if (!addresses || addresses.length === 0) {
      throw new AppError("VALIDATION_FAILED", "Webhook URL hostname could not be resolved", false);
    }
    for (const record of addresses) {
      if (isPrivateIp(record.address)) {
        throw new AppError("VALIDATION_FAILED", "Webhook URL cannot resolve to private or internal IP addresses", false);
      }
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("VALIDATION_FAILED", `Webhook URL hostname could not be resolved: ${(err as Error).message}`, false);
  }

  return url.toString();
}
