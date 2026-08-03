const settingsLocationParameters = Object.freeze({
  area: "settings-area",
  capability: "settings-capability",
  item: "settings-item",
  section: "settings-section",
});
const settingsHistoryState = Object.freeze({ citeloomSettings: true });

export function readSettingsLocation() {
  const url = new URL(window.location.href);
  const view = url.searchParams.get("view");
  if (view !== "settings" && url.pathname !== "/settings") {
    return null;
  }
  return {
    area: readOptionalLocationParameter(
      url.searchParams,
      settingsLocationParameters.area,
    ),
    capability: readOptionalLocationParameter(
      url.searchParams,
      settingsLocationParameters.capability,
    ),
    item: readOptionalLocationParameter(
      url.searchParams,
      settingsLocationParameters.item,
    ),
    section: readOptionalLocationParameter(
      url.searchParams,
      settingsLocationParameters.section,
    ),
  };
}

export function readSettingsHistoryOwner(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  if (value.citeloomSettings === true) {
    return "settings";
  }
  if (value.htmx === true) {
    return "htmx";
  }
  return null;
}

export function initializeSettingsHistory() {
  const location = readSettingsLocation();
  if (location === null) {
    return;
  }
  if (readSettingsHistoryOwner(window.history.state) !== null) {
    return;
  }
  if (isSettingsRootLocation(location)) {
    window.history.replaceState(settingsHistoryState, "", window.location.href);
    return;
  }
  const sectionUrl = createSettingsLocationUrl(location);
  const rootLocation = {
    area: null,
    capability: null,
    item: null,
    section: null,
  };
  window.history.replaceState(
    settingsHistoryState,
    "",
    createSettingsLocationUrl(rootLocation),
  );
  window.history.pushState(settingsHistoryState, "", sectionUrl);
}

export function writeSettingsLocation(location) {
  const url = createSettingsLocationUrl(location);
  if (url.href === window.location.href) {
    return;
  }
  const currentLocation = readSettingsLocation();
  if (currentLocation === null) {
    return;
  }
  const targetIsRoot = isSettingsRootLocation(location);
  const currentIsRoot = isSettingsRootLocation(currentLocation);
  if (targetIsRoot && !currentIsRoot) {
    window.history.back();
    return;
  }
  if (currentIsRoot) {
    window.history.pushState(settingsHistoryState, "", url);
    return;
  }
  window.history.replaceState(settingsHistoryState, "", url);
}

function readOptionalLocationParameter(parameters, name) {
  const value = parameters.get(name)?.trim() ?? "";
  return value === "" ? null : value;
}

function createSettingsLocationUrl(location) {
  const url = new URL(window.location.href);
  for (const parameter of Object.values(settingsLocationParameters)) {
    url.searchParams.delete(parameter);
  }
  if (location.area !== null) {
    url.searchParams.set(settingsLocationParameters.area, location.area);
  }
  if (location.capability !== null) {
    url.searchParams.set(
      settingsLocationParameters.capability,
      location.capability,
    );
  }
  if (location.item !== null) {
    url.searchParams.set(settingsLocationParameters.item, location.item);
  }
  if (location.section !== null) {
    url.searchParams.set(settingsLocationParameters.section, location.section);
  }
  return url;
}

function isSettingsRootLocation(location) {
  return location.area === null
    && location.capability === null
    && location.item === null
    && location.section === null;
}
