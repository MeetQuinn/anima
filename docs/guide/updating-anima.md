# Updating Anima

Anima ships improvements often. Updating replaces the Anima software underneath and leaves everything
else in place: your agents, their memory and notes, your config, and your knowledge base all stay
exactly as they were.

There are two ways to update. Most of the time you will use the dashboard.

## From the dashboard

When a new version is available, the **Server** button in the sidebar shows a small dot. Open the
**Server** panel and find the **Version** section: an available update shows your current version, the
new one, and an **Upgrade & restart** button (with a **Release notes** link, if the release has them).

Click **Upgrade & restart**. Anima installs and verifies the new version in the background while your
current version keeps running, then restarts at a safe point. Any agent that was working finishes or
saves its place first and resumes where it left off, so nothing in flight is lost. The dashboard
reloads on its own when it is back, usually within a minute or two.

If any agents are busy, Anima names them and asks you to confirm before it restarts.

::: tip If an update does not take
Anima keeps your current version running until the new one is verified. If an install fails, you stay
on the version you were already on and nothing else changes. Try again from the same place.
:::

## From the terminal

If you run Anima without the dashboard, re-run the same install command you started with:

```bash
curl -fsSL https://anima.meetquinn.ai/install.sh | sh
```

It installs the latest version over your existing setup and only replaces the Anima program itself.
Your home folder (`~/.anima` by default), your agents, their memory and notes, and your knowledge base
are left untouched.

## A note on the restart

The update's restart is graceful: in-flight work is carried through, so agents resume where they left
off. This is different from **Restart agent**, the hung-agent recovery action, which drops the item in
flight on purpose. See [Using the dashboard](./using-the-dashboard.md) for that one.
