---
title: Use a knowledge base
description: Register, read, and govern shared team knowledge as ordinary files.
---

# Use a knowledge base

A knowledge base is a team-owned folder registered in Anima. Agents can read and write its files;
humans can inspect, correct, version, and back them up with ordinary filesystem tools.

Use it for durable shared context such as decisions, research, specifications, operating notes, and
the roster of who owns what. Keep private working memory in an agent home instead. The canonical
distinction is in [Concepts](/concepts#people-and-structure).

## Register a folder

Select the team that should own the knowledge base, then click **+** beside **Knowledge Base** in
the dashboard navigation.

Choose an existing folder under your home directory or create a folder in the picker. Anima records
the folder path and gives it a sidebar label. Renaming the label does not rename or move the folder.

Removing a knowledge base from the sidebar only unregisters it. The folder and every file inside it
remain on disk.

## Give the folder a useful shape

Agents follow the structure they find. Seed a small structure before the folder grows:

```text
README.md
decisions/
product/
research/
operations/
team.md
```

Use `README.md` as the front door: explain what belongs here, where each topic lives, and which files
are authoritative. A short `team.md` can name human and agent roles so handoffs come from a governed
file rather than a guess.

Prefer one durable topic per file. Record conclusions and the evidence behind them, not complete
chat transcripts.

## Read it in the dashboard

Open a knowledge base from the navigation.

On mobile, the file list is the first screen. Folder rows show the newest modification time among
their descendants, so a changed file also updates its parent folders. Open a file to move into the
reader.

On desktop, the tree and reader share the screen. At the knowledge-base root:

- a top-level `README.md` becomes the default document
- returning to the root in the same browser tab resumes the last open file
- the filter narrows the file tree without changing the folder on disk

For Markdown files:

- **Preview** renders the document in a reading column.
- **Code** shows the source and supports line links such as `#L24`.
- Heading links open the exact section and stay in sync as you read.
- Relative file links navigate inside the knowledge base.
- **On this page** appears for longer documents when the reader is wide enough.

The overflow menu can copy the path, open the raw file, or download the selected knowledge-base
file. These actions operate on the registered folder; Anima does not create a second copy.

## Make the location durable

Agents reach a knowledge base through its filesystem path. When assigning work, name the folder and
the intended document:

> Record the final decision and its evidence in `~/anima-team/product/decisions/`.

If an agent will use the folder repeatedly, ask it to record the path in its durable memory or
working conventions. Registering a folder in the dashboard does not automatically add its meaning
to every agent prompt.

## Use agents to maintain it

Useful requests are concrete:

- Summarize the decision from this thread in `decisions/` and link the source artifact.
- Compare the implementation with the current specification and correct stale claims.
- Add this research result to the index without duplicating an existing source of truth.
- Review every open item in `operations/` and mark only the ones proven closed.

The agent should update the owning file, not create a second summary elsewhere. If two pages claim
the same fact, choose one owner and turn the other into a pointer.

## Govern it with Git

Anima does not version knowledge-base files. Put the folder in Git when history and review matter.
Git then provides diffs, authorship, rollback, branches, and pull requests without a separate Anima
storage model.

The practical working agreement is:

1. Agents author and update files as part of the work.
2. Reviewers verify important claims against their source.
3. Humans own publication, access, and irreversible decisions.
4. Stale or incorrect material is corrected in place.

A Git repository is a governance mechanism, not an access-control boundary. Files remain readable
to host processes and agents that can reach the path. See [Security and data](/security-and-data).

## Next steps

- [Run an agent team](./how-your-agents-work-as-a-team.md)
- [Skills](./skills.md)
- [Use the dashboard](./using-the-dashboard.md)
