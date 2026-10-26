/// <reference types="vite/client" />

// Provides asset and Vue single-file component types to the frontend compiler.
declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, any>;
  export default component;
}
