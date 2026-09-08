export const MARKETPLACE_RESPONSE_SCHEMA_VERSION = 1;

export function withMarketplaceResponseSchema(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  return {
    ...payload,
    schemaVersion: MARKETPLACE_RESPONSE_SCHEMA_VERSION
  };
}
