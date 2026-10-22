import { ErrorCode } from "./constants.js";

const CODES = new Set<string>(Object.values(ErrorCode));

/** Every failure the SDK reports: validation, the registry, or the network. */
export class AuthorityError extends Error {
    override readonly name = "AuthorityError";

    constructor(
        readonly code: ErrorCode,
        message: string = code,
        /** Context such as the field or entry at fault, an interaction hash, or the raw error. */
        readonly details: Record<string, unknown> = {},
    ) {
        super(message);
    }
}

/**
 * Turns a registry exception, an RPC error or any thrown value into an
 * AuthorityError. The registry throws "<CODE>" or "<CODE>: <detail>"; the
 * code and the full message are kept.
 */
export const toAuthorityError = (raw: unknown, details: Record<string, unknown> = {}): AuthorityError => {
    if (raw instanceof AuthorityError) return raw;
    const record = (raw ?? {}) as { error?: unknown; message?: unknown; class?: unknown };
    // A PISA exception's `class` names the thrown type ("string" for a registry
    // throw); it is context, not part of the message.
    const text = typeof raw === "string"
        ? raw
        : [record.error, record.message].filter((part) => typeof part === "string" && part).join(" ");
    const code = text.match(/[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+/g)?.find((token) => CODES.has(token));
    if (code) {
        const message = text.slice(text.indexOf(code)).split("\n")[0]!.trim();
        return new AuthorityError(code as ErrorCode, message, { ...details, raw });
    }
    const kind = typeof record.class === "string" && record.class !== "string" ? `${record.class}: ` : "";
    return new AuthorityError(ErrorCode.NETWORK_ERROR, `${kind}${text}` || "network error", { ...details, raw });
};

export const invalidShape = (field: string): AuthorityError =>
    new AuthorityError(ErrorCode.INVALID_SHAPE, `INVALID_SHAPE: ${field}`, { field });

export const invalidArgument = (message: string): AuthorityError =>
    new AuthorityError(ErrorCode.INVALID_ARGUMENT, message);
