import { readFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { registerPage } from "../web/assets/scripts/account.js";
import {
  findHtmlElementByText,
  htmlElementHasClass,
  readHtmlAttribute,
  readHtmlDocumentText,
  readHtmlElements,
  readHtmlText,
} from "./html-test-helpers.js";

const CURRENT_WORKSPACE_ID = "00000000-0000-4000-8000-000000000101";
const DEFAULT_WORKSPACE_ID = "00000000-0000-4000-8000-000000000102";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CiteLoom account workspace preference", () => {
  it("declares concise workspace-selection copy and controls in the template", async () => {
    const account = await readFile(
      new URL("../web/fragments/account.html", import.meta.url),
      "utf8",
    );
    const elements = readHtmlElements(account);
    const workspaceList = elements.find((element) => {
      return element.tagName === "fieldset"
        && htmlElementHasClass(element, "account-workspace-list");
    });
    const badgeLabels = elements
      .filter((element) => htmlElementHasClass(element, "account-workspace-badge"))
      .map((element) => readHtmlText(element).trim());
    const saveButton = elements.find((element) => {
      return readHtmlAttribute(element, "x-text")
        === "workspaceBusy ? 'Saving…' : 'Save and switch'";
    });
    const visibleText = readHtmlDocumentText(elements);

    expect(findHtmlElementByText(
      elements,
      "h2",
      "Change your default workspace",
    ).tagName).toBe("h2");
    expect(findHtmlElementByText(
      elements,
      "legend",
      "Select your default workspace",
    ).tagName).toBe("legend");
    expect(workspaceList).toBeDefined();
    expect(badgeLabels).toEqual(["Current", "Default"]);
    expect(saveButton?.tagName).toBe("button");
    expect(visibleText).not.toContain("Choose where CiteLoom opens when you sign in");
  });

  it("loads the server default without changing the current workspace", async () => {
    const fetchRequest = vi.fn(async () => Response.json(buildPreference()));
    vi.stubGlobal("fetch", fetchRequest);
    const page = buildAccountPage();

    await page.loadWorkspacePreference();

    expect(page.currentWorkspaceId).toBe(CURRENT_WORKSPACE_ID);
    expect(page.defaultWorkspaceId).toBe(DEFAULT_WORKSPACE_ID);
    expect(page.selectedWorkspaceId).toBe(DEFAULT_WORKSPACE_ID);
    expect(page.hasWorkspaceSelectionChange).toBe(false);
  });

  it("saves the new default and reloads into the switched workspace", async () => {
    const reload = vi.fn();
    vi.stubGlobal("window", { location: { reload } });
    const fetchRequest = vi.fn(async (input) => {
      if (input === "/api/account/default-workspace") {
        return Response.json({
          currentWorkspaceId: DEFAULT_WORKSPACE_ID,
          defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
          workspace: {
            id: DEFAULT_WORKSPACE_ID,
            name: "Research Operations",
            role: "member",
          },
        });
      }
      throw new Error("Unexpected account request.");
    });
    vi.stubGlobal("fetch", fetchRequest);
    const page = buildAccountPage();
    page.currentWorkspaceId = CURRENT_WORKSPACE_ID;
    page.defaultWorkspaceId = CURRENT_WORKSPACE_ID;
    page.selectedWorkspaceId = DEFAULT_WORKSPACE_ID;
    page.workspaces = buildPreference().workspaces;

    await page.saveDefaultWorkspace();

    expect(fetchRequest).toHaveBeenCalledWith(
      "/api/account/default-workspace",
      {
        body: JSON.stringify({ workspaceId: DEFAULT_WORKSPACE_ID }),
        headers: { "Content-Type": "application/json" },
        method: "PUT",
      },
    );
    expect(reload).toHaveBeenCalledOnce();
  });
});

function buildAccountPage() {
  let factory;
  registerPage({
    data(name, candidateFactory) {
      expect(name).toBe("citeloomAccountPage");
      factory = candidateFactory;
    },
  });
  if (factory === undefined) {
    throw new Error("The account page was not registered.");
  }
  return factory();
}

function buildPreference() {
  return {
    currentWorkspaceId: CURRENT_WORKSPACE_ID,
    defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
    workspaces: [
      {
        id: CURRENT_WORKSPACE_ID,
        name: "Knowledge Base",
        role: "member",
      },
      {
        id: DEFAULT_WORKSPACE_ID,
        name: "Research Operations",
        role: "member",
      },
    ],
  };
}
