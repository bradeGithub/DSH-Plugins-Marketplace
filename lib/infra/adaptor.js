import { createAdaptorRules } from "../domain/adaptor.js";

export function createAdaptorAdapter({ loadConfig, normalizeRepo }) {
  let config = null;
  try {
    config = loadConfig();
  } catch {
    config = null;
  }

  return createAdaptorRules({
    redirects: config?.redirects,
    normalizeRepo,
  });
}
