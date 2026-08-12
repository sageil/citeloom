export type SourceLibraryAccess = "manage" | "use";
export type SourceLibraryState = "active" | "archived" | "deleting";

export interface SourceLibrarySummary {
  access: SourceLibraryAccess;
  id: string;
  kind: "private" | "shared";
  name: string;
}

export interface SourceLibraryAdministrationGrant {
  access: SourceLibraryAccess;
  workspaceId: string;
}

export interface SourceLibraryAdministrationLibrary {
  grants: SourceLibraryAdministrationGrant[];
  id: string;
  name: string;
  state: SourceLibraryState;
}

export interface SourceLibraryAdministrationWorkspace {
  id: string;
  name: string;
}

export interface SourceLibraryAdministration {
  libraries: SourceLibraryAdministrationLibrary[];
  workspaces: SourceLibraryAdministrationWorkspace[];
}

export interface CreateSharedSourceLibraryInput {
  name: string;
}

export interface RenameSharedSourceLibraryInput {
  name: string;
}
