import { defineConfig } from "vitepress";

function publicBase(): string {
  const raw = process.env.DOCS_BASE ?? process.env.VITEPRESS_BASE ?? "/";
  const prefixed = raw.startsWith("/") ? raw : `/${raw}`;
  return prefixed.endsWith("/") ? prefixed : `${prefixed}/`;
}

export default defineConfig({
  base: publicBase(),
  description: "AI agent teams that work alongside your human team in Slack.",
  lang: "en-US",
  lastUpdated: true,
  title: "Anima",
  themeConfig: {
    editLink: {
      pattern: "https://github.com/MeetQuinn/anima/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },
    nav: [
      { text: "Guide", link: "/guide/what-is-anima" },
      { text: "Operations", link: "/deployment" },
      { text: "Architecture", link: "/architecture/overview" },
      { text: "Maintainers", link: "/release" },
    ],
    search: {
      provider: "local",
    },
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "What is Anima", link: "/guide/what-is-anima" },
          { text: "Quickstart", link: "/quickstart" },
          {
            text: "Working with your agent",
            link: "/guide/working-with-your-agent",
          },
          { text: "How an agent works", link: "/guide/how-an-agent-works" },
        ],
      },
      {
        text: "Operations",
        items: [
          { text: "Deployment", link: "/deployment" },
          { text: "Service runbook", link: "/service-runbook" },
        ],
      },
      {
        text: "Architecture",
        items: [
          { text: "Overview", link: "/architecture/overview" },
          { text: "Provider layer", link: "/runtime-providers" },
          { text: "Activity events", link: "/activity-events" },
        ],
      },
      {
        text: "Maintainers",
        items: [
          { text: "Release process", link: "/release" },
          { text: "Design principles", link: "/design" },
          { text: "Docs roadmap", link: "/docs-roadmap" },
        ],
      },
    ],
    siteTitle: "Anima",
    socialLinks: [
      { icon: "github", link: "https://github.com/MeetQuinn/anima" },
    ],
  },
});
