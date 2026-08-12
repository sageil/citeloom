let systemHealthDashboardReader = null;

export function activateSystemHealthDashboard(reader) {
  systemHealthDashboardReader = reader;
}

export function deactivateSystemHealthDashboard(reader) {
  if (systemHealthDashboardReader === reader) {
    systemHealthDashboardReader = null;
  }
}

export function readSystemHealthDashboard(dashboard, system, queue) {
  if (systemHealthDashboardReader === null) {
    return null;
  }
  return systemHealthDashboardReader(dashboard, system, queue);
}
