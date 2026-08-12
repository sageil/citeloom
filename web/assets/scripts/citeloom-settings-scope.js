const settingsScopeStorageKey = "citeloom.settings-scope";

export function readSettingsScopePreference() {
  const storage = readSessionStorage();
  if (storage === null) {
    return null;
  }
  let value;
  try {
    value = storage.getItem(settingsScopeStorageKey);
  } catch {
    return null;
  }
  if (value === "organization" || value === "workspace") {
    return value;
  }
  return null;
}

export function writeSettingsScopePreference(scope) {
  const storage = readSessionStorage();
  if (storage === null) {
    return false;
  }
  try {
    storage.setItem(settingsScopeStorageKey, scope);
    return true;
  } catch {
    return false;
  }
}

export function clearSettingsScopePreference() {
  const storage = readSessionStorage();
  if (storage === null) {
    return false;
  }
  try {
    storage.removeItem(settingsScopeStorageKey);
    return true;
  } catch {
    return false;
  }
}

function readSessionStorage() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}
