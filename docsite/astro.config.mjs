import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import mermaid from "astro-mermaid";

export default defineConfig({
  site: "https://sammyageil.com",
  base: "/citeloom",
  integrations: [
    mermaid({
      autoTheme: true,
      enableLog: false,
    }),
    starlight({
      title: "CiteLoom",
      description: "Install, configure, integrate, and operate CiteLoom.",
      customCss: ["./src/styles/citeloom-dark.css"],
      editLink: {
        baseUrl: "https://github.com/sageil/citeloom/edit/main/docsite/",
      },
      favicon: "/favicon.svg",
      logo: {
        src: "./src/assets/citeloom-logo.png",
      },
      social: [
        {
          href: "https://github.com/sageil/citeloom",
          icon: "github",
          label: "GitHub",
        },
      ],
      sidebar: [
        {
          label: "Start",
          items: [
            { label: "Why CiteLoom", slug: "" },
            { label: "Installation overview", slug: "installation" },
          ],
        },
        {
          label: "Features",
          items: [
            { label: "Ask", slug: "features/ask" },
            { label: "Chat", slug: "features/chat" },
            { label: "Find", slug: "features/find" },
          ],
        },
        {
          label: "Install",
          items: [
            { label: "Minimum Installation", slug: "installation/docker-compose" },
            { label: "Use object storage", slug: "installation/seaweedfs" },
            { label: "Use OAuth", slug: "installation/oauth" },
          ],
        },
        {
          label: "Configure",
          items: [
            { label: "Overview", slug: "configuration" },
            { label: "Models", slug: "configuration/providers" },
            { label: "Docling", slug: "configuration/docling" },
            { label: "HHEM", slug: "configuration/hhem" },
            { label: "MCP clients", slug: "configuration/mcp" },
          ],
        },
        {
          label: "Complete reference",
          collapsed: true,
          items: [
            { label: "Architecture", slug: "reference/architecture" },
            { label: "Features", slug: "reference/features" },
            { label: "Security", slug: "reference/oauth" },
            { label: "Configuration", slug: "reference/configuration" },
            { label: "Deployment", slug: "reference/deployment" },
            { label: "Evaluation", slug: "reference/evaluation" },
            { label: "Operations", slug: "reference/operations" },
            { label: "pnpm commands", slug: "reference/commands" },
            { label: "Release notes", slug: "reference/releases" },
          ],
        },
      ],
    }),
  ],
});
