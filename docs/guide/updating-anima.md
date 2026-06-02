# Updating Anima

Anima ships improvements often. Updating moves your install to the latest version while leaving
everything that matters in place: your agents, their memory and notes, your config, and your knowledge
base all stay exactly as they were. Only the Anima software underneath is replaced.

There are two ways to update. Most of the time you will use the dashboard.

## From the dashboard

When a new version is available, the **Server** button in the sidebar shows a small dot. Open the
**Server** panel and find the **Version** section:

- **Up to date** means you are on the latest version for your track. Nothing to do.
- **Update available** shows your current version and the new one, with an **Upgrade & restart**
  button. If the release has notes, a **Release notes** link sits just below.

Click **Upgrade & restart**. Anima installs and verifies the new version in the background while your
current version keeps running, then restarts at a safe point. Any agent that was working finishes or
saves its place first and resumes right where it left off, so nothing in flight is lost. The dashboard
reloads on its own when it is back, usually within a minute or two.

If any agents are busy when you start, Anima names them and asks you to confirm before it restarts, so
you are never interrupting work blind.

To check for a new version yourself rather than wait, use the refresh control next to the update row.

::: tip If an update does not take
Anima keeps your current version running until the new one is verified. If an install fails, you stay
on the version you were already on and nothing else changes. You can try again from the same place.
:::

## From the terminal

If you run Anima without the dashboard, or you just prefer the command line, re-run the same install
command you started with:

```bash
curl -fsSL https://anima.meetquinn.ai/install.sh | sh
```

It installs the latest version over your existing setup. Your home folder (`~/.anima` by default), your
agents, their memory and notes, and your knowledge base are left untouched: the installer only replaces
the Anima program itself.

## What updating does not touch

An update changes the Anima software and nothing else:

- **Your agents** stay configured exactly as they were.
- **Memory, notes, and the knowledge base** are your files, kept in your home folder, and are never
  rewritten by an update.
- **In-flight work** is carried through the restart: agents finish or save their place, then resume.
  This is different from **Restart agent**, the hung-agent recovery action, which drops the item in
  flight on purpose. See [Using the dashboard](./using-the-dashboard.md) for that distinction.

## In short

Updating is routine and safe: click **Upgrade & restart** in the **Server** panel, or re-run the
install command. Your team and everything it has built carry straight across.
