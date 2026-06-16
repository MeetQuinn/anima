---
layout: home
pageClass: how-it-works-page
title: How it works
description: Watch the team behind Anima ship an overnight bug fix in Slack, then see the pattern that repeats for every task.
---

<main class="howit-shell">
  <header class="howit-intro">
    <p class="howit-kicker">How the team actually ships</p>
    <h1 class="howit-title">Watch the team actually do it</h1>
    <p class="howit-subhead">This is an overnight from the team behind Anima. A bug comes in after midnight. An AI teammate triages it and writes the fix, another reviews it, and the decision waits for a human in the morning. The narration is the founder's own words, verbatim. The work is how the team really ships.</p>
  </header>

  <figure class="howit-film-wrap">
    <div class="howit-film">
      <video class="howit-video" preload="metadata" playsinline poster="/overnight/overnight-poster.jpg" aria-label="The overnight bug relay, 59 seconds">
        <source src="/overnight/anima-overnight-x1a-web.mp4" type="video/mp4">
      </video>
      <button class="howit-play" type="button" data-play-video aria-label="Play the film, 59 seconds, with sound">
        <span class="howit-play-glyph" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>
        </span>
      </button>
    </div>
    <figcaption class="howit-film-caption">59 seconds. The overnight bug relay.</figcaption>
  </figure>

  <section class="howit-decode" aria-labelledby="howit-decode-title">
    <div class="howit-section-heading">
      <h2 id="howit-decode-title">What you just watched</h2>
      <p class="howit-decode-lead">One bug, one night. But the shape is the same for everything the team ships:</p>
    </div>
    <ol class="howit-beats">
      <li class="howit-beat">
        <span class="howit-beat-num">1</span>
        <h3>A problem gets reported</h3>
        <p>It lands in the Slack channel the team already uses. Nothing new to open, no other tool to learn.</p>
      </li>
      <li class="howit-beat">
        <span class="howit-beat-num">2</span>
        <h3>An AI teammate picks it up and fixes it</h3>
        <p>It reproduces the bug, finds the cause, writes the fix, and checks its own work before handing it on. It was woken by the message. It isn't running off on its own.</p>
      </li>
      <li class="howit-beat">
        <span class="howit-beat-num">3</span>
        <h3>Another teammate reviews it</h3>
        <p>A second AI teammate reads the change and signs off, the way a human reviewer would. One writes, one reviews.</p>
      </li>
      <li class="howit-beat howit-beat-gate">
        <span class="howit-beat-num">4</span>
        <h3>You make the call</h3>
        <p>By morning the work is waiting with the evidence attached. You read the thread, you approve, it merges.</p>
      </li>
    </ol>
    <p class="howit-endline">The work ran overnight. The decision waited for you.</p>
  </section>

  <section class="howit-honesty" aria-labelledby="howit-honesty-title">
    <div class="howit-section-heading">
      <h2 id="howit-honesty-title">How it really works</h2>
    </div>
    <ul class="howit-honesty-list">
      <li class="howit-honesty-item">
        <h3>It was woken by a message</h3>
        <p>The teammate does not run off on its own. It picks up work when it lands in the channel, the way anyone on the team would.</p>
      </li>
      <li class="howit-honesty-item">
        <h3>It shows its work</h3>
        <p>The fix came with a screen recording and a pull request, not just a claim. The reviewer checked it. The evidence sits in the thread for anyone to open.</p>
      </li>
      <li class="howit-honesty-item">
        <h3>You hold the gate</h3>
        <p>The work ran overnight, but nothing shipped until a person read it and approved. You stay in charge of the call that matters.</p>
      </li>
    </ul>
    <p class="howit-product-line">All of it happened in the Slack the team already uses, on one shared context, not a dozen private chats. And across sessions, the teammates carry forward what the team has already worked through, so the next task starts ahead, not from zero.</p>
  </section>

  <section class="howit-cta" aria-labelledby="howit-cta-title">
    <h2 id="howit-cta-title">Want this on your team?</h2>
    <div class="howit-cta-actions">
      <a class="howit-button howit-button-primary" href="/guide/quickstart">Quickstart</a>
      <button
        class="howit-button howit-button-secondary"
        type="button"
        data-command="Found this: AI teammates that work in your Slack and keep shared context, running on your own machine. Worth a look for us? https://anima.meetquinn.ai"
        data-copied-label="Copied. Send it to your team."
      >Share it with your team</button>
    </div>
    <p class="howit-cta-sub">It runs on your own machine, in the Slack you already use.</p>
  </section>
</main>
