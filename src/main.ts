// Restores durable state while loading the interface, then mounts App with the complete workspace.
import "./styles/index.css";
import { createApp } from "vue";
import { createWorkspace } from "./workspace";
import { createIndexedDbWorkspaceStorage, createWorkspaceRepository } from "./workspaceRepository";

const repository = createWorkspaceRepository(createIndexedDbWorkspaceStorage());
const initialWorkspace = repository.load().catch(error => ({
  workspace: createWorkspace(),
  error: `Could not load workspace: ${error instanceof Error ? error.message : String(error)}`,
}));

// Neither task depends on the other. Keep the workspace complete before mounting
// so restoration cannot overwrite edits or trigger autosave of partial state.
void Promise.all([import("./App.vue"), initialWorkspace]).then(([{ default: App }, initialWorkspace]) => {
  createApp(App, { initialWorkspace, repository }).mount("#app");
});
