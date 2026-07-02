# The knowledge base

Every team accumulates knowledge: decisions and the reasons behind them, research, specs, the
roster of who owns what. On most teams it evaporates into old threads. On an Anima team it lands in
the **knowledge base**: a shared folder of plain Markdown files that agents write to as they work
and humans can read, review, and correct.

The principle behind it is short enough to remember: **agents author it, humans govern it.** Files
are the source of truth. An agent that learns something the team will need again records it where
it belongs, in legible Markdown, and anyone — human or agent — builds on it from there. This page
is the how-to; for where the knowledge base sits in the team model, see
[How your agents work as a team](./how-your-agents-work-as-a-team.md#one-team-memory-many-private-notebooks).

## Add one in the dashboard

In the sidebar, the **Knowledge Base** section sits above your agents. Click **+** and pick the
folder:

- Browse to an existing folder under your home directory, or create a new one right in the picker.
- The folder's name becomes the knowledge base's label (you can rename the label later; renaming
  never touches the folder).
- The knowledge base belongs to the team you are working in, so with more than one team, each team
  sees its own.

Anima registers the folder; it does not take it over. The files stay ordinary files on your
machine, owned by you, editable with anything.

**Removing** a knowledge base from the sidebar only unregisters it. The folder and every file in it
stay exactly where they are.

## Browse it

Click a knowledge base and you get a reading surface for the whole folder: a file tree on the left,
content on the right.

- The top-level `README.md`, if there is one, is what you land on — write one, and it becomes the
  front door.
- Markdown renders as a document, with a table of contents for longer files. Flip to **Code** view
  when you need the raw text, and link to a specific line from there.
- Any file can be downloaded, and links to files and headings are deep links — paste one in Slack
  and a teammate lands on the exact section.

## Let the agents at it

Agents reach the knowledge base the way they reach anything: it is a folder on the machine they
work on. Tell an agent where it lives ("our knowledge base is `~/team/kb`; record decisions
there") and ask it to remember. From then on it reads the knowledge base when it needs context and
writes to it when something worth keeping happens — meeting outcomes, decision records, research
summaries, the why behind a change.

Two habits make this compound instead of sprawl:

- **Give it a shape.** A `README.md` index, one topic per file, folders by area (`decisions/`,
  `research/`, `product/`). Agents follow the structure they find, so the structure you seed is
  the structure you get.
- **Keep a roster.** A `team.md` naming each teammate — human and agent — with their role and what
  they own answers the question every agent asks eventually ("who do I hand this to?") from a
  governed file instead of a guess.

## Govern it with git

Anima does not version the knowledge base for you, and that is deliberate: git already does it
better. Make the folder a git repository, and you get the whole governance story for free —
history for every change an agent makes, diffs you can review, blame that shows which teammate
(agent or human) wrote a line, and revert when something recorded is wrong.

The working agreement that keeps quality up is the same one from the
[team guide](./how-your-agents-work-as-a-team.md): agents write, humans review. When you find
something wrong or stale, fix it or @mention the responsible agent and ask it to revise — the file
is the conversation piece, and the correction becomes part of the record.

## Where to go next

- **[How your agents work as a team](./how-your-agents-work-as-a-team.md)** — where shared memory
  fits in the team model.
- **[Skills](./skills.md)** — when recurring knowledge should graduate from notes into a packaged
  capability.
- **[Using the dashboard](./using-the-dashboard.md)** — the rest of the operator surface.
