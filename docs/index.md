---
layout: home
pageClass: landing-home
---

<main class="landing-shell">
  <section class="landing-hero" aria-labelledby="landing-title">
    <div class="landing-hero-copy">
      <h1 id="landing-title">AI teammates in your Slack, building shared team context.</h1>
      <p class="landing-tagline">
        Named agents with a role and a continuous memory, in the Slack your team already uses. What they learn stays yours.
      </p>
      <div class="landing-actions" aria-label="Primary links">
        <a class="landing-button landing-button-primary" href="/guide/quickstart">Get started</a>
      </div>
    </div>
    <div class="landing-hero-visual">
      <div class="hero-proof-frame">
        <picture>
          <source media="(max-width: 620px)" srcset="/landing/ember-ship-thread-compact.png">
          <img src="/landing/ember-ship-thread.png" alt="A Slack thread: Iris asks Nora to ship the new Ember logo to the docs, Nora opens a pull request and flags a dark-mode nav nit for follow-up.">
        </picture>
      </div>
    </div>
  </section>

  <section class="landing-card-section" aria-labelledby="cards-title">
    <div class="landing-section-heading">
      <p>Why Anima</p>
      <h2 id="cards-title">Built for shared AI work.</h2>
    </div>
    <div class="landing-cards">
      <article class="landing-card-featured">
        <h2>One shared context, not a dozen private chats</h2>
        <p>More and more work gets done with AI, but it happens in each person's private chat. Anima keeps it in one shared place the whole team can reach, and you own it.</p>
      </article>
      <article>
        <h2>Nothing new to adopt</h2>
        <p>They live in the Slack you already use: no new app, no commands to learn. And they are the coding agents you already trust (Claude Code, Codex), now where your team works.</p>
      </article>
      <article>
        <h2>A team, not a single assistant</h2>
        <p>Multiple named agents, each with a role. They split work, hand off in Slack, and pull in whoever is needed. A team takes on the whole project, where one assistant just answers.</p>
      </article>
      <article>
        <h2>You own it, runs locally</h2>
        <p>Open source, with no hosted Anima backend. No database or vector store to run, just local files on a machine you control. Slack stays your system of record, and the AI runs through your provider account.</p>
      </article>
    </div>
  </section>

  <section class="landing-compare" aria-labelledby="compare-title">
    <div class="landing-section-heading">
      <p>On its own vs on Anima</p>
      <h2 id="compare-title">The difference is shared context.</h2>
    </div>
    <div class="compare-card">
      <div class="compare-card-header" aria-hidden="true">
        <span>A coding agent on its own</span>
        <span></span>
        <span>The same agent, on Anima</span>
      </div>
      <div class="compare-row" data-topic="Context">
        <div class="compare-cell compare-before">
          <span>Context</span>
          <p>Stuck in one person's private chat</p>
        </div>
        <div class="compare-arrow" aria-hidden="true">&rarr;</div>
        <div class="compare-cell compare-after">
          <span>Context</span>
          <p>Shared with the whole team</p>
        </div>
      </div>
      <div class="compare-row" data-topic="Where">
        <div class="compare-cell compare-before">
          <span>Where</span>
          <p>In a terminal, for the technical few</p>
        </div>
        <div class="compare-arrow" aria-hidden="true">&rarr;</div>
        <div class="compare-cell compare-after">
          <span>Where</span>
          <p>In Slack, for anyone on the team</p>
        </div>
      </div>
      <div class="compare-row" data-topic="Setup">
        <div class="compare-cell compare-before">
          <span>Setup</span>
          <p>Everyone sets up their own</p>
        </div>
        <div class="compare-arrow" aria-hidden="true">&rarr;</div>
        <div class="compare-cell compare-after">
          <span>Setup</span>
          <p>One power user sets it up for the whole team</p>
        </div>
      </div>
    </div>
    <p class="compare-note">
      Your tools, skills, MCP, and extensions stay exactly the same. Anima just adds the teammate layer around them.
    </p>
  </section>

  <section class="landing-start" aria-labelledby="start-title">
    <div class="landing-section-heading">
      <p>Get started</p>
      <h2 id="start-title">One command on your own machine.</h2>
    </div>
    <p class="landing-start-frame">
      A technical teammate runs the command once; everyone else just works with the agents in Slack, nothing to install.
    </p>
    <div class="landing-command-row">
      <pre class="landing-command"><code>curl -fsSL https://anima.meetquinn.ai/install.sh | sh</code></pre>
      <button
        class="landing-copy-command"
        type="button"
        aria-label="Copy install command"
        data-command="curl -fsSL https://anima.meetquinn.ai/install.sh | sh"
      >Copy</button>
    </div>
    <nav class="landing-links" aria-label="Get started links">
      <a href="/guide/quickstart">Read the Quickstart</a>
    </nav>
  </section>
</main>
