/**
 * Vault placeholder handling for requests the proxy can read (spec section 8). Placeholders are substituted only as
 * literal text in the credential's named headers, on HTTPS requests to its exact destinations. Every other use is
 * rejected instead of being transmitted.
 */
import { findVaultPlaceholders, VAULT_FORBIDDEN_HEADERS, type EgressCredentialBinding, type EgressRegistration } from "@managed-copilot/protocol";

export interface SubstitutionUse {
  readonly header: string;
  readonly placeholder: string;
  readonly credential: EgressCredentialBinding;
}

export type SubstitutionPlan = { readonly ok: true; readonly uses: readonly SubstitutionUse[] } | { readonly ok: false; readonly message: string };

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** True when a plain HTTP request mentions a placeholder anywhere the proxy can see (URL or headers). */
export function mentionsPlaceholder(target: string, rawHeaders: readonly string[]): boolean {
  if (findVaultPlaceholders(safeDecode(target)).length > 0) return true;
  for (let i = 1; i < rawHeaders.length; i += 2) {
    const value = rawHeaders[i]!;
    if (findVaultPlaceholders(value).length > 0 || findVaultPlaceholders(decodeBasic(value)).length > 0) return true;
  }
  return false;
}

function decodeBasic(value: string): string {
  const match = /^\s*basic\s+([A-Za-z0-9+/=_-]+)\s*$/i.exec(value);
  return match ? Buffer.from(match[1]!, "base64").toString("latin1") : "";
}

/**
 * Decides which placeholders in a decrypted HTTPS request to `host:port` may be substituted. Any placeholder outside
 * an allowed header, for another destination, from another session, or in an encoded form fails the whole request.
 */
export function planSubstitution(registration: EgressRegistration, host: string, port: number, path: string, rawHeaders: readonly string[]): SubstitutionPlan {
  if (findVaultPlaceholders(safeDecode(path)).length > 0) {
    return { ok: false, message: "Vault credentials can only be used in request headers, not in URLs or query strings." };
  }
  const uses: SubstitutionUse[] = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const header = rawHeaders[i]!.toLowerCase();
    const value = rawHeaders[i + 1] ?? "";
    if (findVaultPlaceholders(decodeBasic(value)).length > 0) {
      return { ok: false, message: `Vault credentials are not supported inside Basic authentication (${header} header). Send the placeholder as a literal header value instead, for example the word Bearer, a space, then the placeholder.` };
    }
    for (const placeholder of findVaultPlaceholders(value)) {
      const credential = registration.credentials.find((binding) => binding.placeholder === placeholder);
      if (!credential) {
        return { ok: false, message: "A vault placeholder in this request does not belong to this session, or its vault was revoked." };
      }
      if (!credential.destinations.some((destination) => destination.host === host && destination.port === port)) {
        const allowed = credential.destinations.map((destination) => (destination.port === 443 ? destination.host : `${destination.host}:${destination.port}`)).join(", ");
        return { ok: false, message: `This vault credential is only valid for ${allowed}, not ${port === 443 ? host : `${host}:${port}`}.` };
      }
      if (VAULT_FORBIDDEN_HEADERS.includes(header) || !credential.headers.includes(header)) {
        return { ok: false, message: `This vault credential can only be sent in the ${credential.headers.join(", ")} header, not ${header}.` };
      }
      uses.push({ header, placeholder, credential });
    }
  }
  return { ok: true, uses };
}

/** Returns raw headers with every planned placeholder replaced. `values` maps placeholder → secret value. */
export function applySubstitution(rawHeaders: readonly string[], values: ReadonlyMap<string, string>): string[] {
  const out = [...rawHeaders];
  for (let i = 1; i < out.length; i += 2) {
    let value = out[i]!;
    for (const placeholder of findVaultPlaceholders(value)) {
      const secret = values.get(placeholder);
      if (secret !== undefined) value = value.split(placeholder).join(secret);
    }
    out[i] = value;
  }
  return out;
}

/** Replaces secret values in text (response headers), longest first. */
export function redactText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret.length >= 4) out = out.split(secret).join("[redacted]");
  }
  return out;
}
