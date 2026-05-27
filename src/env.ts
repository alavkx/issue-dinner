const API_KEY_ENV = "ISSUE_DINNER_CURSOR_API_KEY";

export function cursorApiKey(): string {
  const key = process.env[API_KEY_ENV];
  if (!key?.trim()) {
    throw new Error(
      `${API_KEY_ENV} is not set. Export a key from https://cursor.com/dashboard/integrations`,
    );
  }
  return key.trim();
}

export function cursorApiKeyEnvName(): string {
  return API_KEY_ENV;
}
