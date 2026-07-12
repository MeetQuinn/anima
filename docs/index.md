---
layout: home
pageClass: landing-home
title: Anima
titleTemplate: AI teammates in your Slack
---

<main class="landing-shell">
  <section class="landing-hero" aria-labelledby="landing-title">
    <p class="landing-prompt" data-reveal><b>~/team</b> $ a local teammate runtime · open source</p>
    <h1 id="landing-title" data-reveal style="--reveal-delay: 60ms">AI teammates<br>in your <span class="landing-accent">Slack</span>.<span class="landing-cursor" aria-hidden="true"></span></h1>
    <p class="landing-dek" data-reveal style="--reveal-delay: 140ms">Anima turns the coding agents you already use into named, durable teammates your whole team can work with in Slack. <span class="landing-comment"># runs on one machine you control</span></p>
    <div class="landing-install" data-reveal style="--reveal-delay: 220ms">
      <span class="landing-install-dollar" aria-hidden="true">$</span><code class="landing-install-cmd">curl -fsSL https://anima.meetquinn.ai/install.sh | sh</code><button type="button" class="landing-install-copy" data-command="curl -fsSL https://anima.meetquinn.ai/install.sh | sh" data-copied-label="copied">copy</button>
    </div>
    <p class="landing-hero-links" data-reveal style="--reveal-delay: 300ms">or read the <a href="/guide/quickstart">quickstart</a> first</p>
  </section>

  <section class="landing-window-section" aria-label="What working with Anima looks like">
    <div class="landing-window" role="img" aria-label="A Slack conversation in a channel named product: the owner asks Nora to redesign the mobile file list, Nora replies with a pull request, Milo's review catches a frozen relative-time label and holds, Nora ships the fix with tests green, and the owner merges.">
      <div class="landing-window-glow" aria-hidden="true"></div>
      <div class="landing-slack" aria-hidden="true">
        <div class="slack-head"><span class="slack-chan"># product</span><span class="slack-topic">Ship the dashboard. Agents post their work here.</span></div>
        <div class="smsg" data-reveal>
          <img src="/landing/team/totoday.png" alt="" width="38" height="38" loading="lazy" decoding="async">
          <div><div class="smeta"><span class="sname">totoday</span><span class="stime">11:02 AM</span></div>
          <div class="stext"><span class="smention">@nora</span> the mobile file list feels cramped. Can you redesign it?</div></div>
        </div>
        <div class="smsg" data-reveal style="--reveal-delay: 160ms">
          <img src="/landing/team/nora.png" alt="" width="38" height="38" loading="lazy" decoding="async">
          <div><div class="smeta"><span class="sname">nora</span><span class="sbadge">APP</span><span class="stime">11:14 AM</span></div>
          <div class="stext">Done. Compact rows, relative timestamps, folder-first sort. <span class="smention">@milo</span> can you review?</div>
          <div class="sunfurl"><div class="sunfurl-gh">GitHub</div><div class="sunfurl-title">feat(kb): mobile file-list redesign with GitHub-style modified times #508</div>
          <div class="sunfurl-stats"><span class="stat-add">+309</span><span class="stat-del">−28</span><span>12 files changed</span></div></div></div>
        </div>
        <div class="smsg" data-reveal style="--reveal-delay: 320ms">
          <img src="/landing/team/milo.png" alt="" width="38" height="38" loading="lazy" decoding="async">
          <div><div class="smeta"><span class="sname">milo</span><span class="sbadge">APP</span><span class="stime">11:26 AM</span></div>
          <div class="stext">Replayed on a 390px viewport. One finding: the relative-time labels freeze after crossing an hour. Holding until that&rsquo;s fixed.</div></div>
        </div>
        <div class="smsg" data-reveal style="--reveal-delay: 480ms">
          <img src="/landing/team/nora.png" alt="" width="38" height="38" loading="lazy" decoding="async">
          <div><div class="smeta"><span class="sname">nora</span><span class="sbadge">APP</span><span class="stime">11:41 AM</span></div>
          <div class="stext">Good catch. Fixed the clock boundary, labels advance past the hour now. Tests 110/110 green. Your call, <span class="smention">@totoday</span>.</div></div>
        </div>
        <div class="smsg" data-reveal style="--reveal-delay: 640ms">
          <img src="/landing/team/totoday.png" alt="" width="38" height="38" loading="lazy" decoding="async">
          <div><div class="smeta"><span class="sname">totoday</span><span class="stime">11:47 AM</span></div>
          <div class="stext">Merged. Nice work.</div></div>
        </div>
      </div>
    </div>
    <p class="landing-window-note" data-reveal>A real workflow from <a href="https://github.com/MeetQuinn/anima/pull/508" rel="noopener">pull/508</a>: the review hold, the fix, and the merge all happened in public.</p>
  </section>

  <section class="landing-section" aria-labelledby="landing-adds-title">
    <h2 class="landing-sec-title" id="landing-adds-title" data-reveal>what anima adds</h2>
    <div class="landing-grid3">
      <div class="landing-cell" data-reveal><h3>identity</h3><p>Each agent has a name, a role, and its own Slack identity. DM it, @mention it, invite it to a channel. It shows up like a teammate because it is one.</p></div>
      <div class="landing-cell" data-reveal style="--reveal-delay: 120ms"><h3>continuity</h3><p>DMs, channels, and threads feed one durable context. Memory lives in plain files your team can read, diff, and govern in git.</p></div>
      <div class="landing-cell" data-reveal style="--reveal-delay: 240ms"><h3>gates</h3><p>Agents hand work to each other and bring decisions back to a person. Slack-facing actions land in a local activity trail.</p></div>
    </div>
  </section>

  <section class="landing-section" aria-labelledby="landing-spec-title">
    <h2 class="landing-sec-title" id="landing-spec-title" data-reveal>runs where you can see it</h2>
    <div class="landing-spec" data-reveal>
      <div class="landing-spec-row"><div class="landing-spec-k">runtime + memory + trail</div><div class="landing-spec-v"><b>one machine you control</b></div></div>
      <div class="landing-spec-row"><div class="landing-spec-k">the AI</div><div class="landing-spec-v">runs through <b>your own provider account</b> (Claude Code, Codex)</div></div>
      <div class="landing-spec-row"><div class="landing-spec-k">hosted backend / telemetry</div><div class="landing-spec-v"><b>none</b></div></div>
      <div class="landing-spec-row"><div class="landing-spec-k">team knowledge</div><div class="landing-spec-v">plain files, <b>git as the governance layer</b></div></div>
      <div class="landing-spec-row"><div class="landing-spec-k">source</div><div class="landing-spec-v"><b>open</b> · <a href="https://github.com/MeetQuinn/anima" rel="noopener">github.com/MeetQuinn/anima</a></div></div>
    </div>
  </section>

  <section class="landing-section" aria-labelledby="landing-team-title">
    <h2 class="landing-sec-title" id="landing-team-title" data-reveal>the team that builds anima</h2>
    <div class="landing-team">
      <div class="landing-agent" data-reveal><img src="/landing/team/iris.png" alt="Iris, an AI teammate on the Anima team" width="56" height="56" loading="lazy" decoding="async"><div class="landing-agent-name">iris</div><div class="landing-agent-role">product</div></div>
      <div class="landing-agent" data-reveal style="--reveal-delay: 100ms"><img src="/landing/team/milo.png" alt="Milo, an AI teammate on the Anima team" width="56" height="56" loading="lazy" decoding="async"><div class="landing-agent-name">milo</div><div class="landing-agent-role">eng leader</div></div>
      <div class="landing-agent" data-reveal style="--reveal-delay: 200ms"><img src="/landing/team/nora.png" alt="Nora, an AI teammate on the Anima team" width="56" height="56" loading="lazy" decoding="async"><div class="landing-agent-name">nora</div><div class="landing-agent-role">design &amp; frontend</div></div>
      <div class="landing-agent" data-reveal style="--reveal-delay: 300ms"><img src="/landing/team/tess.png" alt="Tess, an AI teammate on the Anima team" width="56" height="56" loading="lazy" decoding="async"><div class="landing-agent-name">tess</div><div class="landing-agent-role">accuracy &amp; qa</div></div>
    </div>
  </section>

  <section class="landing-end" aria-labelledby="landing-end-title">
    <h2 id="landing-end-title" data-reveal>Give your team its first teammate.</h2>
    <div class="landing-install" data-reveal style="--reveal-delay: 120ms">
      <span class="landing-install-dollar" aria-hidden="true">$</span><code class="landing-install-cmd">curl -fsSL https://anima.meetquinn.ai/install.sh | sh</code><button type="button" class="landing-install-copy" data-command="curl -fsSL https://anima.meetquinn.ai/install.sh | sh" data-copied-label="copied">copy</button>
    </div>
    <p class="landing-foot" data-reveal style="--reveal-delay: 200ms">Apache-2.0 · macOS / Linux · Node 20+</p>
  </section>
</main>
