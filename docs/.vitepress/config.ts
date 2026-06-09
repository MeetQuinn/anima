import { defineConfig } from "vitepress";

function publicBase(): string {
  const raw = process.env.DOCS_BASE ?? process.env.VITEPRESS_BASE ?? "/";
  const prefixed = raw.startsWith("/") ? raw : `/${raw}`;
  return prefixed.endsWith("/") ? prefixed : `${prefixed}/`;
}

export default defineConfig({
  base: publicBase(),
  description: "AI agent teams that work alongside your human team in Slack.",
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }],
    ["link", { rel: "icon", type: "image/x-icon", href: "/favicon.ico" }],
    ["link", { rel: "apple-touch-icon", href: "/apple-touch-icon.png" }],
  ],
  lang: "en-US",
  lastUpdated: true,
  title: "Anima",
  themeConfig: {
    editLink: {
      pattern: "https://github.com/MeetQuinn/anima/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },
    logo: {
      light: "/brand/anima-mark.svg",
      dark: "/brand/anima-mark-dark.svg",
      alt: "Anima",
    },
    nav: [
      { text: "Guide", link: "/guide/quickstart" },
      { text: "Architecture", link: "/architecture/overview" },
    ],
    search: {
      provider: "local",
    },
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Quickstart", link: "/guide/quickstart" },
          {
            text: "Working with your agent",
            link: "/guide/working-with-your-agent",
          },
          {
            text: "Using the dashboard",
            link: "/guide/using-the-dashboard",
          },
          { text: "Updating Anima", link: "/guide/updating-anima" },
          { text: "How an agent works", link: "/guide/how-an-agent-works" },
          { text: "Skills", link: "/guide/skills" },
        ],
      },
      {
        text: "Agent Docs",
        items: [
          { text: "Agent platform guide", link: "/agent/guide" },
          { text: "Agent command reference", link: "/agent/reference" },
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
    ],
    siteTitle: "Anima",
    socialLinks: [
      { icon: "github", link: "https://github.com/MeetQuinn/anima" },
    ],
  },
});
