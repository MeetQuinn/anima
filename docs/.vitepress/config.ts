import { defineConfig } from "vitepress";

function publicBase(): string {
  const raw = process.env.DOCS_BASE ?? process.env.VITEPRESS_BASE ?? "/";
  const prefixed = raw.startsWith("/") ? raw : `/${raw}`;
  return prefixed.endsWith("/") ? prefixed : `${prefixed}/`;
}

export default defineConfig({
  base: publicBase(),
  // Internal design/PRD material lives under docs/design/ for engineering
  // reference; it must never be built into the public site.
  srcExclude: ["design/**"],
  description:
    "Local infrastructure for durable AI agent teams in Slack and Feishu.",
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
      { text: "How it works", link: "/how-it-works" },
      { text: "Docs", link: "/guide/" },
      {
        text: "Use Cases",
        link: "/use-cases/external-events-via-slack",
      },
      { text: "Architecture", link: "/architecture/overview" },
    ],
    search: {
      provider: "local",
    },
    sidebar: [
      {
        text: "Start",
        items: [
          { text: "Documentation", link: "/guide/" },
          { text: "Quickstart", link: "/guide/quickstart" },
          { text: "Connect Slack", link: "/guide/connect-slack" },
          { text: "Connect Feishu", link: "/guide/connect-feishu" },
          { text: "Provider setup", link: "/guide/providers" },
          { text: "Concepts", link: "/concepts" },
        ],
      },
      {
        text: "Work with agents",
        items: [
          {
            text: "Working with your agent",
            link: "/guide/working-with-your-agent",
          },
          { text: "How an agent works", link: "/guide/how-an-agent-works" },
          {
            text: "How your agents work as a team",
            link: "/guide/how-your-agents-work-as-a-team",
          },
          { text: "The knowledge base", link: "/guide/knowledge-base" },
          { text: "Skills", link: "/guide/skills" },
        ],
      },
      {
        text: "Operate Anima",
        items: [
          {
            text: "Using the dashboard",
            link: "/guide/using-the-dashboard",
          },
          { text: "Updating Anima", link: "/guide/updating-anima" },
          { text: "Deployment and upgrades", link: "/deployment" },
          { text: "Service runbook", link: "/service-runbook" },
        ],
      },
      {
        text: "Evaluate and understand",
        items: [
          { text: "Architecture overview", link: "/architecture/overview" },
          { text: "Security and data", link: "/security-and-data" },
        ],
      },
      {
        text: "Use cases",
        items: [
          {
            text: "Set up a software team",
            link: "/use-cases/run-a-software-team",
          },
          {
            text: "Connect external events through Slack",
            link: "/use-cases/external-events-via-slack",
          },
        ],
      },
      {
        text: "Agent runtime reference",
        items: [
          { text: "Agent platform guide", link: "/agent/guide" },
          { text: "Agent command reference", link: "/agent/reference" },
          { text: "Recipes for common moments", link: "/agent/recipes" },
          { text: "Feishu runbook", link: "/agent/feishu" },
        ],
      },
      {
        text: "Contributor reference",
        items: [
          { text: "Codebase internals", link: "/architecture/internals" },
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
