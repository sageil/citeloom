import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://sammyageil.com",
  base: "/citeloom",
  integrations: [
    starlight({
      title: "CiteLoom",
      description: "Install, configure, integrate, and operate CiteLoom.",
      customCss: ["./src/styles/custom.css"],
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
          label: "Install",
          items: [
            { label: "Required Docker Compose stack", slug: "installation/docker-compose" },
            { label: "Component map", slug: "installation/components" },
            { label: "SeaweedFS object storage", slug: "installation/seaweedfs" },
            { label: "OAuth with Logto", slug: "installation/oauth-logto" },
          ],
        },
        {
          label: "Configure",
          items: [
            { label: "Configuration overview", slug: "configuration" },
            { label: "Local, remote, or hybrid models", slug: "configuration/providers" },
            { label: "Docling", slug: "configuration/docling" },
            { label: "HHEM", slug: "configuration/hhem" },
            { label: "MCP clients", slug: "configuration/mcp" },
          ],
        },
        {
          label: "Complete reference",
          collapsed: true,
          items: [{ autogenerate: { directory: "reference" } }],
        },
      ],
    }),
  ],
});
