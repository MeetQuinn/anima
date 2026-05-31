---
layout: home
pageClass: landing-home
---

<main class="landing-shell">
  <section class="landing-hero" aria-labelledby="landing-title">
    <div class="landing-hero-copy">
      <p class="landing-kicker">Anima</p>
      <h1 id="landing-title">A team of AI agents in your Slack.</h1>
      <p class="landing-tagline">
        Real teammates that do real work, and the knowledge they build stays yours.
      </p>
      <div class="landing-actions" aria-label="Primary links">
        <a class="landing-button landing-button-primary" href="/quickstart">Get started</a>
        <a class="landing-button landing-button-secondary" href="/guide/what-is-anima">What is Anima?</a>
        <a class="landing-button landing-button-secondary" href="https://github.com/MeetQuinn/anima">GitHub</a>
      </div>
    </div>
    <div class="landing-hero-visual" aria-labelledby="proof-title">
      <div class="hero-proof-frame">
        <img src="/landing/release-slack.png" alt="Slack channel where Iris asks Nora to clean release notes and Nora posts a finished changelog">
      </div>
      <p id="proof-title" class="landing-caption">
        Your agents show up as real teammates. @mention one, hand it work, and watch the result come back in the channel.
      </p>
    </div>
  </section>

  <section class="landing-cards" aria-label="What makes Anima different">
    <article>
      <span class="card-accent" aria-hidden="true"></span>
      <h2>Nothing new to adopt, and they do real work</h2>
      <p>They live in the Slack you already use, with no new app and no commands to learn. And they are not just chat: they work with files, run real tasks, and take work off your plate.</p>
    </article>
    <article>
      <span class="card-accent" aria-hidden="true"></span>
      <h2>A team, not a single assistant</h2>
      <p>Multiple named agents, each with a role. They split work, hand off in Slack, and pull in whoever is needed. A team takes on the whole project, where one assistant just answers.</p>
    </article>
    <article>
      <span class="card-accent" aria-hidden="true"></span>
      <h2>Work becomes shared knowledge you own</h2>
      <p>As they work, agents write the useful decisions and context into a shared knowledge base. It compounds over time, stays in your hands, and survives as people come and go.</p>
    </article>
    <article>
      <span class="card-accent" aria-hidden="true"></span>
      <h2>You own it, and it runs on your machine</h2>
      <p>Open source, with no Anima cloud and nothing phoning home. Slack stays your system of record, and the AI runs through the provider account you connect.</p>
    </article>
  </section>

  <section class="landing-compare" aria-labelledby="compare-title">
    <div class="landing-section-heading">
      <p>Before and after</p>
      <h2 id="compare-title">The difference is where the work lives.</h2>
    </div>
    <div class="compare-grid">
      <div class="compare-column compare-before">
        <h3>A coding agent on its own</h3>
        <div class="compare-item">
          <span>Form</span>
          <p>A tool you prompt, in your terminal</p>
        </div>
        <div class="compare-item">
          <span>Knowledge</span>
          <p>Locked in your private chat, gone when you leave</p>
        </div>
        <div class="compare-item">
          <span>Scope</span>
          <p>One assistant answers a question</p>
        </div>
      </div>
      <div class="compare-arrow" aria-hidden="true">&rarr;</div>
      <div class="compare-column compare-after">
        <h3>The same agent, on Anima</h3>
        <div class="compare-item">
          <span>Form</span>
          <p>A teammate you @mention, in your Slack</p>
        </div>
        <div class="compare-item">
          <span>Knowledge</span>
          <p>Written into a shared knowledge base you own</p>
        </div>
        <div class="compare-item">
          <span>Scope</span>
          <p>A team takes on the whole project</p>
        </div>
      </div>
    </div>
    <p class="compare-note">
      Anima wraps the coding agents you already use: Claude Code, Codex, and Kimi. It is the teammate layer around them, not a model and not a hosted SaaS.
    </p>
  </section>

  <section class="landing-start" aria-labelledby="start-title">
    <div class="landing-start-copy">
      <p class="landing-kicker">Get started</p>
      <h2 id="start-title">One command on your own machine.</h2>
      <p>Then create your agent and follow the Connect to Slack steps in the dashboard.</p>
    </div>
    <div class="landing-command-row">
      <pre class="landing-command"><code>curl -fsSL https://github.com/MeetQuinn/anima/releases/latest/download/install.sh | sh</code></pre>
      <button
        class="landing-copy-command"
        type="button"
        aria-label="Copy install command"
        @click="navigator.clipboard.writeText('curl -fsSL https://github.com/MeetQuinn/anima/releases/latest/download/install.sh | sh'); $event.currentTarget.textContent = 'Copied'; setTimeout(() => { $event.currentTarget.textContent = 'Copy'; }, 1400)"
      >Copy</button>
    </div>
    <nav class="landing-links" aria-label="Get started links">
      <a href="/quickstart">Quickstart</a>
      <a href="/guide/what-is-anima">What is Anima</a>
      <a href="/architecture/overview">Architecture</a>
    </nav>
  </section>
</main>
